"use strict";

// Applies and restores a mod's file edits when the EveJS Launcher is not the one doing it (the
// Reverie CLI on a Play.bat install). It follows the launcher's rules so a mod behaves the same
// both ways: anchors stay, only the text between them changes, regions of different mods may not
// overlap, two mods may share a region only with identical text, a whole file can be shared only
// with identical bytes, and removal restores just what the mod changed, refusing when someone has
// edited it since.
//
// The journal is one file per mod in _local/reverie/files/<id>.json. It is written before any
// game file changes, so an interrupted apply can be finished or undone by running it again.

const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const edits = require("./edits");

function journalDir() { return path.join(paths.reverieDir, "files"); }
function journalFile(id) { return path.join(journalDir(), `${String(id).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`); }

function readJournal(id) {
  try { return JSON.parse(fs.readFileSync(journalFile(id), "utf8")); } catch (_) { return null; }
}

function allJournals() {
  let names = [];
  try { names = fs.readdirSync(journalDir()).filter((name) => name.endsWith(".json")); } catch (_) { return []; }
  return names.map((name) => { try { return JSON.parse(fs.readFileSync(path.join(journalDir(), name), "utf8")); } catch (_) { return null; } }).filter(Boolean);
}

const { writeAtomic } = require("./atomicWrite");

function writeJournal(journal) { writeAtomic(journalFile(journal.mod), Buffer.from(`${JSON.stringify(journal, null, 2)}\n`)); }

// True when the launcher has recorded edits of its own on this install; then it owns the files and
// the CLI leaves them alone.
function launcherOwns(root, id) {
  try {
    const index = fs.readFileSync(path.join(root, "_local", "launcher-mods", "contributions.json"), "utf8");
    return id ? index.includes(`mods/${id}`) || index.includes(`"${id}"`) : true;
  } catch (_) { return false; }
}

function getKey(object, key) {
  let at = object;
  for (const part of key) {
    if (!at || typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, part)) return { found: false };
    at = at[part];
  }
  return { found: true, value: at };
}

function setKey(object, key, value) {
  let at = object;
  for (const part of key.slice(0, -1)) {
    if (!at[part] || typeof at[part] !== "object") at[part] = {};
    at = at[part];
  }
  at[key[key.length - 1]] = value;
}

function deleteKey(object, key) {
  let at = object;
  for (const part of key.slice(0, -1)) { if (!at || typeof at !== "object") return; at = at[part]; }
  if (at && typeof at === "object") delete at[key[key.length - 1]];
}

// Regions that other mods hold in this file, by their anchors.
function foreignRegions(id, relPath) {
  const out = [];
  for (const journal of allJournals()) {
    if (journal.mod === id) continue;
    for (const entry of journal.entries || []) if (entry.format === "text" && entry.path === relPath) out.push({ mod: journal.mod, entry });
  }
  return out;
}

function foreignFile(id, relPath) {
  for (const journal of allJournals()) {
    if (journal.mod === id) continue;
    const entry = (journal.entries || []).find((item) => item.path === relPath && item.format !== "text");
    if (entry) return { mod: journal.mod, entry };
  }
  return null;
}

function spanOf(text, entry) {
  const found = edits.locate(text, entry.start, entry.end);
  return typeof found === "string" ? null : [found.before.length - entry.start.length, found.before.length + found.region.length + entry.end.length];
}

