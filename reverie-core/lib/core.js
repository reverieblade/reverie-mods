"use strict";

// One core per process, kept on a global symbol so that a second copy (the launcher's preload
// and this repo's start script both naming it, or a mod requiring it by another path) finds the
// first instead of hooking the loader twice.

const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { detectRole } = require("./role");
const { createPatcher } = require("./patcher");
const { createHooks } = require("./hooks");
const { createServices } = require("./services");
const { createModApi } = require("./api");
const catalog = require("./catalog");
const order = require("./order");
const { createTypeLayer } = require("./typeLayer");
const { startLoginScripts } = require("./loginScripts");
const { createMarketStock } = require("./marketStock");

const CORE_KEY = Symbol.for("reverie.core");
const VERSION = "0.2.3";
const CORE_ID = "reverie-core";

function createLog() {
  // Console until the game's logger can be loaded safely, which is after the world has booted.
  let sink = null;
  const write = (level, message) => {
    const text = `[Reverie] ${message}`;
    if (sink) {
      try { (level === "error" ? sink.err : level === "warn" ? sink.warn : sink.info).call(sink, text); return; } catch (_) { /* fall back */ }
    }
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(text);
  };
  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
    useGameLogger(logger) { if (logger && typeof logger.info === "function") sink = logger; },
  };
}

