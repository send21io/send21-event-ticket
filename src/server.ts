import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import QRCode from "qrcode";
import type { Gate } from "./gate.js";
import { errorPage, eventPage, mockPayPage, orderPage, organizerPage, scanPage, staffLogin, ticketsPage } from "./pages.js";
import { friendlyError, type createMockClient } from "./send21.js";
import { Store } from "./store.js";
import { signV2, verifySignatureV2 } from "./verify.js";

export interface AppDeps {
  gate: Gate;
  secret: string;
  staffToken: string;
  organizerToken: string;
  publicUrl: string;
  log?: (line: string) => void;
  mockSend21?: { client: ReturnType<typeof createMockClient>; selfUrl: string };
  trustProxy?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, HERE.includes(`${sep}dist${sep}`) ? "../../public" : "../public");
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const ORDER = /^[a-z0-9]{12}$/;
const RECEIPT = /^[A-Za-z0-9_-]{43}$/;

const hashReceipt = (r: string) => createHash("sha256").update(r).digest("hex");
const receiptOk = (r: string, hash: string) => {
  if (!RECEIPT.test(r)) return false;
  const a = Buffer.from(hashReceipt(r), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export function rateLimit(burst: number, everyMs: number, mock: boolean) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) / everyMs);
    b.at = now;
    if (b.tokens < 1) {
      res.set("Retry-After", String(Math.ceil(everyMs / 1000))).status(429).type("html").send(errorPage("🐢 slow down, try again in a minute", mock));
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}

export function createApp(deps: AppDeps): Express {
  const { gate, secret, staffToken, organizerToken, publicUrl, log = console.log, mockSend21, trustProxy = false } = deps;
  const mock = !!mockSend21;
  const { event, store } = gate;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use((_req, res, next) => {
    res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, send21: mock ? "mock" : "live", event: event.id });
  });

  // ---------- send21 webhook ----------
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied: ReturnType<Gate["applyEvent"]> | null;
    try {
      applied = store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? gate.applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    log(`webhook ${String(body.event)} ${deliveryId}: ${applied.outcome}`);
    res.status(200).json({ ok: true, outcome: applied.outcome });
  });

  const form = express.urlencoded({ extended: false, limit: "4kb" });

  app.get("/", (_req, res) => {
    res.type("html").send(eventPage(gate, mock));
  });

  app.post("/buy", rateLimit(10, 60_000, mock), form, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const picks = event.tiers
      .map((t) => ({ tierId: t.id, qty: Number(body[`qty_${t.id}`] ?? 0) }))
      .filter((p) => Number.isInteger(p.qty) && p.qty > 0);
    try {
      const r = await gate.buy(picks, String(body.buyer ?? ""));
      if (!r.ok) {
        res.status(r.status ?? 400).type("html").send(eventPage(gate, mock, r.error));
        return;
      }
      res.redirect(303, `/o/${r.order.id}/${r.receipt}`);
    } catch (err) {
      log(`pay link failed: ${(err as Error).message}`);
      res.status(502).type("html").send(eventPage(gate, mock, friendlyError(err)));
    }
  });

  const orderOf = (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const o = ORDER.test(id) ? store.getOrder(id) : undefined;
    if (!o || !receiptOk(String(req.params.receipt ?? ""), o.receiptHash)) {
      noStore(res).status(404).type("html").send(errorPage("🤷 unknown order", mock));
      return null;
    }
    return o;
  };

  const renderOrder = async (req: Request, res: Response) => {
    const o = orderOf(req, res);
    if (!o) return;
    const payHref = o.payUrl;
    const qr = payHref && ["open", "seen"].includes(o.status) ? `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(payHref, { type: "svg", margin: 1, color: { dark: "#121317", light: "#ffffff" } })).toString("base64")}` : null;
    noStore(res)
      .type("html")
      .send(orderPage(event, o, { base: `/o/${o.id}/${String(req.params.receipt)}`, qr, mock, payHref }));
  };
  app.get("/o/:id/:receipt", (req, res) => renderOrder(req, res));
  app.get("/o/:id/:receipt/status", (req, res) => {
    const o = orderOf(req, res);
    if (o) noStore(res).json({ status: o.status });
  });
  app.get("/o/:id/:receipt/tickets", async (req, res) => {
    const o = orderOf(req, res);
    if (!o) return;
    if (o.status !== "paid" || !o.ticketIds.length) {
      res.redirect(303, `/o/${o.id}/${String(req.params.receipt)}`);
      return;
    }
    const tickets = [];
    for (const tid of o.ticketIds) {
      const t = store.getTicket(tid)!;
      const code = gate.codeFor(t);
      const qr = `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(code, { type: "svg", margin: 1, width: 280, color: { dark: "#121317", light: "#ffffff" } })).toString("base64")}`;
      tickets.push({ ticket: t, code, qr });
    }
    noStore(res).type("html").send(ticketsPage(event, o, tickets, mock));
  });

  mountStaff(app, { gate, staffToken, organizerToken, publicUrl, mock, log });
  if (mockSend21) mountMockPay(app, secret, mockSend21);
  app.use(express.static(PUBLIC_DIR, { index: false }));
  return app;
}

