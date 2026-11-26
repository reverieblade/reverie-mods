"use strict";
// Sends each mod's in-game Python to the client at login, through the EveJS Launcher's shared
// login delivery runtime (vendor/login_delivery.cjs, the launcher's own file byte for byte).
//
// A mod lists its scripts in reverie.json, "client": { "scripts": ["client/scripts/x.py"] }. The
// composed type layer records them, and each becomes one provider, "reverie.<mod id>", whose
// source is a short preamble followed by the script:
//
//   REVERIE_MOD = '<mod id>'
//   REVERIE_DATA = {...}        # the layer's clientData for that mod, a plain dict
//
// The script runs in the client right after account login, before character selection, in a
// namespace with the client's builtins and `sm`. It must not block: start the real work in a
// uthread, the way the shipped evejs_*.py scripts do.
//
// Delivery is set up once, in the game thread before the network handshake module loads, and the
// runtime refuses new providers after the first login. A changed script therefore reaches clients
// after the next server start. Scripts are sent only while the type layer is on, so a client
// without the mod's types never runs code that expects them.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const paths = require("./paths");
const catalog = require("./catalog");

const VENDOR_FILE = path.join(__dirname, "..", "vendor", "login_delivery.cjs");
// The core's own script (client/scripts/core.py): client fixes every mod's new types need, such
// as icons for type IDs the client takes for DUST 514 items. Sent first, whenever the layer adds
// or edits types, whether or not any mod has a script of its own.
const CORE_SCRIPT = path.join(__dirname, "..", "client", "scripts", "core.py");
const CORE_ID = "reverie-core";
const VENDOR_SHA256 = "82b7bbe8b43121c8f407aeb3eb576dd730fb40d1720028ac26717ad0cf3a21c5";
const MAX_SOURCE = 256 * 1024;

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// Python string literal for any text: escapes keep it ASCII, so the source's encoding never matters.
function pyString(text) {
  let out = "u'";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return `${out}'`;
}

function preamble(modID, data) {
  return [
    "# Reverie preamble, written by reverie-core/lib/loginScripts.js",
    "import json as _reverie_json",
    `REVERIE_MOD = '${modID}'`,
    `REVERIE_DATA = _reverie_json.loads(${pyString(JSON.stringify(data === undefined ? {} : data))})`,
    "del _reverie_json",
    "",
  ].join("\n");
}

function providerID(modID) {
  return `reverie.${String(modID).toLowerCase().replace(/[^a-z0-9._-]/g, "-")}`.slice(0, 128);
}

