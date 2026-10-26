// Abnahme der Demo im echten Browser (Playwright, lokal installiertes Edge oder Chrome, kein Browser-Download).
// Ohne Internet: jede Anfrage an einen anderen Host als 127.0.0.1 wird abgebrochen und gezählt (Erwartung: 0).
// Start: npm run test:demo
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startDemo } from "./server.js";
import { pruefeUmgebung } from "./simulation.js";

const SERVER = fileURLToPath(new URL("./server.js", import.meta.url));
const KANAELE = process.env.DEMO_BROWSER ? [process.env.DEMO_BROWSER] : ["msedge", "chrome"];

let demo, browser, context, page, kanal;
const abgebrochen = [];
const angefragt = [];

before(async () => {
  demo = await startDemo({ port: 0, maxMs: 120000, env: {}, log: () => {} });
  const fehler = [];
  for (const channel of KANAELE) {
    try {
      browser = await chromium.launch({
        channel, headless: true,
        // Zusätzlich zur Routensperre: keine Namensauflösung außer 127.0.0.1, keine Hintergrunddienste des Browsers.
        args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--disable-background-networking",
          "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check"],
      });
      kanal = channel;
      break;
    } catch (err) { fehler.push(`${channel}: ${err.message.split("\n")[0]}`); }
  }
  if (!browser) throw new Error(`Kein lokaler Browser gefunden (Edge/Chrome).\n${fehler.join("\n")}`);
  console.log(`# Browser: ${kanal} ${browser.version()}`);
  context = await browser.newContext();
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    angefragt.push(url.href);
    if (url.hostname === "127.0.0.1") return route.continue();
    abgebrochen.push(url.href);
    return route.abort("internetdisconnected");
  });
  page = await context.newPage();
});

after(async () => {
  await browser?.close();
  await demo?.close();
});

const zusammenfassung = () => page.locator("#zusammenfassung");
const karte = () => page.locator("#ergebnis-karte");
let aufrufNrX402;
// Ergebnis in Alltagssprache: Art, Titel und Kennzahlen stehen sichtbar oberhalb der JSON-Daten.
async function ergebnis() {
  return {
    art: await karte().getAttribute("data-art"),
    titel: await page.locator("#ergebnis-titel").innerText(),
    text: await page.locator("#ergebnis-text").innerText(),
    zahlen: await page.locator("#ergebnis-zahlen").innerText(),
    naechste: await page.locator("#naechste-aktion button").count(),
    jsonOffen: await page.locator("#ausgabe details[open]").count(),
    jsonGesamt: await page.locator("#ausgabe details").count(),
    sichtbar: await karte().isVisible(),
  };
}
async function szenario(id) {
  const antwort = page.waitForResponse((r) => r.url().includes("/demo/agent/"));
  await page.click(`#knopf-${id}`);
  const r = await antwort;
  assert.equal(r.headers()["x-meterdoor-simulation"], "1");
  const daten = await r.json();
  assert.equal(daten.simulation, true);
  await page.waitForFunction(() => !document.querySelector("button[data-szenario]").disabled);
  return daten;
}

test("Startseite: Simulation-Banner und Kopfzeile", async () => {
  const r = await page.goto(`${demo.url}/`);
  assert.equal(r.status(), 200);
  assert.equal(r.headers()["x-meterdoor-simulation"], "1");
  const banner = page.locator("#simulation-banner");
  assert.ok(await banner.isVisible());
  assert.match(await banner.innerText(), /SIMULATION – keine echte Zahlung/);
});

