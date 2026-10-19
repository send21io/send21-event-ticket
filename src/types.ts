/** One pay-link option: a coin the organizer accepts and their own receiving address. */
export interface PayOption {
  currency: string;
  network: string;
  address: string;
  method?: string;
}

export interface Tier {
  id: string;
  name: string;
  emoji: string;
  /** Fiat price in the event currency. */
  price: number;
  capacity: number;
}

export interface Event {
  id: string;
  name: string;
  emoji: string;
  /** When, e.g. "Sat 24 Oct · 20:00". */
  when: string;
  venue: string;
  currency: string;
  tiers: Tier[];
}

export type OrderStatus =
  | "open" // 💳 pay link created, seats held
  | "seen" // 👀 payment on its way
  | "review" // ⚠️ a different amount arrived, the organizer decides on send21
  | "accepted" // 👍 accepted, waiting for draft.confirmed
  | "paid" // ✅ tickets issued
  | "declined" // ↩️ different amount declined: seats back
  | "unresolved" // ⚠️ expired undecided, money arrived: seats held
  | "expired" // ⌛ seats back
  | "flagged" // 🚩 confirmed but it does not match: seats held, no tickets
  | "failed"; // the pay link could not be created: seats back

/** Statuses that keep their seats off the shelf. */
export const HOLDS_SEATS: readonly OrderStatus[] = ["open", "seen", "review", "accepted", "paid", "unresolved", "flagged"];
/** Statuses that can get tickets (after the organizer grants a flagged one by hand). */
export const TICKETABLE: readonly OrderStatus[] = ["paid"];

export interface OrderItem {
  tierId: string;
  name: string;
  emoji: string;
  qty: number;
  price: number;
}

export interface Order {
  /** Random 12 × [a-z0-9]. orderId on send21 is tkt-<id>, also the Idempotency-Key. */
  id: string;
  orderId: string;
  eventId: string;
  items: OrderItem[];
  total: number;
  currency: string;
  options: PayOption[];
  /** sha256 of the buyer's receipt key. The key itself is only in the buyer's link. */
  receiptHash: string;
  buyer: string;
  status: OrderStatus;
  paymentRequestId: string | null;
  payUrl: string | null;
  expiresAt: string | null;
  paid?: { currency: string; network: string; amount: string | null; txId: string; differentAmount: boolean; late: boolean; at: string };
  problems?: string[];
  /** Ticket ids issued for this order (empty until paid / granted). */
  ticketIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type TicketStatus = "valid" | "used" | "void";

export interface Ticket {
  /** Random 12 × [a-z0-9]. The QR is signed over this + event + tier. */
  id: string;
  orderId: string;
  eventId: string;
  tierId: string;
  tierName: string;
  emoji: string;
  status: TicketStatus;
  usedAt?: string;
  usedBy?: string;
  createdAt: string;
}
