// Härtung des Zahlungskerns (Auftrag vom 23.10.): Fingerabdruck, Parallelität, Grenzen, Dateispeicher, Bindung.
// Nur nachgebildete Gegenstellen, keine Wallet, kein externer Server, keine Schlüssel.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { memoryStore, fileStore, StoreFullError, bindQuery, bindBodyHash, _intern } from "../src/index.js";
import { T0, fake, start, payment, authOf, json, count, checkout, redeem } from "./hilfen.js";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (app, h, p = "/api/bericht") => fetch(`${app.base}${p}`, { headers: { "x-payment": h } });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "meterdoor-test-"));

// Speicher, der jeden Zugriff um `ms` verzögert (wie ein entfernter Speicher).
function slowStore(inner, ms = 50) {
  const w = {};
  for (const k of ["get", "set", "delete", "list", "claim", "release", "compareAndSet"]) {
    if (inner[k]) w[k] = async (...a) => { await pause(ms); return inner[k](...a); };
  }
  return w;
}
// Speicher, dessen set() bei `crash(value)` nie zurückkehrt und nichts schreibt (Prozess „stirbt“ dort).
function crashingStore(inner, crash) {
  return { ...inner, set: (id, v, t) => (crash(v) ? new Promise(() => {}) : inner.set(id, v, t)) };
}
// Route mit Zähler; Inhalt enthält den Zählerstand, damit doppelte Ausführung sichtbar wird.
const counted = (counter, opts = {}) => (a, pw) => {
  const mw = pw(opts);
  counter.mw = mw;
  a.get("/api/bericht", mw, (req, res) => { counter.n++; res.json({ lauf: counter.n }); });
};

// ---------------------------------------------------------------- P1.1 Fingerabdruck

describe("P1.1 Gespeicherte Antwort nur mit identischem, vollständigem Nachweis", () => {
  test("unveränderte Wiederholung: 200 aus dem Speicher, keine neue Prüfung oder Abrechnung", async () => {
    const counter = { n: 0 };
    const app = await start(counted(counter));
    const h = payment();
    const first = await get(app, h);
    assert.equal(first.status, 200);
    const again = await get(app, h);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), await first.json());
    assert.equal(count(app.fk, "/verify"), 1);
    assert.equal(count(app.fk, "/settle"), 1);
    assert.equal(counter.n, 1);
    assert.ok(app.events.some((e) => e.type === "wiederholt_ausgeliefert"));
    await app.close();
  });

  const forgeries = {
    "fehlende Signatur": (auth) => payment({}, { sig: undefined, auth }),
    "veränderte Signatur": (auth) => payment({}, { sig: "0xsig2", auth }),
    "veränderter Betrag": (auth) => payment({ value: "600000" }, { auth }),
    "veränderte Gültigkeit (validBefore)": (auth) => payment({ validBefore: String(T0 + 3600) }, { auth }),
    "veränderte Gültigkeit (validAfter)": (auth) => payment({ validAfter: "1" }, { auth }),
    "veränderter Empfänger": (auth) => payment({ to: "0x00000000000000000000000000000000000000ff" }, { auth }),
  };
  for (const [name, forge] of Object.entries(forgeries)) {
    test(`abgelehnt: ${name} – 402, gespeicherter Zustand unverändert`, async () => {
      const store = memoryStore();
      const counter = { n: 0 };
      const app = await start(counted(counter, { x402: { store } }));
      const h = payment();
      assert.equal((await get(app, h)).status, 200);
      const before = JSON.stringify(store.list());
      const calls = app.fk.calls.length;
      const r = await get(app, forge(authOf(h)));
      assert.equal(r.status, 402);
      assert.equal((await r.json()).accepts.length, 1); // nur Zahlungsaufforderung, keine Daten
      assert.equal(r.headers.get("x-payment-response"), null);
      assert.equal(app.fk.calls.length, calls, "keine Anfrage an Facilitator oder RPC");
      assert.equal(JSON.stringify(store.list()), before);
      // Der Empfänger wird schon lokal abgewiesen; alle anderen erreichen den Vergleich des Fingerabdrucks.
      if (!name.includes("Empfänger")) assert.ok(app.events.some((e) => e.type === "nachweis_abweichend"));
      assert.equal((await get(app, h)).status, 200); // Original funktioniert weiter
      assert.equal(counter.n, 1);
      await app.close();
    });
  }

  test("Fälschung vor resolveUnclear: keine Klärung, kein Kettenzugriff, Fall bleibt unklar", async () => {
    const counter = { n: 0 };
    const app = await start(counted(counter));
    app.fk.settle = "abgerechnet-antwort-weg";
    const h = payment();
    assert.equal((await get(app, h)).status, 503);
    app.fk.settle = "ok";
    const calls = app.fk.calls.length;
    const r = await get(app, payment({}, { sig: undefined, auth: authOf(h) }));
    assert.equal(r.status, 402);
    assert.equal(app.fk.calls.length, calls);
    assert.ok(app.events.some((e) => e.type === "nachweis_abweichend"));
    const open = await counter.mw.openCases();
    assert.equal(open.length, 1);
    assert.equal(open[0].state, "unklar");
    assert.equal((await get(app, h)).status, 200);
    assert.equal(app.fk.settlements, 1);
    await app.close();
  });

  test("Fingerabdruck: SHA-256 im Fall gespeichert, Schreibweise der Adressen egal", async () => {
    const store = memoryStore();
    const app = await start(counted({ n: 0 }, { x402: { store } }));
    const h = payment();
    await get(app, h);
    assert.match(store.list()[0].fingerprint, /^[0-9a-f]{64}$/);
    const auth = authOf(h);
    const upper = payment({ from: auth.from.toUpperCase().replace("0X", "0x") }, { auth });
    assert.equal((await get(app, upper)).status, 200);
    await app.close();
  });
});

