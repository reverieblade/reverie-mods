"use strict";

// Market stock: NPC sell stock for types the mods add. EveJS's market seeders build the market's
// NPC stock once, from the static data as it was then, so a type a mod adds later is on no
// market. A mod's type layer names what it wants sold (`marketStock`, client/compose.js), each
// entry like a type the market already sells: the new type is stocked at every station that
// stocks `like`, with the same quantity, at that station's price times the ratio of base prices.
// The rows follow whatever seed the server was built with (one hub, many stations, finite or
// endless stock), and nothing sets or holds a price afterwards.
//
// The market server keeps its stock in its own SQLite database, which has no RPC to add a row,
// so the rows are written into the database, and then `AdjustSeedStock` with no change is called
// on each one, which makes the running market server drop and rebuild every cache that row is in.
// Removing works the other way round: the stock is set to nothing through the RPC first (every
// read skips empty stock), then the row is deleted.
//
// Every row written is recorded in _local/reverie/marketStock.json, per database, and only those
// rows are ever changed or removed. A row the seeder made is never touched, and a reseeded
// database simply loses the rows and gets them again at the next sync.
//
// Sync runs in the game thread after the mods start, after each type layer change and after a
// mod reloads. It stocks the entries of mods that are running while the type layer is on, and
// takes away the rows of mods that are disabled or removed.

const fs = require("fs");
const path = require("path");
const paths = require("./paths");

const LEDGER = () => path.join(paths.reverieDir, "marketStock.json");
const REASON = "reverie market stock";
const RETRY_MS = 30_000;

function readLedger() {
  try {
    const ledger = JSON.parse(fs.readFileSync(LEDGER(), "utf8"));
    if (ledger && typeof ledger.databases === "object") return ledger;
  } catch (_) { /* none yet */ }
  return { databases: {} };
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER()), { recursive: true });
  const file = LEDGER();
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(ledger, null, 1)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

const key = (stationID, typeID) => `${stationID}:${typeID}`;
const round2 = (value) => Math.round(value * 100) / 100;

