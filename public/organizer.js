(() => {
  const a = document.querySelector('[data-stat="admitted"]');
  const v = document.querySelector('[data-stat="valid"]');
  if (!a || !v) return;
  setInterval(async () => {
    try {
      const r = await fetch("/organizer/stats", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      a.textContent = String(j.admitted);
      v.textContent = String(j.valid);
    } catch {
      /* offline */
    }
  }, 3000);
})();
