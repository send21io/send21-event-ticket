import { describe, expect, it } from "vitest";
import { ticketCode } from "../src/tickets.js";
import { confirmedFor, deliver, ORG, STAFF, world } from "./helpers.js";

type W = Awaited<ReturnType<typeof world>>;
const paid = async (w: W, picks: Record<string, number> = { early: 1 }) => {
  const b = await w.buy(picks);
  await deliver(w.url, confirmedFor(b.order()));
  return b;
};
const doorLogin = async (w: W) => {
  const r = await w.post("/scan/login", { token: STAFF, gate: "door A" });
  expect(r.status).toBe(303);
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const orgLogin = async (w: W) => {
  const r = await w.post("/organizer/login", { token: ORG });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const scan = (w: W, cookie: string, code: string) =>
  fetch(`${w.url}/scan/check`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ code }) }).then((r) => r.json());

describe("🚪 door scanner", () => {
  it("✅ admits a valid ticket once; ⛔ the second scan shows when", async () => {
    const w = await world();
    const b = await paid(w);
    const html = await (await w.get(`${b.page}/tickets`)).text();
    expect(html).toContain("show at the door");
    const code = /tkt1\.[A-Za-z0-9._-]+/.exec(html)![0];
    const cookie = await doorLogin(w);
    const a = await scan(w, cookie, code);
    expect(a).toMatchObject({ result: "admitted", ticket: { emoji: "🐦", tier: "Early bird" } });
    const again = await scan(w, cookie, code);
    expect(again.result).toBe("used");
    expect(again.ticket.usedAt).toMatch(/^\d{4}-/);
    expect(again.detail).toContain("used at");
    // two concurrent scans: only one admits
    const b2 = await paid(w, { vip: 1 });
    const code2 = /tkt1\.[A-Za-z0-9._-]+/.exec(await (await w.get(`${b2.page}/tickets`)).text())![0];
    const [x, y] = await Promise.all([scan(w, cookie, code2), scan(w, cookie, code2)]);
    expect([x.result, y.result].sort()).toEqual(["admitted", "used"]);
    await w.close();
  });

  it("rejects forged, wrong-event, void and unknown codes", async () => {
    const w = await world();
    await paid(w);
    const t = w.store.tickets()[0]!;
    const cookie = await doorLogin(w);
    expect((await scan(w, cookie, "not-a-ticket")).result).toBe("forged");
    expect((await scan(w, cookie, ticketCode("wrong-secret-0123456789abcdef012345", { eventId: t.eventId, tierId: t.tierId, ticketId: t.id }))).result).toBe("forged");
    expect((await scan(w, cookie, ticketCode(w.cfg.ticketSecret, { eventId: "other-event", tierId: t.tierId, ticketId: t.id }))).result).toBe("wrong_event");
    // correctly signed but never issued
    expect((await scan(w, cookie, ticketCode(w.cfg.ticketSecret, { eventId: t.eventId, tierId: t.tierId, ticketId: "zzzzzzzzzzzz" }))).result).toBe("unknown");
    // flagged order: no tickets at all
    const bad = await w.buy({ ga: 1 });
    await deliver(w.url, confirmedFor(bad.order(), { fiatAmount: 1 }));
    expect(bad.order().status).toBe("flagged");
    expect(bad.order().ticketIds).toEqual([]);
    // void: grant then manually void? We don't have void API - mark void in store
    w.store.transaction((d) => {
      d.tickets[t.id] = { ...t, status: "void" };
    });
    expect((await scan(w, cookie, w.gate.codeFor(w.store.getTicket(t.id)!))).result).toBe("void");
    await w.close();
  });

  it("needs a staff session; mock /scan/demo logs in", async () => {
    const w = await world();
    expect((await scan(w, "", "x")).result).toBe("auth");
    expect((await w.post("/scan/login", { token: "wrong" })).status).toBe(401);
    const r = await w.get("/scan/demo");
    expect(r.status).toBe(303);
    expect(r.headers.get("set-cookie")).toMatch(/s21_door=/);
    await w.close();
  });
});

describe("🔐 organizer", () => {
  it("lists sales and 🚩 reviews; 🔓 grant issues tickets", async () => {
    const w = await world();
    const ok = await paid(w, { early: 2 });
    const bad = await w.buy({ vip: 1 });
    await deliver(w.url, confirmedFor(bad.order(), { sentCurrency: "ETH", network: "Arbitrum" }));
    const cookie = await orgLogin(w);
    const html = await (await w.get("/organizer", { headers: { cookie } })).text();
    expect(html).toContain("€24.00</b><span>💰 paid"); // 2×12
    expect(html).toContain("🚩 Review");
    expect(html).toContain("asset ETH on Arbitrum was not offered");
    expect(bad.order().ticketIds).toEqual([]);
    expect((await w.post(`/organizer/grant/${bad.id}`, {}, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await w.post(`/organizer/grant/${bad.id}`, {}, { cookie })).status).toBe(303);
    expect(bad.order().status).toBe("paid");
    expect(bad.order().ticketIds).toHaveLength(1);
    expect((await w.get(`${ok.page}/tickets`)).status).toBe(200);
    // live stats
    expect(await (await w.get("/organizer/stats", { headers: { cookie } })).json()).toMatchObject({ admitted: 0, valid: 3, tickets: 3 });
    await w.close();
  });
});

describe("🧪 mock pay page", () => {
  it("pays end-to-end and unlocks the tickets page", async () => {
    const w = await world();
    const b = await w.buy({ ga: 1, early: 1 });
    const html = await (await w.get(b.page)).text();
    const pay = new URL(/href="([^"]*\/mock\/pay\/[^"]+)"/.exec(html)![1]!).pathname;
    await w.post(`${pay}/paid`, { coin: "1" });
    expect(b.order().status).toBe("paid");
    expect(b.order().ticketIds).toHaveLength(2);
    expect(await (await w.get(`${b.page}/tickets`)).text()).toContain("2 tickets");
    await w.close();
  });
});
