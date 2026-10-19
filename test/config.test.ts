import { describe, expect, it } from "vitest";
import { loadConfig, parseOptions } from "../src/config.js";
import { COINS } from "../src/currencies.js";
import { ORG, SOL, STAFF } from "./helpers.js";

const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const base = { EVENT_FILE: "event.example.json", STAFF_TOKEN: STAFF, ORGANIZER_TOKEN: ORG };

describe("coins", () => {
  it("USDT only on Solana and Ethereum; no USDT or BTC on Base", () => {
    const pairs = COINS.map((c) => `${c.currency}/${c.network}`);
    for (const bad of ["Usdt/Tron", "Usdt/Arbitrum", "Usdt/Polygon", "Usdt/Base", "Btc/Base"]) expect(pairs).not.toContain(bad);
    expect(() => parseOptions("", `usdt-base:${EVM}`)).toThrow(/unknown coin/);
    expect(() => parseOptions("", `usdt-tron:${EVM}`)).toThrow(/unknown coin/);
  });
});

describe("config", () => {
  it("needs no keys in mock mode", () => {
    const c = loadConfig(base);
    expect(c.mock).toBe(true);
    expect(c.event.tiers).toHaveLength(3);
    expect(c.ticketSecret).toHaveLength(64);
  });

  it("with a real key: secrets, own event and own addresses are required", () => {
    expect(() => loadConfig({ ...base, SEND21_API_KEY: "s21_x" })).toThrow(/SEND21_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, SEND21_API_KEY: "s21_x", SEND21_WEBHOOK_SECRET: "s", PAY_OPTIONS: `usdc-sol:${SOL}` })).toThrow(/event.json for your night/);
    expect(() => loadConfig({ ...base, STAFF_TOKEN: ORG, ORGANIZER_TOKEN: ORG })).toThrow(/must differ/);
    expect(() => loadConfig({ ...base, TICKET_SECRET: "short" })).toThrow(/32 characters/);
  });
});
