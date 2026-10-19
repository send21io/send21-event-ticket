import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { buildGate } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const STAFF = "staff-token-for-tests-only-0123456789ab";
export const ORG = "organizer-token-for-tests-only-0123456789";

export function testConfig(env: Record<string, string> = {}): Config {
  return {
    ...loadConfig({
      EVENT_FILE: "event.example.json",
      DATA_FILE: ":memory:",
      PAY_LIGHTNING: "door@wallet.example",
      PAY_OPTIONS: `usdc-sol:${SOL}`,
      STAFF_TOKEN: STAFF,
      ORGANIZER_TOKEN: ORG,
      ...env,
    }),
    webhookSecret: SECRET,
  };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export async function world(env: Record<string, string> = {}) {
  const logs: string[] = [];
  const clock = { now: Date.now() };
  const cfg = testConfig(env);
  const w = buildGate(cfg, { log: (l) => logs.push(l), now: () => new Date(clock.now) });
  const server = await listen(w.app);
  if (w.mockPay) w.mockPay.selfUrl = server.url;
  const get = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { redirect: "manual", ...init });
  const post = (path: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, { method: "POST", redirect: "manual", body: new URLSearchParams(body), headers });
  const buy = async (picks: Record<string, number> = { early: 1 }, buyer = "buyer") => {
    const body: Record<string, string> = { buyer };
    for (const [id, qty] of Object.entries(picks)) body[`qty_${id}`] = String(qty);
    const r = await post("/buy", body);
    const page = new URL(r.headers.get("location")!, server.url).pathname;
    const id = page.split("/")[2]!;
    return { page, id, order: () => w.store.getOrder(id)! };
  };
  return { ...w, ...server, cfg, logs, clock, get, post, buy };
}

export function confirmedFor(o: { orderId: string; paymentRequestId: string | null; total: number; currency: string }, over: Record<string, unknown> = {}) {
  return {
    event: "draft.confirmed",
    data: {
      draftId: crypto.randomUUID(),
      status: "Confirmed",
      txId: "5hRk-sig",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      amountSats: Math.round(o.total * 1e6),
      sentAmount: o.total.toFixed(6),
      fiatCurrency: o.currency,
      fiatAmount: o.total,
      paymentRequestId: o.paymentRequestId ?? undefined,
      orderId: o.orderId,
      occurredAt: new Date().toISOString(),
      ...over,
    },
  };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(payload, deliveryId, t, secret) },
    body: payload,
  });
}
