# Meterdoor (Prototyp 0.0.7)

[English](README.en.md) · [Website](https://meterdoor.com)

Express-Middleware: **ein Endpunkt, zwei Bezahlwege.** Menschen im Browser zahlen in Euro über Stripe Checkout,
KI-Agenten zahlen in USDC über [x402](https://www.x402.org/) (Version 1 und 2, Schema `exact` mit EIP-3009). Abgewickelt wird über Ihr
Stripe-Konto bzw. einen x402-Facilitator; das Geld geht direkt an Sie. Meterdoor selbst verwahrt, tauscht oder leitet kein
Geld weiter.

> Status: Prototyp für das Testnetz Base Sepolia und den Stripe-Testmodus. Quellcode öffentlich, **kein npm-Paket
> veröffentlicht** (Installation aus diesem Repository). Stand der Prüfungen siehe [Funktionsübersicht](#funktionsübersicht).
> Kein Teil eines offiziellen x402-, Coinbase- oder Stripe-Produkts.

## Schnellstart

Voraussetzungen: Node.js 20 oder neuer mit npm, Git. Installation, Demo und Einbindung sind getrennte Schritte; für die
Demo brauchen Sie keine Konten und keine Schlüssel.

### 1. Installieren (aus dem Repository)

```
git clone https://github.com/WestLabsAI/meterdoor
cd meterdoor
npm install
```

### 2. Lokale Demo ohne Schlüssel

Im Ordner `meterdoor`:

```
npm run demo
```

Dann `http://127.0.0.1:8402/` im Browser öffnen. Alles ist simuliert, es fließt kein Geld; Einzelheiten unter
[Demo ohne Schlüssel](#demo-ohne-schlüssel).

### 3. In eine eigene Express-App einbinden

Meterdoor ist ein **ES-Modul**: Ihr `package.json` braucht `"type": "module"` (oder die Datei endet auf `.mjs`).
Geprüft mit Node.js 20.20, 22.23 und 24.19 und Express 4.22 (alle Tests); Express 5.3 nur mit der Paket-Probe
(`npm run test:paket -- --express 5`). Im Ordner Ihrer App, der neben dem geklonten Ordner `meterdoor` liegt:

```
npm init -y                  # nur bei einer neuen App
npm pkg set type=module
npm install express@4 ../meterdoor
```

`server.js` (derselbe Code steht auf der Website; Preise sind Beispielwerte):

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

Umgebungsvariablen, z. B. in einer Datei `.env` (nicht einchecken):

| Variable | Bedeutung |
|---|---|
| `STRIPE_KEY` | Stripe-Testschlüssel `sk_test_…` oder `rk_test_…`; nur nötig, wenn `price.eur` gesetzt ist |
| `WALLET` | Ihre Empfangsadresse auf Base Sepolia; nur nötig, wenn `price.usdc` gesetzt ist |
| `ACCESS_SECRET` | lange Zufallszeichenkette, signiert die Zugangstoken des Euro-Wegs; nötig mit `price.eur` |
| `PORT` | optional, Standard 3000 |

```
node --env-file=.env server.js
curl -H "Accept: application/json" http://localhost:3000/api/bericht
```

`--env-file` gibt es ab Node 20.6; sonst die Variablen in der Shell setzen. In Windows PowerShell heißt der Aufruf
`curl.exe`. Erwartet: `402` mit `accepts` (x402) und `checkout`-Link. Im Browser leitet derselbe Aufruf zu Stripe Checkout
im Testmodus weiter; dafür muss der Testschlüssel gültig sein. In einer bestehenden App genügen Import und `paywall()`-Block
vor Ihrer Route; hinter einem Proxy zusätzlich `app.set("trust proxy", 1)`.

Der Code oben ist `beispiel/schnellstart.js`; `test/schnellstart.test.js` startet ihn bei jedem `npm test` und prüft
`402`, Zahlungsanforderung und Checkout-Link. Wer den Code auf einer eigenen Seite zeigt, gleicht ihn mit
`node werkzeuge/site-beispiel.js --seite <pfad/index.html> --pruefen` ab (ohne `--pruefen`: übertragen); im Test mit
`METERDOOR_SITE=<pfad/index.html> npm test`, sonst wird nur dieser Abgleich übersprungen.

Bricht jemand den Stripe Checkout ab, führt `cancel_url` auf dieselbe Adresse mit `?pw_cancelled=1`: eine Seite
„Zahlung abgebrochen“ (Status `402`, nichts berechnet, nichts freigeschaltet) mit dem Link „Erneut versuchen“; erst
dieser Klick legt eine neue Checkout-Sitzung an. Eigenes Ziel: `stripe.cancelUrl` (absolute `https`-Adresse, `http`
nur für localhost; andere Werte werden beim Start abgewiesen).

Stripe Checkout-Sitzungen werden mit ausgeschaltetem Stripe Managed Payments angelegt (`managed_payments[enabled]=false`),
weil aufgeschlagene Steuer den geprüften Betrag ändern würde; optional `stripe.taxCode` (Steuercode der Position),
`stripe.managedPayments: true` (Parameter weglassen). Hauptnetz `base` nur mit `x402.allowMainnet: true`.

## Eignung und Grenzen

| Geeignet | Nicht geeignet |
|---|---|
| Abgeschlossene Datenantworten und Berichte (bei x402 standardmäßig bis 1 MiB je Antwort, `x402.maxResponseBytes`) | Aktionen mit Nebenwirkungen wie Bestellungen oder E-Mail-Versand: Bei x402 läuft die Route nach `/verify`, aber **vor** der endgültigen Abrechnung (`/settle`). Scheitert diese, ist die Aktion trotzdem geschehen. |
| Endpunkte, die Menschen im Browser und Programme gleichermaßen abrufen | Streaming: Bei x402 wird die Antwort vollständig gepuffert und erst nach der Abrechnung gesendet. |
| Erprobung im Testnetz Base Sepolia und im Stripe-Testmodus | Andere x402-Schemata als `exact` (z. B. `upto`) und Permit2: angenommen wird nur `exact` mit EIP-3009 (USDC). |

- **Speicher:** `memoryStore()` (Standard) ist flüchtig: Beim Neustart gehen gespeicherte Antworten für Wiederholungen und
  offene Fälle verloren. `fileStore({ dir })` übersteht Neustarts (mehrere Prozesse auf demselben Rechner, keine
  Netzlaufwerke). Siehe [Speicher](#speicher).
- **Leistung je Bezahlweg:** Euro öffnet genau einen Endpunkt für eine feste Dauer ab Zahlung; x402 bezahlt genau eine
  Anfrage. Siehe [Was ein Kauf bedeutet](#was-ein-kauf-bedeutet).
- **Erstattung:** x402 erstattet nicht automatisch; offene Fälle liefert `mw.openCases()`.

## Funktionsübersicht

Stufen: **lokal simuliert geprüft** = automatisierte Tests mit nachgebildeten Gegenstellen bestehen; **extern geprüft** =
Test gegen den echten Testdienst bestanden (mit Datum); **geplant** = noch nicht vorhanden. Übersprungene Tests zählen
nicht als bestanden. Alle lokalen Nachweise laufen ohne Konten und ohne Schlüssel. Stand: 25.10.2026.

| Funktion | Kern/Pro | Stand | Lokaler Nachweis |
|---|---|---|---|
| Euro über Stripe Checkout, Zeitzugang zu einem Endpunkt | Kern | lokal simuliert geprüft; Stripe-Testmodus extern geprüft am 23.10.2026 (Sitzung anlegen, unbezahlte und unbekannte Sitzung abgelehnt, Zeitüberschreitung) | `npm test`, `npm run test:demo` |
| USDC je Anfrage über x402 Version 1 (`X-PAYMENT`), Base Sepolia | Kern | lokal simuliert geprüft; echte Testzahlung mit `x402-fetch` gegen den öffentlichen Testnetz-Facilitator extern geprüft am 25.10.2026 (Zahlung, Auslieferung, Wiederholung ohne zweite Abrechnung) | `npm test`, `npm run test:demo` |
| Erkennung Browser oder Agent an einem Endpunkt | Kern | lokal simuliert geprüft | `npm test`, Demo Fall 1 |
| Wiederholung desselben Nachweises ohne neue Abrechnung | Kern | lokal simuliert geprüft | `npm test`, Demo Fall 4 |
| Klärung unklarer Abrechnungen (`authorizationState`) | Kern | lokal simuliert geprüft | `npm test`, Demo Fall 5 |
| Dateispeicher `fileStore` (Neustarts) | Kern | lokal simuliert geprüft | `npm test` |
| Bindung `bindQuery` / `bindBodyHash` | Kern | lokal simuliert geprüft | `npm test` |
| Stripe-Abbruch ohne Checkout-Schleife (`pw_cancelled`, `stripe.cancelUrl`) | Kern | lokal simuliert geprüft (ab 0.0.6) | `npm test` |
| Paket: Installation und Import außerhalb des Repositorys | Kern | lokal geprüft (Node 20/22/24, Express 4 und 5) | `npm run test:paket` |
| Demo ohne Schlüssel | Kern | lokal im Browser geprüft | `npm run test:demo` |
| USDC je Anfrage über x402 Version 2 (`PAYMENT-SIGNATURE`, `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`), Base Sepolia | Kern | lokal simuliert geprüft (ab 0.0.7); echte Testzahlung mit dem offiziellen Client `@x402/fetch` 2.28 gegen den öffentlichen Testnetz-Facilitator extern geprüft am 25.10.2026 (Zahlung, Auslieferung, Wiederholung ohne zweite Abrechnung) | `npm test` |
| Kontingente, CSV-Protokoll, Stripe-Webhook-Abgleich | Pro | lokal simuliert geprüft in der Vorabversion 0.1.0-vorab; nicht veröffentlicht, nicht ausgeliefert | nicht Teil dieses Repositorys |
| Lieferung von Pro mit Updates und Support | Pro | geplant (Vorverkauf) | – |

**Prüfberichte (historisch, mit Datum):**

- 22.10.2026: `integration/` gegen den öffentlichen Testnetz-Facilitator 3/3 bestanden; Stripe und echte Testzahlung
  damals übersprungen (keine Testzugänge).
- 23.10.2026: `integration/` Stripe-Testmodus 3/3 bestanden, nach dem Fix für Managed Payments. Eine im Checkout
  abgeschlossene Testzahlung ist nicht Teil des automatisierten Tests.
- 25.10.2026: `integration/` 7/7 bestanden, 0 übersprungen, darunter die echte x402-Testzahlung auf Base Sepolia mit
  `x402-fetch` (0,01 Test-USDC ohne Wert; Empfängerguthaben um genau 0,01 gestiegen; gleicher Nachweis erneut: gleiche
  Antwort, eine Abrechnung).

## Demo ohne Schlüssel

```
npm install
npm run demo
```

Öffnet einen lokalen Server auf `http://127.0.0.1:8402/` (nur 127.0.0.1, endet nach 10 Minuten; `PORT` und `MAX_MS`
änderbar). Die Seite zeigt: **Zahlung erforderlich** (`402` mit beiden Wegen), **Euro** über einen lokalen, simulierten
Checkout bis zur Freischaltung per Cookie, **x402** mit einem simulierten Agenten (Antwort inkl. `X-PAYMENT-RESPONSE`),
**Wiederholung** (gleicher Nachweis → gespeicherte Antwort, keine zweite Abrechnung) und **unklare Abrechnung**
(Settle-Antwort geht verloren → `503`, beim nächsten Versuch Klärung über `authorizationState`).

**Alles ist simuliert:** Stripe, Facilitator und RPC laufen nachgebildet im selben Prozess (`demo/simulation.js`), es fließt
kein Geld und nichts verlässt den Rechner. Jede Seite trägt das Banner „SIMULATION – keine echte Zahlung“, jede JSON-Antwort
das Feld `simulation: true`, jede Antwort die Kopfzeile `X-Meterdoor-Simulation: 1`. Die Middleware ist unverändert.
Sind Umgebungsvariablen gesetzt, die nach echten Zugängen aussehen (z. B. `STRIPE_*`, `WALLET`, `PRIVATE_KEY`,
Werte wie `sk_live_…`/`rk_live_…` oder `0x` + 64 Hex-Zeichen), startet die Demo nicht.

Browser-Test: `npm run test:demo` (Playwright mit lokal installiertem Edge oder Chrome, kein Browser-Download, Anfragen an
andere Hosts als 127.0.0.1 werden abgebrochen und müssen 0 bleiben).

## Was ein Kauf bedeutet

| Weg | Leistung |
|---|---|
| **Euro (Stripe)** | Ein Kauf öffnet **genau diesen Endpunkt** (Methode + voller Pfad) für die gekaufte Dauer `access.ttlSeconds`, gerechnet **ab Zahlung**. In dieser Zeit beliebig viele Abrufe. Das Ende steht fest: erneutes Einlösen verlängert nichts. |
| **USDC (x402)** | **Jede Anfrage wird einzeln bezahlt.** Ein Zahlungsnachweis gilt für eine Anfrage; derselbe Nachweis liefert innerhalb von `x402.replaySeconds` dieselbe Antwort erneut, ohne neue Abrechnung. |

## Ablauf

| Anfrage | Antwort |
|---|---|
| mit Header `PAYMENT-SIGNATURE` (x402 Version 2) oder `X-PAYMENT` (Version 1) | lokal prüfen (Netz, Empfänger, Betrag, Asset) → Facilitator `/verify` → **Ihre Route (gepuffert)** → `/settle` → Antwort mit `PAYMENT-RESPONSE` (Version 2) bzw. `X-PAYMENT-RESPONSE` (Version 1) |
| mit gültigem Zugangstoken (Cookie `pw_token` oder `Authorization: Bearer`) | Ihre Route |
| Rückkehr aus Stripe (`?pw_session=cs_…`) | Sitzung vollständig prüfen (s. u.), Token mit festem Ende ausgeben |
| Rückkehr nach Abbruch (`?pw_cancelled=1`) | `402`: Seite „Zahlung abgebrochen“ mit „Erneut versuchen“ (JSON: Hinweis und `checkout`-Link), keine neue Sitzung |
| Browser (`Accept: text/html`) oder `?pw_checkout=1` | `303` zu Stripe Checkout |
| alles andere | `402` mit `accepts` (x402 Version 1) und `checkout`-Link im Body, dazu Header `PAYMENT-REQUIRED` (Version 2) |

**x402-Versionen.** Standard ist `x402: { versions: [1, 2] }`: Beide Header werden angenommen, stehen beide da, gilt
`PAYMENT-SIGNATURE`. Mit `versions: [2]` steht das Version-2-Objekt auch im Body und `X-PAYMENT` wird mit `402` abgewiesen;
mit `versions: [1]` fehlt `PAYMENT-REQUIRED`. Die Anforderungen an den Facilitator baut immer die Paywall selbst, nie aus dem
Nachweis. Dieselbe Autorisierung (Netz, Absender, Nonce) ist in beiden Versionen dieselbe Zahlung. Meldet der Facilitator
`settlement_pending` (Transaktion gesendet, Bestätigung offen), gilt der Fall als unklar, nicht als abgelehnt, und wird beim
nächsten Abruf über die Kette geklärt. Ein unlesbarer `PAYMENT-SIGNATURE`-Header ergibt `400`.
Browser-Clients von fremden Domains brauchen `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE` in Ihrer
CORS-Einstellung; die Paywall setzt keine CORS-Header.

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
Stripe Managed Payments ist für die Sitzung ausgeschaltet (`managed_payments[enabled]=false`), weil aufgeschlagene Steuer den Betrag
ändern würde; Konten mit Managed Payments als Standard lehnen sonst mit „product tax code is missing“ ab. Optional: `stripe.taxCode`
(Steuercode der Position), `stripe.managedPayments: true` (Parameter weglassen).

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
Zahlungsereignisse (`abgerechnet`, `stripe_eingeloest`) tragen `method`, `amount`, `currency`, `resource` und `transaction`.
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

- `npm test` – 100 Tests mit nachgebildeten Gegenstellen und steuerbarer Uhr (`now`-Option), inkl. aller Fehlerfälle,
  Fälschungen des Zahlungsnachweises, verzögertem Speicher mit zwei Instanzen, Neustarts mit `fileStore`, Stripe-Abbruch
  und Start von `beispiel/schnellstart.js`. Ohne Schlüssel, ohne Netz; 1 Test (Website-Abgleich) läuft nur mit `METERDOOR_SITE`.
- `npm run test:paket` – Paket-Probe: `npm pack`, Installation in einer separaten Beispielanwendung im temporären
  Verzeichnis, Import der öffentlichen Exporte, simulierte Anfragen (402 und x402-Zahlung gegen nachgebildeten Facilitator).
  Prüft auch den Paketinhalt (nur `src/`, `beispiel/schnellstart.js`, README, LICENSE) und die Lockfile-Version. Braucht
  die npm-Registry für express. `.github/workflows/ci.yml` führt `npm test` und die Paket-Probe für Node 20/22/24 und
  Express 4/5 aus (vorbereitet; ob er läuft, zeigt erst GitHub Actions).
- `integration/` – gegen echte Gegenstellen: öffentlicher Facilitator (ohne Guthaben), Stripe-Testmodus und echte
  Base-Sepolia-Zahlung mit dem unabhängigen Client `x402-fetch`. Läuft nur mit `METERDOOR_INTEGRATION=1`; Schlüssel nur
  aus dem angegebenen Verzeichnis `METERDOOR_SECRETS` (keine Suche in Elternverzeichnissen); fehlen sie, wird übersprungen.
  `cd integration && npm install && METERDOOR_INTEGRATION=1 METERDOOR_SECRETS=<verzeichnis> npm test`. **Übersprungene Tests gelten nicht als bestanden**; datierte Ergebnisse unter
  [Funktionsübersicht](#funktionsübersicht).
- `npm run test:demo` – 13 Browser-Tests der Demo (lokales Edge oder Chrome, ohne Internet): beide Bezahlwege, Wiederholung,
  unklare Abrechnung, Ergebnisanzeige, Tastatur, 390 px, Lade- und Fehlerzustand, Startschutz.

## Bekannte Grenzen des Prototyps

- x402 nur Schema `exact` mit EIP-3009 auf Base und Base Sepolia; kein `upto`, kein Permit2, keine anderen Netze.
- Ohne `app.set("trust proxy", 1)` hinter einem Proxy steht in `resource` `http` statt `https`.
- Kontingente, CSV-Protokoll mit EUR-Gegenwert und Webhook-Abgleich sind nicht Teil des Kerns (Pro).

## Lizenz

Apache License 2.0, siehe `LICENSE`.
