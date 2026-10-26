// Meterdoor: ein Endpunkt, zwei Bezahlwege.
// Menschen zahlen in EUR über Stripe Checkout, KI-Agenten in USDC über x402 (Version 1 und 2, Schema exact, EIP-3009).
// Das Geld geht direkt an das Stripe-Konto bzw. die Wallet des Betreibers; diese Bibliothek
// verwahrt, tauscht oder leitet nichts weiter und betreibt keinen Facilitator.

import crypto from "node:crypto";
import { memoryStore, fileStore, StoreFullError, OPEN_STATES, STORE_DEFAULTS } from "./speicher.js";

export { memoryStore, fileStore, StoreFullError };

// USDC-Verträge (6 Nachkommastellen) und EIP-712-Domänen laut x402-Referenzimplementierung.
// rpcUrl dient nur zum Lesen (authorizationState), nie zum Senden. caip2 = Netzkennung in x402 Version 2.
export const NETWORKS = {
  "base": {
    caip2: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    extra: { name: "USD Coin", version: "2" },
    testnet: false,
    rpcUrl: "https://mainnet.base.org",
  },
  "base-sepolia": {
    caip2: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    extra: { name: "USDC", version: "2" },
    testnet: true,
    rpcUrl: "https://sepolia.base.org",
  },
};

const STRIPE_API = "https://api.stripe.com/v1";
// Stripe: höchstens 999.999,99 € je Zahlung (gleiche Grenze wie Meterdoor Pro).
const STRIPE_MAX_CENTS = 99_999_999n;
const DEFAULT_FACILITATOR = "https://x402.org/facilitator";
const TOKEN_VERSION = "v2";
// EIP-3009 authorizationState(address,bytes32)
const AUTHORIZATION_STATE = "0xe94a0102";

// "0.50" -> 50n bei 2 Stellen, 500000n bei 6 Stellen. Nur Strings, keine Gleitkommazahlen.
export function toUnits(amount, decimals) {
  if (typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new TypeError(`Betrag muss ein String wie "0.50" sein, nicht ${JSON.stringify(amount)}`);
  }
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new RangeError(`Betrag ${amount} hat mehr als ${decimals} Nachkommastellen`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

const b64json = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const fromB64json = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const hmac = (secret, ...parts) => crypto.createHmac("sha256", secret).update(parts.join("\n")).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sha256hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// Hilfen für access.bind: (req, standardBindung) -> Bindung. Standard ohne bind: Methode + voller Pfad.
// bindQuery(["id"]): die genannten Query-Parameter (Rohwerte, sortiert, mehrfache in Reihenfolge) gehören zur Ressource.
export function bindQuery(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== "string" || !k)) throw new TypeError("bindQuery: Liste von Parameternamen angeben");
  const sorted = [...new Set(keys)].sort();
  return (req, base) => {
    const q = new URLSearchParams(String(req.originalUrl || req.url || "").split("?")[1] || "");
    const parts = sorted.map((k) => `${encodeURIComponent(k)}=${q.getAll(k).map(encodeURIComponent).join(",")}`);
    return `${base}?${parts.join("&")}`;
  };
}

// bindBodyHash(): SHA-256 des Anfrage-Bodys gehört zur Ressource. Braucht einen Body-Parser vor paywall()
// (express.raw/text/json/urlencoded); ohne gelesenen Body wird die Anfrage mit 500 abgelehnt statt still gleich behandelt.
export function bindBodyHash() {
  const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
      : JSON.stringify(v ?? null));
  return (req, base) => {
    let data;
    if (Buffer.isBuffer(req.rawBody)) data = req.rawBody;
    else if (Buffer.isBuffer(req.body) || typeof req.body === "string") data = req.body;
    else if (req.body !== undefined && req.body !== null && req._body !== false) data = `json:${stable(req.body)}`;
    else throw new Error("bindBodyHash: kein Body gelesen; Body-Parser vor paywall() einbinden");
    return `${base}#sha256=${sha256hex(data)}`;
  };
}

// Zugangstoken nach einem Stripe-Kauf: v2.<ende-unix>.<bindung-b64url>.<hmac>
// Das Ende steht fest (Zahlungszeitpunkt + gekaufte Dauer), egal wann oder wie oft eingelöst wird.
export function signToken(secret, binding, expiresAt) {
  const body = `${TOKEN_VERSION}.${expiresAt}.${Buffer.from(binding).toString("base64url")}`;
  return `${body}.${hmac(secret, "meterdoor-token", body)}`;
}

export function verifyToken(secret, token, binding, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION || !/^\d+$/.test(parts[1])) return false;
  if (!safeEqual(parts[3], hmac(secret, "meterdoor-token", parts.slice(0, 3).join(".")))) return false;
  if (Number(parts[1]) * 1000 <= now) return false;
  return Buffer.from(parts[2], "base64url").toString() === binding;
}

// Fehler einer Gegenstelle (Stripe, Facilitator, RPC). Wird nie mit Details an Aufrufer gegeben.
export class UpstreamError extends Error {
  constructor(service, kind, detail, status) {
    super(`${service}: ${kind}${detail ? ` (${detail})` : ""}`);
    this.service = service;
    this.kind = kind; // zeitueberschreitung | netzwerk | unlesbar | http
    this.status = status;
  }
}

async function callJson(fetchImpl, service, url, init, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const failKind = (err) => (err?.name === "TimeoutError" || err?.name === "AbortError" || signal.aborted ? "zeitueberschreitung" : "netzwerk");
  let r, text;
  try { r = await fetchImpl(url, { ...init, signal }); } catch (err) { throw new UpstreamError(service, failKind(err), err?.message); }
  try { text = await r.text(); } catch (err) { throw new UpstreamError(service, failKind(err), err?.message, r.status); }
  try { return { status: r.status, ok: r.ok, data: JSON.parse(text) }; } catch {
    throw new UpstreamError(service, "unlesbar", `HTTP ${r.status}, kein JSON`, r.status);
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) { try { return decodeURIComponent(v.join("=")); } catch { return null; } }
  }
  return null;
}

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// stripe.cancelUrl: absolute https-Adresse (http nur für localhost/127.0.0.1), ohne Zugangsdaten und Steuerzeichen.
function checkCancelUrl(value) {
  if (value === undefined) return undefined;
  const fail = () => { throw new Error("paywall: stripe.cancelUrl muss eine absolute https-Adresse sein (http nur für localhost)"); };
  if (typeof value !== "string" || !value || /[\s\x00-\x1f\x7f]/.test(value)) fail();
  let u;
  try { u = new URL(value); } catch { fail(); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.username || u.password) fail();
  return u.href;
}