// Works out every write without making any. Returns { writes: Map(file -> Buffer), entries, errors }.
function plan(mod, root) {
  const resolved = edits.resolveMod(mod, root);
  const errors = [...resolved.errors];
  const writes = new Map();
  const entries = [];
  const textOf = (file) => {
    if (writes.has(file)) return edits.decode(writes.get(file));
    return edits.decode(fs.readFileSync(file));
  };
  for (const r of resolved.results) {
    if (r.error) continue;
    const c = r.contribution;
    if (c.format === "text") {
      const { bom, text } = textOf(r.target);
      const [start, end] = c.key;
      const mine = { start, end };
      let shared = null;
      for (const other of foreignRegions(mod.id, c.path)) {
        if (other.entry.start === start && other.entry.end === end) {
          if (other.entry.value !== r.value) errors.push(`${mod.id}: ${c.path}: ${other.mod} already holds this region with different text`);
          else shared = other.entry;
          continue;
        }
        const a = spanOf(text, mine);
        const b = spanOf(text, other.entry);
        if (a && b && a[0] < b[1] && b[0] < a[1]) errors.push(`${mod.id}: ${c.path}: this region overlaps one held by ${other.mod}`);
      }
      const found = edits.locate(text, start, end);
      const own = (readJournal(mod.id)?.entries || []).find((e) => e.path === c.path && e.format === "text" && e.start === start);
      const original = r.state !== "applied" ? found.region : own ? own.original : shared ? shared.original : undefined;
      if (original === undefined) { errors.push(`${mod.id}: ${c.path}: the region already holds this mod's text but no journal says what was there before`); continue; }
      entries.push({ path: c.path, format: "text", start, end, original, value: r.value });
      if (r.state !== "applied") writes.set(r.target, Buffer.concat([bom, Buffer.from(found.before + r.value + found.after, "utf8")]));
    } else if (c.format === "file") {
      const other = foreignFile(mod.id, c.path);
      if (other && other.entry.sha256 !== edits.sha256(r.staged)) errors.push(`${mod.id}: ${c.path}: ${other.mod} already replaced this file with different content`);
      const previous = (readJournal(mod.id)?.entries || []).find((e) => e.path === c.path && e.format === "file");
      const existed = previous ? previous.existed : fs.existsSync(r.target);
      const original = previous ? previous.original : (existed ? fs.readFileSync(r.target).toString("base64") : null);
      if (r.state === "applied" && !previous && !other) { errors.push(`${mod.id}: ${c.path}: the file already holds this mod's content but no journal says what was there before`); continue; }
      entries.push({ path: c.path, format: "file", existed: other ? other.entry.existed : existed, original: other ? other.entry.original : original, sha256: edits.sha256(r.staged) });
      if (r.state !== "applied") writes.set(r.target, r.staged);
    } else if (c.format === "json") {
      const target = path.join(root, ...c.path.split("/"));
      let data = {};
      if (writes.has(target)) data = JSON.parse(writes.get(target).toString("utf8"));
      else if (fs.existsSync(target)) { try { data = JSON.parse(fs.readFileSync(target, "utf8").replace(/^﻿/, "")); } catch (error) { errors.push(`${mod.id}: ${c.path}: ${error.message}`); continue; } }
      const previous = (readJournal(mod.id)?.entries || []).find((e) => e.path === c.path && JSON.stringify(e.key) === JSON.stringify(c.key));
      const now = getKey(data, c.key);
      entries.push({ path: c.path, format: "json", key: c.key, value: c.value, had: previous ? previous.had : now.found, before: previous ? previous.before : now.value });
      if (!now.found || now.value !== c.value) {
        setKey(data, c.key, c.value);
        writes.set(target, Buffer.from(`${JSON.stringify(data, null, 2)}\n`));
      }
    } else {
      errors.push(`${mod.id}: ${c.path}: ${c.format} edits are applied by the EveJS Launcher only`);
    }
  }
  return { writes, entries, errors };
}

function apply(mod, root = paths.repoRoot) {
  if (launcherOwns(root, mod.id)) throw new Error(`the EveJS Launcher manages ${mod.id}'s files on this install; enable it there`);
  const { writes, entries, errors } = plan(mod, root);
  if (errors.length) throw new Error(errors.join("\n"));
  if (!entries.length) return { changed: 0 };
  writeJournal({ schemaVersion: 1, mod: mod.id, version: mod.version, state: "applying", at: new Date().toISOString(), entries });
  for (const [file, buffer] of writes) writeAtomic(file, buffer);
  writeJournal({ schemaVersion: 1, mod: mod.id, version: mod.version, state: "applied", at: new Date().toISOString(), entries });
  return { changed: writes.size };
}

