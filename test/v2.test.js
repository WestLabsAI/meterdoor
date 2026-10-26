// x402 Version 2 (HTTP-Transport): PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE; Version 1 bleibt unverändert.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { paywall, NETWORKS, _intern } from "../src/index.js";
import { fake, start, simple, payment, authOf, PAY_TO, T0, count, json } from "./hilfen.js";

const NET = NETWORKS["base-sepolia"];
const accepted = (over = {}) => ({
  scheme: "exact", network: "eip155:84532", amount: "500000", asset: NET.asset, payTo: PAY_TO,
  maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...over,
});
let seq = 0;
// Nachweis Version 2; `acc` ändert die gewählte Anforderung, `auth` die Autorisierung.
function paymentV2({ acc = {}, auth = {}, sig = "0xsig" } = {}) {
  const authorization = {
    from: "0x00000000000000000000000000000000000000cd", to: PAY_TO, value: "500000",
    validAfter: "0", validBefore: String(T0 + 60), nonce: "0x" + String(900000 + ++seq).padStart(64, "0"), ...auth,
  };
  return _intern.b64json({
    x402Version: 2, resource: { url: "http://x/api/bericht" }, accepted: accepted(acc),
    payload: { signature: sig, authorization },
  });
}
const v2get = (app, h, p = "/api/bericht") => fetch(`${app.base}${p}`, { headers: { "payment-signature": h } });
const decode = (h) => _intern.fromB64json(h);
const facBodies = (fk) => fk.calls.filter((c) => /\/(verify|settle)$/.test(c.url)).map((c) => JSON.parse(c.init.body));

describe("x402 v2: Anforderungen", () => {
  test("402 trägt PAYMENT-REQUIRED (Version 2), Body bleibt Version 1", async () => {
    const app = await start(simple());
    const r = await fetch(`${app.base}/api/bericht`, { headers: json });
    assert.equal(r.status, 402);
    const pr = decode(r.headers.get("payment-required"));
    assert.equal(pr.x402Version, 2);
    assert.match(pr.resource.url, /\/api\/bericht$/);
    assert.equal(pr.resource.description, "Testbericht");
    assert.deepEqual(pr.accepts, [accepted()]);
    const body = await r.json();
    assert.equal(body.x402Version, 1);
    assert.equal(body.accepts[0].network, "base-sepolia");
    assert.equal(body.accepts[0].maxAmountRequired, "500000");
    assert.match(body.checkout, /pw_checkout=1/);
    await app.close();
  });

  test("nur Version 2: Body ist das PaymentRequired-Objekt, X-PAYMENT wird abgewiesen", async () => {
    const counter = { n: 0 };
    const app = await start((a, pw) => a.get("/api/bericht", pw({ x402: { versions: [2] } }), (req, res) => { counter.n++; res.json({ ok: true }); }));
    const r = await fetch(`${app.base}/api/bericht`, { headers: json });
    const body = await r.json();
    assert.equal(body.x402Version, 2);
    assert.deepEqual(body.accepts, [accepted()]);
    const r1 = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": payment() } });
    assert.equal(r1.status, 402);
    assert.match((await r1.json()).error, /Version 1/);
    assert.equal(app.fk.calls.length, 0);
    assert.equal(counter.n, 0);
    await app.close();
  });

  test("nur Version 1: kein PAYMENT-REQUIRED, PAYMENT-SIGNATURE wird abgewiesen", async () => {
    const app = await start((a, pw) => a.get("/api/bericht", pw({ x402: { versions: [1] } }), (req, res) => res.json({ ok: true })));
    const r = await fetch(`${app.base}/api/bericht`, { headers: json });
    assert.equal(r.headers.get("payment-required"), null);
    const r2 = await v2get(app, paymentV2());
    assert.equal(r2.status, 402);
    assert.equal(app.fk.calls.length, 0);
    await app.close();
  });

  test("x402.versions wird geprüft", () => {
    const base = { price: { usdc: "0.50" }, x402: { payTo: PAY_TO } };
    for (const versions of [[], [3], "2", [1, "2"]]) {
      assert.throws(() => paywall({ ...base, x402: { ...base.x402, versions } }), /x402\.versions/);
    }
  });
});

