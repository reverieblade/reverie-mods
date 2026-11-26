"use strict";
// The client patch in one call, for the CLI (`cli.js client ...`) and the launcher's
// reverie-client package helper: compose the installed mods' type layer, save it where the server
// reads it, and write it into the client (or take it out).

const compose = require("./compose");
const patch = require("./patch");
const { findClientTq, clientIsRunning } = require("./resfiles");
const paths = require("../lib/paths");

function composeOrThrow() {
  const result = compose.compose();
  if (result.errors.length) {
    const error = new Error(`The installed mods' type layers do not fit together:\n${result.errors.join("\n")}`);
    error.lines = result.errors;
    throw error;
  }
  return result;
}

// { tq, layer, saved, ledger, unchanged, notes }
function install({ tq, languages, dryRun = false, log = () => {} } = {}) {
  const client = findClientTq({ explicit: tq, repoRoot: paths.repoRoot });
  if (!client) throw new Error("No EVE client found. Give its tq folder with --client, or set REVERIE_CLIENT_TQ.");
  const { layer, notes } = composeOrThrow();
  for (const note of notes) log(`note: ${note}`);
  const bytes = compose.serialize(layer);
  const { sha256 } = require("./resfiles");
  const layerSha256 = sha256(bytes);
  const previous = patch.readLedger();
  const wantedLanguages = languages && languages.length ? languages : (previous && previous.languages) || ["en-us"];
  const before = patch.status({ tq: client, layerSha256 });
  if (before.matchesLayer && JSON.stringify(previous.languages) === JSON.stringify(wantedLanguages)) {
    if (!dryRun) compose.save(layer);
    log(`The client already has this layer (${layer.mods.map((m) => m.id).join(", ") || "no mods"}).`);
    return { tq: client, layer, layerSha256, ledger: previous, unchanged: true, notes };
  }
  if (!dryRun && clientIsRunning(client)) throw new Error("The EVE client is running; close every client first.");
  log(`Patching ${client} with ${layer.mods.map((m) => `${m.id} ${m.version}`).join(", ") || "no mods"}:`);
  const built = patch.plan({ tq: client, layer, layerSha256, languages: wantedLanguages });
  const ledger = patch.apply(built, { dryRun, log });
  // The layer is saved after the client has it, so the server never turns on a layer the client lacks.
  const saved = dryRun ? null : compose.save(layer);
  if (!dryRun) askServerToReload();
  return { tq: client, layer, layerSha256, ledger, saved, unchanged: false, notes };
}

function remove({ tq, dryRun = false, log = () => {} } = {}) {
  const ledger = patch.readLedger();
  const client = tq ? findClientTq({ explicit: tq }) : ledger ? ledger.client : findClientTq({ repoRoot: paths.repoRoot });
  if (!ledger) { log("Reverie has not patched a client."); return { tq: client, restored: 0, left: [] }; }
  const out = patch.restore({ tq: client, dryRun, log });
  if (!dryRun) askServerToReload();
  return { tq: client, ...out };
}

// Whether the client has exactly the layer the installed mods compose to now.
function check({ tq } = {}) {
  const client = findClientTq({ explicit: tq, repoRoot: paths.repoRoot });
  if (!client) return { ok: false, reason: "no EVE client found" };
  let layer;
  try { layer = composeOrThrow().layer; } catch (error) { return { ok: false, tq: client, reason: error.message }; }
  const { sha256 } = require("./resfiles");
  const layerSha256 = sha256(compose.serialize(layer));
  const state = patch.status({ tq: client, layerSha256 });
  const needed = layer.types.length + layer.typeEdits.length + layer.blueprints.length + layer.blueprintEdits.length +
    layer.groups.length + layer.attributes.length + layer.icons.length + Object.keys(layer.messages).length > 0;
  if (!needed && !state.installed) return { ok: true, tq: client, layerSha256, reason: "no mod changes the client", mods: layer.mods, state };
  if (state.matchesLayer) return { ok: true, tq: client, layerSha256, reason: "the client has the current layer", mods: layer.mods, state };
  const reason = !state.installed ? "the client is not patched"
    : state.error ? state.error
    : !state.inPlace ? "some of Reverie's files in the client were put back or replaced by another tool"
    : "the installed mods changed since the client was patched";
  return { ok: false, tq: client, layerSha256, reason, mods: layer.mods, state };
}

// Asks a running game server to take the layer the client now has: its game thread and workers
// watch _local/reverie/reload.json by mtime, and `typeLayer: true` drops the cached static tables
// and the item type index (lib/typeLayer.js applyLive). With no server running nothing reads it.
function askServerToReload() {
  const fs = require("fs");
  const path = require("path");
  fs.mkdirSync(paths.reverieDir, { recursive: true });
  const file = path.join(paths.reverieDir, "reload.json");
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ mods: [], typeLayer: true, at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { install, remove, check, askServerToReload };