// Puts back what the mod changed. Refuses, and changes nothing, when one of its regions or files
// has been edited since; `force` keeps going and leaves those as they are.
function restore(id, root = paths.repoRoot, { force = false } = {}) {
  const journal = readJournal(id);
  if (!journal) return { changed: 0, kept: [] };
  const writes = new Map();
  const kept = [];
  const errors = [];
  const sharers = (entry) => allJournals().filter((j) => j.mod !== id && (j.entries || []).some((e) => e.path === entry.path && e.format === entry.format && (e.format !== "text" || e.start === entry.start)));
  for (const entry of journal.entries || []) {
    const target = path.join(root, ...entry.path.split("/"));
    if (sharers(entry).length) continue; // another mod still holds the same text; it stays
    if (entry.format === "text") {
      if (!fs.existsSync(target)) { kept.push(`${entry.path} is gone`); continue; }
      const { bom, text } = edits.decode(writes.get(target) || fs.readFileSync(target));
      const found = edits.locate(text, entry.start, entry.end);
      if (typeof found === "string") { errors.push(`${entry.path}: ${found}`); continue; }
      if (found.region === entry.original) continue;
      if (found.region !== entry.value) { errors.push(`${entry.path}: the region was edited after this mod changed it`); continue; }
      writes.set(target, Buffer.concat([bom, Buffer.from(found.before + entry.original + found.after, "utf8")]));
    } else if (entry.format === "file") {
      const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if (!current) continue;
      if (edits.sha256(current) !== entry.sha256) { errors.push(`${entry.path}: the file was edited after this mod replaced it`); continue; }
      writes.set(target, entry.existed ? Buffer.from(entry.original, "base64") : null);
    } else if (entry.format === "json") {
      if (!fs.existsSync(target)) continue;
      const data = JSON.parse((writes.get(target) || fs.readFileSync(target)).toString("utf8").replace(/^﻿/, ""));
      const now = getKey(data, entry.key);
      if (now.found && now.value !== entry.value) { errors.push(`${entry.path}: ${entry.key.join(".")} was changed after this mod set it`); continue; }
      if (entry.had) setKey(data, entry.key, entry.before); else deleteKey(data, entry.key);
      writes.set(target, Buffer.from(`${JSON.stringify(data, null, 2)}\n`));
    }
  }
  if (errors.length && !force) throw new Error(`${id}: nothing was restored.\n${errors.join("\n")}\nEdit those back, or run with --force to restore the rest and keep them.`);
  writeJournal({ ...journal, state: "restoring", at: new Date().toISOString() });
  for (const [file, buffer] of writes) {
    if (buffer === null) fs.rmSync(file, { force: true });
    else writeAtomic(file, buffer);
  }
  fs.rmSync(journalFile(id), { force: true });
  return { changed: writes.size, kept: [...kept, ...errors] };
}

// What the CLI shows: each journal and whether its edits are still in place.
function report(root = paths.repoRoot) {
  return allJournals().map((journal) => {
    const missing = [];
    for (const entry of journal.entries || []) {
      const target = path.join(root, ...entry.path.split("/"));
      if (!fs.existsSync(target)) { missing.push(entry.path); continue; }
      if (entry.format === "text") {
        const found = edits.locate(edits.decode(fs.readFileSync(target)).text, entry.start, entry.end);
        if (typeof found === "string" || found.region !== entry.value) missing.push(entry.path);
      } else if (entry.format === "file" && edits.sha256(fs.readFileSync(target)) !== entry.sha256) missing.push(entry.path);
    }
    return { mod: journal.mod, state: journal.state, entries: (journal.entries || []).length, missing };
  });
}

module.exports = { plan, apply, restore, report, readJournal, launcherOwns };
