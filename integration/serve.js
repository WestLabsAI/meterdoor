// Testserver und Zeitgrenzen für Integrationstests (und ihre lokale Nachstellung in test/haenger.test.js).
//
// Ursache des dokumentierten Hängers (25.10.): Die Tests schlossen den Server erst in ihrer letzten Zeile. Schlug vorher
// eine Assertion fehl, blieb der Server samt Keep-alive-Verbindung offen und der Testprozess endete nicht.
// Darum: serve(t, …) meldet das Schließen beim Testkontext an (t.after läuft auch nach einem Fehlschlag), und jeder
// Aufruf nach außen bekommt eine feste Zeitgrenze.
import express from "express";

export const AUSSEN_MS = 30000; // Zeitgrenze je Aufruf an eine echte Gegenstelle

// Startet eine App mit `mw` vor `handler` auf einem freien Port; schließt sie nach dem Test, auch bei Fehlschlag.
export async function serve(t, mw, handler = (req, res) => res.json({ daten: "Testbericht", bezahltMit: req.payment?.method })) {
  const app = express();
  app.get("/api/bericht", mw, handler);
  const server = await new Promise((ok, fail) => { const sv = app.listen(0, "127.0.0.1", () => ok(sv)); sv.once("error", fail); });
  let closed;
  const close = () => (closed ??= new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }));
  t.after(close);
  return { base: `http://127.0.0.1:${server.address().port}`, close };
}

// fetch mit fester Zeitgrenze (zusätzlich zu einem vorhandenen Signal).
export function timed(fetchImpl = globalThis.fetch, ms = AUSSEN_MS) {
  return (input, init = {}) => {
    const limit = AbortSignal.timeout(ms);
    return fetchImpl(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit });
  };
}
