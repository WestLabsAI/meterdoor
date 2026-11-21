// Meterdoor starter: one paid endpoint, two ways to pay.
// Humans in a browser pay in EUR via Stripe Checkout (test mode), AI agents pay in USDC via x402 (Base Sepolia).
// Configuration comes from environment variables only; see .env.example.
import express from "express";
import { paywall } from "meterdoor";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createApp(env = process.env) {
  const app = express();
  app.set("trust proxy", 1);

  const usdc = env.WALLET ? (env.PRICE_USDC || "0.01") : null;
  const eur = env.STRIPE_KEY ? (env.PRICE_EUR || "0.50") : null;
  const configured = Boolean(usdc || eur);

  app.get("/", (req, res) => {
    res.type("text/plain").send(configured
      ? [
          "Meterdoor starter is running.",
          "",
          `Paid endpoint: GET /api/report  (${[eur && `EUR ${eur} via Stripe Checkout`, usdc && `USDC ${usdc} via x402 on Base Sepolia`].filter(Boolean).join(", ")})`,
          ...(eur ? ["Open it in a browser to pay in EUR (Stripe test mode)."] : []),
          ...(usdc ? ["Call it with an x402 client to pay in USDC (testnet)."] : []),
          "Without payment it answers 402 Payment Required with the offers above.",
        ].join("\n")
      : [
          "Meterdoor starter is running, but no payment method is configured yet.",
          "",
          "Set WALLET (your Base Sepolia address) for USDC via x402,",
          "and/or STRIPE_KEY (sk_test_... or rk_test_...) plus ACCESS_SECRET for EUR via Stripe Checkout.",
          "Then restart. Details: README.md",
        ].join("\n"));
  });

  app.get("/health", (req, res) => res.json({ ok: true, configured }));

  if (configured) {
    app.get("/api/report",
      paywall({
        price: { ...(eur && { eur }), ...(usdc && { usdc }) },
        ...(eur && { stripe: { key: env.STRIPE_KEY } }),
        ...(usdc && { x402: { payTo: env.WALLET, network: "base-sepolia" } }),
        access: { secret: env.ACCESS_SECRET, ttlSeconds: Number(env.ACCESS_TTL_SECONDS || 3600) },
      }),
      // Replace this handler with your own data. It only runs after a verified payment.
      (req, res) => res.json({ report: "Paid content goes here.", servedAt: new Date().toISOString() })
    );
  } else {
    app.get("/api/report", (req, res) =>
      res.status(503).json({ error: "not_configured", hint: "Set WALLET and/or STRIPE_KEY + ACCESS_SECRET, see README.md" }));
  }

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`Meterdoor starter listening on port ${port}`));
}
