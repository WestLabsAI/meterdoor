// Speicher für x402-Zahlungsfälle: memoryStore (Arbeitsspeicher) und fileStore (Dateien, übersteht Neustarts).
//
// Schnittstelle (alle Methoden dürfen synchron oder asynchron sein):
//   get(id)                              -> Wert oder undefined
//   set(id, wert, ttlSekunden)           -> speichert; Ablauf = wert.expiresAt, sonst bisheriger Ablauf, sonst jetzt + ttl
//   delete(id)
//   list()                               -> [{ id, ...wert }]
//   claim(id, owner, ttlSekunden)        -> true, wenn die Sperre für id jetzt `owner` gehört (atomar)
//   release(id, owner)                   -> gibt die Sperre frei, falls sie `owner` gehört
//   compareAndSet(id, alterZustand, neu, ttlSekunden)
//                                        -> true, wenn wert.state === alterZustand (undefined = kein Eintrag) und
//                                           `neu` gespeichert wurde (neu = null löscht); sonst false. Atomar.
//
// Einträge im Zustand "in_abrechnung" oder "unklar" sind offene Zahlungsfälle: sie verfallen nicht und werden nie
// verdrängt. Ist der Speicher voll, wirft set() für eine neue id einen StoreFullError (code "SPEICHER_VOLL").
// Änderungen an einer vorhandenen id sind immer erlaubt (eine Zahlung muss als bezahlt vermerkt werden können).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const OPEN_STATES = new Set(["in_abrechnung", "unklar"]);
const isOpen = (value) => OPEN_STATES.has(value?.state);
const MiB = 1024 * 1024;
export const STORE_DEFAULTS = Object.freeze({ maxEntries: 10000, maxStoredBytes: 64 * MiB });

export class StoreFullError extends Error {
  constructor(detail) {
    super(`Speicher voll${detail ? ` (${detail})` : ""}`);
    this.code = "SPEICHER_VOLL";
  }
}

// Festes Ablaufdatum: Ein mitgegebenes expiresAt gewinnt; sonst bleibt der bisherige Ablauf; nur neue Einträge
// bekommen jetzt + ttl. Zustandsänderungen verlängern also nichts.
function expiryOf(value, prevUntil, ttlSeconds, nowMs) {
  const raw = value?.expiresAt;
  const fixed = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isFinite(fixed)) return fixed;
  if (prevUntil !== undefined) return prevUntil;
  return nowMs + Number(ttlSeconds) * 1000;
}

function checkLimits(maxEntries, maxStoredBytes) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error("Speicher: maxEntries muss eine positive ganze Zahl sein");
  if (!Number.isInteger(maxStoredBytes) || maxStoredBytes <= 0) throw new Error("Speicher: maxStoredBytes muss eine positive ganze Zahl sein");
}

// ---------------------------------------------------------------- Arbeitsspeicher

// Nur für einen Prozess; mehrere Middleware-Instanzen im selben Prozess dürfen ihn teilen (claim gilt für alle).
export function memoryStore({ maxEntries = STORE_DEFAULTS.maxEntries, maxStoredBytes = STORE_DEFAULTS.maxStoredBytes, now = Date.now } = {}) {
  checkLimits(maxEntries, maxStoredBytes);
  const map = new Map(); // id -> { value, until, bytes }
  const locks = new Map(); // id -> { owner, until } (echte Uhrzeit, unabhängig von `now`)
  let bytes = 0;
  const expired = (e) => e.until <= now() && !isOpen(e.value);
  const drop = (id) => { const e = map.get(id); if (e) { bytes -= e.bytes; map.delete(id); } };

  function makeRoom(extra) {
    const fits = () => map.size + 1 <= maxEntries && bytes + extra <= maxStoredBytes;
    if (fits()) return;
    for (const [id, e] of map) if (expired(e)) drop(id);
    // Danach die ältesten zugestellten bzw. erledigten Einträge; offene Fälle und bezahlte, nicht zugestellte nie.
    for (const [id, e] of map) {
      if (fits()) return;
      if (!isOpen(e.value) && e.value?.delivered !== false) drop(id);
    }
    if (!fits()) throw new StoreFullError(`${map.size} Einträge, ${bytes} Bytes`);
  }

  const store = {
    get(id) {
      const e = map.get(id);
      if (!e) return undefined;
      if (expired(e)) { drop(id); return undefined; }
      return e.value;
    },
    set(id, value, ttlSeconds) {
      const size = Buffer.byteLength(JSON.stringify(value ?? null));
      let prev = map.get(id);
      if (prev && expired(prev)) { drop(id); prev = undefined; }
      if (!prev) makeRoom(size);
      const until = expiryOf(value, prev?.until, ttlSeconds, now());
      if (prev) bytes -= prev.bytes;
      bytes += size;
      map.set(id, { value, until, bytes: size });
    },
    delete(id) { drop(id); },
    list() { return [...map.entries()].filter(([, e]) => !expired(e)).map(([id, e]) => ({ id, ...e.value })); },
    claim(id, owner, ttlSeconds) {
      const t = Date.now();
      const l = locks.get(id);
      if (l && l.until > t && l.owner !== owner) return false;
      locks.set(id, { owner, until: t + ttlSeconds * 1000 });
      return true;
    },
    release(id, owner) { if (locks.get(id)?.owner === owner) locks.delete(id); },
    compareAndSet(id, expectedState, value, ttlSeconds) {
      const cur = store.get(id);
      if (cur?.state !== expectedState || (expectedState === undefined && cur !== undefined)) return false;
      if (value === null) store.delete(id); else store.set(id, value, ttlSeconds);
      return true;
    },
  };
  return store;
}

