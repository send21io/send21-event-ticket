import { isFiat, parseTotal } from "./currencies.js";
import { cleanText, isEmoji } from "./sanitize.js";
import type { Event, Tier } from "./types.js";

// event.json: the night out.
//   { "id", "name", "emoji", "when", "venue", "currency",
//     "tiers": [{ "id", "name", "emoji", "price", "capacity" }] }

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function loadEvent(raw: unknown): Event {
  const fail = (msg: string): never => {
    throw new Error(`event.json: ${msg}`);
  };
  const e = (raw ?? {}) as Record<string, unknown>;
  const id = String(e.id ?? "");
  if (!ID.test(id)) fail("id a-z, 0-9 and dashes, max 32");
  const name = cleanText(e.name, 60) ?? fail("name: plain text, max 60");
  const emoji = isEmoji(e.emoji) ? e.emoji : fail("emoji must be one emoji");
  const when = cleanText(e.when, 60) ?? fail("when: plain text, max 60");
  const venue = cleanText(e.venue, 80) ?? fail("venue: plain text, max 80");
  const currency = String(e.currency ?? "").toUpperCase();
  if (!isFiat(currency)) fail(`currency "${String(e.currency)}" is not supported`);
  if (!Array.isArray(e.tiers) || !e.tiers.length) fail("list at least one tier");
  const tiers = (e.tiers as Record<string, unknown>[]).map((t, i): Tier => {
    const tid = String(t.id ?? "");
    if (!ID.test(tid)) fail(`tier ${i + 1}: id a-z, 0-9 and dashes, max 32`);
    const tname = cleanText(t.name, 40) ?? fail(`${tid}: name plain text, max 40`);
    const temoji = isEmoji(t.emoji) ? t.emoji : fail(`${tid}: emoji must be one emoji`);
    const price = parseTotal(t.price, currency, 10_000);
    if (!price.ok) fail(`${tid}: price ${price.error}`);
    const capacity = Number(t.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100_000) fail(`${tid}: capacity is a whole number 1…100000`);
    return { id: tid, name: tname, emoji: temoji, price: (price as { amount: number }).amount, capacity };
  });
  if (new Set(tiers.map((t) => t.id)).size !== tiers.length) fail("a tier id is listed twice");
  return { id, name, emoji, when, venue, currency, tiers };
}
