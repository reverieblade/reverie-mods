"use strict";

// How Holds and Bays reaches the game and its own settings.
//
// game(relative) is a game module under server/src, looked up at each use so
// hot reloads of game files reach the mod. Reverie's core knows where
// server/src is in this installation, so the mod never counts ../ from its own
// folder.
//
// number(name, fallback) and flag(name, fallback) read a tunable. In this
// repo's own server the live tunables (services/market/liveTunables.js) hold
// the values and GM tools change them live; a name they register wins there.
// Anywhere else the order is the environment, then the player's settings
// (preferences.json in the mod folder, which the launcher's Configure form
// writes; PREFERENCES below says which key is which tunable), then
// _local/reverie-holds/tunables.json, then the default the caller gives.
// Both files are read again whenever they change, so a saved setting applies
// without a restart.

const fs = require("fs");
const path = require("path");

const MOD_ID = "reverie-holds";
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
// preference key -> [tunable, scale].
const PREFERENCES = Object.freeze({
  lootToBay: ["EVEJS_HOLDS_LOOT_TO_BAY", null],
  laserOverflow: ["EVEJS_HOLDS_LASER_OVERFLOW", null],
  moduleOutputCan: ["EVEJS_HOLDS_MODULE_OUTPUT_CAN", null],
  extensionLoot: ["EVEJS_BAY_EXTENSION_LOOT", 1],
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
  return readJsonByMtime(path.join(paths().localDir, MOD_ID, "tunables.json"), fileCache);
}

const PREFERENCES_FILE = path.join(__dirname, "..", "..", "preferences.json");
const preferenceCache = { mtimeMs: -1, values: {}, byTunable: {} };
let preferencesRead = null;
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

// This mod's part of the composed type layer, while the core has the layer on
// (it is on only when the client was patched with it): the layer's clientData
// for this mod, or null. Without it the server knows none of the extension
// types, so nothing here may drop or route them.
function layerData() {
  const core = globalThis[Symbol.for("reverie.core")];
  const layer = core && core.typeLayer && typeof core.typeLayer.layer === "function" ? core.typeLayer.layer() : null;
  return layer && layer.clientData ? layer.clientData[MOD_ID] || null : null;
}

function log() {
  return tryGame("utils/logger") || console;
}

module.exports = { MOD_ID, game, tryGame, number, flag, paths, layerData, log, PREFERENCES, PREFERENCES_FILE };
