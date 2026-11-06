// Integrationstests gegen Hänger absichern (Auftrag 25.10., Punkt 5). Nur lokale Simulationen, kein Netz, keine Zahlungen.
// Dokumentierter Fehler: erster Integrationslauf am 25.10. – ein Test schlug fehl, danach hing der Prozess.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { paywall } from "../src/index.js";
import { serve, timed } from "../integration/serve.js";
import { payment, json } from "./hilfen.js";

const KERN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join("test", "fixtures", "haenger.fixture.js");

// Startet die Nachstellung als eigenen Testprozess; beendet ihn spätestens nach limitMs (und immer im finally).
async function runFixture(fall, limitMs) {
  const { NODE_TEST_CONTEXT, ...env } = process.env; // sonst hält sich der Kindprozess für einen Teil dieses Laufs
  const child = spawn(process.execPath, ["--test", FIXTURE], { cwd: KERN, env: { ...env, HAENGER_FALL: fall }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const t0 = Date.now();
  try {
    const code = await new Promise((ok) => {
      const timer = setTimeout(() => ok("haengt"), limitMs);
      child.once("exit", (c) => { clearTimeout(timer); ok(c); });
    });
    return { code, ms: Date.now() - t0, out, pid: child.pid };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((ok) => child.once("exit", ok));
    }
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Gegenstelle, die Verbindungen annimmt und nie antwortet.
async function silentServer(t) {
  const sockets = new Set();
  const srv = net.createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise((ok) => { for (const s of sockets) s.destroy(); srv.close(() => ok()); }));
  return `http://127.0.0.1:${srv.address().port}`;
}

describe("Hänger nach Fehlschlag", () => {
  test("absichtlich fehlschlagende Assertion beendet den Testprozess mit Fehlerstatus in fester Zeit", async () => {
    const r = await runFixture("neu", 10000);
    assert.notEqual(r.code, "haengt", `Prozess hing länger als 10 s:\n${r.out}`);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /absichtlicher Fehlschlag/);
    assert.ok(r.ms < 10000);
    assert.equal(alive(r.pid), false, "kein zurückbleibender Prozess");
  });

  test("Gegenprobe: das bisherige Muster (Schließen erst am Testende) hängt – Ursache nachgestellt", async () => {
    const r = await runFixture("alt", 3000);
    assert.equal(r.code, "haengt", "ohne Aufräumen endet der Prozess nicht von selbst");
    assert.equal(alive(r.pid), false, "nach Abbruch beendet");
  });
});

describe("nicht antwortende Gegenstelle", () => {
  test("Facilitator nimmt die Verbindung an und antwortet nie: begrenzter Fehler 503, kein Hänger", async (t) => {
    const facilitatorUrl = await silentServer(t);
    const app = await serve(t, paywall({ price: { usdc: "0.50" },
      x402: { payTo: "0x0000000000000000000000000000000000000001", network: "base-sepolia", facilitatorUrl, timeoutMs: 300 } }));
    const t0 = Date.now();
    const r = await timed(fetch, 5000)(`${app.base}/api/bericht`, { headers: { ...json, "x-payment": payment() } });
    assert.equal(r.status, 503);
    assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
    assert.doesNotMatch(await r.text(), /at .*\.js/, "kein Stack-Trace");
  });

  test("timed(): Aufruf an eine stumme Gegenstelle bricht nach der Zeitgrenze ab", async (t) => {
    const url = await silentServer(t);
    const t0 = Date.now();
    await assert.rejects(timed(fetch, 300)(url), (e) => e.name === "TimeoutError" || e.cause?.name === "TimeoutError");
    assert.ok(Date.now() - t0 < 2000);
    const outer = new AbortController();
    setTimeout(() => outer.abort(new Error("vom Aufrufer abgebrochen")), 50);
    await assert.rejects(timed(fetch, 5000)(url, { signal: outer.signal }), /vom Aufrufer abgebrochen/, "vorhandenes Signal bleibt wirksam");
  });

  test("serve(): Server ist nach dem Test geschlossen, auch wenn der Test fehlschlägt", async (t) => {
    let base;
    await t.test("innerer Test schlägt fehl", { expectFailure: true }, async (tt) => {
      base = (await serve(tt, paywall({ price: { usdc: "0.50" }, x402: { payTo: "0x0000000000000000000000000000000000000001", network: "base-sepolia" } }))).base;
      assert.equal((await fetch(`${base}/api/bericht`)).status, 200);
    });
    await assert.rejects(timed(fetch, 2000)(`${base}/api/bericht`), "Port nimmt keine Verbindungen mehr an");
  });
});
