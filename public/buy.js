(() => {
  const form = document.getElementById("buy");
  if (!form) return;
  const total = document.getElementById("total");
  const go = document.getElementById("go");
  const currency = (total.textContent || "€0.00").replace(/[\d.,\s]/g, "") || "€";
  const fmt = (n) => `${currency}${n.toFixed(2)}`;
  const sync = () => {
    let sum = 0;
    let n = 0;
    for (const row of form.querySelectorAll(".tier:not(.sold)")) {
      const out = row.querySelector("output");
      const qty = Number(out.textContent) || 0;
      const left = Number(row.dataset.left);
      const price = Number(row.dataset.price);
      sum += qty * price;
      n += qty;
      let input = form.querySelector(`input[name="qty_${row.dataset.tier}"]`);
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden";
        input.name = `qty_${row.dataset.tier}`;
        form.append(input);
      }
      input.value = String(qty);
      row.querySelector('[data-op="-1"]').disabled = qty <= 0;
      row.querySelector('[data-op="1"]').disabled = qty >= left;
    }
    total.textContent = fmt(sum);
    go.disabled = n === 0;
  };
  form.addEventListener("click", (e) => {
    const btn = e.target.closest(".step");
    if (!btn) return;
    const row = btn.closest(".tier");
    const out = row.querySelector("output");
    const left = Number(row.dataset.left);
    const next = Math.max(0, Math.min(left, (Number(out.textContent) || 0) + Number(btn.dataset.op)));
    out.textContent = String(next);
    sync();
  });
  sync();
})();
