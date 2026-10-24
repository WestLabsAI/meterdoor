# Meterdoor (prototype 0.0.4)

[Deutsch](README.md) · [Website](https://meterdoor.com)

Express middleware: **one endpoint, two ways to pay.** Humans in a browser pay in euros via Stripe Checkout, agents and
other software pay in USDC via [x402](https://www.x402.org/) (version 1, scheme `exact`). Money goes straight to your Stripe
account or your wallet; the library never holds, exchanges or forwards funds.

> Status: prototype, source public, not yet on npm (install from this repository). Tested against simulated counterparts
> (`npm test`, 91 tests including failure cases) and against the public testnet facilitator (`integration/`). Not part of
> any official x402, Coinbase or Stripe product.

## Quick start (testnet only)

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

Use a Stripe **test** key (`sk_test_…` / `rk_test_…`). Mainnet `base` requires the explicit option `x402.allowMainnet: true`.
Checkout sessions are created with Stripe Managed Payments off (`managed_payments[enabled]=false`), because added tax would change the
amount that is verified; optional `stripe.taxCode` sets the line item's tax code, `stripe.managedPayments: true` omits the parameter.

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
| with `X-PAYMENT` header (x402) | local checks (network, receiver, amount) → facilitator `/verify` → **your route (buffered)** → `/settle` → response with `X-PAYMENT-RESPONSE` |
| with a valid access token (cookie or `Authorization: Bearer`) | your route |
| return from Stripe (`?pw_session=cs_…`) | session fully verified (amount, currency, own HMAC id, resource), token with fixed end issued |
| browser (`Accept: text/html`) or `?pw_checkout=1` | `303` to Stripe Checkout |
| anything else | `402` with `accepts` (x402) and a `checkout` link |

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

## License

Apache 2.0, see [LICENSE](LICENSE).
