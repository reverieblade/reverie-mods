#!/usr/bin/env node
"use strict";

// Reverie's mod manager from the command line, for installs that do not use the EveJS Launcher.
// It follows the launcher's rules and files (loader.js against loader.js.disabled), so the two can
// be used on one install. Changes take effect at the next server start.
//
//   node mods/reverie-core/cli.js list
//   node mods/reverie-core/cli.js enable <id>      applies the mod's file edits, then turns it on
//   node mods/reverie-core/cli.js disable <id>     puts its file edits back (--force keeps edited ones)
//   node mods/reverie-core/cli.js files            game files each mod has changed
//   node mods/reverie-core/cli.js fingerprint <id> originalSha256 values for a mod's declared edits
//   node mods/reverie-core/cli.js order            the order the next start will load
//   node mods/reverie-core/cli.js move <id> <n>    put a mod at position n of the saved order
//   node mods/reverie-core/cli.js sort             save the resolved order
//   node mods/reverie-core/cli.js check            order, ID claims and patch declarations
//   node mods/reverie-core/cli.js reload <id>...   reload mods in the running server
//   node mods/reverie-core/cli.js status           what the running (or last) server loaded
//   node mods/reverie-core/cli.js client status    whether the EVE client has the mods' types
//   node mods/reverie-core/cli.js client apply     write the mods' types, names, icons and recipes into it
//   node mods/reverie-core/cli.js client restore   put the client's own files back
//     options: --client <tq folder>, --languages en-us,de, --dry-run (apply and restore)

const fs = require("fs");
const path = require("path");
const paths = require("./lib/paths");
const catalog = require("./lib/catalog");
const order = require("./lib/order");
const claims = require("./lib/claims");
const host = require("./lib/host");
const edits = require("./lib/edits");

function find(mods, id) {
  const mod = mods.find((item) => item.id.toLowerCase() === String(id || "").toLowerCase());
  if (!mod) throw new Error(`no mod "${id}" in ${paths.modsDir}`);
  return mod;
}

function resolvedNow() {
  return order.resolve(catalog.discover(), catalog.readConfig().order);
}

