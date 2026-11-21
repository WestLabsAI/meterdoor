# Meterdoor starter: Express API, EUR and USDC on one endpoint

A small Express app with one paid endpoint, `GET /api/report`.

- **Humans** open it in a browser and pay in **EUR via Stripe Checkout** (test mode).
- **AI agents** call it with an x402 client and pay in **USDC via x402** (v1 and v2, Base Sepolia testnet).
- Without payment it answers `402 Payment Required` with both offers.

The money goes straight to your Stripe account or your wallet. Meterdoor does not hold, exchange or forward funds.
Built on [`meterdoor@0.1.0`](https://www.npmjs.com/package/meterdoor) (prototype for Base Sepolia and Stripe test mode).
Not part of any official x402, Coinbase or Stripe product.

## Run it locally (about 10 minutes)

```
npm install
cp .env.example .env        # Windows: copy .env.example .env
# fill in WALLET (Base Sepolia address) and/or STRIPE_KEY + ACCESS_SECRET
npm run dev
curl -H "Accept: application/json" http://localhost:3000/api/report
```

Expected: `402` with `accepts` (x402 v1) in the body, a `PAYMENT-REQUIRED` header (x402 v2) and, if Stripe is configured,
a `checkout` link. In a browser the same URL redirects to Stripe Checkout.

You only need one payment method to start:

| Variable | Needed for | Value |
|---|---|---|
| `WALLET` | USDC via x402 | your receiving address on Base Sepolia |
| `STRIPE_KEY` | EUR via Stripe | `sk_test_…` or a restricted `rk_test_…` key |
| `ACCESS_SECRET` | EUR via Stripe | long random string, signs the access tokens after checkout |
| `PRICE_USDC`, `PRICE_EUR` | optional | default `0.01` and `0.50` (Stripe minimum) |
| `ACCESS_TTL_SECONDS` | optional | how long a EUR purchase opens the endpoint, default `3600` |

Started without any of them, the app still runs and shows a setup hint on `/` instead of crashing.

## Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/meterdoor-starter-eur-usdc-x402-on-one-e)

One click on Railway: the template asks for `WALLET` (Base Sepolia address), leaves `STRIPE_KEY` optional and generates
`ACCESS_SECRET` for you. Railway bills its usage to your own Railway account.

Any Node 20.6+ host works. `railway.json` sets the start command and the health check `/health`;
on Railway, set the variables above in the service settings. Use a single instance: the starter keeps payment state
in memory (`memoryStore()`, lost on restart). To survive restarts on one machine, pass `fileStore({ dir })` from
`meterdoor` as `x402.store` (core README, section "Speicher").

## Make it yours

Replace the handler of `/api/report` in `server.js` with your own data. It runs only after a verified payment.
For more endpoints, add one `paywall({...})` block per route.

## Tests

```
npm test
```

Starts the app in-process without network or real keys and checks the setup hint, the 402 response for USDC only,
the additional checkout link with Stripe, and the start error when `ACCESS_SECRET` is missing.

## Limits

- Testnet and Stripe test mode only. Mainnet `base` needs `x402.allowMainnet: true` in the core and your own review.
- Only the x402 scheme `exact` with USDC (EIP-3009) is accepted.
- No tax, legal or investment advice. Check invoicing and VAT for your own sales yourself.

More: [meterdoor.com](https://meterdoor.com) · core: [github.com/WestLabsAI/meterdoor](https://github.com/WestLabsAI/meterdoor) · License Apache-2.0
