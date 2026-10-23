// Beispiel: ein Endpunkt, zwei Bezahlwege. Nur Testnetz (Base Sepolia) und Stripe-Testmodus.
// Start: STRIPE_KEY=sk_test_… WALLET=0x… ACCESS_SECRET=… node beispiel/server.js
import express from "express";
import { paywall } from "../src/index.js";

const { STRIPE_KEY, WALLET, ACCESS_SECRET, PORT = 4021 } = process.env;
if (STRIPE_KEY && !STRIPE_KEY.startsWith("sk_test_") && !STRIPE_KEY.startsWith("rk_test_")) {
  throw new Error("Beispiel läuft nur mit Stripe-Testschlüssel");
}

const app = express();
app.set("trust proxy", 1); // hinter einem Proxy liefert req.protocol sonst http

app.get("/api/bericht",
  paywall({
    price: { eur: "0.50", usdc: "0.01" },
    stripe: { key: STRIPE_KEY },
    x402: { payTo: WALLET, network: "base-sepolia" },
    access: { secret: ACCESS_SECRET },
    description: "Beispielbericht (Testmodus)",
  }),
  (req, res) => res.json({ bericht: "Testdaten", bezahltMit: req.payment }),
);

const server = app.listen(PORT, () => console.log(`Beispiel auf http://localhost:${PORT}/api/bericht`));
// Laufzeitgrenze, damit kein Prozess liegen bleibt (Standard 10 Minuten)
setTimeout(() => server.close(), Number(process.env.MAX_MS || 600000)).unref();
