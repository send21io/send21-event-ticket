import type { Config } from "./config.js";
import { Gate } from "./gate.js";
import { createMockClient, createSend21Client } from "./send21.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";

/** Wire everything from a Config. Used by index.ts and the tests. */
export function buildGate(cfg: Config, opts: { log?: (l: string) => void; store?: Store; now?: () => Date } = {}) {
  const log = opts.log ?? console.log;
  const store = opts.store ?? new Store(cfg.dataFile);
  const mockSend21 = cfg.send21ApiKey ? null : createMockClient(cfg.publicUrl);
  const send21 = mockSend21 ?? createSend21Client({ apiBase: cfg.send21ApiBase, apiKey: cfg.send21ApiKey as string });
  const gate = new Gate(cfg.event, store, send21, { options: cfg.options, expiryHours: cfg.expiryHours, shortfallPercent: cfg.shortfallPercent, ticketSecret: cfg.ticketSecret, maxPerOrder: cfg.maxPerOrder }, opts.now);
  const mockPay = mockSend21 ? { client: mockSend21, selfUrl: `http://127.0.0.1:${cfg.port}` } : null;
  const app = createApp({
    gate,
    secret: cfg.webhookSecret,
    staffToken: cfg.staffToken,
    organizerToken: cfg.organizerToken,
    publicUrl: cfg.publicUrl,
    log,
    trustProxy: cfg.trustProxy,
    ...(mockPay ? { mockSend21: mockPay } : {}),
  });
  const sweep = () => store.transaction((d) => gate.sweep(d));
  return { app, gate, store, mockSend21, mockPay, sweep };
}