// ---------------------------------------------------------------- Dateien

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rand = () => crypto.randomBytes(6).toString("hex");

// Eine Datei je Eintrag (<sha256(id)>.json), geschrieben als temporäre Datei + fsync + rename (atomar auf demselben
// Dateisystem). Sperren als <hash>.lock, exklusiv angelegt (O_EXCL). Ohne native Abhängigkeit, synchron.
// Mehrere Prozesse auf demselben Rechner dürfen dasselbe Verzeichnis teilen; Netzlaufwerke werden nicht unterstützt.
export function fileStore({
  dir, maxEntries = STORE_DEFAULTS.maxEntries, maxStoredBytes = STORE_DEFAULTS.maxStoredBytes, now = Date.now, fsync = true,
} = {}) {
  if (!dir) throw new Error("fileStore: dir angeben");
  checkLimits(maxEntries, maxStoredBytes);
  fs.mkdirSync(dir, { recursive: true });
  const hash = (id) => crypto.createHash("sha256").update(String(id)).digest("hex");
  const dataFile = (h) => path.join(dir, `${h}.json`);
  const lockFile = (h) => path.join(dir, `${h}.lock`);
  const casFile = (h) => path.join(dir, `${h}.cas`);
  const expired = (entry) => entry.expiresAt <= now() && !isOpen(entry.value);

  function syncDir() {
    if (!fsync) return;
    try { const d = fs.openSync(dir, "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* Windows: Verzeichnis-fsync nicht möglich */ }
  }

  function writeAtomic(target, text) {
    const tmp = `${target}.${process.pid}.${rand()}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try { fs.writeSync(fd, text); if (fsync) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, target); break; } catch (err) {
        // Windows: Ziel kurzzeitig von einem Leser geöffnet.
        if (i >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(err.code)) { fs.rmSync(tmp, { force: true }); throw err; }
        sleepSync(5);
      }
    }
    syncDir();
  }

  // Unlesbare Datei = unbekannter Zustand: Fehler statt "nicht vorhanden", damit nie blind neu abgerechnet wird.
  function readEntry(file) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (err) { if (err.code === "ENOENT") return undefined; throw err; }
    const entry = JSON.parse(text);
    if (!entry || typeof entry.expiresAt !== "number" || !("value" in entry)) throw new Error(`fileStore: Eintrag unlesbar (${path.basename(file)})`);
    return entry;
  }
  const remove = (file) => { fs.rmSync(file, { force: true }); };

  // Index für die Grenzen: Hash -> Bytes. Wird bei Bedarf aus dem Verzeichnis neu aufgebaut (andere Prozesse).
  const index = new Map();
  let total = 0;
  function scan() {
    index.clear(); total = 0;
    const found = [];
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (name.endsWith(".tmp")) {
        // Reste eines Absturzes; frische gehören evtl. einem anderen Prozess.
        try { if (Date.now() - fs.statSync(file).mtimeMs > 60000) remove(file); } catch { /* weg */ }
        continue;
      }
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      let entry, size;
      try { entry = readEntry(file); size = fs.statSync(file).size; } catch { continue; }
      if (!entry) continue;
      const h = name.slice(0, 64);
      index.set(h, size); total += size;
      found.push({ h, file, entry, size });
    }
    return found;
  }
  scan();

  function makeRoom(extra) {
    const fits = () => index.size + 1 <= maxEntries && total + extra <= maxStoredBytes;
    // Andere Prozesse auf demselben Verzeichnis: weicht die Anzahl der Dateien vom Index ab, neu einlesen.
    const onDisk = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length;
    if (onDisk === index.size && fits()) return;
    const all = scan();
    if (fits()) return;
    for (const f of all) if (expired(f.entry)) { remove(f.file); index.delete(f.h); total -= f.size; }
    const evictable = all.filter((f) => index.has(f.h) && !isOpen(f.entry.value) && f.entry.value?.delivered !== false)
      .sort((a, b) => a.entry.expiresAt - b.entry.expiresAt);
    for (const f of evictable) {
      if (fits()) return;
      remove(f.file); index.delete(f.h); total -= f.size;
    }
    if (!fits()) throw new StoreFullError(`${index.size} Einträge, ${total} Bytes`);
  }

  function readLock(file) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch (err) { if (err.code === "ENOENT") return "fehlt"; throw err; }
    try { const l = JSON.parse(text); return typeof l?.owner === "string" && typeof l.until === "number" ? l : null; } catch { return null; }
  }
  function lockIsStale(file, l) {
    if (l) return l.until <= Date.now();
    // Halb geschriebene Sperrdatei (Absturz beim Anlegen): nach 30 s als verwaist betrachten.
    try { return Date.now() - fs.statSync(file).mtimeMs > 30000; } catch { return true; }
  }
  // Exklusiv anlegen; abgelaufene Sperre atomar wegbenennen (nur einer kann umbenennen). Wurde dabei versehentlich
  // eine frische Sperre erwischt, wird sie per link (schlägt fehl, wenn das Ziel existiert) zurückgelegt.
  function acquire(file, owner, untilMs) {
    for (let i = 0; i < 4; i++) {
      try {
        const fd = fs.openSync(file, "wx");
        try { fs.writeSync(fd, JSON.stringify({ owner, until: untilMs })); if (fsync) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        return true;
      } catch (err) { if (err.code !== "EEXIST" && err.code !== "EPERM") throw err; }
      const l = readLock(file);
      if (l === "fehlt") continue;
      if (l && l.owner === owner) { writeAtomic(file, JSON.stringify({ owner, until: untilMs })); return true; }
      if (!lockIsStale(file, l)) return false;
      const grave = `${file}.${rand()}.alt`;
      try { fs.renameSync(file, grave); } catch (err) { if (err.code === "ENOENT" || err.code === "EPERM") continue; throw err; }
      const taken = readLock(grave);
      if (taken !== "fehlt" && !lockIsStale(grave, taken)) {
        try { fs.linkSync(grave, file); } catch { /* inzwischen neu angelegt */ }
        remove(grave);
        return false;
      }
      remove(grave);
    }
    return false;
  }
  function releaseLock(file, owner) {
    const l = readLock(file);
    if (l && l !== "fehlt" && l.owner === owner) remove(file);
  }

  const store = {
    get(id) {
      const h = hash(id);
      const entry = readEntry(dataFile(h));
      if (!entry) return undefined;
      if (expired(entry)) { store.delete(id); return undefined; }
      return entry.value;
    },
    set(id, value, ttlSeconds) {
      const h = hash(id);
      const file = dataFile(h);
      let prev = readEntry(file);
      if (prev && expired(prev)) { store.delete(id); prev = undefined; }
      const expiresAt = expiryOf(value, prev?.expiresAt, ttlSeconds, now());
      const text = JSON.stringify({ v: 1, id: String(id), expiresAt, value });
      const size = Buffer.byteLength(text);
      if (!prev) makeRoom(size);
      writeAtomic(file, text);
      total += size - (index.get(h) || 0);
      index.set(h, size);
    },
    delete(id) {
      const h = hash(id);
      remove(dataFile(h));
      syncDir();
      if (index.has(h)) { total -= index.get(h); index.delete(h); }
    },
    list() {
      return scan().filter((f) => !expired(f.entry)).map((f) => ({ id: f.entry.id, ...f.entry.value }));
    },
    claim(id, owner, ttlSeconds) { return acquire(lockFile(hash(id)), owner, Date.now() + ttlSeconds * 1000); },
    release(id, owner) { releaseLock(lockFile(hash(id)), owner); },
    compareAndSet(id, expectedState, value, ttlSeconds) {
      const file = casFile(hash(id));
      const me = `cas-${process.pid}-${rand()}`;
      const deadline = Date.now() + 2000;
      while (!acquire(file, me, Date.now() + 10000)) {
        if (Date.now() > deadline) throw new Error("fileStore: compareAndSet blockiert");
        sleepSync(2);
      }
      try {
        const cur = store.get(id);
        if (cur?.state !== expectedState || (expectedState === undefined && cur !== undefined)) return false;
        if (value === null) store.delete(id); else store.set(id, value, ttlSeconds);
        return true;
      } finally { releaseLock(file, me); }
    },
  };
  return store;
}
