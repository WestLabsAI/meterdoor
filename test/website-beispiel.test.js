// Optionaler Website-Abgleich: zeigt die Website denselben Code wie beispiel/schnellstart.js?
// Nur mit ausdrücklich angegebener Seite: METERDOOR_SITE=<Pfad zu index.html>. Ohne Angabe wird nur dieser Abgleich
// übersprungen; der Schnellstart selbst wird in schnellstart.test.js immer ausgeführt.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ausSeite } from "../werkzeuge/site-beispiel.js";

const kern = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seite = process.env.METERDOOR_SITE ? path.resolve(process.env.METERDOOR_SITE) : null;
const skip = !seite ? "METERDOOR_SITE nicht gesetzt (optionaler Website-Abgleich)" : !fs.existsSync(seite) ? `METERDOOR_SITE: ${seite} fehlt` : false;

test("Website-Codeblock = beispiel/schnellstart.js", { skip }, () => {
  // Zeilenenden ignorieren: Git checkt unter Windows mit CRLF aus.
  const lf = (t) => t.replace(/\r\n/g, "\n");
  assert.equal(lf(ausSeite(fs.readFileSync(seite, "utf8"))), lf(fs.readFileSync(path.join(kern, "beispiel/schnellstart.js"), "utf8")));
});
