"use strict";

// File edits a mod makes when it is installed, in the EveJS Launcher's contribution format, so
// the launcher can apply them in its journal, keep each mod's edits apart, and restore them on
// disable or removal (docs/how-to-make-a-mod/reference/helpers.md, "Staged whole-file
// contributions" and "Independent text regions").
//
// A mod declares them in reverie.json under "files":
//
//   { "path": "server/src/space/modules/salvagerRuntime.js", "format": "text",
//     "start": "// <unique start anchor>", "end": "// <unique end anchor>",
//     "valueFile": "edits/salvagerRuntime.region.js",   (or "value": "...")
//     "originalSha256": "<sha-256 of the text between the anchors in the supported build>" }
//   { "path": "server/src/services/x/newFile.js", "format": "file", "source": "staged/newFile.js" }
//   { "path": "config/mods/reverie-salvage.json", "format": "json", "key": ["enabled"], "value": true }
//
// The anchors stay in the file and must each occur exactly once, start before end. Only the text
// between them changes. originalSha256 pins the build the region was written for: when EveJS
// changes that text, the edit is refused instead of guessed. The value and the anchors (which may
// span lines) take the file's own line endings, since files in EveJS mix LF and CRLF.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_VALUE = 65536;
const MAX_ANCHOR = 128;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;
const CONFIG_FORMATS = { json: [".json"], ini: [".ini"], yaml: [".yaml", ".yml"] };

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function safeRelative(text) {
  const value = String(text || "");
  if (!value || value.includes("\\") || path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && !/[<>:"|?*\u0000-\u001f]/.test(part) && !/[ .]$/.test(part));
}

function decode(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return { bom: buffer.subarray(0, 3), text: buffer.subarray(3).toString("utf8") };
  return { bom: Buffer.alloc(0), text: buffer.toString("utf8") };
}

function newlineOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

// A region value or an anchor that spans lines, in the target file's own line endings.
function withNewline(text, newline) {
  return String(text).replace(/\r\n/g, "\n").split("\n").join(newline);
}

function count(text, needle) {
  let total = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) total += 1;
  return total;
}

// Where a text region is: { before, region, after } or an error string.
function locate(text, start, end) {
  if (count(text, start) !== 1) return `the start anchor occurs ${count(text, start)} times; it must occur exactly once`;
  if (count(text, end) !== 1) return `the end anchor occurs ${count(text, end)} times; it must occur exactly once`;
  const from = text.indexOf(start) + start.length;
  const to = text.indexOf(end);
  if (to < from) return "the end anchor comes before the start anchor";
  return { before: text.slice(0, from), region: text.slice(from, to), after: text.slice(to) };
}

// One declared edit, checked against the installation at `root`. Returns
// { contribution, state, error } where state is "original", "applied" or "missing".
function resolveEdit(mod, edit, root) {
  const label = `${mod.id}: ${edit && edit.path}`;
  const out = (fields) => ({ label, ...fields });
  if (!edit || typeof edit !== "object") return out({ error: "an entry in files is not an object" });
  const base = edit.base || "evejs";
  if (base !== "evejs") return out({ error: `base "${base}" is not supported here; client files are composed by the core` });
  if (!safeRelative(edit.path)) return out({ error: "the path must be relative, with forward slashes and no . or .. parts" });
  const target = path.join(root, ...edit.path.split("/"));
  const format = edit.format;

  if (format === "text" || format === "file") {
    if (!edit.path.startsWith("server/")) return out({ error: "text and file edits must target server/" });
    if (/\.(json|ini|ya?ml|sqlite3?|db)$/i.test(edit.path)) return out({ error: "configuration and database files cannot be overlaid; use a json, ini or yaml key edit" });
    if (/(^|\/)_local\/gamestore(\/|$)/i.test(edit.path)) return out({ error: "GameStore data is not an edit target" });
  } else if (CONFIG_FORMATS[format]) {
    if (!edit.path.startsWith("config/")) return out({ error: "configuration key edits must target config/" });
    if (!CONFIG_FORMATS[format].some((ext) => edit.path.toLowerCase().endsWith(ext))) return out({ error: `a ${format} edit needs a ${CONFIG_FORMATS[format].join(" or ")} file` });
    if (!Array.isArray(edit.key) || !edit.key.length || edit.key.some((k) => typeof k !== "string" || !k || k.length > 128)) return out({ error: "key must be a list of 1-32 nonempty strings" });
    const value = edit.value;
    if (!(value === null || ["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value)))) return out({ error: "a configuration value must be a string, number, boolean or null" });
    return out({ state: "unknown", contribution: { base: "evejs", path: edit.path, format, key: edit.key, value } });
  } else {
    return out({ error: `format "${format}" is not one of text, file, json, ini, yaml` });
  }

  if (format === "file") {
    if (!safeRelative(edit.source)) return out({ error: "source must be a relative path inside the mod folder" });
    const sourceFile = path.join(mod.dir, ...edit.source.split("/"));
    if (!fs.existsSync(sourceFile)) return out({ error: `the staged file ${edit.source} is missing from the mod` });
    const staged = fs.readFileSync(sourceFile);
    if (staged.length > MAX_FILE) return out({ error: "the staged file is larger than 8 MiB" });
    let state = "missing";
    if (fs.existsSync(target)) {
      const current = fs.readFileSync(target);
      state = current.equals(staged) ? "applied" : "original";
      if (state === "original" && edit.originalSha256 && sha256(current) !== edit.originalSha256) {
        return out({ error: "the file differs from the build this mod supports (originalSha256); update the mod for this EveJS version" });
      }
    }
    return out({ state, target, staged, contribution: { base: "evejs", path: edit.path, format: "file", source: edit.source } });
  }

  // Text region.
  let start = String(edit.start || "");
  let end = String(edit.end || "");
  if (!start || !end || start.length > MAX_ANCHOR || end.length > MAX_ANCHOR) return out({ error: "start and end anchors are required, at most 128 characters each" });
  let value = edit.value;
  if (edit.valueFile !== undefined) {
    if (!safeRelative(edit.valueFile)) return out({ error: "valueFile must be a relative path inside the mod folder" });
    const valuePath = path.join(mod.dir, ...edit.valueFile.split("/"));
    if (!fs.existsSync(valuePath)) return out({ error: `the region file ${edit.valueFile} is missing from the mod` });
    value = fs.readFileSync(valuePath, "utf8").replace(/^﻿/, "");
  }
  if (typeof value !== "string") return out({ error: "a text edit needs value or valueFile" });
  if (!fs.existsSync(target)) return out({ error: "the file to edit does not exist in this EveJS installation" });
  const { text } = decode(fs.readFileSync(target));
  const newline = newlineOf(text);
  value = withNewline(value, newline);
  start = withNewline(start, newline);
  end = withNewline(end, newline);
  if (value.length > MAX_VALUE) return out({ error: "the region text is longer than 65,536 characters" });
  const found = locate(text, start, end);
  if (typeof found === "string") return out({ error: `${found} (an EveJS update may have changed this file)` });
  let state;
  if (found.region === value) state = "applied";
  else if (!edit.originalSha256 || sha256(found.region.replace(/\r\n/g, "\n")) === edit.originalSha256) state = "original";
  else return out({ error: "the text between the anchors differs from the build this mod supports (originalSha256); update the mod for this EveJS version" });
  return out({ state, target, region: found, value, contribution: { base: "evejs", path: edit.path, format: "text", key: [start, end], value } });
}

// Every declared edit of a mod. Returns { contributions, results, errors }.
function resolveMod(mod, root) {
  const list = Array.isArray(mod.reverie && mod.reverie.files) ? mod.reverie.files : [];
  const results = list.map((edit) => resolveEdit(mod, edit, root));
  const errors = results.filter((r) => r.error).map((r) => `${r.label}: ${r.error}`);
  if (list.length > MAX_ENTRIES) errors.push(`${mod.id}: more than ${MAX_ENTRIES} file edits`);
  // Two of this mod's own regions in one file must not overlap.
  const byFile = new Map();
  for (const r of results) {
    if (r.error || !r.region) continue;
    const span = [r.region.before.length, r.region.before.length + r.region.region.length];
    for (const other of byFile.get(r.target) || []) {
      if (span[0] < other[1] && other[0] < span[1]) errors.push(`${r.label}: two regions of this mod overlap`);
    }
    byFile.set(r.target, [...(byFile.get(r.target) || []), span]);
  }
  return { contributions: errors.length ? [] : results.map((r) => r.contribution), results, errors };
}

// The sha-256 a mod author puts in originalSha256 for a region or a file as it is now.
function fingerprint(root, edit) {
  const target = path.join(root, ...String(edit.path).split("/"));
  const buffer = fs.readFileSync(target);
  if (edit.format === "file") return sha256(buffer);
  const { text } = decode(buffer);
  const newline = newlineOf(text);
  const found = locate(text, withNewline(edit.start, newline), withNewline(edit.end, newline));
  if (typeof found === "string") throw new Error(found);
  return sha256(found.region.replace(/\r\n/g, "\n"));
}

module.exports = { resolveEdit, resolveMod, fingerprint, locate, decode, newlineOf, sha256, MAX_VALUE, MAX_ANCHOR, MAX_FILE };