// The sources to deliver: [{ id, mod, files, source, bytes }]. Pure, for tests and the CLI.
function buildSources(layer, { modsDir = paths.modsDir } = {}) {
  const out = [];
  const problems = [];
  if (!layer) return { sources: out, problems };
  const hasTypes = (Array.isArray(layer.types) && layer.types.length > 0) || (Array.isArray(layer.typeEdits) && layer.typeEdits.length > 0);
  if (hasTypes) {
    if (fs.existsSync(CORE_SCRIPT)) {
      const text = fs.readFileSync(CORE_SCRIPT, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
      const source = `${preamble(CORE_ID, {})}\n# --- client/scripts/core.py\n${text}\n`;
      out.push({ id: providerID(CORE_ID), mod: CORE_ID, files: ["client/scripts/core.py"], source, bytes: Buffer.byteLength(source, "utf8") });
    } else {
      problems.push(`${CORE_ID}: client/scripts/core.py is missing, so new types show no icon in the market`);
    }
  }
  if (!Array.isArray(layer.scripts) || !layer.scripts.length) return { sources: out, problems };
  // A disabled mod keeps its types in the layer, but its scripts stay home.
  const installed = catalog.discover(modsDir);
  const disabled = new Set(installed.filter((mod) => !mod.enabled).map((mod) => mod.id.toLowerCase()));
  const dirs = new Map(installed.filter((mod) => mod.enabled).map((mod) => [mod.id.toLowerCase(), mod.dir]));
  const byMod = new Map();
  for (const script of layer.scripts) {
    const key = String(script.mod).toLowerCase();
    if (!byMod.has(key)) byMod.set(key, { mod: script.mod, scripts: [] });
    byMod.get(key).scripts.push(script);
  }
  for (const { mod, scripts } of byMod.values()) {
    if (disabled.has(mod.toLowerCase())) continue;
    const dir = dirs.get(mod.toLowerCase());
    if (!dir) { problems.push(`${mod}: not installed, so its client scripts are not sent`); continue; }
    const parts = [preamble(mod, (layer.clientData || {})[mod])];
    const files = [];
    let ok = true;
    for (const script of scripts) {
      const file = path.resolve(dir, script.file);
      if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) { problems.push(`${mod}: ${script.file} is missing`); ok = false; break; }
      const bytes = fs.readFileSync(file);
      if (script.sha256 && sha256(bytes) !== script.sha256) {
        problems.push(`${mod}: ${script.file} changed since the type layer was composed; the current file is sent`);
      }
      parts.push(`# --- ${script.file}\n${bytes.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n")}\n`);
      files.push(script.file);
    }
    if (!ok) continue;
    const source = parts.join("\n");
    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes > MAX_SOURCE) { problems.push(`${mod}: its client scripts come to ${bytes} bytes, over the 256 KiB a login provider may send`); continue; }
    out.push({ id: providerID(mod), mod, files, source, bytes });
  }
  return { sources: out, problems };
}

// Game thread only, at preload. Returns a status object; never throws.
function startLoginScripts({ typeLayer, log }) {
  const state = { started: false, reason: "", providers: [], receipts: 0, failures: 0, problems: [] };
  try {
    const { isMainThread } = require("worker_threads");
    if (!isMainThread) { state.reason = "not the main thread"; return state; }
    const layerState = typeLayer.read();
    if (!layerState.active) { state.reason = `type layer off (${layerState.reason})`; return state; }
    const { sources, problems } = buildSources(layerState.layer);
    state.problems = problems;
    for (const problem of problems) log.warn(`client scripts: ${problem}`);
    if (!sources.length) { state.reason = "no mod has client scripts"; return state; }
    const vendorBytes = fs.readFileSync(VENDOR_FILE);
    if (sha256(vendorBytes) !== VENDOR_SHA256) { state.reason = "vendor/login_delivery.cjs is not the reviewed copy"; log.error(`client scripts not sent: ${state.reason}`); return state; }
    const delivery = require(VENDOR_FILE);
    if (!delivery.supportsRoot(paths.repoRoot)) { state.reason = `${paths.repoRoot} has no network handshake to deliver through`; log.error(`client scripts not sent: ${state.reason}`); return state; }
    const runtime = delivery.getRuntime(paths.repoRoot, { logger: { log: (m) => log.info(m), error: (m) => log.warn(m) } });
    if (!runtime) { state.reason = "login delivery runs in the main thread only"; return state; }
    for (const source of sources) {
      runtime.register({
        id: source.id,
        source: source.source,
        onReceipt: () => { state.receipts += 1; },
        onFailure: (session, status) => {
          state.failures += 1;
          if (state.failures <= 5 || state.failures % 100 === 0) log.warn(`${source.mod}'s client script did not run (${status && status.reason}); its in-game parts are missing for that pilot`);
        },
      });
      state.providers.push({ id: source.id, mod: source.mod, files: source.files, bytes: source.bytes });
    }
    state.started = true;
    state.reason = `${sources.length} provider(s)`;
    log.info(`client scripts at login: ${sources.map((s) => s.mod).join(", ")}`);
  } catch (error) {
    state.reason = error.message;
    log.error(`client scripts not sent: ${error && error.stack || error}`);
  }
  return state;
}

module.exports = { startLoginScripts, buildSources, preamble, pyString, providerID, VENDOR_SHA256 };
