// Starts the starter in-process (no network, no real keys) and checks what a client sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";

async function withServer(env, fn) {
  const server = createApp(env).listen(0);
  await new Promise((r) => server.once("listening", r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

const WALLET = "0x1111111111111111111111111111111111111111";

test("without configuration: setup hint instead of crash", async () => {
  await withServer({}, async (base) => {
    assert.match(await (await fetch(base + "/")).text(), /no payment method is configured/);
    assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true, configured: false });
    assert.equal((await fetch(base + "/api/report")).status, 503);
  });
});

test("USDC only: 402 with x402 v1 accepts and v2 PAYMENT-REQUIRED header", async () => {
  await withServer({ WALLET }, async (base) => {
    const res = await fetch(base + "/api/report", { headers: { accept: "application/json" } });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.accepts[0].network, "base-sepolia");
    assert.equal(body.accepts[0].payTo.toLowerCase(), WALLET);
    assert.ok(res.headers.get("payment-required"), "PAYMENT-REQUIRED header missing");
    assert.equal(body.checkout, undefined);
  });
});

test("EUR and USDC: 402 also offers a Stripe checkout link", async () => {
  await withServer({ WALLET, STRIPE_KEY: "sk_test_dummy", ACCESS_SECRET: "x".repeat(32) }, async (base) => {
    const res = await fetch(base + "/api/report", { headers: { accept: "application/json" } });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.ok(body.accepts?.length >= 1);
    assert.ok(body.checkout, "checkout link missing");
    assert.match(await (await fetch(base + "/")).text(), /EUR 0\.50 via Stripe Checkout, USDC 0\.01/);
  });
});

test("EUR without ACCESS_SECRET fails loudly at start", () => {
  assert.throws(() => createApp({ STRIPE_KEY: "sk_test_dummy" }), /access\.secret/);
});
