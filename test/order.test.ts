import { describe, expect, it, vi } from "vitest";
import { Send21Error } from "../src/send21.js";
import { world } from "./helpers.js";

describe("🎟️ buy: reserve seats + ONE fiat pay link", () => {
  it("shows the event with tiers and seats left", async () => {
    const w = await world();
    const html = await (await w.get("/")).text();
    expect(html).toContain("Rooftop Sessions");
    expect(html).toContain("Early bird");
    expect(html).toContain("30 left");
    expect(html).toContain("⚡ BTC · Lightning");
    await w.close();
  });

  it("reserves seats atomically and creates the documented pay link", async () => {
    const w = await world();
    const spy = vi.spyOn(w.mockSend21!, "createPaymentRequest");
    const { page, order } = await w.buy({ early: 2, ga: 1 });
    const o = order();
    expect(page).toMatch(/^\/o\/[a-z0-9]{12}\/[A-Za-z0-9_-]{43}$/);
    expect(o.orderId).toBe(`tkt-${o.id}`);
    expect(o.total).toBe(42); // 2×12 + 18
    expect(w.gate.available("early")).toBe(28);
    expect(w.gate.available("ga")).toBe(79);
    expect(spy.mock.calls[0]).toEqual([
      {
        fiatCurrency: "EUR",
        fiatAmount: 42,
        orderId: o.orderId,
        memo: "🎟️ Rooftop Sessions · 1× General, 2× Early bird",
        options: w.cfg.options,
        expiryHours: 1,
        declineNote: "The order is cancelled and the seats go back on sale.",
        reuseOpenForOrder: true,
      },
      o.orderId,
    ]);
    expect(JSON.stringify(o)).not.toContain(page.split("/")[3]!);
    await w.close();
  });

  it("two buyers, last seats: the first write wins", async () => {
    const w = await world();
    // fill early bird to 29 held, 1 left
    for (let i = 0; i < 5; i++) await w.buy({ early: 5 }, `b${i}`);
    await w.buy({ early: 4 }, "b5"); // 29 held
    expect(w.gate.available("early")).toBe(1);
    const [a, b] = await Promise.all([w.gate.buy([{ tierId: "early", qty: 1 }], "winner"), w.gate.buy([{ tierId: "early", qty: 1 }], "loser")]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: "😢 only 0 🐦 Early bird left", status: 409 });
    expect(w.gate.available("early")).toBe(0);
    await w.close();
  });

  it("releases seats on expiry and when send21 refuses", async () => {
    const w = await world();
    const { order } = await w.buy({ vip: 2 });
    expect(w.gate.available("vip")).toBe(10);
    w.clock.now += 2 * 3600_000;
    expect(w.sweep().map((o) => o.status)).toEqual(["expired"]);
    expect(w.gate.available("vip")).toBe(12);
    expect(order().status).toBe("expired");

    vi.spyOn(w.mockSend21!, "createPaymentRequest").mockRejectedValue(new Send21Error("bad", 402));
    const r = await w.post("/buy", { buyer: "x", qty_ga: "1" });
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("fees to settle first");
    // failed order still holds? we patch to failed which is NOT in HOLDS_SEATS
    expect(w.gate.available("ga")).toBe(80);
    await w.close();
  });

  it("limits tickets per order and needs a name", async () => {
    const w = await world({ MAX_PER_ORDER: "2" });
    expect((await w.post("/buy", { buyer: "x", qty_ga: "3" })).status).toBe(400);
    expect(await (await w.post("/buy", { buyer: "see https://evil.com", qty_ga: "1" })).text()).toContain("plain text");
    await w.close();
  });
});
