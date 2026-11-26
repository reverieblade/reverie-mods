"use strict";

// The EveJS Launcher helper every Reverie mod shares (launcher helper API 1,
// docs/how-to-make-a-mod/reference/helpers.md). A mod's own helper.js is one line:
//
//   require("../reverie-core/helper").main(__dirname);
//
// and its manifest declares it:
//
//   "launcherApi": { "version": 1, "minLauncherVersion": "1.0.74",
//     "helper": { "runtime": "node", "path": "helper.js" },
//     "capabilities": ["install", "verify", "recover", "prepare_disable", "prepare_remove", "prepare_server_start"] }
//
// install and recover check the mod against the other enabled mods (order, requirements,
// conflicts, ID ranges) and against this EveJS build, then hand the mod's file edits from
// reverie.json to the launcher as contributions. The launcher writes them through its journal and
// puts them back on disable or removal, so prepare_disable and prepare_remove have nothing left to
// write. Nothing here writes a game file itself.

const fs = require("fs");
const path = require("path");

const PROTOCOL = "evejs_launcher_mod_v1";
const ACTIONS = new Set(["install", "verify", "recover", "prepare_disable", "prepare_remove", "prepare_server_start"]);

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 2 || !argv[index + 1]) throw new Error(`Missing ${name}`);
  return argv[index + 1];
}

function reply(request, fields) {
  return {
    protocol: PROTOCOL,
    requestId: request && typeof request.requestId === "string" ? request.requestId : "",
    success: fields.state !== "failed",
    state: fields.state,
    message: String(fields.message || "").slice(0, 4096),
    restartRequired: fields.restartRequired || [],
    contributions: fields.contributions || [],
    environment: {},
    arguments: [],
  };
}

// Everything the launcher asks, answered without touching the disk. Exported for tests.
function handle(request, modDir) {
  if (!request || request.protocol !== PROTOCOL) return reply(request, { state: "failed", message: "Unsupported helper protocol." });
  if (!ACTIONS.has(request.action)) return reply(request, { state: "failed", message: `Reverie mods do not handle ${request.action}.` });
  const root = request.runtime && request.runtime.evejsRoot;
  if (!root || !fs.existsSync(path.join(root, "server"))) return reply(request, { state: "failed", message: "The EveJS folder the launcher gave has no server folder." });
  if (request.runtime.backend && request.runtime.backend !== "native") return reply(request, { state: "failed", message: "Reverie mods run on the Native backend only." });

  // Paths resolve against the launcher's EveJS root, not wherever this file happens to sit.
  process.env.REVERIE_REPO_ROOT = root;
  const catalog = require("./lib/catalog");
  const edits = require("./lib/edits");
  const mod = catalog.readMod(modDir);
  const name = mod.displayName || mod.id;
  if (mod.errors.length) return reply(request, { state: "failed", message: `${name}: ${mod.errors.join("; ")}` });

  if (request.action === "prepare_disable" || request.action === "prepare_remove") {
    // The launcher owns every edit this mod made and restores them itself. The running server
    // drops the mod's patches at its next start, or at once through the CLI's reload. A mod's
    // market stock goes at the core's next sync; when the core itself goes, no sync follows, so
    // the stock is taken out of the market's database here.
    let market = "";
    if (mod.id.toLowerCase() === "reverie-core") {
      try { market = require("./lib/marketStock").removeAllOffline(path.join(root, "server")); } catch (error) {
        market = `The market stock Reverie added could not be taken out: ${error && error.message || error}`;
      }
    }
    return reply(request, { state: "ready", message: [`${name} has nothing else to undo.`, market].filter(Boolean).join(" "), restartRequired: ["game_server"] });
  }

  const resolved = edits.resolveMod(mod, root);
  if (resolved.errors.length) {
    return reply(request, { state: "failed", message: `${name} does not fit this EveJS build:\n${resolved.errors.join("\n")}` });
  }

  if (request.action === "verify" || request.action === "prepare_server_start") {
    const stale = resolved.results.filter((r) => r.state === "original" || r.state === "missing").map((r) => r.contribution.path);
    if (!stale.length) return reply(request, { state: "ready", message: `${name} is in place.` });
    // An EveJS update replaced files this mod edits. Re-applying is the launcher's job (disable and
    // enable runs install again); preparation may not propose edits of its own.
    return reply(request, { state: "failed", message: `${name}'s changes are missing from ${[...new Set(stale)].join(", ")}, probably after an EveJS update. Disable and enable ${name} to put them back.` });
  }

  // install, recover: the mod has to fit beside the mods already on.
  const order = require("./lib/order");
  const claims = require("./lib/claims");
  // Mods that are not loaders (Reverie Client Data) have no loader.js, so they never read as
  // enabled here. They stay in the list: order.resolve counts an installed one as a met
  // requirement, and the launcher keeps their on and off state itself.
  const others = catalog.discover(path.dirname(modDir)).filter((other) => (other.enabled || (other.kind && other.kind !== "loader")) && other.id.toLowerCase() !== mod.id.toLowerCase());
  const { order: loaded, skipped } = order.resolve([...others, { ...mod, enabled: true }], catalog.readConfig().order);
  const mine = skipped.find((item) => item.id.toLowerCase() === mod.id.toLowerCase());
  if (mine) return reply(request, { state: "failed", message: `${name} cannot load: ${mine.reason}` });
  const word = new RegExp(`(^|[^A-Za-z0-9_-])${mod.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "i");
  const clash = claims.check(loaded).errors.filter((line) => word.test(line));
  if (clash.length) return reply(request, { state: "failed", message: `${name} clashes with an enabled mod:\n${clash.join("\n")}` });

  const count = resolved.contributions.length;
  return reply(request, {
    state: "ready",
    message: count ? `${name} is ready, with ${count === 1 ? "one file change" : `${count} file changes`}.` : `${name} is ready.`,
    restartRequired: ["game_server"],
    contributions: resolved.contributions,
  });
}

function main(modDir, argv = process.argv) {
  let request = null;
  let result;
  try {
    request = JSON.parse(fs.readFileSync(option(argv, "--request"), "utf8").replace(/^﻿/, ""));
    result = handle(request, modDir);
  } catch (error) {
    result = reply(request, { state: "failed", message: error && error.message ? error.message : String(error) });
  }
  fs.writeFileSync(option(argv, "--result"), JSON.stringify(result));
}

module.exports = { main, handle, PROTOCOL };

// The core's own helper is this file.
if (require.main === module) main(__dirname);
