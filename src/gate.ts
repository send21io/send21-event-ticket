import { createHash, randomBytes } from "node:crypto";
import { fiatDecimals, toMinor } from "./currencies.js";
import { cleanText } from "./sanitize.js";
import type { Send21Client } from "./send21.js";
import type { Store, StoreData } from "./store.js";
import { codeOk, parseCode, ticketCode } from "./tickets.js";
import { HOLDS_SEATS, type Event, type Order, type OrderItem, type OrderStatus, type PayOption, type Ticket, type TicketStatus } from "./types.js";

// The gate, without HTTP: orders, seats, webhooks, tickets and the door.

export interface GateConfig {
  options: PayOption[];
  expiryHours: number;
  shortfallPercent: number;
  ticketSecret: string;
  /** Tickets one buyer can hold in one order. */
  maxPerOrder: number;
}

export const ORDER_ID = /^tkt-([a-z0-9]{12})$/;
const GRACE_MS = 15 * 60_000;
const newId = (n: number) => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(n), (b) => abc[b % 36]).join("");
};

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };

export class Gate {
  constructor(
    readonly event: Event,
    readonly store: Store,
    private readonly send21: Send21Client,
    readonly cfg: GateConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  tier = (id: string) => this.event.tiers.find((t) => t.id === id);

  /** Seats not held by any order. Computed, never a counter. */
  available(tierId: string, d: Readonly<StoreData> = this.store.read((x) => x)): number {
    const tier = this.tier(tierId);
    if (!tier) return 0;
    let held = 0;
    for (const o of Object.values(d.orders)) if (HOLDS_SEATS.includes(o.status)) for (const i of o.items) if (i.tierId === tierId) held += i.qty;
    return Math.max(0, tier.capacity - held);
  }

  /**
   * 🎟️ Buy: reserve the seats and store the order in ONE write, then create ONE
   * pay link for the order. orderId tkt-<id> is also the Idempotency-Key.
   */
  async buy(picks: { tierId: string; qty: number }[], rawName: string): Promise<Result<{ order: Order; receipt: string }>> {
    const name = cleanText(rawName, 40);
    if (!name) return { ok: false, error: "✏️ a name for the tickets: plain text, max 40, no links", status: 400 };
    const items: OrderItem[] = [];
    for (const pick of picks) {
      const tier = this.tier(pick.tierId);
      if (!tier) return { ok: false, error: "🤷 no such tier", status: 404 };
      if (!Number.isInteger(pick.qty) || pick.qty < 1) continue;
      items.push({ tierId: tier.id, name: tier.name, emoji: tier.emoji, qty: pick.qty, price: tier.price });
    }
    if (!items.length) return { ok: false, error: "🎟️ pick at least one ticket", status: 400 };
    const totalQty = items.reduce((n, i) => n + i.qty, 0);
    if (totalQty > this.cfg.maxPerOrder) return { ok: false, error: `✋ max ${this.cfg.maxPerOrder} tickets per order`, status: 400 };
    const receipt = randomBytes(32).toString("base64url");
    const receiptHash = createHash("sha256").update(receipt).digest("hex");
    const nowIso = this.now().toISOString();
    const id = newId(12);
    const step = this.store.transaction((d): Result<{ order: Order }> => {
      this.sweep(d);
      for (const item of items) {
        const left = this.available(item.tierId, d);
        if (item.qty > left) return { ok: false, error: `😢 only ${left} ${item.emoji} ${item.name} left`, status: 409 };
      }
      const order: Order = {
        id,
        orderId: `tkt-${id}`,
        eventId: this.event.id,
        items,
        total: (() => {
        const scale = 10 ** fiatDecimals(this.event.currency);
        return items.reduce((n, i) => n + Math.round(i.price * scale) * i.qty, 0) / scale;
      })(),
        currency: this.event.currency,
        options: this.cfg.options,
        receiptHash,
        buyer: name,
        status: "open", // holds seats from now on
        paymentRequestId: null,
        payUrl: null,
        expiresAt: new Date(this.now().getTime() + this.cfg.expiryHours * 3600_000).toISOString(),
        ticketIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      d.orders[id] = order;
      return { ok: true, order };
    });
    if (!step.ok) return step;
    try {
      return { ok: true, order: await this.ensurePayLink(step.order), receipt };
    } catch (err) {
      this.patch(step.order.id, { status: "failed", problems: [String((err as Error).message).slice(0, 200)] });
      throw err;
    }
  }

  async ensurePayLink(o: Order): Promise<Order> {
    if (o.payUrl) return o;
    const pr = await this.send21.createPaymentRequest(
      {
        fiatCurrency: o.currency,
        fiatAmount: o.total,
        orderId: o.orderId,
        memo: `🎟️ ${this.event.name} · ${o.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}`.slice(0, 140),
        options: o.options,
        expiryHours: this.cfg.expiryHours,
        declineNote: "The order is cancelled and the seats go back on sale.",
        reuseOpenForOrder: true,
        ...(this.cfg.shortfallPercent > 0 ? { shortfallPolicy: { absorbUpToPercent: this.cfg.shortfallPercent, absorbedBy: "receiver" as const } } : {}),
      },
      o.orderId,
    );
    return this.patch(o.id, { paymentRequestId: pr.id, payUrl: this.send21.payUrl(pr.payPath), expiresAt: pr.expiresAt ?? o.expiresAt });
  }

  private patch(id: string, patch: Partial<Order>): Order {
    return this.store.transaction((d) => {
      d.orders[id] = { ...d.orders[id]!, ...patch, updatedAt: this.now().toISOString() };
      return d.orders[id]!;
    });
  }

  /** Release seats of open links that expired without a webhook. */
  sweep(d: StoreData, now = this.now()): Order[] {
    const out: Order[] = [];
    for (const o of Object.values(d.orders)) {
      if (["open", "seen"].includes(o.status) && o.expiresAt && Date.parse(o.expiresAt) + GRACE_MS < now.getTime()) {
        d.orders[o.id] = { ...o, status: "expired", updatedAt: now.toISOString() };
        out.push(d.orders[o.id]!);
      }
    }
    return out;
  }

  /** Issue the tickets for a paid order, once. Call inside the same transaction as the status change. */
  private issueTickets(d: StoreData, o: Order, nowIso: string): void {
    if (o.ticketIds.length) return;
    const ids: string[] = [];
    for (const item of o.items) {
      for (let i = 0; i < item.qty; i++) {
        const id = newId(12);
        d.tickets[id] = { id, orderId: o.orderId, eventId: o.eventId, tierId: item.tierId, tierName: item.name, emoji: item.emoji, status: "valid", createdAt: nowIso };
        ids.push(id);
      }
    }
    d.orders[o.id] = { ...d.orders[o.id]!, ticketIds: ids };
  }

  /** The signed QR code for a ticket. Nothing personal in it. */
  codeFor(t: Ticket): string {
    return ticketCode(this.cfg.ticketSecret, { eventId: t.eventId, tierId: t.tierId, ticketId: t.id });
  }

  // ---------- the door ----------

  /**
   * Scan a QR. The signature is checked first; the "used" mark is written in
   * the same step as the check, so two scanners cannot both admit one ticket.
   */
  scan(code: string, staff: string): ScanResult {
    const parsed = parseCode(code);
    if (!parsed || !codeOk(this.cfg.ticketSecret, code)) return { result: "forged", detail: "signature does not match" };
    if (parsed.eventId !== this.event.id) return { result: "wrong_event", detail: `ticket is for ${parsed.eventId}` };
    return this.store.transaction((d) => {
      const t = d.tickets[parsed.ticketId];
      if (!t || t.eventId !== parsed.eventId || t.tierId !== parsed.tierId) return { result: "unknown" as const, detail: "no such ticket" };
      if (t.status === "void") return { result: "void" as const, ticket: t, detail: "refunded" };
      if (t.status === "used") return { result: "used" as const, ticket: t, detail: `used at ${t.usedAt}` };
      const nowIso = this.now().toISOString();
      d.tickets[t.id] = { ...t, status: "used", usedAt: nowIso, usedBy: staff };
      return { result: "admitted" as const, ticket: d.tickets[t.id] };
    });
  }

  /** 🔓 The organizer reviewed a flagged or unresolved order and issues its tickets by hand. */
  grant(orderId: string): Result<{ order: Order }> {
    return this.store.transaction((d) => {
      const o = Object.values(d.orders).find((x) => x.id === orderId || x.orderId === orderId);
      if (!o) return { ok: false, error: "unknown order", status: 404 };
      if (!["flagged", "unresolved"].includes(o.status)) return { ok: false, error: `cannot grant a ${o.status} order`, status: 409 };
      const nowIso = this.now().toISOString();
      d.orders[o.id] = { ...o, status: "paid", updatedAt: nowIso };
      this.issueTickets(d, d.orders[o.id]!, nowIso);
      return { ok: true, order: d.orders[o.id]! };
    });
  }

  // ---------- webhooks ----------

  /** Apply one verified, de-duplicated event. Call inside store.transaction() with Store.remember(). */
  applyEvent(d: StoreData, body: { event?: unknown; data?: unknown }): { outcome: Outcome; order?: Order } {
    const event = typeof body.event === "string" ? body.event : "";
    if (event === "test") return { outcome: "test" };
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as DraftEventData;
    const m = typeof data.orderId === "string" ? ORDER_ID.exec(data.orderId) : null;
    if (data.orderId && !m) return { outcome: "unknown_order" }; // another integration on the same account
    const o = m ? d.orders[m[1]!] : Object.values(d.orders).find((x) => !!data.paymentRequestId && x.paymentRequestId === data.paymentRequestId);
    if (!o || !o.paymentRequestId || (data.paymentRequestId && data.paymentRequestId !== o.paymentRequestId)) return { outcome: "unknown_order" };
    const nowIso = this.now().toISOString();
    const set = (status: OrderStatus, extra: Partial<Order> = {}) => {
      d.orders[o.id] = { ...o, ...extra, status, updatedAt: nowIso };
      if (status === "paid") this.issueTickets(d, d.orders[o.id]!, nowIso);
      return { outcome: status, order: d.orders[o.id] };
    };
    const is = (...s: OrderStatus[]) => s.includes(o.status);
    const same = { outcome: "unchanged" as const, order: o };

    switch (event) {
      case "draft.confirmed": {
        if (o.status === "paid") return { outcome: "already_paid", order: o };
        const problems = checkPaymentAgainstOrder(data, o);
        if (problems.length) return set("flagged", { problems });
        return set("paid", {
          problems: undefined,
          paid: {
            currency: String(data.sentCurrency),
            network: String(data.network),
            amount: data.receivedAmount ?? data.sentAmount ?? null,
            txId: String(data.txId),
            differentAmount: data.receivedAmountSats !== undefined && data.receivedAmountSats !== data.amountSats,
            late: is("expired", "declined", "failed"),
            at: nowIso,
          },
        });
      }
      case "draft.seen":
        return is("open") ? set("seen") : same;
      case "draft.amount_mismatch":
        return is("open", "seen", "expired") ? set("review", { problems: ["a different amount arrived: accept or decline it on send21"] }) : same;
      case "draft.mismatch_accepted":
        return is("paid", "declined") ? same : set("accepted");
      case "draft.mismatch_rejected":
        return is("paid") ? same : set("declined");
      case "draft.mismatch_unresolved":
        return is("open", "seen", "review", "expired") ? set("unresolved") : same;
      case "draft.expired":
        if (data.reviewState === "unresolved") return is("open", "seen", "review", "expired") ? set("unresolved") : same;
        return is("open", "seen") ? set("expired") : same;
      case "payment_request.expired":
        return is("open", "seen") ? set("expired") : same;
      default:
        return { outcome: "ignored", order: o }; // draft.created, draft.cancelled, draft.mismatch_reminder
    }
  }
}

export type Outcome = "test" | "ignored" | "unknown_order" | "unchanged" | "already_paid" | OrderStatus;
export type ScanResult = { result: "admitted" | "used" | "void" | "forged" | "wrong_event" | "unknown"; detail?: string; ticket?: Ticket };

/** Fields of a draft webhook payload the gate reads (docs/webhooks "Payload"). */
export interface DraftEventData {
  status?: string;
  txId?: string;
  sentCurrency?: string;
  network?: string;
  amountSats?: number;
  sentAmount?: string;
  receivedAmountSats?: number;
  receivedAmount?: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  paymentRequestId?: string;
  orderId?: string;
  reviewState?: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isPosInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** A draft.confirmed must be exactly this order. Empty = OK. */
export function checkPaymentAgainstOrder(data: DraftEventData, o: Order): string[] {
  const problems: string[] = [];
  if (data.orderId !== o.orderId) problems.push(`orderId ${data.orderId} != ${o.orderId}`);
  if (!o.paymentRequestId || data.paymentRequestId !== o.paymentRequestId) problems.push(`pay link ${data.paymentRequestId} != ${o.paymentRequestId}`);
  if (data.status !== "Confirmed") problems.push(`status ${data.status} != Confirmed`);
  if (!data.txId) problems.push("no txId");
  if (!eq(data.fiatCurrency, o.currency)) problems.push(`fiat ${data.fiatCurrency} != ${o.currency}`);
  if (typeof data.fiatAmount !== "number" || toMinor(data.fiatAmount, o.currency) !== toMinor(o.total, o.currency)) problems.push(`amount ${data.fiatAmount} != ${o.total}`);
  if (!isPosInt(data.amountSats)) problems.push("no amountSats");
  if (data.receivedAmountSats !== undefined && !isPosInt(data.receivedAmountSats)) problems.push("bad receivedAmountSats");
  // sentCurrency is upper case in payloads ("USDC"), options use API enums ("Usdc").
  if (!o.options.some((opt) => eq(opt.currency, data.sentCurrency) && eq(opt.network, data.network))) problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered`);
  return problems;
}

void (0 as unknown as TicketStatus);
