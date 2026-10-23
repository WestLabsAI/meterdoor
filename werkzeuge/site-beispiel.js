// Schreibt beispiel/schnellstart.js als Codeblock in site/index.html (eine Quelle für Website und Test).
// Aufruf: node werkzeuge/site-beispiel.js [--pruefen]   (--pruefen: nur vergleichen, Exit 1 bei Abweichung)
import fs from "node:fs";
import path from "node:path";

const kern = path.resolve(import.meta.dirname, "..");
const seite = path.resolve(kern, "../../site/index.html");
const START = "<!-- schnellstart:anfang -->";
const ENDE = "<!-- schnellstart:ende -->";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function hervorheben(code) {
  return code.trimEnd().split("\n").map((zeile) => {
    const i = zeile.indexOf("//");
    const [vorne, kommentar] = i >= 0 ? [zeile.slice(0, i), zeile.slice(i)] : [zeile, ""];
    const v = esc(vorne)
      .replace(/"[^"]*"/g, (m) => `<span class="s">${m}</span>`)
      .replace(/\b(import|from|const)\b/g, '<span class="k">$1</span>');
    return v + (kommentar ? `<span class="c">${esc(kommentar)}</span>` : "");
  }).join("\n");
}
export function ausSeite(html) {
  const block = html.slice(html.indexOf(START), html.indexOf(ENDE));
  const pre = block.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1];
  return pre.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const code = fs.readFileSync(path.join(kern, "beispiel/schnellstart.js"), "utf8");
  const html = fs.readFileSync(seite, "utf8");
  if (!html.includes(START) || !html.includes(ENDE)) throw new Error("Marker fehlen in site/index.html");
  if (process.argv.includes("--pruefen")) {
    const gleich = ausSeite(html) === code;
    console.log(gleich ? "Website-Beispiel = beispiel/schnellstart.js" : "ABWEICHUNG");
    process.exit(gleich ? 0 : 1);
  }
  const neu = `${START}\n<pre class="code" aria-label="Codebeispiel: Middleware vor einer Express-Route">${hervorheben(code)}</pre>\n${ENDE}`;
  fs.writeFileSync(seite, html.slice(0, html.indexOf(START)) + neu + html.slice(html.indexOf(ENDE) + ENDE.length));
  console.log("site/index.html aktualisiert");
}
