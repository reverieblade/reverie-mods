"use strict";

// Where things are. The core lives in <root>/mods/reverie-core, both in this repo and in a
// launcher install, so the mods folder is the core's parent and the EveJS root is one above.
// REVERIE_SERVER_ROOT and REVERIE_LOCAL_DIR exist for the offline tests. REVERIE_REPO_ROOT is set
// by the launcher helper to the EveJS root the launcher names.

const path = require("path");

const modsDir = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(process.env.REVERIE_REPO_ROOT || path.resolve(modsDir, ".."));
const serverRoot = path.resolve(process.env.REVERIE_SERVER_ROOT || path.join(repoRoot, "server"));
const srcRoot = path.join(serverRoot, "src");
const localDir = path.resolve(process.env.REVERIE_LOCAL_DIR || path.join(repoRoot, "_local"));
const reverieDir = path.join(localDir, "reverie");

// Windows paths compare without case.
function normalize(file) {
  const resolved = path.resolve(String(file));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// "services/mining/miningRuntime" (or with .js, or "src/...") to the absolute file under
// server/src. An absolute path is taken as it is, so a mod can patch another mod's module.
function resolveTarget(target) {
  const text = String(target || "").split("\\").join("/");
  if (path.isAbsolute(text)) return path.resolve(text.endsWith(".js") ? text : `${text}.js`);
  const name = text.replace(/^(server\/)?(src\/)?/, "").replace(/\.js$/, "");
  if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.split("/").includes("..")) {
    throw new Error(`bad patch target "${target}": give a path under server/src such as services/mining/miningRuntime`);
  }
  return path.join(srcRoot, `${name}.js`);
}

module.exports = { modsDir, repoRoot, serverRoot, srcRoot, localDir, reverieDir, normalize, resolveTarget };