test("Zahlung erforderlich: 402 mit beiden Wegen", async () => {
  const d = await szenario("ohne-zahlung");
  const s = d.schritte[0];
  assert.equal(s.status, 402);
  assert.equal(s.kopfzeilen["x-meterdoor-simulation"], "1");
  assert.equal(s.antwort.simulation, true);
  assert.equal(s.antwort.accepts[0].network, "base-sepolia");
  assert.match(s.antwort.checkout, /pw_checkout=1/);
  assert.equal(await zusammenfassung().getAttribute("data-letzter-status"), "402");
  const e = await ergebnis();
  assert.equal(e.art, "zahlung-erforderlich");
  assert.ok(e.sichtbar);
  assert.match(e.titel, /Zahlung erforderlich/);
  assert.match(e.zahlen, /HTTP 402 Payment Required/);
  assert.match(e.zahlen, /Simulierte Abrechnungen in diesem Durchlauf\s+0/);
  assert.equal(e.naechste, 1, "passende nächste Aktion");
  assert.equal(e.jsonGesamt, 1, "JSON je Schritt aufklappbar");
  assert.equal(e.jsonOffen, 0, "JSON ist zunächst zugeklappt");
  assert.equal(await zusammenfassung().getAttribute("aria-live"), "polite");
  assert.equal(await page.locator("#ergebnis").getAttribute("aria-busy"), "false");
});

test("Euro-Weg: simulierter Checkout bis zur Freischaltung", async () => {
  await page.click("#knopf-euro");
  await page.waitForURL(/\/demo\/checkout\/cs_test_sim_[0-9a-f]+$/);
  assert.ok(await page.locator("#simulation-banner").isVisible());
  assert.equal(await page.locator("h1").innerText(), "Simulierter Checkout");
  assert.match(await page.locator("#betrag").innerText(), /0,50 € \(simuliert\)/);

  const ziel = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/bericht" && r.status() === 200);
  await page.click("#simuliert-bezahlen");
  const r = await ziel;
  assert.equal(r.headers()["x-meterdoor-simulation"], "1");
  await page.waitForURL(`${demo.url}/api/bericht`);
  assert.ok(await page.locator("#freigeschaltet").isVisible());
  assert.ok(await page.locator("#simulation-banner").isVisible());
  assert.match(await page.locator("#freigeschaltet").innerText(), /freigeschaltet/);
  // Vollständige JSON-Antwort steht aufklappbar unter dem Ergebnis.
  await page.locator("details.json summary").click();
  const bericht = JSON.parse(await page.locator("#bericht").innerText());
  assert.equal(bericht.simulation, true);
  assert.equal(bericht.bezahltMit.method, "stripe-token");

  // Freigeschaltet bleibt freigeschaltet: Abruf als JSON mit dem gesetzten Cookie.
  const json = await page.evaluate(async () => {
    const x = await fetch("/api/bericht", { headers: { accept: "application/json" } });
    return { status: x.status, kopf: x.headers.get("x-meterdoor-simulation"), body: await x.json() };
  });
  assert.equal(json.status, 200);
  assert.equal(json.kopf, "1");
  assert.equal(json.body.simulation, true);
  assert.equal(json.body.bezahltMit.method, "stripe-token");
  assert.equal(demo.sim.settlements, 0, "Euro-Weg rechnet nichts über x402 ab");
});

test("x402-Weg: simulierter Agent zahlt, X-PAYMENT-RESPONSE wird angezeigt", async () => {
  await page.goto(`${demo.url}/`);
  const d = await szenario("x402");
  assert.deepEqual(d.schritte.map((s) => s.status), [402, 200]);
  const s = d.schritte[1];
  assert.equal(s.kopfzeilen["x-meterdoor-simulation"], "1");
  assert.ok(s.kopfzeilen["x-payment-response"]);
  assert.equal(s.xPaymentResponse.success, true);
  assert.equal(s.xPaymentResponse.network, "base-sepolia");
  assert.equal(s.antwort.simulation, true);
  assert.equal(s.antwort.bezahltMit.method, "x402");
  assert.equal(d.abrechnungen, 1);
  assert.equal(await zusammenfassung().getAttribute("data-letzter-status"), "200");
  assert.match(await page.locator("#ausgabe").textContent(), /x-payment-response/);
  assert.match(await page.locator("#ausgabe").innerText(), /mit X-PAYMENT-RESPONSE/);
  const e = await ergebnis();
  assert.equal(e.art, "bezahlt");
  assert.match(e.titel, /Bezahlt und ausgeliefert/);
  assert.match(e.zahlen, /HTTP 200 OK/);
  assert.match(e.zahlen, /Simulierte Abrechnungen in diesem Durchlauf\s+1/);
  aufrufNrX402 = s.antwort.aufrufNr;
  assert.match(e.text, new RegExp("Aufruf Nr. " + aufrufNrX402 + " "));
});

