// Abbruch im Stripe Checkout: verständlicher Abbruchzustand statt erneuter Weiterleitung (keine Checkout-Schleife).
// Nur nachgebildete Gegenstellen, keine Schlüssel.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { paywall, bindQuery } from "../src/index.js";
import { start, simple, json, checkout, redeem } from "./hilfen.js";

const html = { accept: "text/html,application/xhtml+xml" };
const posts = (fk) => fk.calls.filter((c) => c.url.endsWith("/checkout/sessions") && c.init.method === "POST").length;

describe("Stripe-Abbruch", () => {
  test("Rückkehr über cancel_url: Abbruchseite (402), keine neue Checkout-Sitzung, kein Zugang", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    assert.equal(s.cancel_url, `${app.base}/api/bericht?pw_cancelled=1`);
    const before = posts(app.fk);
    const r = await fetch(s.cancel_url, { headers: html, redirect: "manual" });
    assert.equal(r.status, 402);
    assert.equal(r.headers.get("location"), null, "keine Weiterleitung zu Stripe");
    assert.equal(r.headers.get("set-cookie"), null, "kein Zugangstoken");
    assert.match(r.headers.get("content-type"), /text\/html/);
    const page = await r.text();
    assert.match(page, /Zahlung abgebrochen/);
    assert.match(page, /nichts berechnet/);
    assert.match(page, /<a[^>]+href="\/api\/bericht\?pw_checkout=1"[^>]*>Erneut versuchen<\/a>/);
    assert.equal(posts(app.fk), before, "Rückkehr erzeugt keine Checkout-Sitzung");
    assert.ok(app.events.some((e) => e.type === "stripe_abgebrochen"));
    // Nachgelagert weiterhin keine Freischaltung
    assert.equal((await fetch(`${app.base}/api/bericht`, { headers: json })).status, 402);
    await app.close();
  });

  test("„Erneut versuchen“ startet genau einen neuen Versuch", async () => {
    const app = await start(simple());
    await checkout(app);
    await fetch(`${app.base}/api/bericht?pw_cancelled=1`, { headers: html, redirect: "manual" });
    const before = posts(app.fk);
    const r = await fetch(`${app.base}/api/bericht?pw_checkout=1`, { headers: html, redirect: "manual" });
    assert.equal(r.status, 303);
    assert.match(r.headers.get("location"), /^https:\/\/checkout\.stripe\.com\//);
    assert.equal(posts(app.fk) - before, 1);
    await app.close();
  });

  test("Abbruch per JSON: 402 mit Hinweis und Checkout-Link, keine Sitzung", async () => {
    const app = await start(simple());
    const r = await fetch(`${app.base}/api/bericht?pw_cancelled=1`, { headers: json });
    assert.equal(r.status, 402);
    const body = await r.json();
    assert.match(body.error, /abgebrochen/);
    assert.equal(body.checkout, `${app.base}/api/bericht?pw_checkout=1`);
    assert.equal(body.accepts.length, 1, "x402 bleibt möglich");
    assert.equal(posts(app.fk), 0);
    await app.close();
  });

  test("gültiges Token hat Vorrang: wer schon gekauft hat, sieht die Route", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    const { token } = await (await redeem(app, s)).json();
    const r = await fetch(`${app.base}/api/bericht?pw_cancelled=1`, { headers: { ...json, authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    await app.close();
  });

  test("mit access.bind bleibt die eigene Query im Abbruchziel und im Wiederholungslink", async () => {
    const app = await start((a, pw) => a.get("/bericht", pw({ access: { bind: bindQuery(["id"]) } }), (req, res) => res.json({})));
    const s = await checkout(app, "/bericht?id=7");
    assert.equal(s.cancel_url, `${app.base}/bericht?id=7&pw_cancelled=1`);
    const page = await (await fetch(s.cancel_url, { headers: html })).text();
    assert.match(page, /href="\/bericht\?id=7&amp;pw_checkout=1"/);
    await app.close();
  });

  test("eigenes Abbruchziel stripe.cancelUrl wird übernommen", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw(), (req, res) => res.json({})));
    // Eigenes Ziel über eine zweite Middleware mit denselben Hilfen
    const fk = app.fk;
    const mw = paywall({ price: { eur: "0.50" }, stripe: { key: "sk_test_dummy", cancelUrl: "https://shop.example/abgebrochen?x=1" },
      access: { secret: "s" }, fetch: fk.fetch });
    await app.close();
    const app2 = await start((a) => a.get("/api/bericht", mw, (req, res) => res.json({})), { fk });
    const s = await checkout(app2);
    assert.equal(s.cancel_url, "https://shop.example/abgebrochen?x=1");
    await app2.close();
  });

  test("ungültige Abbruchziele werden beim Start abgewiesen", () => {
    const opts = (cancelUrl) => ({ price: { eur: "0.50" }, stripe: { key: "sk_test_dummy", cancelUrl }, access: { secret: "s" } });
    for (const bad of ["javascript:alert(1)", "/relativ", "ftp://example.com/", "http://example.com/abbruch", "https://user:pw@example.com/",
      "data:text/html,x", "", 42, "https://example.com/#frag\n"]) {
      assert.throws(() => paywall(opts(bad)), /stripe.cancelUrl/, String(bad));
    }
    for (const ok of ["https://example.com/abbruch", "http://localhost:3000/abbruch", "http://127.0.0.1:8402/"]) {
      assert.doesNotThrow(() => paywall(opts(ok)), ok);
    }
  });

  test("erfolgreiche Rückkehr und Einlösung funktionieren weiterhin", async () => {
    const app = await start(simple());
    const s = await checkout(app);
    const r = await fetch(`${app.base}/api/bericht?pw_session=${s.id}`, { headers: html, redirect: "manual" });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/api/bericht");
    assert.match(r.headers.get("set-cookie"), /^pw_token=/);
    await app.close();
  });
});

test("Euro-Preis über dem Stripe-Höchstbetrag wird beim Start abgewiesen (gleiche Regel wie Pro)", () => {
  const o = (eur) => ({ price: { eur }, stripe: { key: "sk_test_dummy" }, access: { secret: "s" } });
  assert.doesNotThrow(() => paywall(o("999999.99")));
  assert.throws(() => paywall(o("1000000.00")), /999999.99/);
  assert.throws(() => paywall(o("0.505")), RangeError);
  assert.throws(() => paywall(o(0.5)), TypeError);
});
