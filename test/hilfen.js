// Gemeinsame Testhilfen: nachgebildete Gegenstellen (Facilitator, Stripe, RPC), App-Start, Zahlungsnachweise.
import assert from "node:assert/strict";
import express from "express";
import { paywall, _intern } from "../src/index.js";

// Nachgebildete Gegenstellen (Facilitator, Stripe, RPC) mit einstellbaren Fehlern. Kein Netz, keine Schlüssel.
// Echte Gegenstellen: test/integration.test.js (läuft nur mit Testschlüsseln aus .secrets/).

export const SECRET = "geheim-nur-fuer-tests";
export const PAY_TO = "0x0000000000000000000000000000000000000001";
export const T0 = 1_800_000_000; // Sekunden; die Uhr der Middleware wird über `now` gesteuert

export function fake() {
  const s = {
    calls: [], sessions: new Map(), usedNonces: new Set(), settlements: 0,
    verify: "ok", settle: "ok", stripePost: "ok", stripeGet: "ok", rpc: "ok", paidAt: T0,
  };
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const hang = (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(signal.reason)));
  const failure = (mode, signal) => {
    if (mode === "timeout") return hang(signal);
    if (mode === "html") return reply(200, "<html><body>Bad Gateway</body></html>");
    if (mode === "500") return reply(500, { error: { message: "intern" } });
    return null;
  };
  s.fetch = async (url, init = {}) => {
    s.calls.push({ url, init });
    const body = init.body && init.headers?.["content-type"] === "application/json" ? JSON.parse(init.body) : null;
    if (url.endsWith("/verify")) {
      const f = failure(s.verify, init.signal); if (f) return f;
      const auth = body.paymentPayload.payload.authorization;
      if (s.verify === "invalid" || s.usedNonces.has(auth.nonce)) return reply(400, { isValid: false, invalidReason: "invalid_payload" });
      return reply(200, { isValid: true, payer: auth.from });
    }
    if (url.endsWith("/settle")) {
      const auth = body.paymentPayload.payload.authorization;
      // Absturz vor der Abrechnung: Anfrage kommt nie an, Antwort kommt nie (auch keine Zeitüberschreitung).
      if (s.settle === "haengt") { s.settleHangs = (s.settleHangs || 0) + 1; return new Promise(() => {}); }
      if (s.settle === "vor-abrechnung-weg") { s.settle = "ok"; return Promise.reject(new TypeError("fetch failed")); }
      if (s.settle === "abgerechnet-antwort-weg") { s.usedNonces.add(auth.nonce); s.settlements++; return hang(init.signal); }
      const f = failure(s.settle, init.signal); if (f) return f;
      if (s.settle === "fail" || s.usedNonces.has(auth.nonce)) return reply(400, { success: false, errorReason: "invalid_transaction_state" });
      s.usedNonces.add(auth.nonce); s.settlements++;
      return reply(200, { success: true, transaction: `0xtx${s.settlements}`, network: "base-sepolia", payer: auth.from });
    }
    if (url.startsWith("https://rpc.test")) {
      const f = failure(s.rpc, init.signal); if (f) return f;
      const nonce = "0x" + body.params[0].data.slice(-64);
      return reply(200, { jsonrpc: "2.0", id: 1, result: "0x" + (s.usedNonces.has(nonce) ? "1" : "0").padStart(64, "0") });
    }
    if (url.endsWith("/checkout/sessions") && init.method === "POST") {
      const f = failure(s.stripePost, init.signal); if (f) return f;
      const form = Object.fromEntries(new URLSearchParams(init.body));
      const id = `cs_test_${s.sessions.size + 1}`;
      const amount = Number(form["line_items[0][price_data][unit_amount]"]);
      const metadata = Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
      s.sessions.set(id, {
        object: "checkout.session", id, livemode: false, mode: form.mode, status: "complete", payment_status: "paid",
        currency: form["line_items[0][price_data][currency]"], amount_total: amount, amount_subtotal: amount, metadata,
        created: s.paidAt - 7200, success_url: form.success_url, cancel_url: form.cancel_url,
        line_items: { object: "list", has_more: false, data: [{ quantity: 1, currency: "eur", amount_total: amount }] },
        payment_intent: {
          status: "succeeded", currency: "eur", amount_received: amount, created: s.paidAt - 60,
          latest_charge: { paid: true, status: "succeeded", created: s.paidAt },
        },
      });
      return reply(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    const m = url.match(/\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\?/);
    if (m) {
      const f = failure(s.stripeGet, init.signal); if (f) return f;
      if (!s.sessions.has(m[1])) return reply(404, { error: { message: "No such checkout.session" } });
      return reply(200, s.sessions.get(m[1]));
    }
    return reply(404, { error: { message: "unbekannt" } });
  };
  return s;
}

// Baut eine App; `routes(app, pw)` hängt Routen ein, pw(extra) erzeugt eine Middleware mit gemeinsamen Optionen.
export async function start(routes, { fk = fake(), clock = { ms: T0 * 1000 }, events = [] } = {}) {
  const pw = (extra = {}) => paywall({
    price: { eur: "0.50", usdc: "0.50" },
    stripe: { key: "sk_test_dummy", metadata: { venture: "demo" }, timeoutMs: 150 },
    x402: {
      payTo: PAY_TO, network: "base-sepolia", facilitatorUrl: "https://facilitator.test", rpcUrl: "https://rpc.test",
      timeoutMs: 150, routeTimeoutMs: 300, ...extra.x402,
    },
    access: { secret: SECRET, ...extra.access },
    description: "Testbericht",
    fetch: fk.fetch,
    now: () => clock.ms,
    onEvent: (e) => events.push(e),
    ...(extra.price ? { price: extra.price } : {}),
  });
  const app = express();
  routes(app, pw);
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, fk, clock, events, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export const simple = (counter = { n: 0 }) => (app, pw) => {
  app.get("/api/bericht", pw(), (req, res) => { counter.n++; res.json({ ok: true, payment: req.payment }); });
};

let nonceSeq = 0;
// Zahlungsnachweis; `sig` ersetzt die Signatur (undefined = ohne Signatur), `auth` übernimmt eine Autorisierung.
export function payment(over = {}, opts = {}) {
  const sig = "sig" in opts ? opts.sig : "0xsig";
  const auth = {
    from: "0x00000000000000000000000000000000000000ab", to: PAY_TO, value: "500000",
    validAfter: "0", validBefore: String(T0 + 60), nonce: "0x" + String(++nonceSeq).padStart(64, "0"), ...opts.auth, ...over,
  };
  const payload = { authorization: auth };
  if (sig !== undefined) payload.signature = sig;
  return _intern.b64json({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload });
}
export const authOf = (h) => _intern.fromB64json(h).payload.authorization;
export const json = { accept: "application/json" };
export const count = (fk, end) => fk.calls.filter((c) => c.url.endsWith(end)).length;

// Kauft über die Middleware ein (Checkout anlegen) und gibt die Sitzung zum Verändern zurück.
export async function checkout(app, path = "/api/bericht", method = "GET") {
  const r = await fetch(`${app.base}${path}${path.includes("?") ? "&" : "?"}pw_checkout=1`, { method, headers: json, redirect: "manual" });
  assert.equal(r.status, 303);
  const id = r.headers.get("location").split("/").pop();
  return app.fk.sessions.get(id);
}
export const redeem = (app, s, path = "/api/bericht", method = "GET") => fetch(`${app.base}${path}${path.includes("?") ? "&" : "?"}pw_session=${s.id}`, { method, headers: json });
