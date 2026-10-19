import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkPaymentAgainstOrder } from "../src/gate.js";
import { Store } from "../src/store.js";
import { confirmedFor, deliver, world } from "./helpers.js";

type W = Awaited<ReturnType<typeof world>>;
const bought = async (w: W) => (await w.buy({ early: 1 })).order();
const ev = (event: string, o: Parameters<typeof confirmedFor>[0], data: Record<string, unknown> = {}) => ({ event, data: { ...confirmedFor(o).data, status: "Seen", ...data } });

describe("send21 webhook: verify, dedupe, then apply", () => {
  it("401 / 400 / nothing stored on a bad delivery", async () => {
    const w = await world();
    const o = await bought(w);
    expect((await deliver(w.url, confirmedFor(o), { secret: "wrong" })).status).toBe(401);
    expect((await deliver(w.url, confirmedFor(o), { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await deliver(w.url, null, { raw: "{nope" })).status).toBe(400);
    expect(w.store.getOrder(o.id)?.status).toBe("open");
    expect(w.store.getOrder(o.id)?.ticketIds).toEqual([]);
    await w.close();
  });

  it("✅ paid issues tickets once; duplicates are ignored", async () => {
    const w = await world();
    const o = await bought(w);
    const raw = JSON.stringify(confirmedFor(o));
    const id = crypto.randomUUID();
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, outcome: "paid" });
    expect(w.store.getOrder(o.id)?.ticketIds).toHaveLength(1);
    expect(w.store.tickets()).toHaveLength(1);
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await deliver(w.url, confirmedFor(o))).json()).toEqual({ ok: true, outcome: "already_paid" });
    expect(w.store.tickets()).toHaveLength(1);
    await w.close();
  });

  it("remembers deliveries across a restart; 500 retries cleanly", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tkt-")), "d.json");
    const a = await world({ DATA_FILE: file });
    const o = await bought(a);
    const raw = JSON.stringify(confirmedFor(o));
    const id = crypto.randomUUID();
    await deliver(a.url, null, { raw, deliveryId: id });
    await a.close();
    const b = await world({ DATA_FILE: file });
    expect(b.store.getOrder(o.id)?.status).toBe("paid");
    expect(b.store.tickets()).toHaveLength(1);
    expect(await (await deliver(b.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    await b.close();

    const c = await world({ DATA_FILE: join(mkdtempSync(join(tmpdir(), "tkt-")), "d.json") });
    const o2 = await bought(c);
    const raw2 = JSON.stringify(confirmedFor(o2));
    const id2 = crypto.randomUUID();
    const spy = vi.spyOn(c.store as unknown as { persist: () => void }, "persist").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect((await deliver(c.url, null, { raw: raw2, deliveryId: id2 })).status).toBe(500);
    expect(c.store.getOrder(o2.id)?.status).toBe("open");
    spy.mockRestore();
    expect(await (await deliver(c.url, null, { raw: raw2, deliveryId: id2 })).json()).toEqual({ ok: true, outcome: "paid" });
    await c.close();
  });

  it("ignores other apps' orderIds", async () => {
    const w = await world();
    const o = await bought(w);
    expect(await (await deliver(w.url, confirmedFor(o, { orderId: "file-abcdefghij12" }))).json()).toEqual({ ok: true, outcome: "unknown_order" });
    expect(await (await deliver(w.url, { event: "test", data: {} })).json()).toEqual({ ok: true, outcome: "test" });
    await w.close();
  });
});

describe("exact match or no tickets", () => {
  it.each([
    [{ fiatAmount: 11.99 }, /amount/],
    [{ fiatCurrency: "USD" }, /fiat/],
    [{ sentCurrency: "USDT", network: "Solana" }, /not offered/],
    [{ sentCurrency: "USDC", network: "Base" }, /not offered/],
    [{ status: "Seen" }, /status/],
    [{ txId: "" }, /txId/],
  ])("%j → 🚩 flagged, no tickets", async (over, why) => {
    const w = await world();
    const { page, order } = await w.buy();
    expect(checkPaymentAgainstOrder(confirmedFor(order(), over).data, order()).join()).toMatch(why);
    expect(await (await deliver(w.url, confirmedFor(order(), over))).json()).toEqual({ ok: true, outcome: "flagged" });
    expect(order().ticketIds).toEqual([]);
    expect(await (await w.get(page)).text()).toContain("the organizer is reviewing this payment");
    await w.close();
  });
});

describe("state machine", () => {
  const run = async (events: [string, Record<string, unknown>?][]) => {
    const w = await world();
    const o = await bought(w);
    const outcomes: string[] = [];
    for (const [e, data] of events) outcomes.push((await (await deliver(w.url, e === "draft.confirmed" ? confirmedFor(o, data) : ev(e, o, data))).json()).outcome);
    return { w, o, outcomes, status: w.store.getOrder(o.id)!.status };
  };
  it("👀 → ✅", async () => {
    const r = await run([["draft.seen"], ["draft.confirmed"]]);
    expect(r.outcomes).toEqual(["seen", "paid"]);
    await r.w.close();
  });
  it("⚠️ → 👍 → ✅", async () => {
    const r = await run([["draft.amount_mismatch", { receivedAmountSats: 11_400_000 }], ["draft.mismatch_accepted"], ["draft.confirmed", { receivedAmountSats: 11_400_000 }]]);
    expect(r.outcomes).toEqual(["review", "accepted", "paid"]);
    expect(r.w.store.getOrder(r.o.id)?.paid?.differentAmount).toBe(true);
    await r.w.close();
  });
  it("⚠️ → ↩️ declined: seats back", async () => {
    const r = await run([["draft.amount_mismatch"], ["draft.mismatch_rejected"]]);
    expect(r.outcomes).toEqual(["review", "declined"]);
    expect(r.w.gate.available("early")).toBe(30);
    await r.w.close();
  });
  it("⌛ then a late exact payment still issues tickets", async () => {
    const r = await run([["payment_request.expired"], ["draft.confirmed"]]);
    expect(r.outcomes).toEqual(["expired", "paid"]);
    expect(r.w.store.getOrder(r.o.id)?.paid?.late).toBe(true);
    expect(r.w.store.tickets()).toHaveLength(1);
    await r.w.close();
  });
  it("paid is final", async () => {
    const r = await run([["draft.confirmed"], ["draft.mismatch_rejected"], ["draft.expired"]]);
    expect(r.outcomes).toEqual(["paid", "unchanged", "unchanged"]);
    await r.w.close();
  });
});

describe("Store.remember", () => {
  it("drops entries older than 30 days", () => {
    const d = { version: 1 as const, orders: {}, tickets: {}, deliveries: { old: 0 }, events: { k0: 0 } };
    expect(Store.remember(d, "new", "k", 31 * 24 * 3600_000)).toBe(true);
    expect(Object.keys(d.deliveries)).toEqual(["new"]);
  });
});
