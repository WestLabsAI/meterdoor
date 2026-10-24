import { test, describe } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { paywall, toUnits, signToken, verifyToken, memoryStore, _intern } from "../src/index.js";
import { SECRET, PAY_TO, T0, fake, start, simple, payment, json, count, checkout, redeem } from "./hilfen.js";


// ---------------------------------------------------------------- Grundlagen

test("toUnits rechnet ohne Gleitkomma", () => {
  assert.equal(toUnits("0.50", 6), 500000n);
  assert.equal(toUnits("1", 2), 100n);
  assert.equal(toUnits("0.000001", 6), 1n);
  assert.throws(() => toUnits(0.5, 6));
  assert.throws(() => toUnits("0.0000001", 6));
});

test("Agent ohne Zahlung bekommt 402 mit x402-Anforderung und Checkout-Link", async () => {
  const app = await start(simple());
  const r = await fetch(`${app.base}/api/bericht`, { headers: json });
  assert.equal(r.status, 402);
  const body = await r.json();
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts[0].maxAmountRequired, "500000");
  assert.equal(body.accepts[0].asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert.equal(body.checkout, `${app.base}/api/bericht?pw_checkout=1`);
  await app.close();
});

test("Browser wird zu Stripe Checkout weitergeleitet, mit Metadaten und Kennung", async () => {
  const app = await start(simple());
  const r = await fetch(`${app.base}/api/bericht`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(r.status, 303);
  const form = new URLSearchParams(app.fk.calls[0].init.body);
  assert.equal(form.get("line_items[0][price_data][unit_amount]"), "50");
  assert.equal(form.get("line_items[0][price_data][currency]"), "eur");
  assert.equal(form.get("metadata[venture]"), "demo");
  assert.equal(form.get("metadata[pw_resource]"), "GET /api/bericht");
  assert.equal(form.get("metadata[pw_ttl]"), "3600");
  assert.match(form.get("metadata[pw_id]"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(form.get("managed_payments[enabled]"), "false");
  assert.equal(form.get("line_items[0][price_data][product_data][tax_code]"), null);
  await app.close();
});

test("Schutz: Hauptnetz nur ausdrücklich, Mindestbetrag Stripe", () => {
  const common = { access: { secret: "s" }, stripe: { key: "k" } };
  assert.throws(() => paywall({ ...common, price: { usdc: "1" }, x402: { payTo: "0x1", network: "base" } }), /allowMainnet/);
  assert.doesNotThrow(() => paywall({ ...common, price: { usdc: "1" }, x402: { payTo: "0x1", network: "base", allowMainnet: true } }));
  assert.throws(() => paywall({ ...common, price: { eur: "0.30" } }), /0.50/);
});

// ---------------------------------------------------------------- 1. Stripe-Zahlung vollständig prüfen

describe("1. Stripe-Sitzung wird gegen die Kaufdaten geprüft", () => {
  test("gültiger Kauf ergibt Token, Token öffnet die Route", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    const r = await redeem(app, s);
    assert.equal(r.status, 200);
    const { token } = await r.json();
    const r2 = await fetch(`${app.base}/api/bericht`, { headers: { ...json, authorization: `Bearer ${token}` } });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).payment.method, "stripe-token");
    assert.match(app.fk.calls.at(-1).url, /expand\[\]=line_items&expand\[\]=payment_intent\.latest_charge/);
    await app.close();
  });

  const cases = {
    "falscher Betrag (1 Cent)": (s) => { s.amount_total = 1; s.amount_subtotal = 1; s.line_items.data[0].amount_total = 1; s.payment_intent.amount_received = 1; },
    "Rabatt (Zwischensumme ≠ Endbetrag)": (s) => { s.amount_total = 1; },
    "falsche Währung (USD)": (s) => { s.currency = "usd"; },
    "mode=subscription": (s) => { s.mode = "subscription"; },
    "payment_status=unpaid": (s) => { s.payment_status = "unpaid"; },
    "payment_status=no_payment_required": (s) => { s.payment_status = "no_payment_required"; },
    "status=open": (s) => { s.status = "open"; },
    "fehlende pw_id": (s) => { delete s.metadata.pw_id; },
    "gefälschte pw_id": (s) => { s.metadata.pw_id = "A".repeat(43); },
    "gefälschte Dauer (pw_ttl verlängert)": (s) => { s.metadata.pw_ttl = "999999"; },
    "Menge 2": (s) => { s.line_items.data[0].quantity = 2; },
    "zwei Positionen": (s) => { s.line_items.data.push({ quantity: 1, currency: "eur", amount_total: 0 }); },
    "Zahlung nicht abgeschlossen": (s) => { s.payment_intent.status = "processing"; },
    "Livemodus mit Testschlüssel": (s) => { s.livemode = true; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    test(`abgelehnt: ${name}`, async () => {
      const app = await start(simple());
      const s = await checkout(app);
      mutate(s);
      const r = await redeem(app, s);
      assert.equal(r.status, 402);
      assert.doesNotMatch(r.headers.get("set-cookie") || "", /pw_token/);
      await app.close();
    });
  }

  test("abgelehnt: Sitzung einer billigen Ressource an einer teuren", async () => {
    const app = await start((a, pw) => {
      a.get("/billig", pw(), (req, res) => res.json({ was: "billig" }));
      a.get("/teuer", pw({ price: { eur: "5.00" } }), (req, res) => res.json({ was: "teuer" }));
    });
    const s = await checkout(app, "/billig");
    assert.equal((await redeem(app, s, "/billig")).status, 200);
    assert.equal((await redeem(app, s, "/teuer")).status, 402);
    // Auch mit umgeschriebenem Metadatum: Betrag und Kennung passen nicht.
    s.metadata.pw_resource = "GET /teuer";
    assert.equal((await redeem(app, s, "/teuer")).status, 402);
    await app.close();
  });

  test("abgelehnt: Sitzung aus einem anderen Konto (Stripe 404)", async () => {
    const app = await start(simple());
    const r = await fetch(`${app.base}/api/bericht?pw_session=cs_test_fremd`, { headers: json });
    assert.equal(r.status, 402);
    assert.match((await r.json()).error, /unbekannt/);
    await app.close();
  });
});

// ---------------------------------------------------------------- 2. Bindung an die vollständige Ressource

describe("2. Token ist an Methode und vollen Pfad gebunden", () => {
  const routers = (a, pw) => {
    for (const name of ["basic", "premium"]) {
      const r = express.Router();
      r.get("/bericht", pw(), (req, res) => res.json({ von: name }));
      r.post("/bericht", pw(), (req, res) => res.json({ von: `${name}-post` }));
      a.use(`/${name}`, r);
    }
  };

  test("Token von /basic/bericht gilt nicht für /premium/bericht (gleicher Schlüssel)", async () => {
    const app = await start(routers);
    const s = await checkout(app, "/basic/bericht");
    assert.equal(s.metadata.pw_resource, "GET /basic/bericht");
    const { token } = await (await redeem(app, s, "/basic/bericht")).json();
    const auth = { ...json, authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${app.base}/basic/bericht`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${app.base}/premium/bericht`, { headers: auth })).status, 402);
    assert.equal((await redeem(app, s, "/premium/bericht")).status, 402);
    await app.close();
  });

  test("GET-Token gilt nicht für POST", async () => {
    const app = await start(routers);
    const s = await checkout(app, "/basic/bericht");
    const { token } = await (await redeem(app, s, "/basic/bericht")).json();
    const r = await fetch(`${app.base}/basic/bericht`, { method: "POST", headers: { ...json, authorization: `Bearer ${token}` } });
    assert.equal(r.status, 402);
    await app.close();
  });

  test("Rücksprung, Abbruch, Checkout-Link, x402-resource und Cookie-Pfad nennen die volle Adresse", async () => {
    const app = await start(routers);
    const r402 = await (await fetch(`${app.base}/premium/bericht`, { headers: json })).json();
    assert.equal(r402.checkout, `${app.base}/premium/bericht?pw_checkout=1`);
    assert.equal(r402.accepts[0].resource, `${app.base}/premium/bericht`);
    const s = await checkout(app, "/premium/bericht");
    assert.equal(s.success_url, `${app.base}/premium/bericht?pw_session={CHECKOUT_SESSION_ID}`);
    assert.equal(s.cancel_url, `${app.base}/premium/bericht`);
    const r = await fetch(`${app.base}/premium/bericht?pw_session=${s.id}`, { headers: { accept: "text/html" }, redirect: "manual" });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/premium/bericht");
    assert.match(r.headers.get("set-cookie"), /Path=\/premium\/bericht/);
    await app.close();
  });

  test("access.resourceId und access.tenant gehen in die Bindung ein", async () => {
    const app = await start((a, pw) => {
      a.get("/a", pw({ access: { resourceId: "bericht", tenant: "kunde-1" } }), (req, res) => res.json({}));
      a.get("/b", pw({ access: { resourceId: "bericht", tenant: "kunde-2" } }), (req, res) => res.json({}));
    });
    const s = await checkout(app, "/a");
    assert.equal(s.metadata.pw_resource, "kunde-1|id:bericht");
    const { token } = await (await redeem(app, s, "/a")).json();
    assert.equal((await fetch(`${app.base}/b`, { headers: { ...json, authorization: `Bearer ${token}` } })).status, 402);
    await app.close();
  });
});