// ---------------------------------------------------------------- P1.2 Parallelität

describe("P1.2 Parallelität bei asynchronem Speicher", () => {
  test("verzögerter Speicher (50 ms), eine Instanz, zwei parallele Anfragen: eine Route, ein Settle, zweimal 200", async () => {
    const counter = { n: 0 };
    const app = await start(counted(counter, { x402: { store: slowStore(memoryStore()) } }));
    const h = payment();
    const [a, b] = await Promise.all([get(app, h), get(app, h)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(counter.n, 1);
    assert.equal(count(app.fk, "/settle"), 1);
    await app.close();
  });

  test("zwei Middleware-Instanzen, gemeinsamer verzögerter Speicher: Route genau einmal, Settle genau einmal, identischer Inhalt", async () => {
    const counter = { n: 0 };
    const store = slowStore(memoryStore(), 50);
    const fk = fake();
    const route = (a, pw) => a.get("/api/bericht", pw({ x402: { store } }), (req, res) => { counter.n++; res.json({ lauf: counter.n }); });
    const app1 = await start(route, { fk });
    const app2 = await start(route, { fk });
    const h = payment();
    const [a, b] = await Promise.all([get(app1, h), get(app2, h)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    const [ta, tb] = [await a.text(), await b.text()];
    assert.equal(ta, tb);
    assert.equal(a.headers.get("x-payment-response"), b.headers.get("x-payment-response"));
    assert.equal(counter.n, 1);
    assert.equal(count(fk, "/settle"), 1);
    assert.equal(fk.settlements, 1);
    await app1.close(); await app2.close();
  });

  test("zwei Instanzen mit gemeinsamem Dateispeicher: Route genau einmal, Settle genau einmal", async () => {
    const dir = tmpDir();
    const counter = { n: 0 };
    const fk = fake();
    const route = (a, pw) => a.get("/api/bericht", pw({ x402: { store: slowStore(fileStore({ dir }), 50) } }), (req, res) => { counter.n++; res.json({ lauf: counter.n }); });
    const app1 = await start(route, { fk });
    const app2 = await start(route, { fk });
    const h = payment();
    const [a, b] = await Promise.all([get(app1, h), get(app2, h)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(await a.text(), await b.text());
    assert.equal(counter.n, 1);
    assert.equal(count(fk, "/settle"), 1);
    await app1.close(); await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("Speicher ohne claim: Warnung beim Start „nur eine Instanz sicher“; Standardspeicher ohne Warnung", async () => {
    const inner = memoryStore();
    const plain = { get: inner.get, set: inner.set, delete: inner.delete, list: inner.list };
    const events = [];
    let mw;
    const app = await start((a, pw) => { mw = pw({ x402: { store: plain } }); a.get("/x", mw, (q, r) => r.json({})); }, { events });
    const warn = events.find((e) => e.type === "speicher_ohne_sperre");
    assert.ok(warn?.problem);
    assert.match(warn.detail, /nur eine Instanz sicher/);
    assert.equal(mw.limits.multiInstance, false);
    await app.close();
    const events2 = [];
    const app2 = await start((a, pw) => a.get("/x", pw(), (q, r) => r.json({})), { events: events2 });
    assert.ok(!events2.some((e) => e.type === "speicher_ohne_sperre"));
    await app2.close();
  });

  test("memoryStore: claim exklusiv, Ablauf der Sperre, release nur durch Besitzer, compareAndSet", () => {
    const st = memoryStore();
    assert.equal(st.claim("a", "o1", 60), true);
    assert.equal(st.claim("a", "o2", 60), false);
    assert.equal(st.claim("a", "o1", 60), true); // Besitzer darf verlängern
    st.release("a", "o2");
    assert.equal(st.claim("a", "o2", 60), false);
    st.release("a", "o1");
    assert.equal(st.claim("a", "o2", 60), true);
    assert.equal(st.claim("b", "o1", -1), true); // sofort abgelaufen
    assert.equal(st.claim("b", "o2", 60), true);
    assert.equal(st.compareAndSet("c", undefined, { state: "in_abrechnung" }, 60), true);
    assert.equal(st.compareAndSet("c", undefined, { state: "in_abrechnung" }, 60), false);
    assert.equal(st.compareAndSet("c", "unklar", { state: "bezahlt" }, 60), false);
    assert.equal(st.compareAndSet("c", "in_abrechnung", { state: "bezahlt" }, 60), true);
    assert.equal(st.get("c").state, "bezahlt");
  });
});

// ---------------------------------------------------------------- P1.3 Grenzen

describe("P1.3 Grenzen für Antwortpuffer, Speicher und Gleichzeitigkeit", () => {
  test("sichere Standardwerte gesetzt", async () => {
    let mw;
    const app = await start((a, pw) => { mw = pw(); a.get("/x", mw, (q, r) => r.json({})); });
    assert.equal(mw.limits.maxResponseBytes, 1024 * 1024);
    assert.equal(mw.limits.maxConcurrent, 64);
    assert.ok(mw.limits.lockSeconds > 0);
    await app.close();
  });

  test("übergroße Antwort: kontrollierter Abbruch vor der Abrechnung, kein Settle, nichts gespeichert", async () => {
    const store = memoryStore();
    const app = await start((a, pw) => a.get("/api/bericht", pw({ x402: { store, maxResponseBytes: 1000 } }), (req, res) => {
      res.write("x".repeat(600)); res.write("y".repeat(600)); res.end("z");
    }));
    const r = await get(app, payment());
    assert.equal(r.status, 500);
    assert.doesNotMatch(await r.text(), /xxxx|yyyy/);
    assert.equal(count(app.fk, "/settle"), 0);
    assert.equal(store.list().length, 0);
    assert.ok(app.events.some((e) => e.type === "antwort_zu_gross"));
    await app.close();
  });

  test("Antwort genau an der Grenze geht durch", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw({ x402: { maxResponseBytes: 1000 } }), (req, res) => res.end("x".repeat(1000))));
    const r = await get(app, payment());
    assert.equal(r.status, 200);
    assert.equal((await r.text()).length, 1000);
    await app.close();
  });

  test("voller Speicher mit offenem Fall: neuer Auftrag 503 + Retry-After, kein Settle; offener Fall bleibt abrufbar", async () => {
    const counter = { n: 0 };
    const app = await start(counted(counter, { x402: { store: memoryStore({ maxEntries: 1 }) } }));
    app.fk.settle = "abgerechnet-antwort-weg";
    const h1 = payment();
    assert.equal((await get(app, h1)).status, 503);
    app.fk.settle = "ok";
    const settles = count(app.fk, "/settle");
    const r = await get(app, payment());
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "30");
    assert.equal(count(app.fk, "/settle"), settles, "neuer Auftrag wird nicht abgerechnet");
    assert.ok(app.events.some((e) => e.type === "speicher_voll" && e.problem));
    const open = await counter.mw.openCases();
    assert.equal(open.length, 1);
    assert.equal(open[0].state, "unklar");
    const again = await get(app, h1);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { lauf: 1 });
    assert.equal(app.fk.settlements, 1);
    await app.close();
  });

  test("voller Speicher: abgelaufene bezahlte Einträge werden zuerst entfernt", async () => {
    const clock = { ms: T0 * 1000 };
    const app = await start(counted({ n: 0 }, { x402: { store: memoryStore({ maxEntries: 1, now: () => clock.ms }), replaySeconds: 60 } }), { clock });
    assert.equal((await get(app, payment())).status, 200);
    clock.ms += 61_000;
    assert.equal((await get(app, payment({ validBefore: String(T0 + 600) }))).status, 200);
    await app.close();
  });

  test("memoryStore: offene Fälle werden nie verdrängt und verfallen nicht; Änderungen an vorhandenen Einträgen gehen immer", () => {
    const clock = { ms: 0 };
    const st = memoryStore({ maxEntries: 2, now: () => clock.ms });
    st.set("u", { state: "unklar" }, 1);
    st.set("i", { state: "in_abrechnung" }, 1);
    assert.throws(() => st.set("neu", { state: "in_abrechnung" }, 60), (e) => e instanceof StoreFullError && e.code === "SPEICHER_VOLL");
    clock.ms = 10_000;
    assert.equal(st.get("u").state, "unklar");
    assert.equal(st.get("i").state, "in_abrechnung");
    st.set("i", { state: "bezahlt", delivered: false }, 1); // Zustandsänderung trotz vollem Speicher
    assert.equal(st.get("i"), undefined); // bezahlt und Frist vorbei: verfällt
    assert.doesNotThrow(() => st.set("neu", { state: "bezahlt" }, 60));
  });

  test("memoryStore: maxStoredBytes begrenzt die Datenmenge, bezahlte nicht zugestellte Fälle werden nicht verdrängt", () => {
    const st = memoryStore({ maxStoredBytes: 300 });
    st.set("a", { state: "bezahlt", delivered: false, d: "x".repeat(100) }, 60);
    st.set("b", { state: "bezahlt", delivered: true, d: "x".repeat(100) }, 60);
    st.set("c", { state: "bezahlt", delivered: true, d: "x".repeat(100) }, 60); // verdrängt b
    assert.equal(st.get("b"), undefined);
    assert.ok(st.get("a") && st.get("c"));
    assert.throws(() => st.set("d", { d: "x".repeat(400) }, 60), StoreFullError);
  });

  test("maxConcurrent: zu viele gleichzeitige Zahlungen → 503 + Retry-After, keine zusätzliche Abrechnung", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw({ x402: { maxConcurrent: 1 } }), (req, res) => setTimeout(() => res.json({ ok: 1 }), 100)));
    const rs = await Promise.all([get(app, payment()), get(app, payment())]);
    const statuses = rs.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 503]);
    assert.equal(rs.find((r) => r.status === 503).headers.get("retry-after"), "5");
    assert.equal(count(app.fk, "/settle"), 1);
    assert.ok(app.events.some((e) => e.type === "ueberlastet"));
    assert.equal((await get(app, payment())).status, 200); // Zähler wieder frei
    await app.close();
  });
});

