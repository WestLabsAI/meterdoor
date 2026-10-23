// Startet genau den Code aus dem Codeblock der Website (site/index.html) und prüft die 402-Antwort.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ausSeite } from "../werkzeuge/site-beispiel.js";

const kern = path.resolve(import.meta.dirname, "..");
const seite = path.resolve(kern, "../../site/index.html");

test("Website-Codeblock = beispiel/schnellstart.js", { skip: !fs.existsSync(seite) && "site/ fehlt" }, () => {
  // Zeilenenden ignorieren: Git checkt unter Windows mit CRLF aus.
  const lf = (t) => t.replace(/\r\n/g, "\n");
  assert.equal(lf(ausSeite(fs.readFileSync(seite, "utf8"))), lf(fs.readFileSync(path.join(kern, "beispiel/schnellstart.js"), "utf8")));
});

test("Website-Codeblock startet und antwortet mit 402 (Testnetz, Checkout-Link)", { skip: !fs.existsSync(seite) && "site/ fehlt" }, async () => {
  // Liegt im Paket, damit `import "meterdoor"` (Selbstbezug) und express aufgelöst werden.
  const datei = path.join(kern, "test", ".website-beispiel.tmp.js");
  fs.writeFileSync(datei, ausSeite(fs.readFileSync(seite, "utf8")));
  const port = String(40000 + Math.floor(Math.random() * 20000));
  const kind = spawn(process.execPath, [datei], {
    env: { ...process.env, PORT: port, STRIPE_KEY: "sk_test_dummy", WALLET: "0x0000000000000000000000000000000000000001", ACCESS_SECRET: "test" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let fehler = "";
  kind.stderr.on("data", (d) => { fehler += d; });
  try {
    let r;
    for (let i = 0; i < 50 && !r; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      r = await fetch(`http://127.0.0.1:${port}/api/bericht`, { headers: { accept: "application/json" } }).catch(() => null);
      if (kind.exitCode !== null) break;
    }
    assert.ok(r, `Beispiel startet nicht: ${fehler}`);
    assert.equal(r.status, 402);
    const body = await r.json();
    assert.equal(body.accepts[0].network, "base-sepolia");
    assert.equal(body.accepts[0].maxAmountRequired, "10000");
    assert.match(body.checkout, /\/api\/bericht\?pw_checkout=1$/);
  } finally {
    kind.kill();
    fs.rmSync(datei, { force: true });
  }
});