// ---------------------------------------------------------------- 3. Kaufzeitpunkt und Zugangsdauer

describe("3. Zugang läuft ab Zahlung für die gekaufte Dauer", () => {
  test("Einlösung kurz vor Ende: Token endet zum selben Zeitpunkt", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    app.clock.ms = (T0 + 3590) * 1000;
    const r = await redeem(app, s);
    const body = await r.json();
    assert.equal(body.expiresAt, new Date((T0 + 3600) * 1000).toISOString());
    assert.equal(body.expiresIn, 10);
    app.clock.ms = (T0 + 3601) * 1000;
    assert.equal((await fetch(`${app.base}/api/bericht`, { headers: { ...json, authorization: `Bearer ${body.token}` } })).status, 402);
    await app.close();
  });

  test("zweimaliges Einlösen ergibt dasselbe Ende", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    app.clock.ms = (T0 + 100) * 1000;
    const a = await (await redeem(app, s)).json();
    app.clock.ms = (T0 + 2000) * 1000;
    const b = await (await redeem(app, s)).json();
    assert.equal(a.expiresAt, b.expiresAt);
    assert.equal(a.token, b.token);
    await app.close();
  });

  test("Einlösen nach Ende wird abgelehnt", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    app.clock.ms = (T0 + 3600) * 1000;
    assert.equal((await redeem(app, s)).status, 402);
    await app.close();
  });

  test("Checkout 2 h offen, dann bezahlt: volle Dauer ab Zahlung", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    assert.equal(s.created, T0 - 7200); // Sitzung angelegt 2 h vor der Zahlung
    app.clock.ms = (T0 + 5) * 1000;
    const body = await (await redeem(app, s)).json();
    assert.equal(body.expiresAt, new Date((T0 + 3600) * 1000).toISOString());
    await app.close();
  });

  test("Token-Format v2: alte v1-Tokens, Fälschung, andere Bindung, Ablauf", () => {
    const t = signToken("s", "GET /a", 60);
    assert.equal(verifyToken("s", t, "GET /a", 1000), true);
    assert.equal(verifyToken("s", t, "GET /a", 60_000), false);
    assert.equal(verifyToken("s", t, "GET /b", 1000), false);
    assert.equal(verifyToken("x", t, "GET /a", 1000), false);
    assert.equal(verifyToken("s", t.slice(0, -2) + "AA", "GET /a", 1000), false);
    assert.equal(verifyToken("s", t.replace(/^v2\.60\./, "v2.99999999999."), "GET /a", 1000), false);
    assert.equal(verifyToken("s", "v1" + t.slice(2), "GET /a", 1000), false);
  });
});