// ---------- organizer + door staff ----------

const SESSION_MS = 12 * 3600_000;

function mountStaff(app: Express, o: { gate: Gate; staffToken: string; organizerToken: string; publicUrl: string; mock: boolean; log: (l: string) => void }): void {
  const { gate, staffToken, organizerToken, publicUrl, mock, log } = o;
  const orgKey = createHmac("sha256", organizerToken).update("organizer-session").digest();
  const staffKey = createHmac("sha256", staffToken).update("staff-session").digest();
  const session = (key: Buffer, payload: string) => {
    const exp = Date.now() + SESSION_MS;
    return `${exp}.${payload}.${createHmac("sha256", key).update(`${exp}.${payload}`).digest("base64url")}`;
  };
  const readSession = (key: Buffer, raw: string): string | null => {
    const [exp, payload, sig] = raw.split(".");
    if (!exp || !payload || !sig || !/^\d{13}$/.test(exp) || Number(exp) < Date.now()) return null;
    const a = Buffer.from(raw);
    const b = Buffer.from(`${exp}.${payload}.${createHmac("sha256", key).update(`${exp}.${payload}`).digest("base64url")}`);
    return a.length === b.length && timingSafeEqual(a, b) ? Buffer.from(payload, "base64url").toString("utf8") : null;
  };
  const getCookie = (req: Request, name: string) => {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.get("cookie") ?? "");
    return m?.[1] ?? "";
  };
  const secure = publicUrl.startsWith("https://");
  const setCookie = (res: Response, name: string, value: string, path: string) =>
    res.cookie(name, value, { httpOnly: true, sameSite: "strict", secure, path, maxAge: SESSION_MS });
  const sameSite = (req: Request) => {
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    const origin = req.get("origin");
    return !origin || origin === new URL(publicUrl).origin || origin === `${req.protocol}://${req.get("host")}`;
  };
  const tokenEq = (key: Buffer, got: unknown, want: string) => {
    const a = createHmac("sha256", key).update(String(got ?? "")).digest();
    const b = createHmac("sha256", key).update(want).digest();
    return timingSafeEqual(a, b);
  };
  const form = express.urlencoded({ extended: false, limit: "1kb" });
  const json = express.json({ limit: "2kb" });

  // Organizer
  const orgAuthed = (req: Request) => !!readSession(orgKey, getCookie(req, "s21_org"));
  app.get("/organizer", (req, res) => {
    noStore(res).type("html").send(orgAuthed(req) ? organizerPage(gate, mock) : staffLogin("organizer", mock));
  });
  app.get("/organizer/stats", (req, res) => {
    if (!orgAuthed(req)) {
      res.status(401).json({ error: "auth" });
      return;
    }
    const tickets = gate.store.tickets();
    noStore(res).json({ admitted: tickets.filter((t) => t.status === "used").length, valid: tickets.filter((t) => t.status === "valid").length, tickets: tickets.length });
  });
  app.post("/organizer/login", rateLimit(5, 60_000, mock), form, (req, res) => {
    if (!sameSite(req) || !tokenEq(orgKey, (req.body as { token?: unknown })?.token, organizerToken)) {
      res.status(401).type("html").send(staffLogin("organizer", mock, "🙅 wrong token"));
      return;
    }
    setCookie(res, "s21_org", session(orgKey, Buffer.from("organizer").toString("base64url")), "/organizer");
    res.redirect(303, "/organizer");
  });
  if (mock) {
    app.get("/organizer/demo", (_req, res) => {
      setCookie(res, "s21_org", session(orgKey, Buffer.from("organizer").toString("base64url")), "/organizer");
      res.redirect(303, "/organizer");
    });
  }
  app.post("/organizer/grant/:id", form, (req, res) => {
    if (!orgAuthed(req) || !sameSite(req)) {
      res.status(403).type("html").send(staffLogin("organizer", mock, "🔐 log in again"));
      return;
    }
    const r = gate.grant(String(req.params.id));
    if (!r.ok) {
      res.status(r.status ?? 400).type("html").send(errorPage(r.error, mock));
      return;
    }
    res.redirect(303, "/organizer");
  });

  // Door staff
  const doorStaff = (req: Request) => readSession(staffKey, getCookie(req, "s21_door"));
  app.get("/scan", (req, res) => {
    const who = doorStaff(req);
    noStore(res).type("html").send(who ? scanPage(gate.event, mock, who) : staffLogin("scan", mock));
  });
  app.post("/scan/login", rateLimit(5, 60_000, mock), form, (req, res) => {
    const body = (req.body ?? {}) as { token?: unknown; gate?: unknown };
    if (!sameSite(req) || !tokenEq(staffKey, body.token, staffToken)) {
      res.status(401).type("html").send(staffLogin("scan", mock, "🙅 wrong token"));
      return;
    }
    const who = String(body.gate ?? "").trim().slice(0, 20) || "door";
    if (!/^[A-Za-z0-9 _-]{1,20}$/.test(who)) {
      res.status(400).type("html").send(staffLogin("scan", mock, "🚪 gate name: letters, digits, spaces"));
      return;
    }
    setCookie(res, "s21_door", session(staffKey, Buffer.from(who).toString("base64url")), "/scan");
    res.redirect(303, "/scan");
  });
  if (mock) {
    app.get("/scan/demo", (_req, res) => {
      setCookie(res, "s21_door", session(staffKey, Buffer.from("door A").toString("base64url")), "/scan");
      res.redirect(303, "/scan");
    });
  }
  app.get("/scan/logout", (_req, res) => {
    res.clearCookie("s21_door", { path: "/scan" });
    res.redirect(303, "/scan");
  });
  app.post("/scan/check", rateLimit(60, 60_000, mock), json, (req, res) => {
    const who = doorStaff(req);
    if (!who) {
      res.status(401).json({ result: "auth" });
      return;
    }
    const code = String((req.body as { code?: unknown })?.code ?? "");
    const r = gate.scan(code, who);
    log(`scan ${r.result} by ${who}${r.ticket ? ` · ${r.ticket.tierName}` : ""}`);
    noStore(res).json({
      result: r.result,
      detail: r.detail,
      ...(r.ticket
        ? {
            ticket: {
              emoji: r.ticket.emoji,
              tier: r.ticket.tierName,
              usedAt: r.ticket.usedAt,
              usedBy: r.ticket.usedBy,
            },
          }
        : {}),
    });
  });
}

