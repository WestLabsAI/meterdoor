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