describe("x402 v2: Zahlung", () => {
  test("gültige Zahlung: verify und settle mit Version 2 und eigenen Anforderungen, PAYMENT-RESPONSE", async () => {
    const counter = { n: 0 };
    const app = await start(simple(counter));
    const r = await v2get(app, paymentV2());
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.payment.method, "x402");
    assert.equal(body.payment.version, 2);
    const resp = decode(r.headers.get("payment-response"));
    assert.deepEqual(resp, { success: true, transaction: "0xtx1", network: "eip155:84532", payer: "0x00000000000000000000000000000000000000cd" });
    assert.equal(r.headers.get("x-payment-response"), null);
    const calls = facBodies(app.fk);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.x402Version, 2);
      assert.deepEqual(c.paymentRequirements, accepted());
      assert.equal(c.paymentPayload.x402Version, 2);
    }
    assert.equal(counter.n, 1);
    await app.close();
  });

  test("lokal abgewiesen ohne Facilitator: Netz, Betrag, Empfänger, Asset, Schema, Transfermethode", async () => {
    const counter = { n: 0 };
    const app = await start(simple(counter));
    const bad = [
      paymentV2({ acc: { network: "eip155:8453" } }),
      paymentV2({ acc: { network: "base-sepolia" } }),
      paymentV2({ acc: { amount: "1" } }),
      paymentV2({ acc: { amount: "5000000" } }),
      paymentV2({ acc: { payTo: "0x00000000000000000000000000000000000000ff" } }),
      paymentV2({ acc: { asset: "0x0000000000000000000000000000000000000abc" } }),
      paymentV2({ acc: { scheme: "upto" } }),
      paymentV2({ acc: { extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } } }),
      paymentV2({ auth: { to: "0x00000000000000000000000000000000000000ff" } }),
      paymentV2({ auth: { value: "1" } }),
      _intern.b64json({ ...decode(paymentV2()), x402Version: 1 }),
      _intern.b64json({ ...decode(paymentV2()), accepted: undefined }),
    ];
    for (const h of bad) {
      const r = await v2get(app, h);
      assert.equal(r.status, 402, decode(h).accepted ? JSON.stringify(decode(h).accepted) : "ohne accepted");
      assert.ok(r.headers.get("payment-required"));
    }
    assert.equal(app.fk.calls.length, 0);
    assert.equal(counter.n, 0);
    await app.close();
  });

  test("unlesbarer Nachweis: 400 mit PAYMENT-REQUIRED", async () => {
    const app = await start(simple());
    const r = await v2get(app, "kein-base64-json");
    assert.equal(r.status, 400);
    assert.ok(r.headers.get("payment-required"));
    assert.equal(app.fk.calls.length, 0);
    await app.close();
  });

  test("assetTransferMethod eip3009 ausdrücklich: angenommen", async () => {
    const app = await start(simple());
    const r = await v2get(app, paymentV2({ acc: { extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } } }));
    assert.equal(r.status, 200);
    await app.close();
  });

  test("derselbe Nachweis erneut: gleiche Antwort, eine Abrechnung, PAYMENT-RESPONSE", async () => {
    const counter = { n: 0 };
    const app = await start(simple(counter));
    const h = paymentV2();
    const a = await v2get(app, h);
    const b = await v2get(app, h);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal(a.headers.get("payment-response"), b.headers.get("payment-response"));
    assert.equal(b.headers.get("x-payment-response"), null);
    assert.equal(count(app.fk, "/settle"), 1);
    assert.equal(counter.n, 1);
    await app.close();
  });

  test("dieselbe Autorisierung erst als v1, dann als v2: abweichender Nachweis, keine zweite Abrechnung", async () => {
    const app = await start(simple());
    const h1 = payment();
    const auth = authOf(h1);
    assert.equal((await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": h1 } })).status, 200);
    const r = await v2get(app, paymentV2({ auth }));
    assert.equal(r.status, 402);
    assert.match((await r.json()).error, /weicht/);
    assert.equal(count(app.fk, "/settle"), 1);
    await app.close();
  });

  test("beide Header: PAYMENT-SIGNATURE gilt", async () => {
    const app = await start(simple());
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "payment-signature": paymentV2(), "x-payment": "kaputt" } });
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("payment-response"));
    await app.close();
  });

  test("Abrechnung abgelehnt: 402 mit PAYMENT-REQUIRED, keine Daten", async () => {
    const app = await start(simple());
    app.fk.settle = "fail";
    const r = await v2get(app, paymentV2());
    assert.equal(r.status, 402);
    assert.ok(r.headers.get("payment-required"));
    assert.equal((await r.json()).ok, undefined);
    await app.close();
  });
});

describe("settlement_pending (Version 2): unklar statt abgelehnt", () => {
  // Facilitator sendet die Transaktion, kann die Bestätigung aber nicht feststellen (vor dem App-Start eingehängt).
  function pendingFake() {
    const fk = fake();
    const orig = fk.fetch;
    fk.fetch = async (url, init) => {
      if (url.endsWith("/settle") && fk.settle === "pending") {
        fk.calls.push({ url, init });
        const auth = JSON.parse(init.body).paymentPayload.payload.authorization;
        fk.usedNonces.add(auth.nonce); // auf der Kette doch bestätigt
        return { ok: false, status: 400, text: async () => JSON.stringify({ success: false, errorReason: "settlement_pending", transaction: "0xpending", network: "eip155:84532" }) };
      }
      return orig(url, init);
    };
    return fk;
  }

  for (const [name, mk] of [["v2", () => paymentV2()], ["v1", () => payment()]]) {
    test(`${name}: 503, Fall bleibt offen, nächster Abruf klärt über die Kette und liefert aus`, async () => {
      const counter = { n: 0 };
      const app = await start((a, pw) => {
        const mw = pw();
        a.get("/api/bericht", mw, (req, res) => { counter.n++; res.json({ ok: true }); });
        a.get("/offen", async (req, res) => res.json(await mw.openCases()));
      }, { fk: pendingFake() });
      app.fk.settle = "pending";
      const h = mk();
      const hdr = name === "v2" ? { "payment-signature": h } : { "x-payment": h };
      const r1 = await fetch(`${app.base}/api/bericht`, { headers: hdr });
      assert.equal(r1.status, 503);
      const offen = await (await fetch(`${app.base}/offen`)).json();
      assert.equal(offen.length, 1);
      assert.equal(offen[0].state, "unklar");
      app.fk.settle = "ok";
      const r2 = await fetch(`${app.base}/api/bericht`, { headers: hdr });
      assert.equal(r2.status, 200);
      assert.deepEqual(await r2.json(), { ok: true });
      assert.equal(counter.n, 1);
      assert.equal(count(app.fk, "/settle"), 1);
      await app.close();
    });
  }
});