const commands = {
  list() {
    const mods = catalog.discover();
    const { order: loaded, skipped } = resolvedNow();
    const position = new Map(loaded.map((mod, index) => [mod.id, index + 1]));
    const reasons = new Map(skipped.map((item) => [item.id, item.reason]));
    if (!mods.length) return console.log(`No mods in ${paths.modsDir}.`);
    for (const mod of mods) {
      const state = mod.kind !== "loader" ? `${mod.kind || "unknown kind"}, not managed here`
        : !mod.enabled ? "disabled"
        : position.has(mod.id) ? `loads ${position.get(mod.id)}`
        : `enabled but not loaded: ${reasons.get(mod.id) || "unknown"}`;
      console.log(`${mod.id.padEnd(28)} ${mod.version.padEnd(10)} ${state}`);
      for (const error of mod.errors) console.log(`${"".padEnd(39)} ${error}`);
      for (const partner of mod.worksWith) {
        const other = mods.find((item) => item.id.toLowerCase() === partner.mod.toLowerCase());
        const there = !other ? "not installed" : other.enabled ? "enabled" : "installed, disabled";
        console.log(`${"".padEnd(39)} works with ${partner.mod} (${there})${partner.adds ? `: ${partner.adds}` : ""}`);
      }
    }
  },

  enable(id) {
    const mods = catalog.discover();
    const mod = find(mods, id);
    if (mod.kind !== "loader") throw new Error(`${mod.id} is a ${mod.kind} mod; use the launcher for it`);
    if (mod.enabled) return console.log(`${mod.id} is already enabled.`);
    // A client package's on and off state belongs to the launcher, so being installed is enough
    // here, as in lib/order.js.
    const meets = (other) => other.errors.length === 0 && (other.kind === "loader" ? other.enabled : Boolean(other.kind));
    const missing = mod.requires.filter((req) => !mods.some((other) => meets(other) && other.id.toLowerCase() === req.toLowerCase()));
    if (missing.length) throw new Error(`${mod.id} requires ${missing.join(", ")}; enable ${missing.length > 1 ? "those" : "that"} first`);
    const conflicts = mods.filter((other) => other.enabled && other !== mod &&
      (mod.conflicts.some((c) => c.toLowerCase() === other.id.toLowerCase()) || other.conflicts.some((c) => c.toLowerCase() === mod.id.toLowerCase())));
    if (conflicts.length) throw new Error(`${mod.id} conflicts with ${conflicts.map((c) => c.id).join(", ")}, which ${conflicts.length > 1 ? "are" : "is"} enabled`);
    const applied = host.apply(mod);
    if (applied.changed) console.log(`${mod.id} changed ${applied.changed === 1 ? "one game file" : `${applied.changed} game files`}; disable puts them back.`);
    fs.renameSync(path.join(mod.dir, "loader.js.disabled"), path.join(mod.dir, "loader.js"));
    const config = catalog.readConfig();
    if (!config.order.some((item) => item.toLowerCase() === mod.id.toLowerCase())) {
      config.order.push(mod.id);
      catalog.writeConfig(config);
    }
    console.log(`${mod.id} is enabled. It loads at the next server start, or now with: reload ${mod.id}`);
    commands.check();
  },

  disable(id, flag) {
    const mods = catalog.discover();
    const mod = find(mods, id);
    if (!mod.enabled) return console.log(`${mod.id} is already disabled.`);
    const dependents = mods.filter((other) => other.enabled && other.requires.some((req) => req.toLowerCase() === mod.id.toLowerCase()));
    if (dependents.length) throw new Error(`${dependents.map((d) => d.id).join(", ")} require${dependents.length > 1 ? "" : "s"} ${mod.id}; disable ${dependents.length > 1 ? "them" : "it"} first`);
    const restored = host.restore(mod.id, paths.repoRoot, { force: flag === "--force" });
    if (restored.changed) console.log(`${mod.id}'s changes to ${restored.changed === 1 ? "one game file" : `${restored.changed} game files`} were put back.`);
    for (const line of restored.kept) console.log(`kept   ${line}`);
    fs.renameSync(path.join(mod.dir, "loader.js"), path.join(mod.dir, "loader.js.disabled"));
    console.log(`${mod.id} is disabled. Its items stay in the game and its types stay in the client. It stops at the next server start, or now with: reload ${mod.id}`);
  },

  order() {
    const { order: loaded, skipped } = resolvedNow();
    loaded.forEach((mod, index) => console.log(`${String(index + 1).padStart(3)}  ${mod.id}`));
    for (const item of skipped) console.log(`  -  ${item.id}: not loaded, ${item.reason}`);
  },

  move(id, position) {
    const mods = catalog.discover();
    const mod = find(mods, id);
    const config = catalog.readConfig();
    const list = config.order.length ? config.order : resolvedNow().order.map((item) => item.id);
    const rest = list.filter((item) => item.toLowerCase() !== mod.id.toLowerCase());
    const at = Math.max(0, Math.min(rest.length, Number(position) - 1 || 0));
    rest.splice(at, 0, mod.id);
    catalog.writeConfig({ order: rest });
    commands.order();
  },

  sort() {
    const { order: loaded } = resolvedNow();
    catalog.writeConfig({ order: loaded.map((mod) => mod.id) });
    commands.order();
  },

  check() {
    const { order: loaded, skipped } = resolvedNow();
    const claimed = claims.check(loaded);
    const { readDeclarations } = require("./lib/dryrun");
    const declared = readDeclarations(loaded);
    const fileErrors = [];
    for (const mod of catalog.discover().filter((item) => item.reverie && Array.isArray(item.reverie.files))) {
      for (const r of edits.resolveMod(mod, paths.repoRoot).results) {
        if (r.error) fileErrors.push(`${r.label}: ${r.error}`);
        else if (mod.enabled && r.state !== "applied" && r.state !== "unknown") fileErrors.push(`${r.label}: enabled, but its change is not in the file (run disable and enable to put it back)`);
      }
    }
    const errors = [...skipped.map((item) => `${item.id} will not load: ${item.reason}`), ...claimed.errors, ...declared.errors, ...fileErrors];
    const notes = [...claimed.notes, ...declared.notes];
    for (const line of errors) console.log(`error  ${line}`);
    for (const line of notes) console.log(`note   ${line}`);
    const patchCount = declared.declarations.filter((d) => d.target).length;
    console.log(`${loaded.length} mods load, ${patchCount} patches, ${errors.length} errors, ${notes.length} notes.`);
    if (errors.length) process.exitCode = 1;
  },

  // Asks the running server to reload these mods from disk: new code, or enabled or disabled
  // since the start. The server watches the file's mtime (every 2 seconds).
  reload(...ids) {
    if (!ids.length) throw new Error("name the mods to reload: reload <id> [<id> ...]");
    const mods = catalog.discover();
    for (const id of ids) find(mods, id);
    requestReload({ mods: ids });
    console.log(`Asked the server to reload ${ids.join(", ")}. See the result with: status`);
  },

  // The game files each mod has changed, and whether the changes are still there.
  files() {
    const rows = host.report();
    if (!rows.length) return console.log("No mod has changed a game file through the CLI.");
    for (const row of rows) {
      console.log(`${row.mod.padEnd(28)} ${row.entries} changes, ${row.state}${row.missing.length ? `, missing from ${row.missing.join(", ")}` : ""}`);
    }
  },

  // For mod authors: the originalSha256 of each declared edit as the files stand now.
  fingerprint(id) {
    const mod = find(catalog.discover(), id);
    for (const edit of (mod.reverie && mod.reverie.files) || []) {
      try { console.log(`${edit.path}  ${edits.fingerprint(paths.repoRoot, edit)}`); } catch (error) { console.log(`${edit.path}  ${error.message}`); }
    }
  },

  status() {
    const file = path.join(paths.reverieDir, "status.json");
    if (!fs.existsSync(file)) return console.log("No status yet: no server has started with Reverie.");
    const status = catalog.readJson(file);
    console.log(`Server ${status.pid}, core ${status.core}, ${status.booted ? "booted" : "booting"}, written ${status.at}`);
    for (const mod of status.mods) console.log(`  ${mod.id.padEnd(28)} ${mod.state}${mod.error ? `: ${mod.error}` : ""}`);
    for (const item of status.skipped || []) console.log(`  ${item.id.padEnd(28)} skipped: ${item.reason}`);
    for (const problem of status.patches.problems) console.log(`  problem ${problem.label}: ${problem.message}`);
    if (status.typeLayer) console.log(`  type layer ${status.typeLayer.active ? "on" : "off"}: ${status.typeLayer.reason}`);
    if (status.loginScripts) console.log(`  client scripts: ${status.loginScripts.started ? status.loginScripts.providers.map((p) => p.mod).join(", ") : status.loginScripts.reason}`);
  },

  // The EVE client's half: the composed type layer written into the client's resource files.
  client(action = "status", ...rest) {
    const flag = (name) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };
    const tq = flag("--client");
    const languages = flag("--languages") ? flag("--languages").split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const dryRun = rest.includes("--dry-run");
    const run = require("./client/run");
    const log = (line) => console.log(line);
    if (action === "status") {
      const state = run.check({ tq });
      console.log(`${state.tq || "no client"}: ${state.ok ? "up to date" : "needs a patch"}, ${state.reason}.`);
      if (state.mods) console.log(`  mods with types: ${state.mods.map((m) => `${m.id} ${m.version}`).join(", ") || "none"}`);
      for (const line of (state.state && state.state.lines) || []) console.log(`  ${line.resource}: ${line.state}`);
      if (!state.ok) process.exitCode = 1;
      return;
    }
    if (action === "apply") {
      const out = run.install({ tq, languages, dryRun, log });
      if (dryRun) console.log("Dry run: nothing was written.");
      else if (!out.unchanged) console.log("Done. A running server takes the new and changed types within a few seconds.");
      return;
    }
    if (action === "restore") {
      const out = run.remove({ tq, dryRun, log });
      console.log(dryRun ? "Dry run: nothing was written." : `${out.restored} files are the client's own again${out.left.length ? `; ${out.left.length} were changed by another tool and left` : ""}.`);
      return;
    }
    throw new Error(`client ${action}? Use client status, client apply or client restore.`);
  },
};

// _local/reverie/reload.json, which the running server's game thread and workers watch by mtime:
// { mods: [ids to reload] } (client/run.js writes { typeLayer: true } after a client patch).
function requestReload(request) {
  fs.mkdirSync(paths.reverieDir, { recursive: true });
  const file = path.join(paths.reverieDir, "reload.json");
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...request, at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

function main() {
  const [command = "list", ...args] = process.argv.slice(2);
  const run = commands[command];
  if (!run) {
    console.log(`Unknown command "${command}". Commands: ${Object.keys(commands).join(", ")}.`);
    process.exitCode = 2;
    return;
  }
  try { run(...args); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
