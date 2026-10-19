(() => {
  const result = document.getElementById("result");
  const video = document.getElementById("cam");
  const hint = document.getElementById("hint");
  const paste = document.getElementById("paste");
  if (!result) return;
  let busy = false;
  let last = "";
  let lastAt = 0;

  const show = (j) => {
    const map = {
      admitted: ["✅", "admitted", "ok"],
      used: ["⛔", "already used", "bad"],
      void: ["↩️", "void", "bad"],
      forged: ["🚩", "forged / bad QR", "bad"],
      wrong_event: ["🔀", "wrong event", "bad"],
      unknown: ["🤷", "unknown ticket", "bad"],
      auth: ["🔐", "log in again", "bad"],
    };
    const [icon, label, cls] = map[j.result] || ["·", j.result, "idle"];
    const tier = j.ticket ? `${j.ticket.emoji} ${j.ticket.tier}` : "";
    const when = j.result === "used" && j.ticket?.usedAt ? ` · ${j.ticket.usedAt.slice(11, 16)} UTC` : "";
    result.className = `result ${cls}`;
    result.innerHTML = `<p class="huge">${icon}</p><p><b>${label}</b></p>${tier ? `<p>${tier}${when}</p>` : ""}${j.detail && j.result !== "used" ? `<p class="small">${j.detail}</p>` : ""}`;
  };

  const check = async (code) => {
    if (!code || busy) return;
    if (code === last && Date.now() - lastAt < 2500) return;
    busy = true;
    last = code;
    lastAt = Date.now();
    try {
      const r = await fetch("/scan/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      show(await r.json());
    } catch {
      show({ result: "unknown", detail: "network" });
    } finally {
      setTimeout(() => {
        busy = false;
      }, 900);
    }
  };

  if (paste) {
    paste.hidden = false;
    paste.onsubmit = (e) => {
      e.preventDefault();
      const input = paste.querySelector("input");
      check(input.value.trim());
      input.value = "";
    };
  }

  // BarcodeDetector when available (Chrome/Android). Fallback: paste form.
  (async () => {
    if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) {
      if (hint) hint.textContent = "📷 camera QR not available here · paste the ticket code";
      if (paste) paste.hidden = false;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } } });
      video.srcObject = stream;
      await video.play();
      if (hint) hint.textContent = "📷 point at a ticket QR";
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const loop = async () => {
        if (video.readyState >= 2 && !busy) {
          try {
            const codes = await detector.detect(video);
            if (codes[0]?.rawValue) await check(codes[0].rawValue);
          } catch {
            /* frame miss */
          }
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch {
      if (hint) hint.textContent = "📷 camera blocked · paste the ticket code";
      if (paste) paste.hidden = false;
    }
  })();
})();
