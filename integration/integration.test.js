// Tests gegen echte Gegenstellen. Nur Testmodus und Testnetz; Schlüssel nur aus .secrets/ (nie im Repo).
//   Stripe:  .secrets/stripe-test-key.txt (sk_test_… oder rk_test_…)
//   x402:    .secrets/x402-testnet-wallet.json (Base Sepolia, Chain-ID 84532) mit Test-USDC beim Zahler
// Fehlt etwas, wird der jeweilige Test übersprungen (nicht als Fehler gewertet).
// Zahlender Client ist x402-fetch (Referenz-Client von Coinbase), nicht der eigene Code.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { paywall, _intern } from "../src/index.js";

const SECRETS = path.resolve(import.meta.dirname, "../../../.secrets");
const read = (f) => { try { return fs.readFileSync(path.join(SECRETS, f), "utf8").trim(); } catch { return null; } };
const stripeKey = read("stripe-test-key.txt");
const wallet = (() => { try { return JSON.parse(read("x402-testnet-wallet.json")); } catch { return null; } })();
if (stripeKey && !/^(sk|rk)_test_/.test(stripeKey)) throw new Error("Nur Stripe-Testschlüssel erlaubt");
if (wallet && wallet.chainId !== 84532) throw new Error("Nur Testnetz-Wallet (Base Sepolia) erlaubt");

const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC = "https://sepolia.base.org";

async function usdcBalance(address) {
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_SEPOLIA, data }, "latest"] }),
    signal: AbortSignal.timeout(10000),
  });
  return BigInt((await r.json()).result);
}

async function serve(mw, handler = (req, res) => res.json({ daten: "Testbericht", bezahltMit: req.payment?.method })) {
  const app = express();
  app.get("/api/bericht", mw, handler);
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// Ein formal vollständiger, aber nicht gültig signierter Nachweis (für Ablehnungs- und Fehlerfälle, ohne Guthaben).
function unsignedPayment(payTo) {
  return _intern.b64json({
    x402Version: 1, scheme: "exact", network: "base-sepolia",
    payload: {
      signature: "0x" + "11".repeat(65),
      authorization: {
        from: "0x00000000000000000000000000000000000000ab", to: payTo, value: "10000", validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: "0x" + "22".repeat(32),
      },
    },
  });
}

describe("Stripe-Testmodus", { skip: stripeKey ? false : "kein .secrets/stripe-test-key.txt" }, () => {
  const mw = () => paywall({
    price: { eur: "0.50" },
    stripe: { key: stripeKey, metadata: { venture: "v18" } },
    access: { secret: "integration-" + Date.now() },
    description: "Beispielbericht (Testmodus)",
  });

  test("Checkout wird angelegt; unbezahlte echte Sitzung öffnet nichts", async () => {
    const app = await serve(mw());
    const r = await fetch(`${app.base}/api/bericht?pw_checkout=1`, { headers: { accept: "application/json" }, redirect: "manual" });
    assert.equal(r.status, 303);
    const loc = r.headers.get("location");
    assert.match(loc, /^https:\/\/checkout\.stripe\.com\//);
    const id = loc.match(/cs_test_[A-Za-z0-9]+/)[0];
    const r2 = await fetch(`${app.base}/api/bericht?pw_session=${id}`, { headers: { accept: "application/json" } });
    assert.equal(r2.status, 402); // 402 statt 502 heißt auch: Stripe akzeptiert die expand-Parameter
    assert.match((await r2.json()).error, /nicht bezahlt/);
    await app.close();
  });

  test("unbekannte Sitzung: 402, nicht 500", async () => {
    const app = await serve(mw());
    const r = await fetch(`${app.base}/api/bericht?pw_session=cs_test_gibtesnicht123`, { headers: { accept: "application/json" } });
    assert.equal(r.status, 402);
    await app.close();
  });

  test("Zeitüberschreitung gegenüber Stripe: 503 mit Retry-After", async () => {
    const app = await serve(paywall({ price: { eur: "0.50" }, stripe: { key: stripeKey, timeoutMs: 1 }, access: { secret: "x" } }));
    const r = await fetch(`${app.base}/api/bericht?pw_checkout=1`, { headers: { accept: "application/json" }, redirect: "manual" });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "5");
    await app.close();
  });
});

describe("x402 Base Sepolia, öffentlicher Facilitator (ohne Guthaben)", () => {
  const payTo = wallet?.empfaenger.address || "0x000000000000000000000000000000000000dEaD";

  test("ungültige Signatur: echter Facilitator lehnt ab, 402, Route läuft nicht", async () => {
    let ran = false;
    const app = await serve(paywall({ price: { usdc: "0.01" }, x402: { payTo, network: "base-sepolia" } }), (req, res) => { ran = true; res.json({}); });
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": unsignedPayment(payTo) } });
    assert.equal(r.status, 402);
    assert.ok((await r.json()).error);
    assert.equal(ran, false);
    await app.close();
  });

  test("Facilitator-Adresse liefert HTML: 502, kein Stack-Trace", async () => {
    const app = await serve(paywall({ price: { usdc: "0.01" }, x402: { payTo, network: "base-sepolia", facilitatorUrl: "https://example.com" } }));
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": unsignedPayment(payTo) } });
    assert.ok([502, 503].includes(r.status), `Status ${r.status}`);
    assert.doesNotMatch(await r.text(), /at .*\.js/);
    await app.close();
  });

  test("Facilitator antwortet nicht rechtzeitig: 503", async () => {
    const app = await serve(paywall({ price: { usdc: "0.01" }, x402: { payTo, network: "base-sepolia", timeoutMs: 1 } }));
    const r = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": unsignedPayment(payTo) } });
    assert.equal(r.status, 503);
    await app.close();
  });
});

const funded = wallet ? await usdcBalance(wallet.zahler.address).catch(() => 0n) : 0n;
describe("x402 Base Sepolia, echte Testzahlung mit x402-fetch", {
  skip: !wallet ? "kein .secrets/x402-testnet-wallet.json" : funded < 20000n ? `Zahler ${wallet.zahler.address} hat < 0,02 Test-USDC` : false,
}, () => {
  test("zahlen, ausliefern, gleichen Nachweis erneut: gleiche Antwort ohne zweite Abrechnung", async () => {
    const { wrapFetchWithPayment, createSigner, decodeXPaymentResponse } = await import("x402-fetch");
    const events = [];
    const app = await serve(paywall({
      price: { usdc: "0.01" },
      x402: { payTo: wallet.empfaenger.address, network: "base-sepolia", timeoutMs: 30000 },
      onEvent: (e) => events.push(e),
    }));
    const sent = [];
    const recording = (url, init = {}) => { const h = new Headers(init.headers); if (h.get("x-payment")) sent.push(h.get("x-payment")); return fetch(url, init); };
    const signer = await createSigner("base-sepolia", wallet.zahler.privateKey);
    const pay = wrapFetchWithPayment(recording, signer, 20000n);
    const before = await usdcBalance(wallet.empfaenger.address);
    const r = await pay(`${app.base}/api/bericht`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const receipt = decodeXPaymentResponse(r.headers.get("x-payment-response"));
    assert.match(receipt.transaction, /^0x[0-9a-f]{64}$/i);
    assert.equal(await usdcBalance(wallet.empfaenger.address) - before, 10000n);
    const again = await fetch(`${app.base}/api/bericht`, { headers: { "x-payment": sent[0] } });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), body);
    assert.equal(events.filter((e) => e.type === "abgerechnet").length, 1);
    await app.close();
  });
});
