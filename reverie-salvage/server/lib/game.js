"use strict";

// How the salvage mod reaches the game and its own settings.
//
// game(relative) is a game module under server/src, looked up at each use so
// hot reloads of game files reach the mod. Reverie's core knows where
// server/src is in this installation (the launcher's EveJS folder or this
// repo), so the mod never counts ../ from its own folder.
//
// number(name, fallback) and flag(name, fallback) read a tunable. In this
// repo's own server the live tunables (services/market/liveTunables.js) hold
// the values and GM tools change them live; a name they register wins there.
// Anywhere else the order is the environment, then the player's settings
// (preferences.json in the mod folder, which the launcher's Configure form
// writes; PREFERENCES below says which key is which tunable), then
// _local/reverie-salvage/tunables.json, then the default the caller gives.
// Both files are read again whenever they change, so a saved setting applies
// without a restart.

const fs = require("fs");
const path = require("path");

const CORE_PATHS = path.join(__dirname, "..", "..", "..", "reverie-core", "lib", "paths");

function paths() {
  const core = globalThis[Symbol.for("reverie.core")];
  return core && core.paths ? core.paths : require(CORE_PATHS);
}

function game(relative) {
  return require(paths().resolveTarget(relative));
}

function tryGame(relative) {
  try {
    return game(relative);
  } catch (_) {
    return null;
  }
}

function liveTunables() {
  const file = paths().resolveTarget("services/market/liveTunables");
  if (!fs.existsSync(file)) return null;
  try {
    return require(file);
  } catch (_) {
    return null;
  }
}

// The Configure form's fields (evejs-launcher.mod.json "settings"):
// preference key -> [tunable, scale]. A percentage setting is stored as the
// player typed it and scaled to the tunable's share here.
const PREFERENCES = Object.freeze({
  gearInLoot: ["EVEJS_SALVAGE_GEAR_LOOT", null],
  alloysEnabled: ["EVEJS_NPC_ALLOY_LOOT", null],
  salvageHoldFirst: ["EVEJS_SALVAGE_HOLD_AUTO", null],
  salvageChanceBonus: ["EVEJS_SALVAGE_CHANCE_BONUS", 1],
  emptyWreckPct: ["EVEJS_SALVAGE_EMPTY_FACTOR", 0.01],
  scrapAmount: ["EVEJS_SALVAGE_SCRAP", 1],
  salvageAlloyAmount: ["EVEJS_SALVAGE_ALLOYS", 1],
  hullRecoveryPct: ["EVEJS_SALVAGE_HULL_RECOVERY", 0.01],
  cutSpeed: ["EVEJS_CUT_SPEED", 1],
  cutRecoveryPct: ["EVEJS_CUT_RECOVERY", 0.01],
  cutContainers: ["EVEJS_CUT_CONTAINERS", 1],
  cutWreckMinutes: ["EVEJS_CUT_WRECK_HOLD_MINUTES", 1],
});

function readJsonByMtime(file, cache) {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (_) {
    cache.mtimeMs = 0;
    cache.values = {};
    return cache.values;
  }
  if (mtimeMs !== cache.mtimeMs) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      cache.values = parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      // a half-written file keeps the values read before it
    }
    cache.mtimeMs = mtimeMs;
  }
  return cache.values;
}

const fileCache = { mtimeMs: -1, values: {} };
function fileValues() {
  return readJsonByMtime(path.join(paths().localDir, "reverie-salvage", "tunables.json"), fileCache);
}

const PREFERENCES_FILE = path.join(__dirname, "..", "..", "preferences.json");
const preferenceCache = { mtimeMs: -1, values: {}, byTunable: {} };
let preferencesRead = null;
// tunable name -> value, from the player's saved settings.
function preferenceValues() {
  const values = readJsonByMtime(PREFERENCES_FILE, preferenceCache);
  if (values === preferencesRead) return preferenceCache.byTunable;
  preferencesRead = values;
  const byTunable = {};
  for (const [key, [name, scale]] of Object.entries(PREFERENCES)) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const value = values[key];
    if (scale === null) byTunable[name] = value;
    else if (Number.isFinite(Number(value))) byTunable[name] = Number(value) * scale;
  }
  preferenceCache.byTunable = byTunable;
  return byTunable;
}

function raw(name) {
  if (process.env[name] !== undefined && process.env[name] !== "") return process.env[name];
  const preferences = preferenceValues();
  if (Object.prototype.hasOwnProperty.call(preferences, name)) return preferences[name];
  const values = fileValues();
  return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
}

function number(name, fallback) {
  const live = liveTunables();
  if (live && live.KNOWN && live.KNOWN[name]) {
    const value = Number(live.number(name));
    if (Number.isFinite(value)) return value;
  }
  const value = Number(raw(name));
  return raw(name) !== undefined && Number.isFinite(value) ? value : fallback;
}

function flag(name, fallback) {
  const live = liveTunables();
  if (live && live.KNOWN && live.KNOWN[name]) return live.flag(name) !== false;
  const value = raw(name);
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

// The type IDs whose client model this mod's type layer sets (the hull panels), while the core
// has the layer on, which it does only when the client was patched with it. Empty when the core
// is missing or the layer is off, so the server never spawns a type the client would draw as
// something else. The composed layer names the mod behind each field in `by`.
let layerSeen = null;
let layerTypes = new Set();
function layerModelTypes() {
  const core = globalThis[Symbol.for("reverie.core")];
  const layer = core && core.typeLayer && typeof core.typeLayer.layer === "function" ? core.typeLayer.layer() : null;
  if (layer !== layerSeen) {
    layerSeen = layer;
    layerTypes = new Set(((layer && layer.typeEdits) || [])
      .filter((edit) => edit && edit.by && edit.by["client.graphicID"] === "reverie-salvage")
      .map((edit) => Number(edit.typeID)));
  }
  return layerTypes;
}

module.exports = { game, tryGame, number, flag, paths, layerModelTypes, PREFERENCES, PREFERENCES_FILE };
