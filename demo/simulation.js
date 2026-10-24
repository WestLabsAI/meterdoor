// Simulierte Gegenstellen für die Demo: Stripe, Facilitator und RPC über eine injizierte fetch-Funktion.
// Kein Netz, keine Schlüssel, kein Geld. Jede Anfrage an eine unbekannte Adresse wird abgelehnt (nie ins Internet).
import crypto from "node:crypto";
import { _intern } from "../src/index.js";

export const NETWORK = "base-sepolia";
export const STRIPE_DUMMY_KEY = "sk_test_demo";
export const PAY_TO = "0x0000000000000000000000000000000000000001";
export const AGENT_WALLET = "0x00000000000000000000000000000000000000ab";
export const FACILITATOR_URL = "https://facilitator.simulation.invalid";
export const RPC_URL = "https://rpc.simulation.invalid";
const SIM_SIGNATURE = "0x" + "51".repeat(65); // erkennbar simulierte Signatur, nicht kryptografisch

// ---------- Startschutz ----------

// Variablennamen, die auf echte Zugänge hindeuten: Ist einer davon gesetzt, startet die Demo nicht (streng).
const VERBOTENE_NAMEN = /STRIPE|WALLET|PRIVATE_?KEY|MNEMONIC|SEED_?PHRASE|PAY_?TO|FACILITATOR|RPC_?URL|CDP_API|ACCESS_SECRET|X402/i;
// Werte, die wie echte Schlüssel aussehen – egal unter welchem Namen.
const VERBOTENE_WERTE = [
  [/(^|[^A-Za-z0-9])(sk|rk|pk)_(live|test)_[A-Za-z0-9]/, "Stripe-Schlüssel"],
  [/(^|[^A-Za-z0-9])whsec_[A-Za-z0-9]/, "Stripe-Webhook-Geheimnis"],
  [/^0x[0-9a-fA-F]{64}$/, "möglicher privater Wallet-Schlüssel"],
];
// 64 Hex-Zeichen ohne 0x sind oft harmlose Kennungen; unter schlüsselartigem Namen gelten sie als Wallet-Schlüssel.
const SCHLUESSEL_NAME = /KEY|SECRET|PRIV|WALLET|SIGNER|ACCOUNT|MNEMONIC/i;

// Liefert eine Liste von Funden (nur Namen, nie Werte). Leere Liste = sicher.
export function pruefeUmgebung(env = process.env) {
  const funde = [];
  for (const [name, wert] of Object.entries(env)) {
    if (wert === undefined || wert === "") continue;
    if (VERBOTENE_NAMEN.test(name)) { funde.push(`${name} (Name deutet auf einen echten Zugang hin)`); continue; }
    if (SCHLUESSEL_NAME.test(name) && /^[0-9a-fA-F]{64}$/.test(String(wert).trim())) { funde.push(`${name} (Wert sieht aus wie: möglicher privater Wallet-Schlüssel)`); continue; }
    for (const [muster, art] of VERBOTENE_WERTE) {
      if (muster.test(String(wert).trim())) { funde.push(`${name} (Wert sieht aus wie: ${art})`); break; }
    }
  }
  return funde;
}

// ---------- Gegenstellen ----------

