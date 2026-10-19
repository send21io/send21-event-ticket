import { coinFor, formatFiat } from "./currencies.js";
import type { Gate } from "./gate.js";
import type { Event, Order, PayOption, Ticket } from "./types.js";

// Server-rendered pages. Every dynamic value goes through esc(). No inline
// script or style (CSP 'self'): scripts are /buy.js, /order.js, /scan.js.

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function layout(title: string, body: string, opts: { script?: string; mock?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/ticket.css">${opts.script ? `<script src="${esc(opts.script)}" defer></script>` : ""}</head>
<body><main class="wrap">${body}</main>
<footer class="foot">${opts.mock ? "🧪 mock mode · no real money · " : ""}🔒 non-custodial · paid with <a href="https://send21.io">send21</a></footer></body></html>`;
}

const chips = (options: PayOption[]) =>
  `<ul class="coins">${[...new Map(options.map((o) => { const c = coinFor(o.currency, o.network, o.method); return [c?.id ?? o.currency, c] as const; })).values()]
    .map((c) => (c ? `<li>${c.emoji} ${esc(c.label)}</li>` : ""))
    .join("")}</ul>`;

export function eventPage(gate: Gate, mock: boolean, error?: string): string {
  const e = gate.event;
  const tiers = e.tiers
    .map((t) => {
      const left = gate.available(t.id);
      const sold = left === 0;
      return `<li class="tier ${sold ? "sold" : ""}" data-tier="${esc(t.id)}" data-price="${t.price}" data-left="${left}">
<span class="em">${esc(t.emoji)}</span>
<div><b>${esc(t.name)}</b><span class="small"> · ${sold ? "sold out" : `${left} left`}</span></div>
<span class="pr">${esc(formatFiat(t.price, e.currency))}</span>
<div class="qty">${sold ? "" : `<button type="button" class="step" data-op="-1" aria-label="fewer">−</button><output>0</output><button type="button" class="step" data-op="1" aria-label="more">+</button>`}</div>
</li>`;
    })
    .join("");
  return layout(
    e.name,
    `<article class="card event">
<div class="hero-tile"><span class="big">${esc(e.emoji)}</span></div>
<p class="kicker">🎟️ live event</p>
<h1>${esc(e.name)}</h1>
<p class="when">📅 ${esc(e.when)} · 📍 ${esc(e.venue)}</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/buy" id="buy" class="stack">
<ul class="tiers">${tiers}</ul>
<input type="text" name="buyer" maxlength="40" placeholder="Name on the tickets" aria-label="name" required autocomplete="name">
<button class="cta" id="go" disabled>🎟️ Buy · <span id="total">${esc(formatFiat(0, e.currency))}</span></button>
</form>
${chips(gate.cfg.options)}
<p class="small">👛 no account · pay from your own wallet · 📱 ticket in your phone</p>
</article>`,
    { script: "/buy.js", mock },
  );
}

const STATUS: Record<string, [string, string]> = {
  open: ["⏳", "waiting for your payment"],
  seen: ["👀", "payment on its way"],
  review: ["⚠️", "a different amount arrived · the organizer is checking"],
  accepted: ["👍", "accepted · waiting for confirmation"],
  paid: ["✅", "paid · your tickets"],
  declined: ["↩️", "declined · seats back on sale"],
  unresolved: ["🚩", "the organizer is reviewing this payment"],
  expired: ["⌛", "this pay link expired"],
  flagged: ["🚩", "the organizer is reviewing this payment"],
  failed: ["😵", "could not create a pay link"],
};

export function orderPage(e: Event, o: Order, opts: { base: string; qr: string | null; mock: boolean; payHref: string | null }): string {
  const [icon, text] = STATUS[o.status] ?? ["•", o.status];
  const lines = o.items.map((i) => `${i.qty}× ${esc(i.emoji)} ${esc(i.name)} · ${esc(formatFiat(i.price * i.qty, o.currency))}`).join("<br>");
  const head = `<p class="kicker">${esc(e.emoji)} ${esc(e.name)}</p><h1>${esc(formatFiat(o.total, o.currency))}</h1>
<p class="small">${lines}<br>👤 ${esc(o.buyer)}</p>
<p class="pill s-${esc(o.status)}" data-status="${esc(o.status)}" id="status">${icon} ${esc(text)}</p>`;
  let body: string;
  if (o.status === "paid" && o.ticketIds.length) {
    body = `<a class="cta" href="${esc(opts.base)}/tickets">📱 Show tickets</a>
<p class="small">🔖 bookmark this page · your tickets live here</p>`;
  } else if (["open", "seen", "review", "accepted"].includes(o.status) && opts.payHref) {
    body = `${opts.qr ? `<img class="qr" src="${opts.qr}" alt="QR code of the pay link" width="220" height="220">` : ""}
<a class="cta" href="${esc(opts.payHref)}" target="_blank" rel="noopener noreferrer">💳 Pay ${esc(formatFiat(o.total, o.currency))}</a>
${chips(o.options)}
<p class="small">🔖 keep this page open: tickets unlock by themselves once the payment confirms</p>`;
  } else if (["flagged", "unresolved"].includes(o.status)) {
    body = `<p class="small">🔍 Something about this payment did not match the order. The organizer checks it by hand. No tickets until then.</p>`;
  } else {
    body = `<a class="cta ghost" href="/">🔁 Start again</a>`;
  }
  return layout(`${e.name} · order`, `<article class="card" data-order>${head}${body}</article>`, { script: "/order.js", mock: opts.mock });
}

export function ticketsPage(e: Event, o: Order, tickets: { ticket: Ticket; code: string; qr: string }[], mock: boolean): string {
  const cards = tickets
    .map(
      ({ ticket: t, code, qr }) => `<li class="ticket ${t.status}">
<img class="tqr" src="${qr}" alt="Ticket QR" width="200" height="200">
<p class="em">${esc(t.emoji)} <b>${esc(t.tierName)}</b></p>
<p class="small">${esc(e.name)} · ${esc(e.when)}</p>
<p class="small">📍 ${esc(e.venue)}</p>
<p class="code"><code>${esc(code)}</code></p>
${t.status === "used" ? `<p class="pill s-used">✅ admitted ${esc(t.usedAt?.slice(11, 16) ?? "")} UTC</p>` : t.status === "void" ? `<p class="pill s-flagged">↩️ void</p>` : `<p class="pill s-paid">✅ valid · show at the door</p>`}
</li>`,
    )
    .join("");
  return layout(
    `tickets · ${e.name}`,
    `<article class="card"><p class="kicker">📱 your tickets</p><h1>${esc(e.name)}</h1>
<p class="small">👤 ${esc(o.buyer)} · ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}</p>
<ul class="tlist">${cards}</ul>
<p class="small">💡 screenshot or bookmark · one QR per person at the door</p></article>`,
    { mock },
  );
}

export function scanPage(e: Event, mock: boolean, staff: string): string {
  return layout(
    `scan · ${e.name}`,
    `<article class="card scan">
<p class="kicker">🚪 door</p>
<h1>${esc(e.name)}</h1>
<p class="small">📅 ${esc(e.when)} · 📍 ${esc(e.venue)}</p>
<div id="result" class="result idle" aria-live="polite"><p class="huge">📷</p><p>point at a ticket QR</p></div>
<video id="cam" playsinline muted></video>
<form id="paste" class="stack"${mock ? "" : " hidden"}><input name="code" placeholder="paste a ticket code" aria-label="ticket code" autocomplete="off"><button class="cta ghost">✔️ Check code</button></form>
<p class="small" id="hint">📷 starting camera…</p>
<p class="small">🚪 ${esc(staff)} · <a href="/scan/logout">log out</a></p>
</article>`,
    { script: "/scan.js", mock },
  );
}

export function staffLogin(kind: "organizer" | "scan", mock: boolean, error?: string): string {
  const path = kind === "organizer" ? "/organizer/login" : "/scan/login";
  return layout(kind, `<article class="card center"><p class="huge">${kind === "organizer" ? "🔐" : "🚪"}</p><h1>${kind === "organizer" ? "Organizer" : "Door staff"}</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="${path}" class="stack"><input type="password" name="token" placeholder="${kind === "organizer" ? "ORGANIZER_TOKEN" : "STAFF_TOKEN"}" aria-label="token" autocomplete="current-password" required>${kind === "scan" ? `<input name="gate" maxlength="20" placeholder="gate name, e.g. door A" aria-label="gate name">` : ""}<button class="cta">Open</button></form></article>`, { mock });
}

const ICON: Record<string, string> = { open: "💳", seen: "👀", review: "⚠️", accepted: "👍", paid: "✅", declined: "↩️", unresolved: "🚩", expired: "⌛", flagged: "🚩", failed: "😵" };

export function organizerPage(gate: Gate, mock: boolean): string {
  const e = gate.event;
  const orders = [...gate.store.orders()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const tickets = gate.store.tickets();
  const paid = orders.filter((o) => o.status === "paid");
  const revenue = paid.reduce((n, o) => n + Math.round(o.total * 100), 0) / 100;
  const admitted = tickets.filter((t) => t.status === "used").length;
  const valid = tickets.filter((t) => t.status === "valid").length;
  const review = orders.filter((o) => ["flagged", "unresolved", "review"].includes(o.status));
  const coin = (o: Order) => (o.paid ? (coinFor(o.paid.currency, o.paid.network)?.label ?? `${o.paid.currency} · ${o.paid.network}`) : "");
  return layout(
    "organizer",
    `<header class="hero left"><p class="kicker">🔐 organizer</p><h1>${esc(e.emoji)} ${esc(e.name)}</h1>
<p class="small">📅 ${esc(e.when)} · 📍 ${esc(e.venue)}</p></header>
<ul class="stats"><li><b>${esc(formatFiat(revenue, e.currency))}</b><span>💰 paid</span></li><li><b>${tickets.length}</b><span>🎟️ tickets</span></li><li><b data-stat="admitted">${admitted}</b><span>✅ in</span></li><li><b data-stat="valid">${valid}</b><span>📱 still out</span></li><li class="${review.length ? "warn" : ""}"><b>${review.length}</b><span>🚩 to review</span></li></ul>
<p class="small"><a class="cta ghost" href="/scan">🚪 open the scanner</a></p>
<h2>🎚️ Tiers</h2>
<ul class="list">${e.tiers.map((t) => { const sold = t.capacity - gate.available(t.id); return `<li class="row"><span class="ic">${esc(t.emoji)}</span><div><b>${esc(t.name)}</b><span class="small"> · ${esc(formatFiat(t.price, e.currency))} · ${sold}/${t.capacity} sold</span></div></li>`; }).join("")}</ul>
${review.length ? `<h2>🚩 Review</h2><ul class="list">${review.map((o) => `<li class="row flag"><div><b>${ICON[o.status]} ${esc(formatFiat(o.total, o.currency))}</b> · <code>${esc(o.orderId)}</code> · ${esc(o.buyer)}<ul class="problems">${(o.problems ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>${["flagged", "unresolved"].includes(o.status) ? `<form method="post" action="/organizer/grant/${esc(o.id)}"><button class="mini-btn">🔓 grant</button></form>` : `<span class="small">decide on send21</span>`}</li>`).join("")}</ul>` : ""}
<h2>🧾 Orders</h2>
<ul class="list">${orders.slice(0, 40).map((o) => `<li class="row"><span class="ic">${ICON[o.status] ?? "•"}</span><div><b>${esc(formatFiat(o.total, o.currency))}</b><span class="small"> · ${esc(o.buyer)}${o.paid ? ` · ${esc(coin(o))}` : ""} · ${o.status}${o.ticketIds.length ? ` · 🎟️ ${o.ticketIds.length}` : ""}</span></div><time>${esc(o.createdAt.slice(11, 16))} UTC</time></li>`).join("") || '<li class="row small">no orders yet</li>'}</ul>
<h2>✅ Recent check-ins</h2>
<ul class="list">${tickets.filter((t) => t.status === "used").sort((a, b) => (b.usedAt ?? "").localeCompare(a.usedAt ?? "")).slice(0, 20).map((t) => `<li class="row"><span class="ic">${esc(t.emoji)}</span><div><b>${esc(t.tierName)}</b><span class="small"> · ${esc(t.usedBy ?? "staff")}</span></div><time>${esc((t.usedAt ?? "").slice(11, 16))} UTC</time></li>`).join("") || '<li class="row small">nobody in yet</li>'}</ul>`,
    { mock, script: "/organizer.js" },
  );
}

export function mockPayPage(entry: { fiatAmount: number; fiatCurrency: string; memo: string; options: PayOption[] }, token: string): string {
  const t = esc(token);
  const coins = entry.options.map((o, i) => `<option value="${i}">${esc(`${o.currency.toUpperCase()} · ${o.method ?? o.network}`)}</option>`).join("");
  const actions = [["seen", "👀 start paying"], ["paid", "✅ pay"], ["short", "⚠️ pay 5% short"], ["wrong", "🚩 pay a wrong coin"], ["expire", "⌛ let it expire"]];
  return layout(
    "mock pay · send21",
    `<article class="card center"><p class="pill">🧪 mock send21 · no real money</p><p class="price">${esc(formatFiat(entry.fiatAmount, entry.fiatCurrency))}</p><p class="small">${esc(entry.memo)}</p>
${actions.map(([a, l]) => `<form class="mockrow" method="post" action="/mock/pay/${t}/${a}"><select name="coin" aria-label="coin">${coins}</select><button>${l}</button></form>`).join("")}
<p class="small">↩️ then go back to the order tab</p></article>`,
    { mock: true },
  );
}

export function errorPage(msg: string, mock: boolean): string {
  return layout("oops", `<article class="card center"><p class="huge">😵</p><p>${esc(msg)}</p><a class="cta ghost" href="/">↩️ back</a></article>`, { mock });
}
