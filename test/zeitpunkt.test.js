import { test } from "node:test";
import assert from "node:assert/strict";
import { T0, start, simple, payment, json, checkout, redeem } from "./hilfen.js";

// Zahlungsereignisse tragen occurred_at: den Zeitpunkt beim Zahlungsdienst (Stripe) bzw. der bestätigten Abrechnung (x402).
// Pro ordnet Bewegungen damit in der wirtschaftlichen Sicht ein statt unter „ohne_zeitangabe“.

test("stripe_eingeloest trägt occurred_at aus latest_charge.created, nicht den Einlösezeitpunkt", async () => {
  const app = await start(simple());
  app.fk.paidAt = T0 - 120;
  const s = await checkout(app);
  const r = await redeem(app, s);
  assert.equal(r.status, 200);
  const e = app.events.find((x) => x.type === "stripe_eingeloest");
  assert.equal(e.occurred_at, new Date((T0 - 120) * 1000).toISOString());
  assert.equal(e.at, new Date(T0 * 1000).toISOString());
  await app.close();
});

test("ohne latest_charge gilt payment_intent.created", async () => {
  const app = await start(simple());
  const s = await checkout(app);
  delete s.payment_intent.latest_charge;
  assert.equal((await redeem(app, s)).status, 200);
  const e = app.events.find((x) => x.type === "stripe_eingeloest");
  assert.equal(e.occurred_at, new Date((T0 - 60) * 1000).toISOString());
  await app.close();
});

test("abgerechnet (x402) trägt occurred_at = Zeitpunkt der bestätigten Abrechnung", async () => {
  const app = await start(simple());
  const r = await fetch(`${app.base}/api/bericht`, { headers: { ...json, "x-payment": payment() } });
  assert.equal(r.status, 200);
  const e = app.events.find((x) => x.type === "abgerechnet");
  assert.equal(e.occurred_at, new Date(T0 * 1000).toISOString());
  assert.equal(e.transaction, "0xtx1");
  await app.close();
});