// ---------------------------------------------------------------- 4. Bezahlt, aber keine Daten (x402)

describe("4. x402: erst Leistung, dann Abrechnung; Nachweis liefert erneut aus", () => {
  test("gültige Zahlung: verify, Route, settle, Daten und X-PAYMENT-RESPONSE", async () => {
    const counter = { n: 0 };
    const app = await start(simple(counter));
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.payment.method, "x402");
    assert.deepEqual(app.fk.calls.map((c) => c.url.split("/").pop()), ["verify", "settle"]);
    assert.equal(_intern.fromB64json(r.headers.get("x-payment-response")).transaction, "0xtx1");
    assert.equal(counter.n, 1);
    await app.close();
  });

  test("ungültige Zahlung: 402, Route läuft nicht, kein settle", async () => {
    const counter = { n: 0 };
    const app = await start(simple(counter));
    app.fk.verify = "invalid";
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r.status, 402);
    assert.equal(count(app.fk, "/settle"), 0);
    assert.equal(counter.n, 0);
    await app.close();
  });

  test("lokal abgewiesen ohne Facilitator: falsches Netz, fremde Empfangsadresse, zu wenig", async () => {
    const app = await start(simple());
    const bad = [
      _intern.b64json({ ...JSON.parse(Buffer.from(payment(), "base64")), network: "base" }),
      payment({ to: "0x00000000000000000000000000000000000000ff" }),
      payment({ value: "1" }),
      "kein-base64-json",
    ];
    for (const h of bad) assert.equal((await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } })).status, 402);
    assert.equal(app.fk.calls.length, 0);
    await app.close();
  });

  test("fehlgeschlagene Abrechnung liefert keine Daten", async () => {
    const app = await start(simple());
    app.fk.settle = "fail";
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r.status, 402);
    assert.equal((await r.json()).ok, undefined);
    await app.close();
  });

  test("Route wirft Fehler: 500 ohne Stack-Trace, keine Abrechnung", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw(), () => { throw new Error("kaputt"); }));
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.doesNotMatch(text, /kaputt|at .*\.js/);
    assert.equal(count(app.fk, "/settle"), 0);
    await app.close();
  });

  test("Route antwortet 404: durchgereicht, keine Abrechnung", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw(), (req, res) => res.status(404).json({ fehlt: true })));
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { fehlt: true });
    assert.equal(count(app.fk, "/settle"), 0);
    await app.close();
  });

  test("Route zu langsam: 504, keine Abrechnung, späte Antwort der Route wird verworfen", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw(), (req, res) => setTimeout(() => res.write("spät"), 500)));
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r.status, 504);
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(count(app.fk, "/settle"), 0);
    await app.close();
  });

  test("Verbindungsabbruch während der Route: keine Abrechnung", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw(), (req, res) => setTimeout(() => res.json({ ok: true }), 150)));
    const ctrl = new AbortController();
    const p = fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() }, signal: ctrl.signal }).catch((e) => e);
    setTimeout(() => ctrl.abort(), 50);
    assert.equal((await p).name, "AbortError");
    await new Promise((ok) => setTimeout(ok, 250));
    assert.equal(count(app.fk, "/settle"), 0);
    assert.ok(app.events.some((e) => e.type === "abbruch_vor_abrechnung"));
    await app.close();
  });

  test("zwei parallele Anfragen mit demselben Nachweis: eine Abrechnung, eine Ausführung, gleiche Antwort", async () => {
    const counter = { n: 0 };
    const app = await start((a, pw) => a.get("/api/bericht", pw(), (req, res) => setTimeout(() => { counter.n++; res.json({ n: counter.n }); }, 50)));
    const h = payment();
    const [a, b] = await Promise.all([1, 2].map(() => fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } })));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(app.fk.settlements, 1);
    assert.equal(count(app.fk, "/settle"), 1);
    assert.equal(counter.n, 1);
    await app.close();
  });

  test("Nachweis nach Erfolg erneut: gleiche Antwort ohne neue Abrechnung; an anderer Ressource abgelehnt", async () => {
    const counter = { n: 0 };
    const app = await start((a, pw) => {
      a.get("/api/bericht", pw(), (req, res) => { counter.n++; res.json({ n: counter.n }); });
      a.get("/api/anderes", pw(), (req, res) => res.json({ anderes: true }));
    });
    const h = payment();
    const first = await (await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } })).json();
    const again = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), first);
    assert.equal(count(app.fk, "/settle"), 1);
    assert.equal(counter.n, 1);
    assert.equal((await fetch(`${app.base}/api/anderes`, { headers: { "x-payment": h } })).status, 402);
    await app.close();
  });

  test("Abrechnung verarbeitet, Antwort verloren: 503, offener Fall, zweiter Versuch liefert ohne zweite Abrechnung", async () => {
    let mw;
    const app = await start((a, pw) => { mw = pw(); a.get("/api/bericht", mw, (req, res) => res.json({ daten: 42 })); });
    app.fk.settle = "abgerechnet-antwort-weg";
    const h = payment();
    const r1 = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } });
    assert.equal(r1.status, 503);
    assert.equal(r1.headers.get("retry-after"), "10");
    const open = await mw.openCases();
    assert.equal(open.length, 1);
    assert.equal(open[0].state, "unklar");
    app.fk.settle = "ok";
    const r2 = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { daten: 42 });
    assert.equal(app.fk.settlements, 1);
    assert.equal(count(app.fk, "/settle"), 1); // geklärt über die Kette, kein zweiter settle-Aufruf
    assert.equal((await mw.openCases()).length, 0);
    await app.close();
  });

  test("Abrechnung erreicht den Facilitator nicht: zweiter Versuch rechnet genau einmal ab", async () => {
    const app = await start(simple());
    app.fk.settle = "vor-abrechnung-weg";
    const h = payment();
    assert.equal((await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } })).status, 503);
    const r2 = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } });
    assert.equal(r2.status, 200);
    assert.equal(app.fk.settlements, 1);
    await app.close();
  });

  test("unklar und Kette nicht erreichbar: weiter 503, Fall bleibt offen", async () => {
    let mw;
    const app = await start((a, pw) => { mw = pw(); a.get("/api/bericht", mw, (req, res) => res.json({})); });
    app.fk.settle = "abgerechnet-antwort-weg";
    const h = payment();
    await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } });
    app.fk.rpc = "html";
    assert.equal((await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h } })).status, 503);
    assert.equal((await mw.openCases()).length, 1);
    await app.close();
  });

  test("Speicher: memoryStore verfällt und begrenzt die Größe", () => {
    const st = memoryStore({ maxEntries: 2 });
    st.set("a", { x: 1 }, 60); st.set("b", { x: 2 }, 60); st.set("c", { x: 3 }, 60);
    assert.equal(st.get("a"), undefined);
    assert.deepEqual(st.list().map((e) => e.id), ["b", "c"]);
    st.set("d", { x: 4 }, -1);
    assert.equal(st.get("d"), undefined);
  });
});