// better-sqlite3 from the EveJS server's own dependencies, so the version matches its Node.
function openDatabase(file, root = paths.serverRoot) {
  const Database = require(require.resolve("better-sqlite3", { paths: [root] }));
  const db = new Database(file, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

// The database the market server says it uses; relative paths are the market server's own.
function resolveDatabase(reported) {
  if (!reported) return null;
  if (path.isAbsolute(reported)) return fs.existsSync(reported) ? path.normalize(reported) : null;
  for (const base of [path.join(paths.repoRoot, "externalservices", "market-server"), paths.repoRoot, paths.serverRoot]) {
    const candidate = path.resolve(base, reported);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// The rows to add and remove, worked out and written in one transaction. Exported for tests.
//   wanted: [{ typeID, like, basePrice, likeBasePrice, mod }]
//   rows:   the ledger's rows for this database, [{ stationID, typeID, mod }]
// Returns { added: [rows], removing: [rows], rows: [ledger rows kept and added], gone }.
function planAndInsert(db, wanted, rows) {
  const exists = db.prepare("SELECT 1 FROM seed_stock WHERE station_id = ? AND type_id = ?");
  const stationsOf = db.prepare(`SELECT station_id, solar_system_id, constellation_id, region_id, price, initial_quantity
    FROM seed_stock WHERE type_id = ? AND quantity > 0 ORDER BY station_id`);
  const insert = db.prepare(`INSERT INTO seed_stock (station_id, solar_system_id, constellation_id, region_id, type_id,
    price, quantity, initial_quantity, price_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  const out = { added: [], removing: [], rows: [], gone: 0 };
  const wantedTypes = new Map(wanted.map((entry) => [Number(entry.typeID), entry]));
  db.transaction(() => {
    const owned = new Set();
    for (const row of rows) {
      // A reseed took it away; it is added again below if it is still wanted.
      if (!exists.get(row.stationID, row.typeID)) { out.gone += 1; continue; }
      const entry = wantedTypes.get(Number(row.typeID));
      if (!entry || entry.mod !== row.mod) { out.removing.push(row); continue; }
      out.rows.push(row);
      owned.add(key(row.stationID, row.typeID));
    }
    const now = new Date().toISOString();
    for (const entry of wanted) {
      const ratio = entry.basePrice / entry.likeBasePrice;
      for (const like of stationsOf.all(entry.like)) {
        const stationID = Number(like.station_id);
        if (owned.has(key(stationID, entry.typeID)) || exists.get(stationID, entry.typeID)) continue;
        const quantity = Math.max(1, Number(like.initial_quantity) || 1);
        insert.run(stationID, like.solar_system_id, like.constellation_id, like.region_id, entry.typeID,
          round2(Number(like.price) * ratio), quantity, quantity, now);
        const row = { stationID, typeID: Number(entry.typeID), mod: entry.mod };
        out.added.push(row);
        out.rows.push(row);
      }
    }
  })();
  return out;
}

// onSettled(state) runs after every sync, the retries after a failure included, so the core's
// status.json follows a market server that came up late.
function createMarketStock({ typeLayer, host, log, client: givenClient = null, open = openDatabase, onSettled = null } = {}) {
  let state = { at: null, result: "not run yet", stocked: 0 };
  let running = null;
  let again = false;
  let retryTimer = null;

  function marketClient() {
    if (givenClient) return givenClient;
    const file = path.join(paths.srcRoot, "services", "market", "marketDaemonClient.js");
    if (!fs.existsSync(file)) return null;
    return require(file).marketDaemonClient || null;
  }

  function wantedEntries() {
    const layer = typeLayer && typeLayer.layer();
    if (!layer || !Array.isArray(layer.marketStock)) return [];
    return layer.marketStock.filter((entry) => host.isModActive(entry.mod));
  }

  async function syncOnce() {
    const wanted = wantedEntries();
    const ledger = readLedger();
    const anyRecorded = Object.values(ledger.databases).some((db) => (db.rows || []).length);
    if (!wanted.length && !anyRecorded) return { result: "nothing to stock", stocked: 0 };

    const client = marketClient();
    if (!client) return { result: "this EveJS build has no market daemon client", stocked: 0 };
    const health = await client.call("Health", {}, { suppressConnectFailureLog: true });
    const file = resolveDatabase(health && health.database_path);
    if (!file) throw new Error(`the market server's database (${health && health.database_path}) was not found`);

    const record = ledger.databases[file] || { rows: [] };
    const db = open(file);
    let plan;
    const removed = [];
    const kept = [];
    try {
      plan = planAndInsert(db, wanted, record.rows || []);
      // Recorded before anything else can fail, so no row is ever left that nobody owns.
      ledger.databases[file] = { rows: [...plan.rows, ...plan.removing], at: new Date().toISOString() };
      writeLedger(ledger);

      // New rows: the market server rebuilds every cache they are in.
      for (const row of plan.added) {
        await client.call("AdjustSeedStock", { station_id: row.stationID, type_id: row.typeID, delta_quantity: 0, reason: REASON });
      }
      // Rows no longer wanted: emptied through the market server, then deleted.
      for (const row of plan.removing) {
        try {
          await client.call("AdjustSeedStock", { station_id: row.stationID, type_id: row.typeID, new_quantity: 0, reason: REASON });
          removed.push(row);
        } catch (error) {
          kept.push(row);
          log.warn(`market stock: could not empty type ${row.typeID} at station ${row.stationID}: ${error && error.message || error}`);
        }
      }
      if (removed.length) {
        const del = db.prepare("DELETE FROM seed_stock WHERE station_id = ? AND type_id = ?");
        db.transaction(() => { for (const row of removed) del.run(row.stationID, row.typeID); })();
      }
    } finally { db.close(); }

    ledger.databases[file] = { rows: [...plan.rows, ...kept], at: new Date().toISOString() };
    writeLedger(ledger);
    const types = new Set(plan.rows.map((row) => row.typeID));
    const parts = [];
    if (plan.added.length) parts.push(`added ${plan.added.length} rows`);
    if (removed.length) parts.push(`removed ${removed.length}`);
    if (plan.gone) parts.push(`${plan.gone} lost to a reseed`);
    return { result: parts.join(", ") || "in place", stocked: plan.rows.length, types: [...types].sort((a, b) => a - b), database: file };
  }

  // Coalesced: a sync asked for while one runs runs once more afterwards. A market server that is
  // not up yet is tried again every 30 seconds until it answers.
  function sync(why = "") {
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        try {
          const out = await syncOnce();
          state = { at: new Date().toISOString(), ...out };
          if (out.result !== "nothing to stock" && out.result !== "in place") {
            log.info(`market stock${why ? ` (${why})` : ""}: ${out.result}; ${out.stocked} rows of ${(out.types || []).length} types stocked`);
          }
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        } catch (error) {
          state = { at: new Date().toISOString(), result: `failed: ${error && error.message || error}`, stocked: state.stocked };
          log.warn(`market stock${why ? ` (${why})` : ""} failed, trying again in ${RETRY_MS / 1000} s: ${error && error.message || error}`);
          if (!retryTimer) {
            retryTimer = setTimeout(() => { retryTimer = null; sync("retry"); }, RETRY_MS);
            if (typeof retryTimer.unref === "function") retryTimer.unref();
          }
        }
      } while (again);
      running = null;
      if (typeof onSettled === "function") {
        try { onSettled({ ...state }); } catch (_) { /* the status is the caller's business */ }
      }
      return state;
    })();
    return running;
  }

  return { sync, status: () => ({ ...state }) };
}

// For the launcher helper when the core itself is disabled or removed, with no server running:
// every recorded row is deleted from its database directly. The market server, if it is still
// up, may show the rows until it restarts. Returns a sentence for the helper's message.
function removeAllOffline(serverRoot) {
  const ledger = readLedger();
  let removed = 0;
  const failures = [];
  for (const [file, record] of Object.entries(ledger.databases)) {
    const rows = record.rows || [];
    if (!rows.length) continue;
    try {
      const db = openDatabase(file, serverRoot);
      try {
        const del = db.prepare("DELETE FROM seed_stock WHERE station_id = ? AND type_id = ?");
        db.transaction(() => { for (const row of rows) removed += del.run(row.stationID, row.typeID).changes; })();
      } finally { db.close(); }
      ledger.databases[file] = { rows: [], at: new Date().toISOString() };
    } catch (error) {
      failures.push(`${file}: ${error && error.message || error}`);
    }
  }
  if (removed || failures.length) writeLedger(ledger);
  if (failures.length) return `The market stock Reverie added could not be taken out of ${failures.join("; ")}; it stays until the market is seeded again.`;
  return removed ? `The market stock Reverie added (${removed} rows) was taken out.` : "";
}

module.exports = { createMarketStock, planAndInsert, removeAllOffline, resolveDatabase, LEDGER };
