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
        <div class="ergebnis-karte" data-art="bezahlt">
          <p class="art">Zahlung (Euro, simuliert)</p>
          <p id="freigeschaltet"><strong>Der Bericht ist für Sie freigeschaltet.</strong> Der simulierte Stripe-Kauf über 0,50 € wurde von der
          Middleware geprüft; das Zugangstoken liegt als Cookie vor. Weitere Aufrufe dieses Endpunkts sind ab der Zahlung eine Stunde lang
          frei, ohne neue Zahlung.</p>
          <dl class="zahlen"><dt>HTTP-Status</dt><dd>200 OK</dd><dt>Bezahlweg</dt><dd>${esc(req.payment?.method || "–")}</dd></dl>
          <p class="naechste"><a class="knopf" href="${PFAD}">Endpunkt noch einmal abrufen (ohne neue Zahlung)</a>
          <a class="knopf zweit" href="/#szenario-x402">Zurück zur Demo: x402 ausprobieren</a></p>
        </div>
        <details class="json"><summary>Vollständige Antwort als JSON</summary>
        <pre id="bericht">${esc(JSON.stringify(bericht, null, 2))}</pre></details>`));
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
button.zweit,a.knopf.zweit{background:#fff;color:#0b3d91}
button:focus-visible,a:focus-visible{outline:3px solid #000;outline-offset:2px}
a{color:#0b3d91}
pre{background:#f3f3f3;color:#111;border:1px solid #888;padding:.7rem;overflow:auto;font-size:.85rem;white-space:pre-wrap;word-break:break-all}
code{font-size:.9em}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}dt{font-weight:700}dd{margin:0}
.schritt{margin:.6rem 0}.status{font-weight:700}
small{color:#333}
form.inline{display:inline}
button:disabled{opacity:.6;cursor:progress}
#ergebnis{scroll-margin-top:7.5rem}
#ergebnis-h:focus{outline:3px solid #000;outline-offset:2px}
#zusammenfassung{font-weight:600}
.ergebnis-karte{border:3px solid #111;border-radius:6px;padding:.8rem 1rem;margin:.8rem 0;background:#fff}
.ergebnis-karte h3{margin:.1rem 0 .4rem;font-size:1.25rem}
.ergebnis-karte .art{display:inline-block;margin:0;padding:.1rem .55rem;border-radius:999px;font-size:.85rem;font-weight:700;background:#111;color:#fff}
.ergebnis-karte[data-art="bezahlt"]{border-color:#1d6b3a}.ergebnis-karte[data-art="bezahlt"] .art{background:#1d6b3a}
.ergebnis-karte[data-art="wiederholung"]{border-color:#0b3d91}.ergebnis-karte[data-art="wiederholung"] .art{background:#0b3d91}
.ergebnis-karte[data-art="unklar"]{border-color:#8a4b00;border-style:dashed}.ergebnis-karte[data-art="unklar"] .art{background:#8a4b00}
.ergebnis-karte[data-art="fehler"]{border-color:#b42318;background:#fff4f2}.ergebnis-karte[data-art="fehler"] .art{background:#b42318}
.ergebnis-karte[data-art="laeuft"]{border-style:dotted}
.zahlen{margin:.6rem 0;grid-template-columns:fit-content(60%) minmax(0,1fr)}.zahlen dt,.zahlen dd{overflow-wrap:anywhere}.naechste{margin:.6rem 0 0}
details.json,.schritt details{margin:.3rem 0 .6rem}
details summary{cursor:pointer;font-weight:600;padding:.6rem 0;color:#0b3d91;text-decoration:underline;text-underline-offset:.15em}
details summary:focus-visible{outline:3px solid #000;outline-offset:2px}
.schritt h4{margin:.4rem 0 .1rem;font-size:1rem}
.beispielpreise{border-left:4px solid #0b3d91;background:#eef3fc;padding:.6rem .9rem}
.beispielpreise p{margin:.2rem 0}
@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto!important;transition:none!important}}
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
  <p>Der Endpunkt <code>GET ${PFAD}</code> ist mit <code>paywall()</code> geschützt. Alle Gegenstellen (Stripe, Facilitator, Blockchain)
  laufen simuliert in diesem Prozess auf Ihrem Rechner; die Middleware selbst ist unverändert. Es gibt keine Konten, keine Schlüssel
  und keine echte Zahlung.</p>
  <div class="beispielpreise">
    <p><strong>Beispielpreise dieser Demo – was man dafür bekommt:</strong></p>
    <p><strong>0,50 € über Stripe Checkout (Mensch im Browser):</strong> öffnet genau diesen Endpunkt für eine Stunde ab Zahlung,
    beliebig viele Abrufe.</p>
    <p><strong>0,01 USDC über x402 (${NETWORK}, Agent):</strong> bezahlt genau eine Anfrage. Jede neue Anfrage braucht eine neue
    Zahlung; wird derselbe Zahlungsnachweis wiederholt (z.&nbsp;B. nach einem Verbindungsabbruch), kommt dieselbe Antwort ohne neue
    Abrechnung.</p>
  </div>

  <section id="szenario-ohne-zahlung"><h2>1. Zahlung erforderlich</h2>
  <p>Ohne Zahlung antwortet der Endpunkt mit <code>402</code> und nennt beide Wege.</p>
  <button type="button" data-szenario="ohne-zahlung" id="knopf-ohne-zahlung">Ohne Zahlung abrufen</button></section>

  <section id="szenario-euro"><h2>2. Euro über Stripe Checkout (simuliert)</h2>
  <p>Der Browser wird zu einem lokalen, simulierten Checkout geleitet. Nach „Simuliert bezahlen“ prüft die Middleware die Sitzung
  und schaltet den Endpunkt per Cookie frei.</p>
  <a class="knopf" href="${PFAD}" id="knopf-euro">Im Browser kaufen</a>
  <form method="post" action="/demo/zuruecksetzen" class="inline"><button class="zweit" type="submit" id="knopf-zuruecksetzen">Euro-Zugang zurücksetzen</button></form></section>

  <section id="szenario-x402"><h2>3. USDC über x402 (simuliert)</h2>
  <p>Ein simulierter Agent liest die Anforderungen aus der 402-Antwort, erzeugt einen Zahlungsnachweis und sendet ihn im Kopf <code>X-PAYMENT</code>.</p>
  <button type="button" data-szenario="x402" id="knopf-x402">Simulierten Agenten zahlen lassen</button></section>

  <section id="szenario-wiederholung"><h2>4. Wiederholung</h2>
  <p>Derselbe Nachweis noch einmal: Die Middleware liefert die gespeicherte Antwort, ohne erneut abzurechnen.</p>
  <button type="button" data-szenario="wiederholung" id="knopf-wiederholung">Nachweis wiederholen</button></section>

  <section id="szenario-unklar"><h2>5. Unklare Abrechnung</h2>
  <p>Die Abrechnung gelingt, aber die Antwort des Facilitators geht verloren. Die Middleware rechnet nicht blind neu ab, sondern
  klärt beim nächsten Versuch mit demselben Nachweis über die Kette (<code>authorizationState</code>), ob schon gezahlt wurde.</p>
  <button type="button" data-szenario="unklar" id="knopf-unklar">Unklare Abrechnung durchspielen</button></section>

  <section id="ergebnis" aria-labelledby="ergebnis-h" aria-busy="false"><h2 id="ergebnis-h" tabindex="-1">Ergebnis</h2>
  <p id="zusammenfassung" role="status" aria-live="polite">Noch nichts ausgeführt. Wählen Sie oben ein Szenario.</p>
  <div id="ergebnis-karte" class="ergebnis-karte" hidden>
    <p class="art" id="ergebnis-art"></p>
    <h3 id="ergebnis-titel"></h3>
    <p id="ergebnis-text"></p>
    <dl class="zahlen" id="ergebnis-zahlen"></dl>
    <p class="naechste" id="naechste-aktion"></p>
  </div>
  <div id="ausgabe"></div>
  <p><small id="status"></small></p></section>`).replace("</body>", `<script src="/demo/app.js"></script></body>`);
}

