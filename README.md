# Meterdoor (Prototyp 0.0.3)

[English](README.en.md)

Express-Middleware: **ein Endpunkt, zwei Bezahlwege.** Menschen im Browser zahlen in Euro über Stripe Checkout,
KI-Agenten zahlen in USDC über [x402](https://www.x402.org/) (Version 1, Schema `exact`). Das Geld geht direkt an Ihr
Stripe-Konto bzw. Ihre Wallet; die Bibliothek verwahrt, tauscht oder leitet nichts weiter.

> Status: Prototyp, Quellcode öffentlich, noch nicht auf npm (Installation aus dem Repo). Getestet mit nachgebildeten Gegenstellen (`npm test`, inkl. Fehlerfällen) und gegen den
> öffentlichen Testnetz-Facilitator (`integration/`). Echte Testzahlungen (Stripe-Testmodus, Base Sepolia) stehen noch aus.
> Kein Teil eines offiziellen x402-, Coinbase- oder Stripe-Produkts.

```js
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
```

Derselbe Code steht auf der Website; `test/website-beispiel.test.js` startet ihn. Quelle: `beispiel/schnellstart.js`,
Übertrag auf die Seite mit `node werkzeuge/site-beispiel.js`.

## Was ein Kauf bedeutet

| Weg | Leistung |
|---|---|
| **Euro (Stripe)** | Ein Kauf öffnet **genau diesen Endpunkt** (Methode + voller Pfad) für die gekaufte Dauer `access.ttlSeconds`, gerechnet **ab Zahlung**. In dieser Zeit beliebig viele Abrufe. Das Ende steht fest: erneutes Einlösen verlängert nichts. |
| **USDC (x402)** | **Jede Anfrage wird einzeln bezahlt.** Ein Zahlungsnachweis gilt für eine Anfrage; derselbe Nachweis liefert innerhalb von `x402.replaySeconds` dieselbe Antwort erneut, ohne neue Abrechnung. |

## Ablauf

| Anfrage | Antwort |
|---|---|
| mit Header `X-PAYMENT` (x402) | lokal prüfen (Netz, Empfänger, Betrag) → Facilitator `/verify` → **Ihre Route (gepuffert)** → `/settle` → Antwort mit `X-PAYMENT-RESPONSE` |
| mit gültigem Zugangstoken (Cookie `pw_token` oder `Authorization: Bearer`) | Ihre Route |
| Rückkehr aus Stripe (`?pw_session=cs_…`) | Sitzung vollständig prüfen (s. u.), Token mit festem Ende ausgeben |
| Browser (`Accept: text/html`) oder `?pw_checkout=1` | `303` zu Stripe Checkout |
| alles andere | `402` mit `accepts` (x402) und `checkout`-Link |

`req.payment` sagt Ihrer Route, wie bezahlt wurde.

## Prüfungen

**Ressource.** Kennung = Methode + `req.baseUrl + req.path` (ohne Query), optional mit `access.tenant`; `access.resourceId`
ersetzt Methode und Pfad durch eine ausdrückliche Kennung. Sie steckt im Token, im Stripe-Metadatum, in `resource` (x402), in
Rücksprungadressen und im Cookie-Pfad. Bei `app.use("/premium", router)` gilt also ein Token für `/basic/bericht` nicht für
`/premium/bericht`, und ein GET-Token nicht für POST.

**Engere Bindung (`access.bind`).** Standard bleibt Methode + voller Pfad ohne Query: `/bericht?id=1` und `/bericht?id=2` sind
dieselbe Ressource. Hängt der Inhalt von Parametern ab, binden Sie diese ein:

```js
import { paywall, bindQuery, bindBodyHash } from "meterdoor";

// Ein Kauf bzw. eine Zahlung gilt nur für genau diese id.
app.get("/bericht", paywall({ ...optionen, access: { secret, bind: bindQuery(["id"]) } }), bericht);

// POST: Die Zahlung gilt nur für genau diesen Body (Body-Parser vorher einbinden).
app.post("/rechnen", express.json(), paywall({ ...optionen, access: { secret, bind: bindBodyHash() } }), rechnen);

// Eigene Regel: (req, standard) => String
const bind = (req, standard) => `${standard}|${req.params.kunde}`;
```

Die Bindung gilt für Token, `metadata[pw_resource]`, gespeicherte x402-Antworten und den Abgleich beim Einlösen. Mit `bind`
bleibt die eigene Query (ohne `pw_`-Parameter) in `resource`, `checkout`-Link und Rücksprungadressen erhalten, und das
Cookie heißt `pw_token_<kennung>`, damit Käufe für verschiedene ids sich nicht überschreiben. `bindQuery` berücksichtigt nur
die genannten Parameter. `bindBodyHash` bildet SHA-256 über den Body (Rohdaten bei `express.raw`/`express.text`, sonst über
eine sortierte JSON-Form); ohne gelesenen Body antwortet die Middleware mit 500, statt alle Bodys gleich zu behandeln. Der
Euro-Weg leitet per GET weiter; `bindBodyHash` ist daher für x402-Aufrufe gedacht. Stripe begrenzt Metadaten auf 500 Zeichen
je Wert.

**Stripe-Sitzung.** Beim Anlegen setzt Meterdoor `metadata[pw_id]` = HMAC(`access.secret`; Ressource, Betrag, Währung, Dauer).
Beim Einlösen wird die Sitzung mit `line_items` und `payment_intent.latest_charge` abgerufen und verlangt: `mode=payment`,
`status=complete`, `payment_status=paid`, `currency=eur`, `amount_total` = `amount_subtotal` = Preis, genau eine Position mit
Menge 1, PaymentIntent `succeeded` mit vollem Betrag, passende Ressource und `pw_id`, Test-/Livemodus passend zum Schlüssel.
Unbekannte Sitzung (z. B. aus einem anderen Konto) → 402. Ändern Sie den Preis, lassen sich ältere Sitzungen nicht mehr einlösen.

**Zugangsdauer.** Beginn = Zeitpunkt der Belastung (`latest_charge.created`), Ende = Beginn + gekaufte Dauer. Token-Format
`v2.<ende>.<ressource>.<hmac>`; Tokens des Formats `v1` werden abgelehnt.

## x402: bezahlt, aber keine Daten?

Entscheidung: **erst die Leistung, dann die Abrechnung** (wie die x402-Referenz-Middleware), plus Wiederholung über den Nachweis.

1. Route läuft erst nach erfolgreichem `/verify`; ihre Antwort wird **gepuffert**, nicht gesendet.
2. Antwortet die Route mit Status ≥ 400, wirft sie, überschreitet sie `x402.routeTimeoutMs` (Standard 30 s) oder bricht der
   Client vorher ab, wird **nicht abgerechnet**.
3. Sonst wird die gepufferte Antwort unter der Zahlungskennung (Netz + Absender + Nonce der Autorisierung) gespeichert und
   dann `/settle` aufgerufen. Erst bei Erfolg wird ausgeliefert.
4. Gleicher Nachweis erneut (Verbindungsabbruch, Neustart des Agenten): dieselbe Antwort ohne neue Abrechnung. Parallele
   Anfragen mit demselben Nachweis warten auf die erste; die Route läuft einmal, abgerechnet wird einmal – auch über
   mehrere Instanzen, wenn der Speicher `claim` beherrscht (siehe Speicher).
   Ausgeliefert wird nur bei **vollständig gleichem Nachweis**: Beim ersten Durchlauf speichert Meterdoor einen
   Fingerabdruck (SHA-256 über Signatur, `from`, `to`, `value`, `validAfter`, `validBefore`, `nonce`, Netzwerk, Asset).
   Jede Wiederholung und jede Klärung wird zeitkonstant dagegen geprüft; Abweichung → 402, Ereignis `nachweis_abweichend`,
   der gespeicherte Fall bleibt unverändert. Absender + Nonce allein (z. B. ohne Signatur) öffnen also nichts.
5. Geht die Antwort des Facilitators verloren (Zeitüberschreitung, unlesbar), ist der Fall **unklar**: 503 mit `Retry-After`.
   Beim nächsten Versuch mit demselben Nachweis liest Meterdoor `authorizationState` des USDC-Vertrags (nur lesend, `x402.rpcUrl`):
   eingelöst → ausliefern; nicht eingelöst und noch gültig → erneut abrechnen; abgelaufen → 402. Doppelt abgerechnet werden kann
   dieselbe Autorisierung nicht (EIP-3009-Nonce).

Nachteile, offen gesagt: Die Route läuft, bevor Geld geflossen ist; scheitert danach `/settle` (z. B. Guthaben inzwischen weg),
hat die Route umsonst gearbeitet – für Endpunkte mit Nebenwirkungen (Mails, Bestellungen) ungeeignet. Streaming-Antworten werden
vollständig gepuffert. Antwortet die Route nach `routeTimeoutMs` noch, wird das verworfen.

**Zustände eines Falls.** `in_abrechnung` (Antwort gesichert, `/settle` läuft) → `bezahlt`; geht die Antwort des
Facilitators verloren: `unklar`; lehnt er die Abrechnung ab, wird der Fall gelöscht.

**Offene Fälle und Erstattung.** `mw.openCases()` liefert Fälle in Abrechnung, mit unklarer Abrechnung oder mit bezahlter,
nicht zugestellter Antwort; `onEvent` meldet jedes Ereignis (`abgerechnet`, `abrechnung_unklar`, `nicht_zugestellt`, `route_fehler` …).
**x402 erstattet nicht automatisch.** Hat jemand bezahlt und die Antwort nie abgerufen, zahlen Sie den Betrag bei Bedarf von
Ihrer Wallet an die Absenderadresse zurück (Transaktion und Absender stehen im Fall).

## Speicher

| Speicher | Einsatz |
|---|---|
| `memoryStore()` (Standard) | ein Prozess; geht beim Neustart verloren. Mehrere Middleware-Instanzen im selben Prozess dürfen ihn teilen. |
| `fileStore({ dir })` | übersteht Neustarts; eine Datei je Fall (temporäre Datei + `fsync` + `rename`), Sperren als exklusiv angelegte Dateien. Mehrere Prozesse auf **demselben Rechner** dürfen ein Verzeichnis teilen; keine Netzlaufwerke. Ohne native Abhängigkeit. |

```js
import { paywall, fileStore } from "meterdoor";
const store = fileStore({ dir: "./daten/zahlungen" }); // Verzeichnis nicht öffentlich ausliefern
app.get("/api/bericht", paywall({ ...optionen, x402: { payTo, network: "base-sepolia", store } }), bericht);
```

**Schnittstelle für eigene Speicher** (Methoden dürfen synchron oder asynchron sein):

| Methode | Bedeutung |
|---|---|
| `get(id)` | Wert oder `undefined` |
| `set(id, wert, sekunden)` | speichern. Ablauf = `wert.expiresAt`, sonst bisheriger Ablauf, sonst jetzt + Sekunden. Zustandsänderungen verlängern nichts. |
| `delete(id)`, `list()` | löschen; alle Einträge als `{ id, ...wert }` (für `openCases` und Wiederanlauf) |
| `claim(id, owner, sekunden)` | **atomar**: `true`, wenn die Sperre für `id` jetzt `owner` gehört (frei, abgelaufen oder schon eigene) |
| `release(id, owner)` | Sperre freigeben, wenn sie `owner` gehört |
| `compareAndSet(id, alterZustand, neu, sekunden)` | **atomar**: nur speichern, wenn `wert.state === alterZustand` (`undefined` = kein Eintrag); `neu = null` löscht |

Fehlen `claim`/`release`, meldet die Middleware beim Start das Ereignis `speicher_ohne_sperre` („nur eine Instanz
sicher“): Innerhalb eines Prozesses bleibt alles korrekt; über mehrere Instanzen kann dieselbe Route dann doppelt laufen
(abgerechnet wird trotzdem höchstens einmal, EIP-3009-Nonce).

**Ablauf je Nachweis.** Die lokale Sperre wird ohne vorheriges `await` gesetzt; danach `claim` im Speicher (wartet, solange
eine andere Instanz denselben Nachweis bearbeitet), dann wird der Zustand gelesen und entschieden. Die Sperre gilt
`x402.lockSeconds` (Standard: `routeTimeoutMs` + 3 × `timeoutMs` + 5 s; muss länger sein als `routeTimeoutMs` + 2 × `timeoutMs`).

**Wiederanlauf.** Beim Start (`await mw.ready`, Ergebnis = Anzahl) werden Fälle `in_abrechnung` ohne lebende Sperre auf
`unklar` gesetzt (Ereignis `wiederanlauf_unklar`). Der nächste Abruf mit demselben Nachweis klärt sie über `authorizationState`:
eingelöst → gespeicherte Antwort ausliefern; nicht eingelöst und gültig → einmal abrechnen; abgelaufen → 402. Ein Fall wird
nie blind neu abgerechnet. Findet ein Abruf einen Fall `in_abrechnung` mit abgelaufener Sperre (Instanz abgestürzt), gilt
dasselbe.

**Ablauf der Fälle.** Jeder Fall bekommt beim Anlegen ein festes `expiresAt` (`x402.replaySeconds`, Standard 3600 s). Fälle
`in_abrechnung` und `unklar` verfallen nicht und werden nie verdrängt; sie bleiben, bis sie geklärt sind oder Sie sie
löschen (`store.delete(id)`).

## Grenzen

| Option | Standard | Wirkung |
|---|---|---|
| `x402.maxResponseBytes` | 1 MiB | Größere Antwort der Route → Puffer verworfen, 500, **keine Abrechnung** (Ereignis `antwort_zu_gross`) |
| `x402.maxConcurrent` | 64 | Mehr gleichzeitige x402-Anfragen → 503 mit `Retry-After: 5`, nichts berechnet (Ereignis `ueberlastet`) |
| `x402.maxEntries` | 10 000 | Fälle im Standardspeicher (bei eigenem Speicher: `memoryStore({ maxEntries })` bzw. `fileStore({ dir, maxEntries })`) |
| `x402.maxStoredBytes` | 64 MiB | Datenmenge im Standardspeicher (ebenso als Option von `memoryStore`/`fileStore`) |

Ist der Speicher voll, entfernt er zuerst abgelaufene Fälle, dann die ältesten bereits zugestellten. Offene Fälle
(`in_abrechnung`, `unklar`) und bezahlte, noch nicht zugestellte Antworten werden nie verdrängt; stattdessen wird der neue
Auftrag vor der Abrechnung mit 503 und `Retry-After: 30` abgewiesen (Ereignis `speicher_voll`). Die Route ist dann bereits
gelaufen (siehe Nachteile oben). `mw.limits` zeigt die wirksamen Werte.

## Fehler der Gegenstellen

Jede Anfrage an Stripe, Facilitator und RPC hat eine Zeitgrenze (`stripe.timeoutMs`, `x402.timeoutMs`, Standard 10 s).
Zeitüberschreitung, Netzfehler oder 5xx → `503` mit `Retry-After`; unlesbare Antwort (z. B. HTML) oder unerwarteter 4xx → `502`.
Nie ein Stack-Trace, nie „bezahlt“ ohne Bestätigung.

## Schutz eingebaut

- Beträge nur als String (`"0.50"`), Umrechnung ohne Gleitkomma; Stripe-Mindestbetrag 0,50 € wird beim Start geprüft.
- Hauptnetz `base` nur mit `x402.allowMainnet: true`; Standard ist `base-sepolia`.

## Tests

- `npm test` – 91 Tests mit nachgebildeten Gegenstellen und steuerbarer Uhr (`now`-Option), inkl. aller Fehlerfälle,
  Fälschungen des Zahlungsnachweises, verzögertem Speicher mit zwei Instanzen und Neustarts mit `fileStore`.
- `integration/` – gegen echte Gegenstellen: öffentlicher Facilitator (ohne Guthaben), Stripe-Testmodus und echte
  Base-Sepolia-Zahlung mit dem unabhängigen Client `x402-fetch`. Schlüssel nur aus `.secrets/`; fehlen sie, wird übersprungen.
  `cd integration && npm install && npm test`.

## Bekannte Grenzen des Prototyps

- x402 Version 1 (Header `X-PAYMENT`); Version 2 folgt.
- Ohne `app.set("trust proxy", 1)` hinter einem Proxy steht in `resource` `http` statt `https`.
- Kontingente, CSV-Protokoll mit EUR-Gegenwert und Webhook-Abgleich sind nicht Teil des Kerns (Pro).

## Lizenz

Apache License 2.0, siehe `LICENSE`.