function createCore() {
  const role = detectRole();
  const log = createLog();
  const patcher = createPatcher({ log });
  const hooks = createHooks({ log });
  const services = createServices({ log });
  // The type layer reshapes static tables wherever they load, so every thread gets it.
  const typeLayer = role === "game" || role === "worker" ? createTypeLayer({ hooks, log: role === "game" ? log : null }) : null;
  let loginScripts = { started: false, reason: "not the game thread" };
  // NPC sell stock for the types mods add; the game thread alone writes the market's database.
  const marketStock = role === "game" && typeLayer && process.env.REVERIE_MARKET_STOCK !== "off"
    ? createMarketStock({ typeLayer, host: { isModActive: (id) => host.isModActive(id) }, log, onSettled: () => writeStatus() })
    : null;
  const syncMarket = (why) => {
    if (marketStock && booted) marketStock.sync(why).catch(() => { /* reported in its status */ });
  };
  const records = new Map(); // lower-case id -> record
  const loadOrder = [];
  const skipped = [];
  let booted = false;

  // States: listed (not for this process), blocked, failed, patched, running, degraded.
  function addRecord(mod, state) {
    const record = { ...mod, index: loadOrder.length, state, error: null, module: null, api: null };
    records.set(mod.id.toLowerCase(), record);
    loadOrder.push(record);
    return record;
  }

  const host = {
    role,
    version: VERSION,
    log,
    hooks,
    services,
    addPatch(record, target, exportPath, spec) {
      patcher.install();
      const ok = patcher.add(record.id, record.index, target, exportPath, spec);
      if (!ok && record.state !== "failed") record.state = "degraded";
      return ok;
    },
    isModActive(id) {
      const record = records.get(String(id).toLowerCase());
      return Boolean(record && ["patched", "running", "degraded"].includes(record.state));
    },
    listMods() {
      return loadOrder.map((r) => ({ id: r.id, version: r.version, state: r.state }));
    },
  };

  function fail(record, stage, error) {
    record.state = "failed";
    record.error = `${stage}: ${error && error.message || error}`;
    services.removeMod(record.id);
    patcher.removeMod(record.id);
    hooks.removeMod(record.id);
    log.error(`${record.id} ${stage} failed, so it is not loaded: ${error && error.stack || error}`);
  }

  // A requirement that is not a loader (a client package) is met when it is installed, as in
  // lib/order.js: the launcher keeps its on and off state and it never loads here.
  function installedClientPackage(id) {
    const wanted = String(id).toLowerCase();
    return catalog.discover(paths.modsDir).some((other) =>
      other.id.toLowerCase() === wanted && other.kind && other.kind !== "loader" && other.errors.length === 0);
  }

  // Called by every mod's loader.js, in load order.
  function register(dir) {
    const mod = catalog.readMod(path.resolve(dir));
    const existing = records.get(mod.id.toLowerCase());
    if (existing) {
      if (paths.normalize(existing.dir) !== paths.normalize(mod.dir)) {
        log.warn(`${mod.id} is registered twice, from ${existing.dir} and ${mod.dir}; the first is kept`);
      }
      return existing;
    }
    if (mod.errors.length) {
      const record = addRecord(mod, "failed");
      record.error = mod.errors.join("; ");
      log.error(`${mod.id} is not loaded: ${record.error}`);
      return record;
    }
    const processes = Array.isArray(mod.reverie && mod.reverie.processes) ? mod.reverie.processes : ["game", "worker"];
    if (mod.id.toLowerCase() === CORE_ID || !processes.includes(role)) {
      return addRecord(mod, mod.id.toLowerCase() === CORE_ID ? "running" : "listed");
    }
    const record = addRecord(mod, "blocked");
    const missing = mod.requires.filter((id) => !host.isModActive(id) && String(id).toLowerCase() !== CORE_ID && !installedClientPackage(id));
    if (missing.length) {
      record.error = `requires ${missing.join(", ")}, which did not load before it`;
      log.error(`${mod.id} is not loaded: ${record.error}`);
      return record;
    }
    record.state = "patched";
    const entry = path.join(mod.dir, "server", "index.js");
    if (!fs.existsSync(entry)) return record;
    try { record.module = require(entry); } catch (error) { fail(record, "load", error); return record; }
    record.api = createModApi(host, record);
    if (typeof record.module.patches === "function") {
      try { record.module.patches(record.api); } catch (error) { fail(record, "patches", error); return record; }
    }
    return record;
  }

  // In the game thread, once the world has booted, each mod's init(api), in load order.
  async function initAll() {
    if (booted || role !== "game") return;
    booted = true;
    try { log.useGameLogger(require(path.join(paths.srcRoot, "utils", "logger"))); } catch (_) { /* console */ }
    for (const record of loadOrder) {
      if (record.state !== "patched" && record.state !== "degraded") continue;
      await initOne(record);
    }
    const loaded = loadOrder.filter((r) => r.id.toLowerCase() !== CORE_ID);
    log.info(`${loaded.length} mods: ${loaded.map((r) => `${r.id} ${r.state}`).join(", ") || "none"}`);
    writeStatus();
    syncMarket("start");
  }

  // Without the launcher, the core loads the enabled mods itself, in the resolved order.
  function loadStandalone() {
    const resolved = order.resolve(catalog.discover(paths.modsDir), catalog.readConfig().order);
    for (const item of resolved.skipped) {
      skipped.push(item);
      if (role === "game") log.error(`${item.id} is not loaded: ${item.reason}`);
    }
    for (const mod of resolved.order) {
      if (mod.id.toLowerCase() === CORE_ID) continue;
      try { require(path.join(mod.dir, "loader.js")); } catch (error) {
        const record = records.get(mod.id.toLowerCase()) || addRecord(mod, "failed");
        fail(record, "loader", error);
      }
    }
  }

  // Drop every cached file under a mod's folder, and the stale copies Node keeps in each parent's
  // children list (the leak described in playerBotGmApi.js unlinkStaleCopies).
  function forgetModFiles(dir) {
    const prefix = paths.normalize(dir) + path.sep;
    const dropped = new Set();
    for (const name of Object.keys(require.cache)) {
      if (paths.normalize(name).startsWith(prefix)) { dropped.add(require.cache[name]); delete require.cache[name]; }
    }
    for (const parent of Object.values(require.cache)) {
      if (parent && Array.isArray(parent.children)) parent.children = parent.children.filter((child) => !dropped.has(child));
    }
    return dropped.size;
  }

  // Live reload of one mod: dispose, forget its patches, hooks and files, then load it again from
  // disk. A mod disabled on disk stays unloaded, and a mod not loaded before is registered, so
  // this also enables and disables live. Patches take effect at once, since wrappers read their
  // lists on every call.
  async function reloadMod(id) {
    const wanted = String(id || "").toLowerCase();
    if (!wanted || wanted === CORE_ID) return { id, result: "refused: the core reloads only with a server start" };
    let record = records.get(wanted);
    if (!record) {
      const found = catalog.discover(paths.modsDir).find((mod) => mod.id.toLowerCase() === wanted);
      if (!found) return { id, result: "no such mod" };
      if (!found.enabled) return { id, result: "disabled, nothing to do" };
      record = register(found.dir);
      if (role === "game" && booted && record.state === "patched") await initOne(record);
      writeStatus();
      return { id: record.id, result: record.state };
    }
    // Partners let go of this mod's services while it still works, then it disposes.
    services.removeMod(record.id);
    if (role === "game" && record.module && typeof record.module.dispose === "function" && record.api) {
      try { await record.module.dispose(record.api); } catch (error) { log.error(`${record.id} dispose failed: ${error && error.stack || error}`); }
    }
    patcher.removeMod(record.id);
    hooks.removeMod(record.id);
    forgetModFiles(record.dir);
    record.module = null;
    record.api = null;
    record.error = null;
    const mod = catalog.readMod(record.dir);
    Object.assign(record, { version: mod.version, manifest: mod.manifest, reverie: mod.reverie, requires: mod.requires });
    if (mod.errors.length) { record.state = "failed"; record.error = mod.errors.join("; "); writeStatus(); return { id: record.id, result: `failed: ${record.error}` }; }
    if (!mod.enabled) { record.state = "disabled"; writeStatus(); return { id: record.id, result: "disabled" }; }
    const missing = mod.requires.filter((req) => !host.isModActive(req) && String(req).toLowerCase() !== CORE_ID && !installedClientPackage(req));
    if (missing.length) { record.state = "blocked"; record.error = `requires ${missing.join(", ")}`; writeStatus(); return { id: record.id, result: `blocked: ${record.error}` }; }
    record.state = "patched";
    const entry = path.join(record.dir, "server", "index.js");
    if (fs.existsSync(entry)) {
      try { record.module = require(entry); } catch (error) { fail(record, "load", error); writeStatus(); return { id: record.id, result: record.error }; }
      record.api = createModApi(host, record);
      if (typeof record.module.patches === "function") {
        try { record.module.patches(record.api); } catch (error) { fail(record, "patches", error); writeStatus(); return { id: record.id, result: record.error }; }
      }
    }
    if (role === "game" && booted) await initOne(record);
    else if (role !== "game" && record.state === "patched") record.state = "running";
    writeStatus();
    return { id: record.id, result: record.state };
  }

  async function initOne(record) {
    if (!record.module || typeof record.module.init !== "function") { if (record.state === "patched") record.state = "running"; return; }
    try {
      await record.module.init(record.api);
      if (record.state === "patched") record.state = "running";
    } catch (error) { fail(record, "init", error); }
  }

  // `cli.js reload <id>` writes _local/reverie/reload.json; the game thread and every worker
  // thread watch its mtime and reload the named mods.
  let reloadSeen = 0;
  let reloadTimer = null;
  function watchReloads(intervalMs = 2000) {
    if (reloadTimer || role === "other") return;
    const file = path.join(paths.reverieDir, "reload.json");
    try { reloadSeen = fs.statSync(file).mtimeMs; } catch (_) { reloadSeen = 0; }
    let busy = false;
    reloadTimer = setInterval(async () => {
      if (busy) return;
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch (_) { return; }
      if (mtime === reloadSeen) return;
      reloadSeen = mtime;
      busy = true;
      try {
        const request = catalog.readJson(file);
        const reloaded = Array.isArray(request.mods) ? request.mods : [];
        for (const id of reloaded) {
          const out = await reloadMod(id);
          if (role === "game") log.info(`reload ${out.id}: ${out.result}`);
        }
        // `cli.js client apply` and `client restore` ask for this: the cached static tables are
        // dropped, so the next read takes the layer the client now has (or none).
        if (request.typeLayer === true && typeLayer) {
          const out = typeLayer.applyLive();
          if (role === "game") log.info(`type layer ${out.active ? "on" : "off"} (${out.reason}), cleared ${out.cleared.join(", ") || "nothing"}`);
        }
        // A mod turned on or off, or a new layer, changes what the market should stock.
        if (reloaded.length || request.typeLayer === true || request.market === true) syncMarket("reload");
      } catch (error) { log.error(`reload request failed: ${error && error.message || error}`); }
      busy = false;
    }, intervalMs);
    if (typeof reloadTimer.unref === "function") reloadTimer.unref();
  }

  function status() {
    return {
      core: VERSION,
      role,
      pid: process.pid,
      booted,
      at: new Date().toISOString(),
      mods: loadOrder.map((r) => ({ id: r.id, version: r.version, dir: path.relative(paths.repoRoot, r.dir), state: r.state, error: r.error })),
      skipped,
      patches: patcher.status(),
      hooks: hooks.status(),
      services: services.status(),
      typeLayer: typeLayer ? typeLayer.status() : null,
      marketStock: marketStock ? marketStock.status() : null,
      loginScripts,
    };
  }

  function writeStatus() {
    if (role !== "game") return;
    try {
      fs.mkdirSync(paths.reverieDir, { recursive: true });
      const file = path.join(paths.reverieDir, "status.json");
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(status(), null, 2)}\n`);
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) { log.warn(`could not write status.json: ${error.message}`); }
  }

  const core = { version: VERSION, role, paths, register, loadStandalone, initAll, reloadMod, status, writeStatus, hooks, services, patcher, typeLayer, marketStock };

  if (role === "game" || role === "worker") {
    patcher.install();
    watchReloads(Number(process.env.REVERIE_RELOAD_POLL_MS) || 2000);
  }
  register(path.resolve(__dirname, ".."));
  if (role === "game") {
    // Before the handshake module compiles; the delivery runtime refuses to start after it.
    loginScripts = startLoginScripts({ typeLayer, log });
    patcher.add(CORE_ID, 0, path.join(paths.serverRoot, "bootstrap.js"), "bootWorld", {
      async: true,
      postfix(ctx, world) {
        initAll().catch((error) => log.error(`init failed: ${error && error.stack || error}`));
        return world;
      },
    });
  }
  return core;
}

function getCore() {
  if (!(CORE_KEY in globalThis)) {
    globalThis[CORE_KEY] = process.env.REVERIE_DISABLE === "1" ? null : createCore();
  }
  return globalThis[CORE_KEY];
}

module.exports = { getCore, CORE_KEY, VERSION, CORE_ID };
