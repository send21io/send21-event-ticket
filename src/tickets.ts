import { createHmac, timingSafeEqual } from "node:crypto";

// Ticket QR codes: signed, bound to one ticket, one event and one tier.
//
//   tkt1.<event id>.<tier id>.<ticket id>.<sig>
//   sig = base64url(HMAC-SHA256(TICKET_SECRET, "tkt1|<event>|<tier>|<ticket id>"))
//
// Nothing personal is in the QR: no name, no receipt key, no order. The
// signature stops forged or edited codes; the ticket record in the store makes
// each ticket usable exactly once.

const CODE = /^tkt1\.([a-z0-9-]{1,32})\.([a-z0-9-]{1,32})\.([a-z0-9]{12})\.([A-Za-z0-9_-]{43})$/;

export interface CodeBinding {
  eventId: string;
  tierId: string;
  ticketId: string;
}

const sign = (secret: string, b: CodeBinding) =>
  createHmac("sha256", secret).update(`tkt1|${b.eventId}|${b.tierId}|${b.ticketId}`).digest("base64url");

export function ticketCode(secret: string, b: CodeBinding): string {
  return `tkt1.${b.eventId}.${b.tierId}.${b.ticketId}.${sign(secret, b)}`;
}

export const parseCode = (code: string) => {
  const m = CODE.exec(code.trim());
  return m ? { eventId: m[1]!, tierId: m[2]!, ticketId: m[3]!, sig: m[4]! } : null;
};

/** Signature only (constant time). The ticket's status is checked by the caller, against the store. */
export function codeOk(secret: string, code: string): boolean {
  const c = parseCode(code);
  if (!c) return false;
  const want = Buffer.from(sign(secret, c));
  const got = Buffer.from(c.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
