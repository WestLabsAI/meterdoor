# Meterdoor (prototype 0.0.7)

[Deutsch](README.md) · [Website](https://meterdoor.com)

Express middleware: **one endpoint, two ways to pay.** Humans in a browser pay in euros via Stripe Checkout, agents and
other software pay in USDC via [x402](https://www.x402.org/) (versions 1 and 2, scheme `exact` with EIP-3009). Payments are processed by your
Stripe account or an x402 facilitator and go straight to you; Meterdoor itself never holds, exchanges or forwards funds.

> Status: prototype for the Base Sepolia testnet and Stripe test mode. Source public, **not published on npm** (install
> from this repository). Test status: see [Feature overview](#feature-overview). Not part of any official x402, Coinbase
> or Stripe product.

## Quick start

Requirements: Node.js 20 or newer with npm, Git. Installation, demo and integration are separate steps; the demo needs no
accounts and no keys.

### 1. Install (from this repository)

```
git clone https://github.com/WestLabsAI/meterdoor
cd meterdoor
npm install
```

### 2. Local demo without keys

In the `meterdoor` folder:

```
npm run demo
```

Then open `http://127.0.0.1:8402/`. Everything is simulated and no money moves; details under
[Demo without keys](#demo-without-keys).

### 3. Add it to your own Express app

Meterdoor is an **ES module**: your `package.json` needs `"type": "module"` (or use a `.mjs` file). Tested with Node.js 20.20, 22.23 and 24.19 and Express 4.22 (all tests); Express 5.3 only with the package check (`npm run test:paket -- --express 5`).
In your app's folder, next to the cloned `meterdoor` folder:

```
npm init -y                  # only for a new app
npm pkg set type=module
npm install express@4 ../meterdoor
```

`server.js` (the same code is shown on the website; prices are examples):

```js
import express from "express";
import { paywall } from "meterdoor";

const app = express();
app.set("trust proxy", 1);

app.get("/api/bericht",
  paywall({
    price:  { eur: "0.50", usdc: "0.01" },
    stripe: { key: process.env.STRIPE_KEY },
    x402:   { payTo: process.env.WALLET,
              network: "base-sepolia" },
    access: { secret: process.env.ACCESS_SECRET,
              ttlSeconds: 3600 },
  }),
  (req, res) => res.json({ bericht: "…" })
);

app.listen(process.env.PORT || 3000);
```

Environment variables, e.g. in a `.env` file (do not commit it):

| Variable | Meaning |
|---|---|
| `STRIPE_KEY` | Stripe **test** key `sk_test_…` or `rk_test_…`; only needed if `price.eur` is set |
| `WALLET` | your receiving address on Base Sepolia; only needed if `price.usdc` is set |
| `ACCESS_SECRET` | long random string that signs the euro access tokens; needed with `price.eur` |
| `PORT` | optional, default 3000 |

```
node --env-file=.env server.js
curl -H "Accept: application/json" http://localhost:3000/api/bericht
```

`--env-file` requires Node 20.6+; otherwise set the variables in your shell. In Windows PowerShell use `curl.exe`.
Expected: `402` with `accepts` (x402) and a `checkout` link. In a browser the same URL redirects to Stripe Checkout in test
mode, which needs a valid test key. In an existing app you only need the import and the `paywall()` block in front of your
route; behind a proxy also `app.set("trust proxy", 1)`.

`test/schnellstart.test.js` starts `beispiel/schnellstart.js` on every `npm test` and checks the `402`, the payment
requirements and the checkout link. If Checkout is cancelled, `cancel_url` returns to the same URL with `?pw_cancelled=1`:
a "payment cancelled" page (status `402`, nothing charged, nothing unlocked) with a "try again" link; only that click
creates a new Checkout session. Custom target: `stripe.cancelUrl` (absolute `https` URL, `http` only for localhost;
anything else is rejected at startup).

Mainnet `base` requires the explicit option `x402.allowMainnet: true`. Checkout sessions are created with Stripe Managed
Payments off (`managed_payments[enabled]=false`), because added tax would change the amount that is verified; optional
`stripe.taxCode` sets the line item's tax code, `stripe.managedPayments: true` omits the parameter.

## Fit and limits

| Good fit | Not a good fit |
|---|---|
| Finite data responses and reports (x402: up to 1 MiB per response by default, `x402.maxResponseBytes`) | Actions with side effects such as orders or sending e-mail: with x402 the route runs after `/verify` but **before** final settlement (`/settle`). If settlement fails, the action has still happened. |
| Endpoints called both by people in a browser and by software | Streaming: with x402 the response is fully buffered and only sent after settlement. |
| Trying things out on Base Sepolia and in Stripe test mode | x402 schemes other than `exact` (e.g. `upto`) and Permit2: only `exact` with EIP-3009 (USDC) is accepted. |

- **Storage:** `memoryStore()` (default) is volatile: a restart loses stored responses for replays and open cases.
  `fileStore({ dir })` survives restarts (several processes on the same machine, no network drives).
- **What each payment buys:** euro opens exactly one endpoint for a fixed period from payment; x402 pays for exactly one
  request. See [What a purchase means](#what-a-purchase-means).
- **Refunds:** x402 does not refund automatically; `mw.openCases()` lists open cases.

## Feature overview

Levels: **tested locally (simulated)** = automated tests against emulated counterparts pass; **tested externally** = test
against the real test service passed (dated); **planned** = not available yet. Skipped tests do not count as passed. All
local checks run without accounts or keys. As of 2026-10-25.

| Feature | Core/Pro | Status | Local evidence |
|---|---|---|---|
| Euro via Stripe Checkout, timed access to one endpoint | Core | tested locally (simulated); Stripe test mode tested externally on 2026-10-23 (session creation, unpaid and unknown sessions rejected, timeout) | `npm test`, `npm run test:demo` |
| USDC per request via x402 version 1 (`X-PAYMENT`), Base Sepolia | Core | tested locally (simulated); real test payment with `x402-fetch` against the public testnet facilitator tested externally on 2026-10-25 (payment, delivery, replay without a second settlement) | `npm test`, `npm run test:demo` |
| Browser vs. agent detection on one endpoint | Core | tested locally (simulated) | `npm test`, demo case 1 |
| Replay of the same proof without a second settlement | Core | tested locally (simulated) | `npm test`, demo case 4 |
| Resolving unclear settlements (`authorizationState`) | Core | tested locally (simulated) | `npm test`, demo case 5 |
| File store `fileStore` (restarts) | Core | tested locally (simulated) | `npm test` |
| Binding `bindQuery` / `bindBodyHash` | Core | tested locally (simulated) | `npm test` |
| Stripe cancel without a checkout loop (`pw_cancelled`, `stripe.cancelUrl`) | Core | tested locally (simulated), since 0.0.6 | `npm test` |
| Package: install and import outside this repository | Core | tested locally (Node 20/22/24, Express 4 and 5) | `npm run test:paket` |
| Demo without keys | Core | tested locally in a browser | `npm run test:demo` |
| USDC per request via x402 version 2 (`PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`), Base Sepolia | Core | tested locally (simulated, since 0.0.7); real test payment with the official client `@x402/fetch` 2.28 against the public testnet facilitator tested externally on 2026-10-25 (payment, delivery, replay without a second settlement) | `npm test` |
| Quotas, CSV log, Stripe webhook reconciliation | Pro | tested locally (simulated) in pre-release 0.1.0-vorab; not published, not delivered | not part of this repository |
| Delivery of Pro with updates and support | Pro | planned (pre-sale) | – |

**Test reports (historical, dated):** 2026-10-22: `integration/` against the public testnet facilitator 3/3 passed;
Stripe and the real test payment were skipped then (no test credentials). 2026-10-23: `integration/` Stripe test mode 3/3
passed after the Managed Payments fix; a payment completed in Checkout is not part of the automated test. 2026-10-25: `integration/`
7/7 passed, 0 skipped, including the real x402 test payment on Base Sepolia with `x402-fetch` (0.01 test USDC without
value; same proof again: same response, one settlement). Skipped tests do not count as passed.

## Demo without keys

```
npm install
npm run demo
```

Starts a local server on `http://127.0.0.1:8402/` (127.0.0.1 only, stops after 10 minutes; set `PORT` / `MAX_MS` to change).
The page shows: **payment required** (`402` with both paths), **euro** via a local, simulated checkout up to access by cookie,
**x402** with a simulated agent (response incl. `X-PAYMENT-RESPONSE`), **replay** (same proof → stored response, no second
settlement) and **unclear settlement** (settle response lost → `503`, resolved on the next attempt via `authorizationState`).

**Everything is simulated:** Stripe, the facilitator and the RPC are emulated in the same process (`demo/simulation.js`); no
money moves and nothing leaves your machine. Every page carries the banner "SIMULATION – keine echte Zahlung" (no real payment),
every JSON response the field `simulation: true`, every response the header `X-Meterdoor-Simulation: 1`. The middleware is
unchanged. If environment variables look like real credentials (e.g. `STRIPE_*`, `WALLET`, `PRIVATE_KEY`, values such as
`sk_live_…`/`rk_live_…` or `0x` + 64 hex characters), the demo refuses to start.

Browser test: `npm run test:demo` (Playwright with a locally installed Edge or Chrome, no browser download; requests to hosts
other than 127.0.0.1 are aborted and must stay at 0).

## What a purchase means

| Path | What the buyer gets |
|---|---|
| **Euro (Stripe)** | One purchase opens **exactly this endpoint** (method + full path) for `access.ttlSeconds`, counted **from payment**. Unlimited calls in that window; redeeming again never extends it. |
| **USDC (x402)** | **Every request is paid individually.** Re-sending the same proof within `x402.replaySeconds` returns the stored response without a second settlement. |

## Flow

| Request | Response |
|---|---|
| with `PAYMENT-SIGNATURE` header (x402 version 2) or `X-PAYMENT` (version 1) | local checks (network, receiver, amount, asset) → facilitator `/verify` → **your route (buffered)** → `/settle` → response with `PAYMENT-RESPONSE` (version 2) or `X-PAYMENT-RESPONSE` (version 1) |
| with a valid access token (cookie or `Authorization: Bearer`) | your route |
| return from Stripe (`?pw_session=cs_…`) | session fully verified (amount, currency, own HMAC id, resource), token with fixed end issued |
| return after cancelling (`?pw_cancelled=1`) | `402`: "payment cancelled" page with "try again" (JSON: note and `checkout` link), no new session |
| browser (`Accept: text/html`) or `?pw_checkout=1` | `303` to Stripe Checkout |
| anything else | `402` with `accepts` (x402 version 1) and a `checkout` link in the body, plus a `PAYMENT-REQUIRED` header (version 2) |

**x402 versions.** Default is `x402: { versions: [1, 2] }`: both headers are accepted; if both are present,
`PAYMENT-SIGNATURE` wins. With `versions: [2]` the version 2 object is also the body and `X-PAYMENT` is rejected with `402`;
with `versions: [1]` there is no `PAYMENT-REQUIRED`. The requirements sent to the facilitator are always built by the
paywall, never taken from the proof. The same authorization (network, sender, nonce) is the same payment in both versions.
If the facilitator reports `settlement_pending` (transaction sent, confirmation open), the case is unclear, not rejected,
and is resolved on chain on the next request. An unreadable `PAYMENT-SIGNATURE` header yields `400`.
Browser clients on other origins need `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE` in your CORS
setup; the paywall sets no CORS headers.

## Hardening in 0.0.3

- **Proof fingerprint:** stored responses are only replayed for a proof whose SHA-256 fingerprint (signature and all
  authorization fields) matches the original, compared in constant time; otherwise `402` and event `nachweis_abweichend`.
- **Concurrency:** lock taken before the first `await`; stores offer atomic `claim`/`release`/`compareAndSet`, so two
  instances sharing a store run the route and settle exactly once.
- **Limits:** `maxResponseBytes` (1 MiB, oversize → no settlement), `maxConcurrent` (64), `maxEntries`, `maxStoredBytes`;
  open payment cases are never evicted.
- **Durable store:** `fileStore({ dir })` survives restarts (temp file + fsync + rename); cases left "in settlement" become
  "unclear" and are resolved on-chain via `authorizationState`, never settled blindly. Fixed `expiresAt` per case.
- **Binding:** default resource = method + full path; `access.bind`, `bindQuery(['id'])`, `bindBodyHash()` for
  parameter-dependent resources.

Details (German): [README.md](README.md).

## Tests

- `npm test` – 100 tests against emulated counterparts with a controllable clock, no keys, no network; 1 test (website
  comparison) runs only with `METERDOOR_SITE=<path/index.html>`.
- `npm run test:paket` – package check: `npm pack`, install into a separate sample app in a temporary directory, import the
  public exports, simulated requests; also checks package contents and the lockfile version. Needs the npm registry for
  express. `.github/workflows/ci.yml` runs `npm test` and the package check for Node 20/22/24 and Express 4/5 (prepared;
  only GitHub Actions will show whether it passes).
- `integration/` – against real test services; runs only with `METERDOOR_INTEGRATION=1`, keys only from the directory given
  in `METERDOOR_SECRETS` (no lookup in parent directories). Skipped tests do not count as passed.
- `npm run test:demo` – 13 browser tests of the demo (local Edge or Chrome, offline).

## License

Apache 2.0, see [LICENSE](LICENSE).