function wantsHtml(req) {
  return (req.headers.accept || "").includes("text/html");
}

const toBuf = (chunk, enc) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === "string" ? enc : "utf8"));

export function paywall(options) {
  const {
    price, stripe, x402, access = {}, description = "",
    fetch: fetchImpl = globalThis.fetch, now = Date.now,
    onEvent = (e) => { if (e.problem) console.warn(`[meterdoor] ${e.type}`, e.id || "", e.detail || ""); },
  } = options || {};
  if (!price || (!price.eur && !price.usdc)) throw new Error("paywall: price.eur und/oder price.usdc angeben");
  if (price.eur && !stripe?.key) throw new Error("paywall: price.eur braucht stripe.key");
  if (price.usdc && !x402?.payTo) throw new Error("paywall: price.usdc braucht x402.payTo");
  if (price.eur && !access.secret) throw new Error("paywall: price.eur braucht access.secret (Schlüssel für Zugangstoken)");

  const network = x402?.network || "base-sepolia";
  const net = NETWORKS[network];
  if (price.usdc && !net) throw new Error(`paywall: Netzwerk ${network} wird nicht unterstützt (${Object.keys(NETWORKS).join(", ")})`);
  if (price.usdc && !net.testnet && x402.allowMainnet !== true) {
    throw new Error("paywall: Hauptnetz nur mit x402.allowMainnet = true (Schutz gegen versehentliche Echtzahlungen)");
  }
  const centsEur = price.eur ? toUnits(price.eur, 2) : null;
  if (centsEur !== null && centsEur < 50n) throw new Error("paywall: Stripe verlangt mindestens 0.50 EUR je Zahlung");
  if (centsEur !== null && centsEur > STRIPE_MAX_CENTS) throw new Error("paywall: Stripe erlaubt höchstens 999999.99 EUR je Zahlung");
  const cancelTarget = price.eur ? checkCancelUrl(stripe.cancelUrl) : undefined;
  const cents = centsEur === null ? null : Number(centsEur);
  const unitsUsdc = price.usdc ? toUnits(price.usdc, 6).toString() : null;
  const facilitator = (x402?.facilitatorUrl || DEFAULT_FACILITATOR).replace(/\/$/, "");
  const rpcUrl = x402?.rpcUrl ?? net?.rpcUrl;
  const ttl = access.ttlSeconds ?? 3600;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("paywall: access.ttlSeconds muss eine positive ganze Zahl sein");
  const cookieName = access.cookieName || "pw_token";
  const stripeTimeout = stripe?.timeoutMs ?? 10000;
  const x402Timeout = x402?.timeoutMs ?? 10000;
  const routeTimeout = x402?.routeTimeoutMs ?? 30000;
  const replaySeconds = x402?.replaySeconds ?? 3600;
  // x402-Versionen, die angenommen werden: 1 (Header X-PAYMENT) und/oder 2 (Header PAYMENT-SIGNATURE). Standard beide.
  const versions = x402?.versions ?? [1, 2];
  if (!Array.isArray(versions) || versions.length === 0 || versions.some((v) => v !== 1 && v !== 2)) {
    throw new Error("paywall: x402.versions muss eine Liste aus 1 und/oder 2 sein");
  }
  const v1 = versions.includes(1);
  const v2 = versions.includes(2);
  const posInt = (v, name) => { if (!Number.isInteger(v) || v <= 0) throw new Error(`paywall: ${name} muss eine positive ganze Zahl sein`); return v; };
  // Grenzen mit sicheren Standardwerten.
  const maxResponseBytes = posInt(x402?.maxResponseBytes ?? 1024 * 1024, "x402.maxResponseBytes");
  const maxConcurrent = posInt(x402?.maxConcurrent ?? 64, "x402.maxConcurrent");
  const store = x402?.store || memoryStore({
    maxEntries: posInt(x402?.maxEntries ?? STORE_DEFAULTS.maxEntries, "x402.maxEntries"),
    maxStoredBytes: posInt(x402?.maxStoredBytes ?? STORE_DEFAULTS.maxStoredBytes, "x402.maxStoredBytes"),
    now,
  });
  // Sperre je Zahlungsnachweis: muss Route + verify + settle überdauern.
  const lockSeconds = posInt(x402?.lockSeconds ?? Math.ceil((routeTimeout + 3 * x402Timeout) / 1000) + 5, "x402.lockSeconds");
  if (lockSeconds * 1000 <= routeTimeout + 2 * x402Timeout) {
    throw new Error("paywall: x402.lockSeconds muss länger sein als routeTimeoutMs + 2 × timeoutMs");
  }
  const canClaim = typeof store.claim === "function" && typeof store.release === "function";
  const pending = new Map();
  let active = 0;
  if (typeof access.bind !== "undefined" && typeof access.bind !== "function") throw new Error("paywall: access.bind muss eine Funktion sein");
  // Testschlüssel dürfen nur Testsitzungen freischalten, Live-Schlüssel nur Live-Sitzungen.
  const expectLivemode = /^(sk|rk)_live_/.test(stripe?.key || "") ? true : /^(sk|rk)_test_/.test(stripe?.key || "") ? false : undefined;
  const emit = (e) => { try { onEvent({ at: new Date(now()).toISOString(), ...e }); } catch { /* Protokoll darf nie stören */ } };
  // Gemeinsame Felder aller x402-Ereignisse zu einem Nachweis (id = Kennung der Zahlung, stabil über Wiederholungen).
  const x402Fields = (rec) => ({ method: "x402", id: rec.id, amount: String(price.usdc), currency: "USDC", resource: rec.binding });
  if (unitsUsdc && !canClaim) {
    emit({ type: "speicher_ohne_sperre", problem: true, detail: "x402.store hat kein claim/release: nur eine Instanz sicher (mehrere Instanzen können doppelt ausführen)" });
  }

  // Ressource = Methode + voller Pfad (req.baseUrl + req.path, ohne Query), optional Mandant.
  // access.resourceId ersetzt Methode und Pfad durch eine ausdrückliche Kennung.
  const fullPath = (req) => (req.baseUrl || "") + req.path;
  const fullUrl = (req) => `${req.protocol}://${req.get("host")}${fullPath(req)}`;
  // access.bind(req, standard) kann die Bindung enger fassen (z. B. bindQuery, bindBodyHash).
  function bindingOf(req) {
    const method = req.method === "HEAD" ? "GET" : req.method;
    let id = access.resourceId ? `id:${access.resourceId}` : `${method} ${fullPath(req)}`;
    if (access.bind) {
      id = access.bind(req, id);
      if (typeof id !== "string" || !id) throw new Error("access.bind muss einen nicht leeren String liefern");
    }
    return access.tenant ? `${access.tenant}|${id}` : id;
  }
  // Mit access.bind bleibt die eigene Query (ohne pw_-Parameter) in Adressen erhalten, damit Rücksprung und
  // x402-resource dieselbe Bindung ergeben. Ohne bind wie bisher: voller Pfad ohne Query.
  function ownQuery(req) {
    if (!access.bind) return "";
    const q = new URLSearchParams(String(req.originalUrl || "").split("?")[1] || "");
    for (const k of [...q.keys()]) if (k.startsWith("pw_")) q.delete(k);
    const s = q.toString();
    return s ? `?${s}` : "";
  }
  const resourceUrl = (req) => fullUrl(req) + ownQuery(req);
  const withParam = (url, kv) => `${url}${url.includes("?") ? "&" : "?"}${kv}`;
  // Mit access.bind eigener Cookie je Bindung, damit Käufe für ?id=1 und ?id=2 sich nicht überschreiben.
  const cookieFor = (binding) => (access.bind ? `${cookieName}_${sha256hex(binding).slice(0, 12)}` : cookieName);
  const checkoutId = (binding, soldTtl) => hmac(access.secret, "meterdoor-checkout", binding, String(centsEur), "eur", String(soldTtl));

  function requirements(req) {
    return {
      scheme: "exact",
      network,
      maxAmountRequired: unitsUsdc,
      resource: resourceUrl(req),
      description,
      mimeType: "application/json",
      payTo: x402.payTo,
      maxTimeoutSeconds: x402.maxTimeoutSeconds ?? 60,
      asset: net.asset,
      extra: net.extra,
    };
  }

  // Version 2: Netz als CAIP-2, Betrag als amount, Ressource getrennt (ResourceInfo).
  function requirementsV2(req) {
    return {
      scheme: "exact",
      network: net.caip2,
      amount: unitsUsdc,
      asset: net.asset,
      payTo: x402.payTo,
      maxTimeoutSeconds: x402.maxTimeoutSeconds ?? 60,
      extra: net.extra,
    };
  }
  const requirementsFor = (version, req) => (version === 2 ? requirementsV2(req) : requirements(req));
  const resourceInfo = (req) => ({ url: resourceUrl(req), description, mimeType: "application/json" });

  // 402 für beide Versionen: Body im Format von Version 1 (wenn angenommen), dazu Header PAYMENT-REQUIRED (Version 2).
  // Nimmt die Paywall nur Version 2 an, steht das PaymentRequired-Objekt von Version 2 auch im Body.
  function paymentRequired(req, error) {
    const headers = {};
    let body;
    if (unitsUsdc && v2) {
      const pr = { x402Version: 2, error, resource: resourceInfo(req), accepts: [requirementsV2(req)] };
      headers["PAYMENT-REQUIRED"] = b64json(pr);
      if (!v1) body = pr;
    }
    body ||= { x402Version: 1, error, accepts: unitsUsdc ? [requirements(req)] : [] };
    if (centsEur !== null) body.checkout = withParam(resourceUrl(req), "pw_checkout=1");
    return { body, headers };
  }

  function send402(req, res, error) {
    const { body, headers } = paymentRequired(req, error);
    res.status(402).set(headers).json(body);
  }

  // Abbruchseite: 402, weil weiterhin nichts bezahlt ist. Browser bekommen eine kurze Seite mit „Erneut versuchen“
  // (relativer Link auf dieselbe Ressource mit pw_checkout=1), alle anderen JSON wie bei send402.
  function sendCancelled(req, res) {
    emit({ type: "stripe_abgebrochen", resource: bindingOf(req) });
    const retry = withParam(fullPath(req) + ownQuery(req), "pw_checkout=1");
    if (!wantsHtml(req)) return send402(req, res, "Checkout abgebrochen; nichts wurde berechnet");
    res.status(402).set("Cache-Control", "no-store").type("html").send(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Zahlung abgebrochen</title></head>
<body><main><h1>Zahlung abgebrochen</h1><p>Sie haben den Checkout abgebrochen. Es wurde nichts berechnet und nichts freigeschaltet.</p>
<p><a href="${escapeHtml(retry)}">Erneut versuchen</a></p></main></body></html>`);
  }

  function sendUpstreamError(res, err) {
    const status = err.kind === "unlesbar" || (err.kind === "http" && err.status < 500) ? 502 : 503;
    res.status(status).set("Retry-After", "5").json({
      error: `${err.service} nicht erreichbar oder Antwort unlesbar; nichts wurde berechnet oder freigeschaltet, bitte in 5 Sekunden erneut versuchen`,
    });
  }

  function sendInternalError(res, err) {
    emit({ type: "interner_fehler", problem: true, detail: err?.message });
    if (!res.headersSent) res.status(500).json({ error: "interner Fehler" });
  }

  // ---------- Stripe ----------

  async function stripeCall(method, path, form) {
    return callJson(fetchImpl, "Stripe", `${STRIPE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${stripe.key}`,
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    }, stripeTimeout);
  }

  async function checkoutUrl(req) {
    const binding = bindingOf(req);
    const { status, ok, data } = await stripeCall("POST", "/checkout/sessions", {
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "eur",
      "line_items[0][price_data][unit_amount]": String(centsEur),
      "line_items[0][price_data][product_data][name]": description || fullPath(req),
      ...(stripe.taxCode ? { "line_items[0][price_data][product_data][tax_code]": String(stripe.taxCode) } : {}),
      // Managed Payments würde Steuer aufschlagen und den Betrag ändern (checkSession prüft amount_total) – daher aus,
      // außer ausdrücklich gewünscht. Konten mit Managed Payments als Standard lehnen sonst ab („product tax code is missing“).
      ...(stripe.managedPayments ? {} : { "managed_payments[enabled]": "false" }),
      success_url: withParam(resourceUrl(req), "pw_session={CHECKOUT_SESSION_ID}"),
      // Abbruch führt nie zurück auf den geschützten Endpunkt ohne Kennzeichen (sonst sofort neuer Checkout):
      // eigenes Ziel (stripe.cancelUrl) oder dieselbe Adresse mit pw_cancelled=1 (Abbruchseite).
      cancel_url: cancelTarget || withParam(resourceUrl(req), "pw_cancelled=1"),
      ...(stripe.metadata ? Object.fromEntries(Object.entries(stripe.metadata).map(([k, v]) => [`metadata[${k}]`, String(v)])) : {}),
      "metadata[pw_resource]": binding,
      "metadata[pw_ttl]": String(ttl),
      "metadata[pw_id]": checkoutId(binding, ttl),
    });
    if (!ok || typeof data?.url !== "string") throw new UpstreamError("Stripe", "http", data?.error?.message, status);
    return data.url;
  }

  // Prüft eine Checkout-Sitzung gegen die erwarteten Kaufdaten. Ergebnis: { ok, reason } oder { ok, expiresAt }.
  function checkSession(s, sessionId, binding, nowMs) {
    const no = (reason) => ({ ok: false, reason });
    if (s?.object !== "checkout.session" || s.id !== sessionId) return no("unerwartete Antwort von Stripe");
    if (expectLivemode !== undefined && s.livemode !== expectLivemode) return no("Sitzung aus dem anderen Stripe-Modus");
    if (s.mode !== "payment") return no("keine Einmalzahlung");
    if (s.status !== "complete" || s.payment_status !== "paid") return no("Sitzung nicht bezahlt");
    if (s.currency !== "eur") return no("falsche Währung");
    if (s.amount_total !== cents || s.amount_subtotal !== cents) return no("falscher Betrag");
    const md = s.metadata || {};
    if (md.pw_resource !== binding) return no("Sitzung gehört zu einer anderen Ressource");
    if (!/^\d+$/.test(md.pw_ttl || "")) return no("Sitzung ohne gekaufte Dauer");
    const soldTtl = Number(md.pw_ttl);
    if (!safeEqual(md.pw_id, checkoutId(binding, soldTtl))) return no("Kennung der Sitzung passt nicht");
    const items = s.line_items?.data;
    if (!Array.isArray(items) || items.length !== 1 || s.line_items.has_more) return no("unerwartete Positionen");
    const item = items[0];
    if (item.quantity !== 1 || item.currency !== "eur" || item.amount_total !== cents) return no("unerwartete Positionen");
    const pi = s.payment_intent;
    if (!pi || typeof pi !== "object") return no("keine Zahlung zur Sitzung");
    if (pi.status !== "succeeded" || pi.currency !== "eur" || pi.amount_received !== cents) return no("Zahlung nicht abgeschlossen");
    const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    if (charge && (charge.paid !== true || charge.status !== "succeeded")) return no("Zahlung nicht abgeschlossen");
    const paidAt = charge?.created ?? pi.created;
    if (!Number.isInteger(paidAt)) return no("Zahlungszeitpunkt fehlt");
    const expiresAt = paidAt + soldTtl;
    if (expiresAt * 1000 <= nowMs) return no("gekaufte Zugangsdauer ist abgelaufen");
    return { ok: true, expiresAt };
  }

  async function redeemSession(req, res, sessionId) {
    const binding = bindingOf(req);
    const q = "expand[]=line_items&expand[]=payment_intent.latest_charge";
    const { status, ok, data } = await stripeCall("GET", `/checkout/sessions/${sessionId}?${q}`);
    if (status === 404) return send402(req, res, "Stripe-Sitzung unbekannt");
    if (!ok) throw new UpstreamError("Stripe", "http", data?.error?.message, status);
    const nowMs = now();
    const check = checkSession(data, sessionId, binding, nowMs);
    if (!check.ok) {
      emit({ type: "stripe_abgelehnt", id: sessionId, detail: check.reason });
      return send402(req, res, `Stripe-Sitzung ungültig: ${check.reason}`);
    }
    const t = signToken(access.secret, binding, check.expiresAt);
    const maxAge = check.expiresAt * 1000 - nowMs;
    res.cookie(cookieFor(binding), t, { httpOnly: true, secure: req.secure, sameSite: "lax", maxAge, path: fullPath(req) });
    emit({ type: "stripe_eingeloest", method: "stripe", id: sessionId, amount: String(price.eur), currency: "EUR", resource: binding,
      transaction: typeof data.payment_intent === "object" ? data.payment_intent.id : data.payment_intent, detail: binding });
    if (wantsHtml(req)) return res.redirect(303, fullPath(req) + ownQuery(req));
    return res.json({ token: t, expiresAt: new Date(check.expiresAt * 1000).toISOString(), expiresIn: Math.floor(maxAge / 1000) });
  }

  // ---------- x402 ----------

  // Die Anforderungen baut immer die Paywall selbst (nie aus dem Nachweis übernommen); Version wie im Nachweis.
  async function facilitatorCall(endpoint, parsed, paymentRequirements) {
    const { status, ok, data } = await callJson(fetchImpl, "Facilitator", `${facilitator}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: parsed.version, paymentPayload: parsed.payload, paymentRequirements }),
    }, x402Timeout);
    // Eine fachliche Ablehnung (isValid/success = false) ist eine Antwort, kein Ausfall.
    const verdict = endpoint === "verify" ? data?.isValid : data?.success;
    if (typeof verdict !== "boolean" || (!ok && verdict !== false) || status >= 500) {
      throw new UpstreamError("Facilitator", "http", `${endpoint}: HTTP ${status}`, status);
    }
    return data;
  }

  // Wurde die Autorisierung (Absender + Nonce) schon auf der Kette eingelöst? Nur lesend.
  async function nonceUsedOnChain(auth) {
    if (!rpcUrl) throw new UpstreamError("RPC", "netzwerk", "keine rpcUrl");
    const data = AUTHORIZATION_STATE + auth.from.slice(2).toLowerCase().padStart(64, "0") + auth.nonce.slice(2).toLowerCase();
    const { ok, data: body } = await callJson(fetchImpl, "RPC", rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: net.asset, data }, "latest"] }),
    }, x402Timeout);
    if (!ok || typeof body?.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.result)) throw new UpstreamError("RPC", "unlesbar");
    return BigInt(body.result === "0x" ? 0 : body.result) !== 0n;
  }

  // Version 1: scheme/network oben im Nachweis. Version 2: gewählte Anforderung in `accepted`, Netz als CAIP-2.
  function parsePayment(header, version) {
    let payload;
    try { payload = fromB64json(header); } catch {
      return { error: `${version === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT"} ist kein gültiges Base64-JSON`, malformed: true };
    }
    if (version === 1) {
      if (payload?.x402Version !== 1 || payload.network !== network || payload.scheme !== "exact") return { error: "Version, Netzwerk oder Schema passt nicht" };
    } else {
      const acc = payload?.accepted;
      if (payload?.x402Version !== 2 || !acc || typeof acc !== "object" || acc.scheme !== "exact" || acc.network !== net.caip2) {
        return { error: "Version, Netzwerk oder Schema passt nicht" };
      }
      const method = acc.extra?.assetTransferMethod;
      if (method !== undefined && method !== "eip3009") return { error: "nur assetTransferMethod eip3009 wird angenommen" };
      if (String(acc.asset || "").toLowerCase() !== net.asset.toLowerCase()) return { error: "falsches Asset" };
      if (String(acc.payTo || "").toLowerCase() !== x402.payTo.toLowerCase()) return { error: "Zahlung geht an eine andere Adresse" };
      if (acc.amount !== unitsUsdc) return { error: "Betrag passt nicht zur Anforderung" };
    }
    const auth = payload.payload?.authorization;
    const hex = (v, n) => typeof v === "string" && new RegExp(`^0x[0-9a-fA-F]{${n}}$`).test(v);
    const uint = (v) => /^\d+$/.test(String(v));
    if (!auth || !hex(auth.from, 40) || !hex(auth.to, 40) || !hex(auth.nonce, 64) || !uint(auth.value) || !uint(auth.validAfter) || !uint(auth.validBefore)) {
      return { error: "Zahlungsnachweis unvollständig" };
    }
    if (auth.to.toLowerCase() !== x402.payTo.toLowerCase()) return { error: "Zahlung geht an eine andere Adresse" };
    if (BigInt(auth.value) < BigInt(unitsUsdc)) return { error: "Betrag zu niedrig" };
    // Kennung unabhängig von der Version: dieselbe Autorisierung (Netz + Absender + Nonce) ist dieselbe Zahlung.
    return { payload, auth, version, id: `${network}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`, fingerprint: fingerprintOf(payload, auth) };
  }

  // Fingerabdruck des vollständigen Nachweises: SHA-256 über eine kanonische Form mit Signatur und allen
  // Autorisierungsfeldern (from, to, value, validAfter, validBefore, nonce) sowie Netzwerk und Asset.
  // Die Kennung (Netz + Absender + Nonce) allein genügt so nie, um eine gespeicherte Antwort abzurufen.
  function fingerprintOf(payload, auth) {
    const lc = (v) => String(v).toLowerCase();
    const sig = payload.payload?.signature;
    return sha256hex(JSON.stringify([
      "meterdoor-nachweis-v1", payload.x402Version, payload.scheme ?? payload.accepted?.scheme, network, lc(net.asset),
      lc(auth.from), lc(auth.to), BigInt(auth.value).toString(), BigInt(auth.validAfter).toString(),
      BigInt(auth.validBefore).toString(), lc(auth.nonce), typeof sig === "string" ? lc(sig) : null,
    ]));
  }
  function sameFingerprint(stored, fresh) {
    if (typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) return false; // Altbestand ohne Fingerabdruck: ablehnen
    return crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(fresh, "hex"));
  }

  // Führt die Route aus und puffert die Antwort, statt sie zu senden. Danach entscheidet die Middleware.
  // pass(fn) sendet über die echten Methoden; späte Schreibversuche der Route werden verworfen.
  // Mehr als maxResponseBytes: Puffer wird verworfen, Ergebnis "zu_gross" (es wird nicht abgerechnet).
  function runBuffered(req, res, next) {
    return new Promise((resolve) => {
      const orig = { write: res.write, end: res.end, writeHead: res.writeHead };
      let chunks = [];
      let size = 0;
      let mode = "puffern";
      const pass = (fn) => { const before = mode; mode = "durch"; try { fn(); } finally { mode = before === "durch" ? "durch" : "sperren"; } };
      const finish = (kind) => {
        if (mode !== "puffern") return;
        mode = "sperren";
        clearTimeout(timer);
        const headers = { ...res.getHeaders() };
        resolve({ kind, status: res.statusCode, headers, body: Buffer.concat(chunks), pass });
        chunks = [];
      };
      const add = (chunk, enc) => {
        if (chunk == null) return;
        const b = toBuf(chunk, enc);
        size += b.length;
        if (size > maxResponseBytes) { chunks = []; finish("zu_gross"); } else chunks.push(b);
      };
      res.writeHead = function (status, reason, headers) {
        if (mode === "durch") return orig.writeHead.apply(res, arguments);
        if (mode === "sperren") return res;
        if (typeof reason !== "string") headers = reason;
        res.statusCode = status;
        if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        return res;
      };
      res.write = function (chunk, enc, cb) {
        if (mode === "durch") return orig.write.apply(res, arguments);
        if (mode === "puffern") add(chunk, enc);
        const done = typeof enc === "function" ? enc : cb;
        if (done) process.nextTick(done);
        return true;
      };
      res.end = function (chunk, enc, cb) {
        if (mode === "durch") return orig.end.apply(res, arguments);
        if (typeof chunk === "function") { cb = chunk; chunk = null; } else if (typeof enc === "function") { cb = enc; enc = undefined; }
        if (mode === "puffern") add(chunk, enc);
        if (cb) process.nextTick(cb);
        finish("fertig");
        return res;
      };
      const timer = setTimeout(() => finish("zeitueberschreitung"), routeTimeout);
      try { next(); } catch (err) { emit({ type: "route_fehler", problem: true, detail: err?.message }); res.statusCode = 500; finish("fehler"); }
    });
  }

  function replyFromRecord(res, rec, send = (fn) => fn()) {
    send(() => {
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      for (const [k, v] of Object.entries(rec.response.headers)) if (k !== "x-payment-response" && k !== "payment-response") res.setHeader(k, v);
      // Fälle ohne version stammen aus Version 1 (Altbestand).
      if (rec.version === 2) {
        res.setHeader("PAYMENT-RESPONSE", b64json({ success: true, transaction: rec.transaction || "", network: net.caip2, payer: rec.payer }));
      } else {
        res.setHeader("X-PAYMENT-RESPONSE", b64json({ success: true, transaction: rec.transaction || null, network, payer: rec.payer }));
      }
      res.statusCode = rec.response.status;
      res.end(Buffer.from(rec.response.body, "base64"));
    });
    // Zustellung verfolgen: Bricht die Verbindung ab, bleibt der Fall offen und der Nachweis abrufbar.
    res.once("close", () => {
      const delivered = res.writableFinished;
      emit({ type: delivered ? "zugestellt" : "nicht_zugestellt", problem: !delivered, id: rec.id });
      if (delivered !== rec.delivered) Promise.resolve().then(() => store.set(rec.id, { ...rec, delivered }, replaySeconds)).catch(() => {});
    });
  }

  function replyJson(res, status, body, send = (fn) => fn(), headers = {}) {
    send(() => {
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      res.status(status).set(headers).json(body);
    });
  }

  async function storeQuietly(fn, id) {
    try { await fn(); } catch (err) { emit({ type: "speicher_fehler", problem: true, id, detail: err?.message }); }
  }

  // Bezahlt ist bezahlt: Scheitert der Speicher, wird trotzdem ausgeliefert (Fall wird gemeldet).
  async function markPaid(rec, settled) {
    const paid = { ...rec, state: "bezahlt", transaction: settled?.transaction || rec.transaction || null, payer: settled?.payer || rec.payer };
    await storeQuietly(() => store.set(rec.id, paid, replaySeconds), rec.id);
    return paid;
  }

  // Klärt einen Nachweis mit unklarer Abrechnung ("unklar" oder nach Neustart/Sperrablauf "in_abrechnung").
  // Nie blind neu abrechnen: erst auf der Kette nachsehen, ob die Autorisierung schon eingelöst ist.
  async function resolveUnclear(req, res, rec, parsed) {
    let used;
    try { used = await nonceUsedOnChain(parsed.auth); } catch (err) {
      emit({ type: "abrechnung_unklar", problem: true, ...x402Fields(rec), detail: err.message });
      return replyJson(res, 503, { error: "Zahlungsstatus noch unklar; nichts wird doppelt berechnet, bitte mit demselben Nachweis erneut versuchen" }, undefined, { "Retry-After": "10" });
    }
    if (used) {
      emit({ type: "abrechnung_geklaert", ...x402Fields(rec) });
      return replyFromRecord(res, await markPaid(rec));
    }
    if (Number(parsed.auth.validBefore) * 1000 + 60000 < now()) {
      await store.delete(rec.id);
      emit({ type: "abrechnung_verfallen", ...x402Fields(rec) });
      return send402(req, res, "Zahlung wurde nicht ausgeführt und die Autorisierung ist abgelaufen");
    }
    // Noch gültig und nicht eingelöst: erneut abrechnen (dieselbe Nonce kann höchstens einmal eingelöst werden).
    try {
      const settled = await facilitatorCall("settle", parsed, requirementsFor(parsed.version, req));
      if (settled.success) {
        emit({ type: "abgerechnet", ...x402Fields(rec), transaction: settled.transaction, detail: settled.transaction });
        return replyFromRecord(res, await markPaid(rec, settled));
      }
    } catch (err) { emit({ type: "abrechnung_unklar", problem: true, ...x402Fields(rec), detail: err.message }); }
    if (rec.state !== "unklar") await storeQuietly(() => store.set(rec.id, { ...rec, state: "unklar" }, replaySeconds), rec.id);
    return replyJson(res, 503, { error: "Zahlungsstatus noch unklar; bitte mit demselben Nachweis erneut versuchen" }, undefined, { "Retry-After": "10" });
  }

  async function firstUse(req, res, next, parsed) {
    const reqs = requirementsFor(parsed.version, req);
    const verified = await facilitatorCall("verify", parsed, reqs);
    if (!verified.isValid) return send402(req, res, verified.invalidReason || "Zahlung ungültig");

    // Erst die Leistung, dann die Abrechnung: Scheitert die Route, wird nichts berechnet.
    let aborted = false;
    res.once("close", () => { if (!res.writableFinished) aborted = true; });
    req.payment = { method: "x402", version: parsed.version, network, amount: unitsUsdc, payer: verified.payer || parsed.auth.from, id: parsed.id };
    const out = await runBuffered(req, res, next);
    try {
      return await afterRoute(req, res, parsed, reqs, out, () => aborted);
    } catch (err) {
      emit({ type: "interner_fehler", problem: true, id: parsed.id, detail: err?.message });
      return replyJson(res, 500, { error: "interner Fehler; bitte mit demselben Nachweis erneut versuchen" }, out.pass);
    }
  }

  async function afterRoute(req, res, parsed, reqs, out, isAborted) {
    if (out.kind === "zeitueberschreitung") {
      emit({ type: "route_zeitueberschreitung", problem: true, id: parsed.id });
      return replyJson(res, 504, { error: "Route hat nicht rechtzeitig geantwortet; nichts wurde berechnet" }, out.pass);
    }
    if (out.kind === "zu_gross") {
      emit({ type: "antwort_zu_gross", problem: true, id: parsed.id, detail: `mehr als ${maxResponseBytes} Bytes` });
      return replyJson(res, 500, { error: "Antwort der Route überschreitet die Größengrenze; nichts wurde berechnet" }, out.pass);
    }
    if (out.status >= 400) {
      emit({ type: "route_fehler", problem: out.status >= 500, id: parsed.id, detail: `HTTP ${out.status}` });
      if (out.status >= 500) return replyJson(res, out.status, { error: "Route fehlgeschlagen; nichts wurde berechnet" }, out.pass);
      return out.pass(() => res.end(out.body));
    }
    if (isAborted() || res.destroyed) {
      emit({ type: "abbruch_vor_abrechnung", id: parsed.id });
      return;
    }

    // Antwort vor der Abrechnung sichern, damit sie bei verlorener Facilitator-Antwort nachgeliefert werden kann.
    // expiresAt steht ab hier fest und beginnt bei Zustandsänderungen nicht neu.
    const t = now();
    const rec = {
      id: parsed.id, version: parsed.version, binding: parsed.binding, state: "in_abrechnung", fingerprint: parsed.fingerprint,
      payer: req.payment.payer, delivered: false,
      createdAt: new Date(t).toISOString(), expiresAt: new Date(t + replaySeconds * 1000).toISOString(),
      response: { status: out.status, headers: out.headers, body: out.body.toString("base64") },
    };
    try { await store.set(rec.id, rec, replaySeconds); } catch (err) {
      // Ohne gesicherten Fall keine Abrechnung. Ein voller Speicher verdrängt nie offene Fälle, sondern weist ab.
      const full = err?.code === "SPEICHER_VOLL";
      emit({ type: full ? "speicher_voll" : "speicher_fehler", problem: true, id: rec.id, detail: err?.message });
      return replyJson(res, 503, {
        error: full ? "Speicher für Zahlungsfälle ist voll; nichts wurde berechnet, bitte später erneut versuchen"
          : "Speicher nicht verfügbar; nichts wurde berechnet, bitte später erneut versuchen",
      }, out.pass, { "Retry-After": full ? "30" : "5" });
    }
    let settled;
    const unclear = async (detail) => {
      emit({ type: "abrechnung_unklar", problem: true, ...x402Fields(rec), detail });
      await storeQuietly(() => store.set(rec.id, { ...rec, state: "unklar" }, replaySeconds), rec.id);
      return replyJson(res, 503, { error: "Zahlungsstatus unklar; nichts wird doppelt berechnet, bitte mit demselben Nachweis erneut versuchen" }, out.pass, { "Retry-After": "10" });
    };
    try { settled = await facilitatorCall("settle", parsed, reqs); } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      return unclear(err.message);
    }
    // settlement_pending (Version 2): Transaktion gesendet, Bestätigung offen – keine Ablehnung, sondern unklar.
    if (!settled.success && settled.errorReason === "settlement_pending") return unclear(`settlement_pending ${settled.transaction || ""}`.trim());
    if (!settled.success) {
      await storeQuietly(() => store.delete(rec.id), rec.id);
      emit({ type: "abrechnung_abgelehnt", ...x402Fields(rec), detail: settled.errorReason });
      const { body, headers } = paymentRequired(req, settled.errorReason || "Abrechnung fehlgeschlagen");
      return replyJson(res, 402, body, out.pass, headers);
    }
    req.payment.transaction = settled.transaction;
    emit({ type: "abgerechnet", ...x402Fields(rec),
      transaction: settled.transaction, detail: settled.transaction });
    return replyFromRecord(res, await markPaid(rec, settled), out.pass);
  }

  // Synchron bis zur Sperre: parsePayment, Grenze und pending.set laufen ohne await, damit zwei gleichzeitige
  // Anfragen mit demselben Nachweis nie beide am Speicher vorbeikommen.
  function handleX402(req, res, next, header, version) {
    const parsed = parsePayment(header, version);
    // Version 2 (HTTP-Transport): unlesbarer Nachweis = 400, sonst 402 mit den Anforderungen.
    if (parsed.malformed && version === 2) {
      const { headers } = paymentRequired(req, parsed.error);
      return res.status(400).set(headers).json({ x402Version: 2, error: parsed.error });
    }
    if (parsed.error) return send402(req, res, parsed.error);
    parsed.binding = bindingOf(req); // wirft bei fehlerhafter Bindung (z. B. bindBodyHash ohne Body) vor jeder Prüfung
    if (active >= maxConcurrent) {
      emit({ type: "ueberlastet", problem: true, id: parsed.id, detail: `${active} gleichzeitige Zahlungsanfragen` });
      return res.status(503).set("Retry-After", "5").json({ error: "zu viele gleichzeitige Zahlungsanfragen; nichts wurde berechnet, bitte in 5 Sekunden erneut versuchen" });
    }
    active++;
    return withLock(parsed.id, () => processPayment(req, res, next, parsed)).finally(() => { active--; });
  }

  // Lokale Sperre je Nachweis (dieser Prozess). Ist kein anderer Durchlauf offen, wird sie ohne await gesetzt.
  async function withLock(id, fn) {
    while (pending.has(id)) await pending.get(id);
    let release;
    pending.set(id, new Promise((r) => { release = r; }));
    try { return await fn(); } finally { pending.delete(id); release(); }
  }

  // Sperre über Instanzen hinweg (store.claim). Wartet, solange eine andere Instanz denselben Nachweis bearbeitet.
  async function claimOrWait(id) {
    const owner = crypto.randomUUID();
    const deadline = Date.now() + lockSeconds * 1000 + 2000;
    for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
      if (await store.claim(id, owner, lockSeconds)) return owner;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * delay)));
    }
  }

  async function processPayment(req, res, next, parsed) {
    await ready;
    const owner = canClaim ? await claimOrWait(parsed.id) : null;
    if (canClaim && !owner) {
      emit({ type: "nachweis_in_bearbeitung", problem: true, id: parsed.id });
      return res.status(503).set("Retry-After", "5").json({ error: "Zahlungsnachweis wird gerade bearbeitet; bitte mit demselben Nachweis erneut versuchen" });
    }
    try {
      const rec = await store.get(parsed.id);
      if (!rec) return await firstUse(req, res, next, parsed);
      // Vor jeder erneuten Auslieferung und vor jeder Klärung: Nachweis vollständig gleich? (zeitkonstant)
      if (!sameFingerprint(rec.fingerprint, parsed.fingerprint)) {
        emit({ type: "nachweis_abweichend", problem: true, id: rec.id });
        return send402(req, res, "Zahlungsnachweis weicht vom bereits verwendeten Nachweis ab");
      }
      if (rec.binding !== parsed.binding) return send402(req, res, "Zahlungsnachweis wurde bereits für eine andere Ressource verwendet");
      if (rec.state === "bezahlt") {
        emit({ type: "wiederholt_ausgeliefert", ...x402Fields(rec) });
        return replyFromRecord(res, rec);
      }
      return await resolveUnclear(req, res, rec, parsed);
    } finally {
      if (owner) await storeQuietly(() => store.release(parsed.id, owner), parsed.id);
    }
  }

  // Wiederanlauf: Fälle "in_abrechnung" ohne lebende Sperre stammen aus einem abgebrochenen Durchlauf. Sie werden
  // "unklar" und beim nächsten Abruf mit demselben Nachweis über resolveUnclear geklärt, nie blind neu abgerechnet.
  async function recover() {
    if (!unitsUsdc || typeof store.list !== "function") return 0;
    let n = 0;
    for (const r of (await store.list()) || []) {
      if (r?.state !== "in_abrechnung") continue;
      const owner = canClaim ? crypto.randomUUID() : null;
      if (owner && !(await store.claim(r.id, owner, lockSeconds))) continue; // eine andere Instanz arbeitet daran
      try {
        const next = { ...r, state: "unklar" };
        const done = typeof store.compareAndSet === "function"
          ? await store.compareAndSet(r.id, "in_abrechnung", next, replaySeconds)
          : (await store.set(r.id, next, replaySeconds), true);
        if (done) { n++; emit({ type: "wiederanlauf_unklar", problem: true, id: r.id }); }
      } finally {
        if (owner) await storeQuietly(() => store.release(r.id, owner), r.id);
      }
    }
    return n;
  }
  const ready = Promise.resolve().then(recover).catch((err) => { emit({ type: "wiederanlauf_fehler", problem: true, detail: err?.message }); return 0; });

  const middleware = async function paywallMiddleware(req, res, next) {
    try {
      // 1. x402: Agent schickt eine signierte Zahlung im Header PAYMENT-SIGNATURE (Version 2) oder X-PAYMENT (Version 1).
      //    Stehen beide da, gilt PAYMENT-SIGNATURE. Ein Header einer abgeschalteten Version wird mit 402 beantwortet.
      if (unitsUsdc) {
        const h2 = req.get("payment-signature");
        const h1 = h2 ? undefined : req.get("x-payment");
        if (h2 || h1) {
          const version = h2 ? 2 : 1;
          if (!versions.includes(version)) return send402(req, res, `x402 Version ${version} wird hier nicht angenommen`);
          return await handleX402(req, res, next, h2 || h1, version);
        }
      }

      if (centsEur !== null) {
        // 2. Gültiges Zugangstoken aus einem Stripe-Kauf (Cookie oder Bearer).
        const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
        const binding = bindingOf(req);
        const token = readCookie(req, cookieFor(binding)) || bearer;
        if (token && verifyToken(access.secret, token, binding, now())) {
          req.payment = { method: "stripe-token" };
          return next();
        }

        // 3. Rückkehr aus Stripe Checkout: Sitzung vollständig prüfen, Token mit festem Ende ausgeben.
        const sessionId = req.query?.pw_session;
        if (typeof sessionId === "string" && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) return await redeemSession(req, res, sessionId);

        // 4. Rückkehr nach Abbruch im Checkout: Abbruchzustand anzeigen, keine neue Sitzung, nichts freischalten.
        //    Ein neuer Versuch beginnt erst mit dem Link „Erneut versuchen“ (?pw_checkout=1).
        if (req.query?.pw_cancelled === "1" && req.query?.pw_checkout !== "1") return sendCancelled(req, res);

        // 5. Mensch im Browser oder ausdrücklicher Wunsch nach Checkout: weiter zu Stripe.
        if (wantsHtml(req) || req.query?.pw_checkout === "1") return res.redirect(303, await checkoutUrl(req));
      }

      // 6. Sonst: 402 mit beiden Wegen.
      return send402(req, res, "Zahlung erforderlich");
    } catch (err) {
      if (err instanceof UpstreamError) {
        emit({ type: "gegenstelle_fehler", problem: true, detail: err.message });
        if (!res.headersSent) return sendUpstreamError(res, err);
        return;
      }
      return sendInternalError(res, err);
    }
  };

  // Offene Fälle für den Betreiber: Abrechnung in Arbeit/unklar oder bezahlt, aber (noch) nicht zugestellt.
  middleware.openCases = async () => {
    const all = (await store.list?.()) || [];
    return all.filter((r) => OPEN_STATES.has(r.state) || r.delivered === false)
      .map(({ response, ...r }) => r);
  };
  // Wiederanlaufprüfung (läuft beim Start automatisch; Ergebnis: Anzahl auf "unklar" gesetzter Fälle).
  middleware.ready = ready;
  middleware.recover = recover;
  middleware.limits = Object.freeze({ maxResponseBytes, maxConcurrent, lockSeconds, replaySeconds, multiInstance: canClaim });
  return middleware;
}

export const _intern = { b64json, fromB64json };