function noStore(res: Response) {
  return res.set("Cache-Control", "no-store");
}

// ---------- mock send21 ----------

function mountMockPay(app: Express, secret: string, mock: NonNullable<AppDeps["mockSend21"]>): void {
  const { client } = mock;
  app.get("/mock/pay/:token", (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)));
  });
  app.post("/mock/pay/:token/:action", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    const body = mockEvent(entry, Number((req.body as { coin?: string })?.coin ?? 0), String(req.params.action));
    const raw = JSON.stringify(body);
    const deliveryId = randomUUID();
    const r = await fetch(`${mock.selfUrl}/webhooks/send21`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-send21-event": body.event, "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret) },
      body: raw,
    });
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)).replace("<p class=\"small\">↩️", `<p class="pill">${r.ok ? "📨 sent" : "❌"} ${body.event}</p><p class="small">↩️`));
  });
}

type MockEntry = NonNullable<ReturnType<ReturnType<typeof createMockClient>["requests"]["get"]>>;

export function mockEvent(entry: MockEntry, coin: number, action: string) {
  const option = entry.body.options[coin] ?? entry.body.options[0]!;
  const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
  const price = option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1;
  const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / price) * units));
  const base = {
    draftId: randomUUID(),
    paymentRequestId: entry.response.id,
    orderId: entry.body.orderId,
    sentCurrency: option.currency.toUpperCase(),
    network: option.network,
    fiatCurrency: entry.body.fiatCurrency,
    fiatAmount: entry.body.fiatAmount,
    amountSats,
    sentAmount: (amountSats / units).toFixed(Math.log10(units)),
    occurredAt: new Date().toISOString(),
  };
  const confirmed = { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: `mock-${randomUUID()}`, confirmations: 1 } };
  switch (action) {
    case "paid":
      return confirmed;
    case "wrong":
      return { ...confirmed, data: { ...confirmed.data, sentCurrency: "ETH", network: "Arbitrum" } };
    case "seen":
      return { event: "draft.seen", data: { ...base, status: "Seen", txId: `mock-${randomUUID()}`, confirmations: 0 } };
    case "short":
      return { event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amountSats * 0.95) } };
    default:
      return { event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: entry.body.orderId, opened: true, quoteRequested: false } };
  }
}