const CLIENT_JS = `
const ergebnis = document.getElementById("ergebnis");
const kopf = document.getElementById("ergebnis-h");
const karte = document.getElementById("ergebnis-karte");
const ausgabe = document.getElementById("ausgabe");
const zusammenfassung = document.getElementById("zusammenfassung");
const statusZeile = document.getElementById("status");
const STATUS_TEXT = { 200: "OK", 402: "Payment Required", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable" };
const NAECHSTE = {
  "ohne-zahlung": ["x402", "Weiter: simulierten Agenten zahlen lassen"],
  "x402": ["wiederholung", "Weiter: denselben Nachweis wiederholen"],
  "wiederholung": ["unklar", "Weiter: unklare Abrechnung durchspielen"],
  "unklar": ["ohne-zahlung", "Von vorn: ohne Zahlung abrufen"],
};
function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function http(s) { return "HTTP " + s + (STATUS_TEXT[s] ? " " + STATUS_TEXT[s] : ""); }
function ruhig() { return window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches; }

// Deutet die Antwort des Szenarios in Alltagssprache. Liefert { art, etikett, titel, text }.
function deute(d) {
  const s = d.schritte || [];
  const letzt = s.at(-1) || {};
  const nr = letzt.antwort && letzt.antwort.aufrufNr;
  const stati = s.map((x) => x.status).join(",");
  if (d.szenario === "ohne-zahlung" && letzt.status === 402) return { art: "zahlung-erforderlich", etikett: "Zahlung erforderlich",
    titel: "Noch keine Daten: Zahlung erforderlich",
    text: "Ohne Zahlung liefert der Endpunkt nichts aus. Die Antwort nennt beide Wege: 0,01 USDC per x402 für genau diese Anfrage oder 0,50 € über Stripe Checkout für eine Stunde Zugang (Beispielpreise)." };
  if (d.szenario === "x402" && letzt.status === 200 && d.abrechnungen === 1) return { art: "bezahlt", etikett: "Zahlung (x402, simuliert)",
    titel: "Bezahlt und ausgeliefert",
    text: "Der simulierte Agent hat 0,01 USDC gezahlt und den Bericht erhalten (Aufruf Nr. " + nr + " der Route). Für jede neue Anfrage müsste er erneut zahlen." };
  if (d.szenario === "wiederholung" && letzt.status === 200 && letzt.abrechnungenDabei === 0) return { art: "wiederholung", etikett: "Wiederholung",
    titel: "Wiederholung: keine neue Abrechnung",
    text: (s.length > 1 ? "Es gab noch keinen Zahlungsnachweis; die Demo hat deshalb zuerst einmal bezahlt. " : "")
      + "Derselbe Zahlungsnachweis kam noch einmal (wie nach einem Verbindungsabbruch). Die Middleware hat die gespeicherte Antwort geliefert (Aufruf Nr. " + nr + ", die Route lief nicht erneut) und nichts zusätzlich abgerechnet." };
  if (d.szenario === "unklar" && stati === "402,503,200" && d.abrechnungen === 1) return { art: "unklar", etikett: "Unklare Abrechnung, geklärt",
    titel: "Unklare Abrechnung geklärt: genau einmal abgerechnet",
    text: "Beim ersten Versuch ging die Antwort des Facilitators verloren. Die Middleware hat mit 503 geantwortet und nichts ausgeliefert, statt „bezahlt“ zu raten. Beim nächsten Versuch mit demselben Nachweis hat sie auf der simulierten Kette nachgesehen (authorizationState): bereits eingelöst, also Bericht ausgeliefert und nicht noch einmal abgerechnet." };
  return { art: "anders", etikett: "Unerwartet", titel: "Unerwartetes Ergebnis",
    text: "Die Antworten waren " + (stati || "leer") + ". Die einzelnen Schritte stehen unten." };
}

function zeigeErgebnis() {
  karte.hidden = false;
  kopf.focus({ preventScroll: true });
  ergebnis.scrollIntoView({ behavior: ruhig() ? "auto" : "smooth", block: "start" });
}

function fuelleKarte(art, etikett, titel, text, zahlen, naechste) {
  karte.dataset.art = art;
  document.getElementById("ergebnis-art").textContent = etikett;
  document.getElementById("ergebnis-titel").textContent = titel;
  document.getElementById("ergebnis-text").textContent = text;
  const dl = document.getElementById("ergebnis-zahlen");
  dl.replaceChildren();
  for (const [k, v] of zahlen) { dl.append(el("dt", k)); dl.append(el("dd", v)); }
  const n = document.getElementById("naechste-aktion");
  n.replaceChildren();
  if (naechste) {
    const b = el("button", naechste[1]);
    b.type = "button";
    b.dataset.szenario = naechste[0];
    b.id = "naechste-knopf";
    n.append(b);
  }
}

function zeigeSchritte(schritte) {
  ausgabe.replaceChildren();
  if (!schritte.length) return;
  ausgabe.append(el("h3", "Einzelne Schritte"));
  schritte.forEach((s, i) => {
    const box = el("div", null, "schritt");
    box.dataset.status = s.status;
    box.append(el("h4", (i + 1) + ". " + s.schritt));
    const kopfzeilen = s.kopfzeilen || {};
    box.append(el("p", s.anfrage + " → " + http(s.status) + (kopfzeilen["x-payment-response"] ? " · mit X-PAYMENT-RESPONSE" : "")
      + (s.abrechnungenDabei === 0 ? " · keine Abrechnung dabei" : ""), "status"));
    const det = el("details");
    det.append(el("summary", "Vollständige Antwort als JSON (Schritt " + (i + 1) + ")"));
    det.append(el("pre", JSON.stringify({ kopfzeilen: s.kopfzeilen, xPaymentResponse: s.xPaymentResponse, antwort: s.antwort }, null, 2)));
    box.append(det);
    ausgabe.append(box);
  });
}

async function status() {
  const s = await (await fetch("/demo/status")).json();
  statusZeile.textContent = "Simulierte Abrechnungen gesamt: " + s.abrechnungenGesamt + " · Checkout-Sitzungen: " + s.checkoutSitzungen + " · Routenaufrufe: " + s.routenaufrufe;
}

async function starte(szenario) {
  for (const x of document.querySelectorAll("button")) x.disabled = true;
  ergebnis.setAttribute("aria-busy", "true");
  zusammenfassung.textContent = "Läuft …";
  delete zusammenfassung.dataset.letzterStatus;
  delete zusammenfassung.dataset.abrechnungen;
  fuelleKarte("laeuft", "Läuft", "Szenario läuft …", "Die Demo ruft den Endpunkt auf. Das dauert meist unter zwei Sekunden.", [], null);
  ausgabe.replaceChildren();
  zeigeErgebnis();
  try {
    const r = await fetch("/demo/agent/" + szenario, { method: "POST" });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const letzt = (d.schritte || []).at(-1);
    const e = deute(d);
    fuelleKarte(e.art, e.etikett, e.titel, e.text, [
      ["Letzte Antwort", letzt ? http(letzt.status) : "–"],
      ["Simulierte Abrechnungen in diesem Durchlauf", String(d.abrechnungen)],
      ["Schritte", String((d.schritte || []).length)],
    ], NAECHSTE[d.szenario]);
    zeigeSchritte(d.schritte || []);
    zusammenfassung.textContent = e.titel + ". Letzte Antwort " + (letzt ? http(letzt.status) : "–") + ", simulierte Abrechnungen: " + d.abrechnungen + ".";
    zusammenfassung.dataset.letzterStatus = letzt ? letzt.status : "";
    zusammenfassung.dataset.abrechnungen = d.abrechnungen;
    zusammenfassung.dataset.art = e.art;
  } catch (e) {
    const text = "Die Demo hat nicht geantwortet (" + e.message + "). Läuft der Server noch? Er endet nach 10 Minuten; im Terminal mit „npm run demo“ neu starten und die Seite neu laden.";
    fuelleKarte("fehler", "Fehler", "Szenario nicht ausgeführt", text, [], null);
    zusammenfassung.textContent = "Fehler: " + text;
    zusammenfassung.dataset.art = "fehler";
  } finally {
    for (const x of document.querySelectorAll("button")) x.disabled = false;
    ergebnis.setAttribute("aria-busy", "false");
    status().catch(() => {});
  }
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-szenario]");
  if (b && !b.disabled) starte(b.dataset.szenario);
});
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
