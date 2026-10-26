// Paket-Smoke-Test: Paket lokal erzeugen (npm pack) → in einer separaten Beispielanwendung in einem temporären
// Verzeichnis installieren → öffentliche Exporte importieren → simulierte Anfragen prüfen. Veröffentlicht nichts.
// Aufruf: node werkzeuge/paket-probe.js [--express 4|5]
// Braucht Zugriff auf die npm-Registry für express (oder einen gefüllten npm-Cache). Keine Schlüssel, kein Zahlungsdienst:
// Stripe bekommt einen Platzhalter-Schlüssel und wird nicht aufgerufen, der Facilitator ist eine lokale Nachbildung.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const kern = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ei = process.argv.indexOf("--express");
const expressVersion = ei > 0 ? process.argv[ei + 1] : "4";
if (!/^\d+$/.test(expressVersion)) { console.error("--express: Hauptversion angeben, z. B. 4"); process.exit(2); }

// Inhalt des Pakets: genau diese Dateien und Ordner, sonst nichts (files in package.json).
const PFLICHT = ["package.json", "LICENSE", "README.md", "README.en.md", "src/index.js", "src/speicher.js", "beispiel/schnellstart.js"];
const VERBOTEN = /^(test|integration|demo|werkzeuge|node_modules|\.github)\/|\.secrets|\.env|\.meterdoor-store|pro\/|\.tgz$/;

function npm(args, cwd) {
  // Über `npm run` gestartet: npm-cli.js direkt mit diesem Node aufrufen (ohne Shell); sonst npm aus dem PATH.
  const viaNode = process.env.npm_execpath && /\.c?js$/.test(process.env.npm_execpath);
  const r = viaNode
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} fehlgeschlagen:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meterdoor-paket-"));
let kind;
try {
  // 1. Paket erzeugen
  const info = JSON.parse(npm(["pack", "--json", "--pack-destination", tmp], kern))[0];
  const inhalt = info.files.map((f) => f.path.replace(/\\/g, "/"));
  const fehlt = PFLICHT.filter((p) => !inhalt.includes(p));
  const zuviel = inhalt.filter((p) => VERBOTEN.test(p));
  if (fehlt.length || zuviel.length) throw new Error(`Paketinhalt: fehlt ${fehlt.join(", ") || "-"}; nicht erlaubt ${zuviel.join(", ") || "-"}`);
  const lock = JSON.parse(fs.readFileSync(path.join(kern, "package-lock.json"), "utf8"));
  if (lock.version !== info.version || lock.packages?.[""]?.version !== info.version) throw new Error(`Lockfile-Version ${lock.version} ≠ Paket ${info.version}`);
  console.log(`Paket ${info.filename}: ${inhalt.length} Dateien, ${info.size} Bytes`);

  // 2. Separate Beispielanwendung
  const app = path.join(tmp, "app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "paket-probe", private: true, type: "module" }, null, 2));
  npm(["install", "--no-audit", "--no-fund", "--loglevel=error", path.join(tmp, info.filename), `express@${expressVersion}`], app);
  const expressInstalliert = JSON.parse(fs.readFileSync(path.join(app, "node_modules/express/package.json"), "utf8")).version;

  // 3. Öffentliche Exporte und simulierte Anfragen
  fs.writeFileSync(path.join(app, "probe.mjs"), `
import express from "express";
import * as md from "meterdoor";
const erwartet = ["paywall", "memoryStore", "fileStore", "bindQuery", "bindBodyHash", "toUnits", "signToken", "verifyToken", "NETWORKS"];
const fehlt = erwartet.filter((n) => !(n in md));
if (fehlt.length) { console.error("Exporte fehlen: " + fehlt.join(", ")); process.exit(1); }
// Nachgebildeter Facilitator: verify ok, settle ok. Stripe wird nicht aufgerufen.
const fakeFetch = async (url, init) => {
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  if (String(url).endsWith("/verify")) return ok({ isValid: true, payer: "0x00000000000000000000000000000000000000aa" });
  if (String(url).endsWith("/settle")) return ok({ success: true, transaction: "0x" + "ab".repeat(32), network: "base-sepolia" });
  throw new Error("unerwarteter Aufruf " + url);
};
const app = express();
app.get("/api/bericht", md.paywall({
  price: { eur: "0.50", usdc: "0.01" }, stripe: { key: "sk_test_dummy" },
  x402: { payTo: "0x0000000000000000000000000000000000000001", network: "base-sepolia" },
  access: { secret: "probe-geheimnis" }, fetch: fakeFetch,
}), (req, res) => res.json({ bericht: "ok", weg: req.payment?.method || null }));
const server = app.listen(0, "127.0.0.1", async () => {
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const r = await fetch(base + "/api/bericht", { headers: { accept: "application/json" } });
    const b = await r.json();
    if (r.status !== 402 || b.accepts?.[0]?.maxAmountRequired !== "10000" || !b.checkout) throw new Error("402 unerwartet: " + r.status + " " + JSON.stringify(b));
    const now = Math.floor(Date.now() / 1000);
    const nachweis = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {
      signature: "0x" + "11".repeat(65),
      authorization: { from: "0x00000000000000000000000000000000000000aa", to: "0x0000000000000000000000000000000000000001",
        value: "10000", validAfter: "0", validBefore: String(now + 60), nonce: "0x" + "22".repeat(32) } } })).toString("base64");
    const p = await fetch(base + "/api/bericht", { headers: { accept: "application/json", "x-payment": nachweis } });
    const pb = await p.json();
    if (p.status !== 200 || pb.weg !== "x402" || !p.headers.get("x-payment-response")) throw new Error("Zahlung unerwartet: " + p.status + " " + JSON.stringify(pb));
    console.log("ok: Exporte vollständig, 402 mit beiden Wegen, simulierte x402-Zahlung 200");
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  server.close();
});
`);
  const ergebnis = await new Promise((ok) => {
    kind = spawn(process.execPath, ["probe.mjs"], { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    kind.stdout.on("data", (d) => { out += d; });
    kind.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => kind.kill(), 20000);
    kind.on("exit", (code) => { clearTimeout(t); ok({ code, out }); });
  });
  process.stdout.write(ergebnis.out);
  if (ergebnis.code !== 0) throw new Error("Probe-Anwendung fehlgeschlagen");
  console.log(`Paket-Probe bestanden (Node ${process.versions.node}, Express ${expressInstalliert})`);
} catch (err) {
  console.error(`Paket-Probe fehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (kind && kind.exitCode === null) kind.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
