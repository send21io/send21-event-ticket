import { buildGate } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app, sweep } = buildGate(cfg);

app.listen(cfg.port, cfg.mock ? "127.0.0.1" : "0.0.0.0", () => {
  console.log(`🎟️ ${cfg.event.name} ${cfg.publicUrl}/  ·  🪝 /webhooks/send21`);
  console.log(`🔐 organizer ${cfg.publicUrl}/organizer  ·  🚪 door ${cfg.publicUrl}/scan`);
  if (cfg.mock) {
    console.log("🧪 MOCK send21: no send21 calls, pay links open a local simulator.");
    console.log(`🧪 one-click: ${cfg.publicUrl}/organizer/demo  ·  ${cfg.publicUrl}/scan/demo`);
  }
  setInterval(sweep, 60_000).unref();
  sweep();
});
