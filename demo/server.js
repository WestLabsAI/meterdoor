// Demo ohne Schlüssel: ein Endpunkt, zwei Bezahlwege – alles simuliert (Stripe, Facilitator, RPC).
// Start: npm run demo   (lauscht nur auf 127.0.0.1, endet nach MAX_MS, Standard 10 Minuten)
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import express from "express";
import { paywall } from "../src/index.js";
import {
  simulation, simulierterNachweis, pruefeUmgebung, nonceVon, entschluessle,
  STRIPE_DUMMY_KEY, PAY_TO, NETWORK, FACILITATOR_URL, RPC_URL,
} from "./simulation.js";

const HOST = "127.0.0.1";
const PFAD = "/api/bericht";

export class UnsichereUmgebung extends Error {
  constructor(funde) {
    super("Demo startet nicht: echte Zugangsdaten in der Umgebung gefunden.\n"
      + funde.map((f) => `  - ${f}`).join("\n")
      + "\nDie Demo braucht keine Schlüssel. Bitte diese Variablen entfernen (oder eine frische Shell öffnen) und erneut starten.");
    this.code = "UNSICHERE_UMGEBUNG";
    this.funde = funde;
  }
}

export async function startDemo({ port = 8402, maxMs = 600000, env = process.env, log = console.log } = {}) {
  const funde = pruefeUmgebung(env);
  if (funde.length) throw new UnsichereUmgebung(funde);

  let basis = "";
  const sim = simulation({ basis: () => basis });
  const ereignisse = [];
  const zaehler = { route: 0 };
  let letzterNachweis = null;

  const pw = paywall({
    price: { eur: "0.50", usdc: "0.01" },
    stripe: { key: STRIPE_DUMMY_KEY, metadata: { demo: "simulation" } },
    x402: { payTo: PAY_TO, network: NETWORK, facilitatorUrl: FACILITATOR_URL, rpcUrl: RPC_URL, timeoutMs: 1500 },
    access: { secret: crypto.randomBytes(32).toString("hex"), ttlSeconds: 3600 },
    description: "Demobericht (Simulation)",
    fetch: sim.fetch,
    onEvent: (e) => { ereignisse.push(e); if (ereignisse.length > 50) ereignisse.shift(); },
  });

  const app = express();
  app.disable("x-powered-by");

  // Jede Antwort: Kopfzeile X-Meterdoor-Simulation: 1, jedes JSON-Objekt: simulation: true.
  // Die Kopfzeile wird beim Schreiben gesetzt, damit sie auch Antworten übersteht, deren Kopfzeilen die Middleware neu setzt.
  app.use((req, res, next) => {
    res.setHeader("X-Meterdoor-Simulation", "1");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'");
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!res.headersSent) res.setHeader("X-Meterdoor-Simulation", "1");
      return writeHead.apply(res, args);
    };
    const json = res.json;
    res.json = function (body) {
      const b = body && typeof body === "object" && !Array.isArray(body) ? { simulation: true, ...body } : body;
      return json.call(res, b);
    };
    next();
  });

  app.get("/", (req, res) => res.type("html").send(startseite()));
  app.get("/demo/app.js", (req, res) => res.type("js").send(CLIENT_JS));
  app.get("/demo/stil.css", (req, res) => res.type("css").send(CSS));

  app.get(PFAD, pw, (req, res) => {
    zaehler.route++;
    const bericht = {
      simulation: true,
      hinweis: "Simulierte Daten; keine echte Zahlung.",
      bericht: { titel: "Demobericht", werte: [3, 1, 4, 1, 5] },
      aufrufNr: zaehler.route,
      erzeugtUm: new Date().toISOString(),
      bezahltMit: req.payment,
    };
    if (req.accepts(["json", "html"]) === "html" && (req.get("accept") || "").includes("text/html")) {
      return res.type("html").send(seite("Freigeschaltet", `
        <h1>Freigeschaltet (Euro, simuliert)</h1>
        <p id="freigeschaltet">Der simulierte Stripe-Kauf wurde von der Middleware geprüft; das Zugangstoken liegt als Cookie vor.
        Weitere Aufrufe dieses Endpunkts sind eine Stunde lang frei.</p>
        <pre id="bericht">${esc(JSON.stringify(bericht, null, 2))}</pre>
        <p><a href="/">Zurück zur Demo</a></p>`));
    }
    res.json(bericht);
  });

  app.get("/demo/checkout/:id", (req, res) => {
    const s = sim.sessions.get(req.params.id);
    if (!s) return res.status(404).type("html").send(seite("Unbekannt", "<h1>Sitzung unbekannt</h1><p><a href=\"/\">Zurück</a></p>"));
    const betrag = (s.amount_total / 100).toFixed(2).replace(".", ",");
    res.type("html").send(seite("Simulierter Checkout", `
      <h1>Simulierter Checkout</h1>
      <p>Diese Seite ersetzt Stripe Checkout. Es werden <strong>keine Kartendaten</strong> abgefragt und <strong>kein Geld</strong> bewegt.</p>
      <dl>
        <dt>Produkt</dt><dd>${esc(s._produkt)}</dd>
        <dt>Betrag</dt><dd id="betrag">${betrag} € (simuliert)</dd>
        <dt>Sitzung</dt><dd><code>${esc(s.id)}</code></dd>
      </dl>
      <form method="post" action="/demo/checkout/${encodeURIComponent(s.id)}/bezahlen">
        <button type="submit" id="simuliert-bezahlen">Simuliert bezahlen</button>
      </form>
      <p><a href="/">Abbrechen</a></p>`));
  });

  app.post("/demo/checkout/:id/bezahlen", (req, res) => {
    const ziel = sim.bezahle(req.params.id);
    if (!ziel) return res.status(404).json({ error: "Sitzung unbekannt" });
    res.redirect(303, ziel);
  });

  app.post("/demo/zuruecksetzen", (req, res) => {
    res.clearCookie("pw_token", { path: PFAD });
    res.redirect(303, "/");
  });

  // Simulierter Agent: ruft den Endpunkt serverseitig auf (nur 127.0.0.1) und berichtet jeden Schritt.
  async function abrufen(schritt, nachweis) {
    const headers = { accept: "application/json" };
    if (nachweis) headers["x-payment"] = nachweis;
    const r = await fetch(`${basis}${PFAD}`, { headers });
    const text = await r.text();
    let antwort; try { antwort = JSON.parse(text); } catch { antwort = text; }
    const xpr = r.headers.get("x-payment-response");
    return {
      schritt,
      anfrage: `GET ${PFAD}${nachweis ? " mit X-PAYMENT" : ""}`,
      status: r.status,
      kopfzeilen: {
        "x-meterdoor-simulation": r.headers.get("x-meterdoor-simulation"),
        ...(xpr ? { "x-payment-response": xpr } : {}),
        ...(r.headers.get("retry-after") ? { "retry-after": r.headers.get("retry-after") } : {}),
      },
      ...(xpr ? { xPaymentResponse: entschluessle(xpr) } : {}),
      antwort,
    };
  }

  async function neuerNachweis(schritte) {
    const erst = await abrufen("Anfrage ohne Zahlung → 402 mit Anforderungen", null);
    schritte.push(erst);
    const anf = erst.antwort?.accepts?.[0];
    if (erst.status !== 402 || !anf) throw new Error("keine x402-Anforderungen erhalten");
    return simulierterNachweis(anf);
  }

  app.post("/demo/agent/:szenario", async (req, res) => {
    const schritte = [];
    const vorher = sim.settlements;
    try {
      const sz = req.params.szenario;
      if (sz === "ohne-zahlung") {
        schritte.push(await abrufen("Anfrage ohne Zahlung", null));
      } else if (sz === "x402") {
        letzterNachweis = await neuerNachweis(schritte);
        schritte.push(await abrufen("Simulierter Agent zahlt (X-PAYMENT)", letzterNachweis));
      } else if (sz === "wiederholung") {
        if (!letzterNachweis) {
          letzterNachweis = await neuerNachweis(schritte);
          schritte.push(await abrufen("Erste Zahlung", letzterNachweis));
        }
        const zwischen = sim.settlements;
        schritte.push(await abrufen("Derselbe Nachweis noch einmal → gespeicherte Antwort", letzterNachweis));
        schritte.at(-1).abrechnungenDabei = sim.settlements - zwischen;
      } else if (sz === "unklar") {
        const n = await neuerNachweis(schritte);
        sim.antwortVerlieren.add(nonceVon(n));
        schritte.push(await abrufen("Zahlung, Settle-Antwort geht verloren → 503, Status unklar", n));
        schritte.push(await abrufen("Derselbe Nachweis erneut → Klärung über RPC (authorizationState)", n));
        letzterNachweis = n;
      } else {
        return res.status(404).json({ error: "unbekanntes Szenario" });
      }
      res.json({ szenario: sz, abrechnungen: sim.settlements - vorher, abrechnungenGesamt: sim.settlements, schritte });
    } catch (err) {
      res.status(500).json({ error: err.message, schritte });
    }
  });

  app.get("/demo/status", (req, res) => res.json({
    abrechnungenGesamt: sim.settlements,
    checkoutSitzungen: sim.sessions.size,
    routenaufrufe: zaehler.route,
    gegenstellenAufrufe: sim.calls.length,
    ereignisse: ereignisse.slice(-15),
  }));

  const server = await new Promise((resolve, reject) => {
    const sv = app.listen(port, HOST, () => resolve(sv));
    sv.once("error", reject);
  });
  basis = `http://${HOST}:${server.address().port}`;
  let geschlossen = null;
  const close = () => (geschlossen ||= new Promise((r) => {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close(() => r());
  }));
  const timer = setTimeout(() => { log("Laufzeitgrenze erreicht, Demo beendet."); close(); }, maxMs);
  timer.unref();
  return { url: basis, close, sim, server };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;font:17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;background:#fff}
