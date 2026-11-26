"use strict";

// The preload runs in every Node process and thread the server starts, and in npm too when it
// comes through NODE_OPTIONS. The core decides once which of them this is:
//   game    the game server's main thread (node . in server/, or node server/index.js)
//   worker  a worker thread of the game process (persistence, marshal, killmail, shipwright)
//   other   anything else: npm, child processes (wallet authority, scheduler), tools
// Mods patch in game and worker; init runs only in game. REVERIE_ROLE forces a role for tests.

const path = require("path");
const { isMainThread } = require("worker_threads");
const paths = require("./paths");

const ROLES = new Set(["game", "worker", "other"]);

function detectRole() {
  const forced = String(process.env.REVERIE_ROLE || "").trim();
  if (ROLES.has(forced) && isMainThread) {
    if (forced === "game") process.env.REVERIE_GAME_PID = String(process.pid);
    return forced;
  }
  if (!isMainThread) {
    return process.env.REVERIE_GAME_PID === String(process.pid) ? "worker" : "other";
  }
  const entry = process.argv[1] ? paths.normalize(process.argv[1]) : "";
  const server = paths.normalize(paths.serverRoot);
  const isGame = entry === server ||
    entry === paths.normalize(path.join(paths.serverRoot, "index.js")) ||
    entry === paths.normalize(path.join(paths.serverRoot, "index"));
  if (!isGame) return "other";
  // Worker threads copy the environment when they are created, which is after this point, so
  // they can tell they belong to this process. Child processes have another PID.
  process.env.REVERIE_GAME_PID = String(process.pid);
  return "game";
}

module.exports = { detectRole, ROLES };
