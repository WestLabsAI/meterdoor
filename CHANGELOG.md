# Changelog

## 0.1.0 – 2026-11-05

- First release intended for the npm registry: package metadata (English description, keywords, homepage, repository, bugs, author).
- Payment events `stripe_eingeloest` and `abgerechnet` carry `occurred_at` (ISO time of the payment: the Stripe charge or the
  confirmed x402 settlement); `at` stays the time of the event.
- Test tooling: time limit per test file, reproduction of hanging upstream requests, local server for the integration tests.
- Still a prototype for Base Sepolia and Stripe test mode. No breaking change compared with 0.0.7 (`occurred_at` is an added field).

## 0.0.7 – 2026-10-26

- x402 version 2 (`PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`) alongside version 1.
