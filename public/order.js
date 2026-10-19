(() => {
  const el = document.getElementById("status");
  if (!el) return;
  const now = el.dataset.status;
  if (["paid", "declined", "expired", "flagged", "failed"].includes(now)) return;
  const url = location.pathname.replace(/\/$/, "") + "/status";
  setInterval(async () => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok && (await r.json()).status !== now) location.reload();
    } catch {
      /* offline */
    }
  }, 2500);
})();
