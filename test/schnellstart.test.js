// Startet beispiel/schnellstart.js (derselbe Code wie im Schnellstart der README) und prüft Start, 402, Zahlungsanforderung
// und Checkout-Link. Läuft in jedem Checkout des Kerns, ohne Website-Dateien, ohne Schlüssel und ohne Netz:
// Stripe wird nur mit einem Platzhalter-Schlüssel konfiguriert und nie aufgerufen (der Test folgt dem Checkout-Link nicht).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const kern = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Schnellstart startet und antwortet mit 402, Zahlungsanforderung (x402 v1, Testnetz) und Checkout-Link", async () => {
  const port = String(40000 + Math.floor(Math.random() * 20000));
  const kind = spawn(process.execPath, [path.join(kern, "beispiel/schnellstart.js")], {
    cwd: kern,
    env: { ...process.env, PORT: port, STRIPE_KEY: "sk_test_dummy", WALLET: "0x0000000000000000000000000000000000000001", ACCESS_SECRET: "test-geheimnis" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let fehler = "";
  kind.stderr.on("data", (d) => { fehler += d; });
  try {
    let r;
    for (let i = 0; i < 50 && !r; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      if (kind.exitCode !== null) break;
      r = await fetch(`http://127.0.0.1:${port}/api/bericht`, { headers: { accept: "application/json" } }).catch(() => null);
    }
    assert.ok(r, `Schnellstart startet nicht: ${fehler}`);
    assert.equal(r.status, 402);
    const body = await r.json();
    assert.equal(body.x402Version, 1);
    assert.equal(body.accepts.length, 1);
    assert.deepEqual([body.accepts[0].scheme, body.accepts[0].network, body.accepts[0].maxAmountRequired],
      ["exact", "base-sepolia", "10000"]);
    assert.equal(body.accepts[0].payTo, "0x0000000000000000000000000000000000000001");
    assert.equal(body.checkout, `http://127.0.0.1:${port}/api/bericht?pw_checkout=1`);
  } finally {
    kind.kill();
    await new Promise((ok) => (kind.exitCode !== null || kind.signalCode ? ok() : kind.once("exit", ok)));
  }
});