test("Wiederholung: gespeicherte Antwort, keine zweite Abrechnung", async () => {
  const vorher = demo.sim.settlements;
  const d = await szenario("wiederholung");
  assert.deepEqual(d.schritte.map((s) => s.status), [200]);
  assert.equal(d.abrechnungen, 0);
  assert.equal(demo.sim.settlements, vorher);
  assert.equal(d.schritte[0].xPaymentResponse.success, true);
  assert.equal(await zusammenfassung().getAttribute("data-abrechnungen"), "0");
  // Nachvollziehbar ohne JSON: eigene Art, keine Abrechnung, dieselbe Aufrufnummer wie die bezahlte Antwort.
  assert.equal(d.schritte[0].antwort.aufrufNr, aufrufNrX402, "Route lief nicht erneut");
  const e = await ergebnis();
  assert.equal(e.art, "wiederholung");
  assert.match(e.titel, /keine neue Abrechnung/);
  assert.match(e.text, new RegExp("Aufruf Nr. " + aufrufNrX402 + ", die Route lief nicht erneut"));
  assert.match(e.zahlen, /Simulierte Abrechnungen in diesem Durchlauf\s+0/);
  assert.match(await page.locator("#ausgabe").innerText(), /keine Abrechnung dabei/);
});

test("Unklare Abrechnung: 503, dann Klärung über RPC, genau eine Abrechnung", async () => {
  const d = await szenario("unklar");
  assert.deepEqual(d.schritte.map((s) => s.status), [402, 503, 200]);
  assert.equal(d.schritte[1].antwort.simulation, true);
  assert.equal(d.schritte[1].kopfzeilen["x-meterdoor-simulation"], "1");
  assert.equal(d.schritte[2].xPaymentResponse.success, true);
  assert.equal(d.abrechnungen, 1);
  assert.ok(demo.sim.calls.some((c) => c.url.startsWith("https://rpc.simulation.invalid")), "RPC wurde befragt");
  const e = await ergebnis();
  assert.equal(e.art, "unklar");
  assert.match(e.titel, /Unklare Abrechnung geklärt/);
  assert.match(e.text, /503/);
  assert.match(e.zahlen, /Simulierte Abrechnungen in diesem Durchlauf\s+1/);
  assert.equal(e.jsonGesamt, 3);
  // Zahlung, Wiederholung und unklare Abrechnung sind ohne JSON unterscheidbar (eigene Art und eigenes Etikett).
  assert.match(await page.locator("#ergebnis-art").innerText(), /Unklare Abrechnung/);
});

test("Nächste Aktion im Ergebnis startet das folgende Szenario", async () => {
  // Nach "unklar" schlägt die Demo "Von vorn: ohne Zahlung abrufen" vor.
  const antwort = page.waitForResponse((r) => r.url().endsWith("/demo/agent/ohne-zahlung"));
  await page.click("#naechste-knopf");
  await antwort;
  await page.waitForFunction(() => document.querySelector("#ergebnis-karte").dataset.art === "zahlung-erforderlich");
});

test("Tastatur: Szenario per Tab und Enter, Fokus springt zum Ergebnis", async () => {
  await page.goto(`${demo.url}/`);
  await page.focus("#knopf-ohne-zahlung");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "knopf-ohne-zahlung");
  const antwort = page.waitForResponse((r) => r.url().includes("/demo/agent/"));
  await page.keyboard.press("Enter");
  await antwort;
  await page.waitForFunction(() => document.querySelector("#ergebnis").getAttribute("aria-busy") === "false");
  assert.equal(await page.evaluate(() => document.activeElement.id), "ergebnis-h");
  // Nächster Tab-Halt nach dem Ergebnis-Kopf ist die vorgeschlagene nächste Aktion.
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "naechste-knopf");
});

