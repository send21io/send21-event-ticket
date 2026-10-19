import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadEvent } from "../src/catalog.js";

const sample = () => JSON.parse(readFileSync("event.example.json", "utf8"));
const withTier = (t: Record<string, unknown>) => ({ id: "night", name: "Night", emoji: "🎧", when: "Sat", venue: "Roof", currency: "EUR", tiers: [{ id: "ga", name: "GA", emoji: "🎟️", price: 10, capacity: 10, ...t }] });

describe("event.json", () => {
  it("loads the sample", () => {
    const e = loadEvent(sample());
    expect(e.id).toBe("rooftop-sessions");
    expect(e.tiers.map((t) => t.id)).toEqual(["ga", "early", "vip"]);
  });

  it.each([
    [{ id: "Bad" }, /id/],
    [{ name: "see evil.com" }, /name/],
    [{ emoji: "x" }, /emoji/],
    [{ price: 0 }, /price/],
    [{ capacity: 0 }, /capacity/],
    [{ capacity: 1.5 }, /capacity/],
  ])("refuses %j", (t, err) => {
    expect(() => loadEvent(withTier(t))).toThrow(err);
  });

  it("refuses a bad currency, empty tiers and duplicate ids", () => {
    expect(() => loadEvent({ ...withTier({}), currency: "XYZ" })).toThrow(/currency/);
    expect(() => loadEvent({ ...withTier({}), tiers: [] })).toThrow(/at least one/);
    expect(() => loadEvent({ ...withTier({}), tiers: [withTier({}).tiers[0], withTier({}).tiers[0]] })).toThrow(/twice/);
  });
});
