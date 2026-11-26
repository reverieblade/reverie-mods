"use strict";

// The mods on disk. A mod is a folder in mods/ with an evejs-launcher.mod.json. A loader mod is
// enabled when loader.js is present and disabled when it is loader.js.disabled, the launcher's
// own rule, so the launcher and the Reverie CLI always agree about which mods are on.

const fs = require("fs");
const path = require("path");
const paths = require("./paths");

const MANIFEST = "evejs-launcher.mod.json";
const REVERIE = "reverie.json";
const CONFIG = "modsConfig.json";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

function idList(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

// reverie.json "worksWith": the mods this one attaches to when they are there, and what each
// adds, so a player sees it before enabling. [{ mod, service, version, adds }]
function readPartners(record) {
  const list = record.reverie ? record.reverie.worksWith : undefined;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { record.errors.push(`${REVERIE}: worksWith must be a list`); return []; }
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry.mod !== "string" || !entry.mod.trim()) { record.errors.push(`${REVERIE}: every worksWith entry needs a mod`); continue; }
    out.push({
      mod: entry.mod.trim(),
      service: typeof entry.service === "string" ? entry.service.trim() : "",
      version: entry.version === undefined ? "" : String(entry.version),
      adds: typeof entry.adds === "string" ? entry.adds.trim() : "",
    });
  }
  return out;
}

// One mod folder to a plain record; problems with the files go in `errors`, never thrown.
function readMod(dir) {
  const record = {
    dir, folder: path.basename(dir), id: path.basename(dir), version: "", displayName: "",
    kind: "", enabled: false, manifest: null, reverie: null,
    requires: [], loadAfter: [], loadBefore: [], conflicts: [], worksWith: [], errors: [],
  };
  try {
    record.manifest = readJson(path.join(dir, MANIFEST));
  } catch (error) {
    record.errors.push(`${MANIFEST}: ${error.message}`);
    return record;
  }
  const manifest = record.manifest;
  if (manifest.schemaVersion !== 3) record.errors.push(`${MANIFEST}: schemaVersion must be 3`);
  if (typeof manifest.id === "string" && manifest.id.trim()) record.id = manifest.id.trim();
  else record.errors.push(`${MANIFEST}: id is missing`);
  record.version = String(manifest.version || "");
  record.displayName = String(manifest.displayName || record.id);
  record.kind = String(manifest.kind || "");
  record.requires = idList(manifest.requires);
  record.loadAfter = idList(manifest.loadAfter);
  record.loadBefore = idList(manifest.loadBefore);
  record.conflicts = idList(manifest.conflicts);
  const on = fs.existsSync(path.join(dir, "loader.js"));
  const off = fs.existsSync(path.join(dir, "loader.js.disabled"));
  if (record.kind === "loader") {
    if (on && off) record.errors.push("both loader.js and loader.js.disabled are present");
    if (!on && !off) record.errors.push("no loader.js or loader.js.disabled");
    record.enabled = on && !off;
  }
  const reverieFile = path.join(dir, REVERIE);
  if (fs.existsSync(reverieFile)) {
    try { record.reverie = readJson(reverieFile); } catch (error) { record.errors.push(`${REVERIE}: ${error.message}`); }
  }
  record.worksWith = readPartners(record);
  return record;
}

function discover(modsDir = paths.modsDir) {
  let names = [];
  try { names = fs.readdirSync(modsDir, { withFileTypes: true }); } catch (_) { return []; }
  return names
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(modsDir, entry.name, MANIFEST)))
    .map((entry) => readMod(path.join(modsDir, entry.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function configFile() { return path.join(paths.reverieDir, CONFIG); }

function readConfig() {
  try {
    const config = readJson(configFile());
    return { schemaVersion: 1, order: idList(config.order) };
  } catch (_) {
    return { schemaVersion: 1, order: [] };
  }
}

function writeConfig(config) {
  fs.mkdirSync(paths.reverieDir, { recursive: true });
  const file = configFile();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, order: idList(config.order) }, null, 2)}\n`);
  fs.renameSync(temp, file);
}

module.exports = { MANIFEST, REVERIE, readMod, discover, readConfig, writeConfig, readJson };
