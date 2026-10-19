import { describe, expect, it } from "vitest";
import { codeOk, parseCode, ticketCode } from "../src/tickets.js";

const S = "ticket-secret-for-tests-0123456789abcdef";
const b = { eventId: "rooftop-sessions", tierId: "early", ticketId: "abcdefghij12" };

describe("ticket QR codes", () => {
  it("are signed and bound to event + tier + ticket, with no PII", () => {
    const code = ticketCode(S, b);
    expect(code).toMatch(/^tkt1\.rooftop-sessions\.early\.abcdefghij12\.[A-Za-z0-9_-]{43}$/);
    expect(parseCode(code)).toMatchObject(b);
    expect(codeOk(S, code)).toBe(true);
    expect(codeOk("other-secret-0123456789abcdef01234567", code)).toBe(false);
    expect(codeOk(S, ticketCode(S, { ...b, tierId: "vip" }).replace(".vip.", ".early."))).toBe(false);
    expect(code).not.toMatch(/buyer|@|name/i);
  });

  it("refuses an edited id or a mangled code", () => {
    const code = ticketCode(S, b);
    expect(codeOk(S, code.replace("abcdefghij12", "zzzzzzzzzzzz"))).toBe(false);
    expect(parseCode("tkt1.a.b.c.d")).toBeNull();
    expect(parseCode("../../etc/passwd")).toBeNull();
  });
});
