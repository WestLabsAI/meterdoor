// Startet alle Tests in test/*.test.js mit dem eingebauten Test-Runner von Node.
// Eigene Dateiliste statt Glob, weil Node 20 `node --test test/*.test.js` unter Windows nicht auflöst.
// Integrationstests (integration/) und die Browser-Demo (demo/) laufen hier nie mit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const kern = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dateien = fs.readdirSync(path.join(kern, "test")).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join("test", f));
const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...dateien], { cwd: kern, stdio: "inherit" });
process.exit(r.status ?? 1);