test("Kleiner Bildschirm (390 px, reduzierte Bewegung): Ergebnis nach der Aktion im Blickfeld", async () => {
  const p = await context.newPage();
  await p.emulateMedia({ reducedMotion: "reduce" });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${demo.url}/`);
  const antwort = p.waitForResponse((r) => r.url().includes("/demo/agent/"));
  await p.click("#knopf-x402");
  await antwort;
  await p.waitForFunction(() => document.querySelector("#ergebnis").getAttribute("aria-busy") === "false");
  const box = await p.locator("#ergebnis-karte").boundingBox();
  assert.ok(box && box.y >= 0 && box.y < 844, `Ergebnis-Karte sichtbar (y=${box && box.y})`);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "kein waagerechtes Scrollen");
  assert.ok(await p.locator("#simulation-banner").isVisible());
  await p.close();
});

test("Lade- und Fehlerzustand sichtbar und zugänglich", async () => {
  const p = await context.newPage();
  await p.goto(`${demo.url}/`);
  // Ladezustand: Antwort künstlich verzögern (nur lokal, keine Anfrage nach außen).
  let freigeben;
  const gehalten = new Promise((ok) => { freigeben = ok; });
  await p.route("**/demo/agent/ohne-zahlung", async (route) => { await gehalten; await route.continue(); });
  await p.click("#knopf-ohne-zahlung");
  await p.waitForFunction(() => document.querySelector("#ergebnis").getAttribute("aria-busy") === "true");
  assert.match(await p.locator("#zusammenfassung").innerText(), /Läuft/);
  assert.equal(await p.locator("#ergebnis-karte").getAttribute("data-art"), "laeuft");
  assert.ok(await p.locator("#knopf-x402").isDisabled(), "Knöpfe gesperrt, solange es läuft");
  freigeben();
  await p.waitForFunction(() => document.querySelector("#ergebnis").getAttribute("aria-busy") === "false");
  assert.equal(await p.locator("#ergebnis-karte").getAttribute("data-art"), "zahlung-erforderlich");
  await p.unroute("**/demo/agent/ohne-zahlung");
  // Fehlerzustand: Verbindung zur Demo bricht ab.
  await p.route("**/demo/agent/x402", (route) => route.abort("connectionrefused"));
  await p.click("#knopf-x402");
  await p.waitForFunction(() => document.querySelector("#ergebnis-karte").dataset.art === "fehler");
  assert.match(await p.locator("#zusammenfassung").innerText(), /^Fehler: .*npm run demo/);
  assert.ok(!(await p.locator("#knopf-x402").isDisabled()), "Knöpfe nach Fehler wieder bedienbar");
  await p.close();
});

test("Kein Internetzugriff: keine Anfrage musste abgebrochen werden", () => {
  assert.ok(angefragt.length > 5, "Browser hat Anfragen gestellt");
  assert.deepEqual(abgebrochen, []);
});

function starteKind(extraEnv) {
  return new Promise((resolve) => {
    const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PORT: "0", MAX_MS: "5000", ...extraEnv };
    const kind = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    kind.stdout.on("data", (b) => { out += b; });
    kind.stderr.on("data", (b) => { out += b; });
    const notbremse = setTimeout(() => kind.kill(), 8000); // nur dieses Kind, nie nach Namen
    kind.on("exit", (code) => { clearTimeout(notbremse); resolve({ code, out }); });
  });
}

test("Startschutz: Demo startet nicht mit echtem Stripe-Schlüssel", async () => {
  const wert = "sk_" + "live_" + "0".repeat(24);
  const { code, out } = await starteKind({ STRIPE_SECRET_KEY: wert });
  assert.equal(code, 2);
  assert.match(out, /Demo startet nicht/);
  assert.match(out, /STRIPE_SECRET_KEY/);
  assert.ok(!out.includes(wert), "Wert wird nie ausgegeben");
});

test("Startschutz: auch Wallet-Schlüssel und Schlüssel unter fremdem Namen", async () => {
  const k = "0x" + "ab".repeat(32);
  const r1 = await starteKind({ MEIN_SIGNER: k });
  assert.equal(r1.code, 2);
  assert.match(r1.out, /MEIN_SIGNER/);
  assert.ok(!r1.out.includes(k));
  assert.deepEqual(pruefeUmgebung({ HOME: "/x", BUILD_HASH: "ab".repeat(32) }), []);
  assert.equal(pruefeUmgebung({ GANZ_ANDERS: "rk_" + "live_abc" }).length, 1);
  assert.equal(pruefeUmgebung({ WALLET: "0x1" }).length, 1);
});