// ---------------------------------------------------------------- 5. Fehler der Gegenstellen

describe("5. Zeitüberschreitung, HTML statt JSON, 5xx: kontrollierte Antwort", () => {
  const cases = [
    ["Facilitator verify Zeitüberschreitung", "verify", "timeout", 503],
    ["Facilitator verify HTML", "verify", "html", 502],
    ["Facilitator verify 500", "verify", "500", 503],
  ];
  for (const [name, field, mode, status] of cases) {
    test(name, async () => {
      const app = await start(simple());
      app.fk[field] = mode;
      const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
      assert.equal(r.status, status);
      assert.equal(r.headers.get("retry-after"), "5");
      const text = await r.text();
      assert.doesNotMatch(text, /at .*\.js|Bad Gateway|intern"/);
      assert.equal(count(app.fk, "/settle"), 0);
      await app.close();
    });
  }

  test("Facilitator settle HTML: 503, Fall bleibt unklar statt bezahlt", async () => {
    const app = await start(simple());
    app.fk.settle = "html";
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("x-payment-response"), null);
    await app.close();
  });

  for (const [mode, status] of [["timeout", 503], ["html", 502], ["500", 503]]) {
    test(`Stripe Checkout anlegen: ${mode}`, async () => {
      const app = await start(simple());
      app.fk.stripePost = mode;
      const r = await fetch(`${app.base}/api/bericht`, { headers: { accept: "text/html" }, redirect: "manual" });
      assert.equal(r.status, status);
      assert.equal(r.headers.get("location"), null);
      await app.close();
    });
    test(`Stripe Sitzung prüfen: ${mode} – kein Token`, async () => {
      const app = await start(simple());
      const s = await checkout(app);
      app.fk.stripeGet = mode;
      const r = await redeem(app, s);
      assert.equal(r.status, status);
      assert.equal(r.headers.get("set-cookie"), null);
      await app.close();
    });
  }
});