// ---------------------------------------------------------------- P1.4 Dateispeicher und Neustart

describe("P1.4 Dauerhafter Dateispeicher und Wiederanlauf", () => {
  test("fileStore: übersteht neue Instanz, atomar ohne Reste, festes expiresAt", () => {
    const dir = tmpDir();
    const clock = { ms: 1_000_000 };
    const a = fileStore({ dir, now: () => clock.ms });
    a.set("x", { state: "in_abrechnung", n: 1 }, 60);
    clock.ms += 50_000;
    a.set("x", { state: "bezahlt", n: 2 }, 60); // Zustandsänderung: Ablauf bleibt bei +60 s
    const b = fileStore({ dir, now: () => clock.ms });
    assert.deepEqual(b.get("x"), { state: "bezahlt", n: 2 });
    assert.deepEqual(b.list(), [{ id: "x", state: "bezahlt", n: 2 }]);
    clock.ms += 10_001;
    assert.equal(b.get("x"), undefined);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
    b.set("y", { state: "unklar" }, 1);
    clock.ms += 3_600_000;
    assert.equal(b.get("y").state, "unklar"); // offene Fälle verfallen nicht
    b.delete("y");
    assert.equal(fileStore({ dir }).get("y"), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("fileStore: claim exklusiv über Instanzen, abgelaufene Sperre übernehmbar, compareAndSet, Grenzen", () => {
    const dir = tmpDir();
    const a = fileStore({ dir, maxEntries: 2 });
    const b = fileStore({ dir, maxEntries: 2 });
    assert.equal(a.claim("k", "o1", 60), true);
    assert.equal(b.claim("k", "o2", 60), false);
    b.release("k", "o2");
    assert.equal(b.claim("k", "o2", 60), false);
    a.release("k", "o1");
    assert.equal(b.claim("k", "o2", 60), true);
    assert.equal(a.claim("z", "o1", -1), true);
    assert.equal(b.claim("z", "o2", 60), true); // abgelaufen → übernommen
    assert.equal(a.claim("z", "o1", 60), false);
    assert.equal(a.compareAndSet("c", undefined, { state: "in_abrechnung" }, 60), true);
    assert.equal(b.compareAndSet("c", undefined, { state: "in_abrechnung" }, 60), false);
    assert.equal(b.compareAndSet("c", "in_abrechnung", { state: "unklar" }, 60), true);
    a.set("d", { state: "in_abrechnung" }, 60);
    assert.throws(() => b.set("e", { state: "in_abrechnung" }, 60), StoreFullError); // b sieht a's Einträge
    a.set("c", { state: "bezahlt", delivered: true }, 60);
    assert.doesNotThrow(() => b.set("e", { state: "in_abrechnung" }, 60)); // verdrängt den zugestellten
    assert.equal(a.get("c"), undefined);
    assert.equal(a.get("d").state, "in_abrechnung");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("memoryStore: expiresAt beginnt bei Zustandsänderungen nicht neu", () => {
    const clock = { ms: 0 };
    const st = memoryStore({ now: () => clock.ms });
    st.set("x", { state: "bezahlt", delivered: false }, 60);
    clock.ms = 50_000;
    st.set("x", { state: "bezahlt", delivered: true }, 60);
    clock.ms = 60_001;
    assert.equal(st.get("x"), undefined);
    st.set("y", { state: "bezahlt", expiresAt: new Date(5_000_000).toISOString() }, 1);
    clock.ms = 4_999_000;
    assert.ok(st.get("y"));
  });

  test("Middleware: Wiederholung nur innerhalb der festen Frist, Zustellvermerk verlängert nichts", async () => {
    const clock = { ms: T0 * 1000 };
    const app = await start(counted({ n: 0 }, { x402: { store: memoryStore({ now: () => clock.ms }), replaySeconds: 60 } }), { clock });
    const h = payment({ validBefore: String(T0 + 600) });
    assert.equal((await get(app, h)).status, 200);
    clock.ms += 59_000;
    assert.equal((await get(app, h)).status, 200);
    await pause(20); // Zustellvermerk schreibt den Fall erneut
    clock.ms += 2_000;
    assert.equal((await get(app, h)).status, 402); // Frist vorbei; Nonce verbraucht → keine zweite Abrechnung
    assert.equal(app.fk.settlements, 1);
    await app.close();
  });

  // Gemeinsamer Ablauf: Instanz 1 „stirbt“ an einer Stelle, Instanz 2 startet auf demselben Verzeichnis.
  async function crashAndRestart({ prepare, waitFor, waitLockExpiry }) {
    const dir = tmpDir();
    const clock = { ms: T0 * 1000 };
    const fk = fake();
    const counter = { n: 0 };
    const opts = (store) => ({ x402: { store, lockSeconds: 1 } });
    const app1 = await start(counted(counter, opts(prepare(fileStore({ dir, now: () => clock.ms }), fk))), { fk, clock });
    const h = payment();
    const p1 = get(app1, h).then((r) => r.status, () => "abgebrochen");
    if (waitFor) { for (let i = 0; i < 100 && !waitFor(fk); i++) await pause(10); await pause(30); }
    else assert.equal(await p1, 200);
    await app1.close(); // Absturz bzw. Neustart
    if (waitLockExpiry) await pause(1100);
    fk.settle = "ok";
    const events = [];
    const counter2 = { n: 100 };
    const app2 = await start(counted(counter2, opts(fileStore({ dir, now: () => clock.ms }))), { fk, clock, events });
    const recovered = await counter2.mw.ready;
    const openAfterStart = await counter2.mw.openCases();
    const r = await get(app2, h);
    const result = { status: r.status, body: await r.json(), fk, counter, counter2, events, recovered, openAfterStart, first: await Promise.race([p1, pause(50).then(() => "haengt")]) };
    assert.equal((await get(app2, h)).status, 200); // und danach weiter aus dem Speicher
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }

  test("Neustart vor dem Settle: Fall wird „unklar“, Klärung rechnet genau einmal ab, Antwort nicht verloren", async () => {
    const r = await crashAndRestart({
      prepare: (store, fk) => { fk.settle = "haengt"; return store; },
      waitFor: (fk) => fk.settleHangs === 1,
      waitLockExpiry: true,
    });
    assert.equal(r.recovered, 1);
    assert.equal(r.openAfterStart[0].state, "unklar");
    assert.ok(r.events.some((e) => e.type === "wiederanlauf_unklar"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { lauf: 1 }); // gespeicherte Antwort der ersten Instanz, Route nicht erneut
    assert.equal(r.counter2.n, 100);
    assert.equal(r.fk.settlements, 1);
  });

  test("Neustart zwischen Settle und Speichern: Klärung über die Kette, kein zweiter Settle", async () => {
    const r = await crashAndRestart({
      prepare: (store) => crashingStore(store, (v) => v.state === "bezahlt"),
      waitFor: (fk) => fk.settlements === 1,
      waitLockExpiry: false, // Sperre der toten Instanz läuft während der Anfrage ab
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { lauf: 1 });
    assert.equal(r.counter2.n, 100);
    assert.equal(r.fk.settlements, 1);
    assert.equal(count(r.fk, "/settle"), 1, "nie blind neu abgerechnet");
    assert.ok(r.events.some((e) => e.type === "abrechnung_geklaert"));
  });

  test("Neustart nach dem Speichern: Wiederholung aus dem Dateispeicher, keine neue Prüfung oder Abrechnung", async () => {
    const r = await crashAndRestart({ prepare: (store) => store });
    assert.equal(r.first, 200);
    assert.equal(r.recovered, 0);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { lauf: 1 });
    assert.equal(r.counter2.n, 100);
    assert.equal(count(r.fk, "/verify"), 1);
    assert.equal(count(r.fk, "/settle"), 1);
  });
});

// ---------------------------------------------------------------- P2.5 Bindung an Parameter

describe("P2.5 Parameterabhängige Ressourcen (access.bind)", () => {
  const bericht = (bind) => (a, pw) => {
    a.get("/bericht", pw(bind ? { access: { bind } } : {}), (req, res) => res.json({ id: req.query.id }));
  };

  test("bindQuery(['id']): x402-Antwort von ?id=1 gilt nicht für ?id=2", async () => {
    const app = await start(bericht(bindQuery(["id"])));
    const h = payment();
    const r1 = await get(app, h, "/bericht?id=1");
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { id: "1" });
    const r2 = await get(app, h, "/bericht?id=2");
    assert.equal(r2.status, 402);
    assert.equal((await get(app, h, "/bericht?id=1&x=9")).status, 200); // andere Parameter zählen nicht
    const req402 = await (await fetch(`${app.base}/bericht?id=2`, { headers: json })).json();
    assert.equal(req402.accepts[0].resource, `${app.base}/bericht?id=2`);
    assert.equal(req402.checkout, `${app.base}/bericht?id=2&pw_checkout=1`);
    await app.close();
  });

  test("bindQuery(['id']): Stripe-Token von ?id=1 gilt nicht für ?id=2; Rücksprung behält ?id", async () => {
    const app = await start(bericht(bindQuery(["id"])));
    const s = await checkout(app, "/bericht?id=1");
    assert.equal(s.metadata.pw_resource, "GET /bericht?id=1");
    assert.equal(s.success_url, `${app.base}/bericht?id=1&pw_session={CHECKOUT_SESSION_ID}`);
    const r = await fetch(`${app.base}/bericht?id=1&pw_session=${s.id}`, { headers: json });
    assert.equal(r.status, 200);
    const { token } = await r.json();
    const auth = { ...json, authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${app.base}/bericht?id=1`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${app.base}/bericht?id=2`, { headers: auth })).status, 402);
    assert.equal((await fetch(`${app.base}/bericht?id=2&pw_session=${s.id}`, { headers: json })).status, 402);
    const html = await fetch(`${app.base}/bericht?id=1&pw_session=${s.id}`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(html.headers.get("location"), "/bericht?id=1");
    assert.match(html.headers.get("set-cookie"), /^pw_token_[0-9a-f]{12}=/);
    await app.close();
  });

  test("ohne Option wie bisher: Methode + voller Pfad, Query zählt nicht", async () => {
    const app = await start(bericht(null));
    const h = payment();
    assert.equal((await get(app, h, "/bericht?id=1")).status, 200);
    assert.equal((await get(app, h, "/bericht?id=2")).status, 200);
    const s = await checkout(app, "/bericht?id=1");
    assert.equal(s.metadata.pw_resource, "GET /bericht");
    assert.equal(s.success_url, `${app.base}/bericht?pw_session={CHECKOUT_SESSION_ID}`);
    const { token } = await (await redeem(app, s, "/bericht")).json();
    assert.equal((await fetch(`${app.base}/bericht?id=2`, { headers: { ...json, authorization: `Bearer ${token}` } })).status, 200);
    await app.close();
  });

  test("bindBodyHash(): POST-Antwort gilt nur für denselben Body; ohne Body-Parser 500 statt stiller Gleichbehandlung", async () => {
    const app = await start((a, pw) => {
      a.post("/rechnen", express.json(), pw({ access: { bind: bindBodyHash() } }), (req, res) => res.json({ summe: req.body.a + req.body.b }));
      a.post("/ohne-parser", pw({ access: { bind: bindBodyHash() } }), (req, res) => res.json({}));
    });
    const h = payment();
    const post = (body, p = "/rechnen") => fetch(`${app.base}${p}`, { method: "POST", headers: { "x-payment": h, "content-type": "application/json" }, body: JSON.stringify(body) });
    const r1 = await post({ a: 1, b: 2 });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { summe: 3 });
    assert.equal((await post({ b: 2, a: 1 })).status, 200); // gleiche Daten, andere Reihenfolge
    assert.equal((await post({ a: 5, b: 2 })).status, 402);
    const r3 = await post({ a: 1 }, "/ohne-parser");
    assert.equal(r3.status, 500);
    assert.equal(count(app.fk, "/settle"), 1);
    await app.close();
  });

  test("access.bind muss eine Funktion sein", async () => {
    await assert.rejects(start((a, pw) => a.get("/x", pw({ access: { bind: "id" } }))), /access.bind/);
  });
});

test("Testhilfe: Nachweis ohne Signatur enthält wirklich keine", () => {
  const p = _intern.fromB64json(payment({}, { sig: undefined }));
  assert.equal("signature" in p.payload, false);
});