.banner{position:sticky;top:0;z-index:1;background:#ffd400;color:#000;border-bottom:4px solid #000;padding:.7rem 1rem;font-weight:700;text-align:center}
main{max-width:52rem;margin:0 auto;padding:1rem 1rem 3rem}
h1{font-size:1.7rem;margin:1.2rem 0 .5rem}h2{font-size:1.2rem;margin:1.6rem 0 .3rem}
section{border-top:2px solid #111;padding-top:.4rem}
button,a.knopf{display:inline-block;font:inherit;font-weight:600;background:#0b3d91;color:#fff;border:2px solid #0b3d91;border-radius:4px;padding:.45rem .9rem;margin:.2rem .4rem .2rem 0;cursor:pointer;text-decoration:none}
button.zweit{background:#fff;color:#0b3d91}
button:focus-visible,a:focus-visible{outline:3px solid #000;outline-offset:2px}
a{color:#0b3d91}
pre{background:#f3f3f3;color:#111;border:1px solid #888;padding:.7rem;overflow:auto;font-size:.85rem;white-space:pre-wrap;word-break:break-all}
code{font-size:.9em}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}dt{font-weight:700}dd{margin:0}
.schritt{margin:.6rem 0}.status{font-weight:700}
small{color:#333}
form.inline{display:inline}
`;

function seite(titel, inhalt) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titel)} – Meterdoor-Demo (Simulation)</title><link rel="stylesheet" href="/demo/stil.css"></head><body>
<div class="banner" id="simulation-banner" role="status">SIMULATION – keine echte Zahlung. Stripe, Facilitator und Blockchain sind nachgebildet; es fließt kein Geld.</div>
<main>${inhalt}</main></body></html>`;
}

function startseite() {
  return seite("Demo", `
  <h1>Meterdoor-Demo: ein Endpunkt, zwei Bezahlwege</h1>
  <p>Der Endpunkt <code>GET ${PFAD}</code> ist mit <code>paywall()</code> geschützt: 0,50 € per Stripe Checkout oder 0,01 USDC per x402
  (${NETWORK}). Alle Gegenstellen laufen simuliert in diesem Prozess; die Middleware selbst ist unverändert.</p>

  <section><h2>1. Zahlung erforderlich</h2>
  <p>Ohne Zahlung antwortet der Endpunkt mit <code>402</code> und nennt beide Wege.</p>
  <button data-szenario="ohne-zahlung" id="knopf-ohne-zahlung">Ohne Zahlung abrufen</button></section>

  <section><h2>2. Euro über Stripe Checkout (simuliert)</h2>
  <p>Der Browser wird zu einem lokalen, simulierten Checkout geleitet. Nach „Simuliert bezahlen“ prüft die Middleware die Sitzung
  und schaltet den Endpunkt per Cookie frei.</p>
  <a class="knopf" href="${PFAD}" id="knopf-euro">Im Browser kaufen</a>
  <form method="post" action="/demo/zuruecksetzen" class="inline"><button class="zweit" type="submit" id="knopf-zuruecksetzen">Euro-Zugang zurücksetzen</button></form></section>

  <section><h2>3. USDC über x402 (simuliert)</h2>
  <p>Ein simulierter Agent liest die Anforderungen aus der 402-Antwort, erzeugt einen Zahlungsnachweis und sendet ihn im Kopf <code>X-PAYMENT</code>.</p>
  <button data-szenario="x402" id="knopf-x402">Simulierten Agenten zahlen lassen</button></section>

  <section><h2>4. Wiederholung</h2>
  <p>Derselbe Nachweis noch einmal: Die Middleware liefert die gespeicherte Antwort, ohne erneut abzurechnen.</p>
  <button data-szenario="wiederholung" id="knopf-wiederholung">Nachweis wiederholen</button></section>

  <section><h2>5. Unklare Abrechnung</h2>
  <p>Die Abrechnung gelingt, aber die Antwort des Facilitators geht verloren. Die Middleware rechnet nicht blind neu ab, sondern
  klärt beim nächsten Versuch mit demselben Nachweis über die Kette (<code>authorizationState</code>), ob schon gezahlt wurde.</p>
  <button data-szenario="unklar" id="knopf-unklar">Unklare Abrechnung durchspielen</button></section>

  <section><h2>Ergebnis</h2>
  <p id="zusammenfassung" aria-live="polite">Noch nichts ausgeführt.</p>
  <div id="ausgabe"></div>
  <p><small id="status"></small></p></section>`).replace("</body>", `<script src="/demo/app.js"></script></body>`);
}

const CLIENT_JS = `
const ausgabe = document.getElementById("ausgabe");
const zusammenfassung = document.getElementById("zusammenfassung");
const statusZeile = document.getElementById("status");
function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
async function status() {
  const s = await (await fetch("/demo/status")).json();
  statusZeile.textContent = "Simulierte Abrechnungen gesamt: " + s.abrechnungenGesamt + " · Checkout-Sitzungen: " + s.checkoutSitzungen + " · Routenaufrufe: " + s.routenaufrufe;
}
for (const b of document.querySelectorAll("button[data-szenario]")) {
  b.addEventListener("click", async () => {
    for (const x of document.querySelectorAll("button")) x.disabled = true;
    zusammenfassung.textContent = "Läuft …";
    ausgabe.replaceChildren();
    try {
      const r = await fetch("/demo/agent/" + b.dataset.szenario, { method: "POST" });
      const d = await r.json();
      for (const s of d.schritte || []) {
        const box = el("div", null, "schritt");
        box.dataset.status = s.status;
        box.append(el("h3", s.schritt));
        box.append(el("p", s.anfrage + " → HTTP " + s.status, "status"));
        box.append(el("pre", JSON.stringify({ kopfzeilen: s.kopfzeilen, xPaymentResponse: s.xPaymentResponse, antwort: s.antwort }, null, 2)));
        ausgabe.append(box);
      }
      const letzt = (d.schritte || []).at(-1);
      zusammenfassung.textContent = d.error ? "Fehler: " + d.error
        : "Szenario " + d.szenario + ": letzte Antwort HTTP " + (letzt ? letzt.status : "–") + ", simulierte Abrechnungen in diesem Szenario: " + d.abrechnungen;
      zusammenfassung.dataset.letzterStatus = letzt ? letzt.status : "";
      zusammenfassung.dataset.abrechnungen = d.abrechnungen;
    } catch (e) {
      zusammenfassung.textContent = "Fehler: " + e.message;
    } finally {
      for (const x of document.querySelectorAll("button")) x.disabled = false;
      status().catch(() => {});
    }
  });
}
status().catch(() => {});
`;

// Direkt gestartet: npm run demo
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = process.env.PORT ? Number(process.env.PORT) : 8402;
    const maxMs = process.env.MAX_MS ? Number(process.env.MAX_MS) : 600000;
    const demo = await startDemo({ port, maxMs });
    console.log(`Meterdoor-Demo (SIMULATION, keine echte Zahlung) auf ${demo.url}/`);
    console.log(`Endet nach ${Math.round(maxMs / 1000)} s oder mit Strg+C.`);
    const ende = () => demo.close().then(() => process.exit(0));
    process.once("SIGINT", ende);
    process.once("SIGTERM", ende);
  } catch (err) {
    console.error(err.message);
    process.exit(err.code === "UNSICHERE_UMGEBUNG" ? 2 : 1);
  }
}