export function simulation({ basis }) {
  const s = {
    calls: [], sessions: new Map(), usedNonces: new Set(), settlements: 0,
    antwortVerlieren: new Set(), // Nonces, deren Settle-Antwort verloren geht (Abrechnung passiert trotzdem)
  };
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const hang = (signal) => new Promise((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason)));
  const nowSec = () => Math.floor(Date.now() / 1000);

  function pruefeNachweis(body) {
    const auth = body?.paymentPayload?.payload?.authorization;
    const req = body?.paymentRequirements;
    if (!auth || !req) return "invalid_payload";
    if (body.paymentPayload.payload.signature !== SIM_SIGNATURE) return "invalid_signature";
    if (auth.to.toLowerCase() !== req.payTo.toLowerCase()) return "invalid_pay_to";
    if (BigInt(auth.value) < BigInt(req.maxAmountRequired)) return "insufficient_value";
    if (Number(auth.validBefore) <= nowSec()) return "authorization_expired";
    if (s.usedNonces.has(auth.nonce.toLowerCase())) return "invalid_transaction_state";
    return null;
  }

  s.fetch = async (url, init = {}) => {
    url = String(url);
    s.calls.push({ url, method: init.method || "GET" });
    const body = init.body && init.headers?.["content-type"] === "application/json" ? JSON.parse(init.body) : null;

    if (url === `${FACILITATOR_URL}/verify`) {
      const fehler = pruefeNachweis(body);
      if (fehler) return reply(200, { isValid: false, invalidReason: fehler });
      return reply(200, { isValid: true, payer: body.paymentPayload.payload.authorization.from });
    }
    if (url === `${FACILITATOR_URL}/settle`) {
      const fehler = pruefeNachweis(body);
      if (fehler) return reply(200, { success: false, errorReason: fehler });
      const auth = body.paymentPayload.payload.authorization;
      const nonce = auth.nonce.toLowerCase();
      s.usedNonces.add(nonce);
      s.settlements++;
      const transaction = "0x" + crypto.createHash("sha256").update(`simulation:${nonce}`).digest("hex");
      // Abgerechnet, aber die Antwort kommt nie an: der Kern läuft in seine Zeitüberschreitung.
      if (s.antwortVerlieren.delete(nonce)) return hang(init.signal);
      return reply(200, { success: true, transaction, network: NETWORK, payer: auth.from });
    }
    if (url === RPC_URL) {
      // authorizationState(address,bytes32): letzte 64 Hex-Zeichen sind die Nonce.
      const nonce = "0x" + String(body?.params?.[0]?.data || "").slice(-64).toLowerCase();
      return reply(200, { jsonrpc: "2.0", id: body?.id ?? 1, result: "0x" + (s.usedNonces.has(nonce) ? "1" : "0").padStart(64, "0") });
    }
    if (url === "https://api.stripe.com/v1/checkout/sessions" && init.method === "POST") {
      if (init.headers?.authorization !== `Bearer ${STRIPE_DUMMY_KEY}`) return reply(401, { error: { message: "nur der Simulationsschlüssel ist erlaubt" } });
      const form = Object.fromEntries(new URLSearchParams(init.body));
      const id = `cs_test_sim_${crypto.randomBytes(8).toString("hex")}`;
      const amount = Number(form["line_items[0][price_data][unit_amount]"]);
      const metadata = Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
      s.sessions.set(id, {
        object: "checkout.session", id, livemode: false, mode: form.mode, status: "open", payment_status: "unpaid",
        currency: form["line_items[0][price_data][currency]"], amount_total: amount, amount_subtotal: amount, metadata,
        created: nowSec(), success_url: form.success_url, cancel_url: form.cancel_url,
        line_items: { object: "list", has_more: false, data: [{ quantity: 1, currency: "eur", amount_total: amount }] },
        payment_intent: null,
        _produkt: form["line_items[0][price_data][product_data][name]"] || "",
      });
      // Statt checkout.stripe.com: lokale Seite des simulierten Checkouts.
      const ruecksprung = new URL(form.success_url);
      const ursprung = ["127.0.0.1", "localhost", "[::1]"].includes(ruecksprung.hostname) ? ruecksprung.origin : basis();
      return reply(200, { id, url: `${ursprung}/demo/checkout/${id}` });
    }
    const m = url.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\?/);
    if (m && (init.method || "GET") === "GET") {
      const sess = s.sessions.get(m[1]);
      if (!sess) return reply(404, { error: { message: "No such checkout.session" } });
      const { _produkt, ...sichtbar } = sess;
      return reply(200, sichtbar);
    }
    // Alles andere: nie ins Netz, sondern Fehler.
    throw new TypeError(`Simulation: keine Gegenstelle für ${url}`);
  };

  // Simulierter Checkout: Knopf "Simuliert bezahlen".
  s.bezahle = (id) => {
    const sess = s.sessions.get(id);
    if (!sess) return null;
    if (sess.status !== "complete") {
      const t = nowSec();
      Object.assign(sess, {
        status: "complete", payment_status: "paid",
        payment_intent: {
          status: "succeeded", currency: "eur", amount_received: sess.amount_total, created: t,
          latest_charge: { paid: true, status: "succeeded", created: t },
        },
      });
    }
    return sess.success_url.replace("{CHECKOUT_SESSION_ID}", encodeURIComponent(id));
  };

  return s;
}

// Simulierter Agent: baut einen Zahlungsnachweis (x402 v1, exact) aus den Anforderungen einer 402-Antwort.
export function simulierterNachweis(anforderung) {
  const auth = {
    from: AGENT_WALLET, to: anforderung.payTo, value: anforderung.maxAmountRequired,
    validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce: "0x" + crypto.randomBytes(32).toString("hex"),
  };
  return _intern.b64json({ x402Version: 1, scheme: "exact", network: NETWORK, payload: { signature: SIM_SIGNATURE, authorization: auth } });
}

export const nonceVon = (nachweis) => _intern.fromB64json(nachweis).payload.authorization.nonce.toLowerCase();
export const entschluessle = (b64) => { try { return _intern.fromB64json(b64); } catch { return null; } };
