// Wird nur von test/haenger.test.js als eigener Prozess gestartet (kein *.test.js, läuft nicht in npm test mit).
// Nachstellung des Integrationstest-Musters: Server läuft, Client hält eine Keep-alive-Verbindung, dann schlägt eine
// Assertion fehl. HAENGER_FALL=neu: Aufräumen über serve(t, …); HAENGER_FALL=alt: Schließen erst am Testende (bisher).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { paywall } from "../../src/index.js";
import { serve } from "../../integration/serve.js";

const mw = paywall({ price: { usdc: "0.01" }, x402: { payTo: "0x0000000000000000000000000000000000000001", network: "base-sepolia" } });
const agent = new http.Agent({ keepAlive: true });
const get = (url) => new Promise((ok, fail) => http.get(url, { agent }, (r) => { r.resume(); r.on("end", () => ok(r.statusCode)); }).on("error", fail));

test("absichtlich fehlschlagende Assertion bei offenem Server", async (t) => {
  if (process.env.HAENGER_FALL === "alt") {
    const app = express();
    app.get("/api/bericht", mw, (req, res) => res.json({}));
    const server = await new Promise((r) => { const sv = app.listen(0, "127.0.0.1", () => r(sv)); });
    const status = await get(`http://127.0.0.1:${server.address().port}/api/bericht`);
    assert.equal(status, 200, "absichtlicher Fehlschlag");
    await new Promise((r) => server.close(r)); // wird nie erreicht
  } else {
    t.after(() => agent.destroy());
    const app = await serve(t, mw);
    const status = await get(`${app.base}/api/bericht`);
    assert.equal(status, 200, "absichtlicher Fehlschlag");
  }
});
