"use strict";

// What a mod gets: one api object, handed to patches(api) at preload and to init(api) and
// dispose(api) in the game thread. `host` is the live core, or the recorder `reverie check` uses
// to read a mod's declarations without starting anything.

const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { skip } = require("./patcher");

function createModApi(host, record) {
  const prefix = `[${record.id}]`;
  const stateDir = path.join(paths.localDir, record.id);
  const api = {
    id: record.id,
    version: record.version,
    dir: record.dir,
    role: host.role,
    coreVersion: host.version,
    paths: { repoRoot: paths.repoRoot, serverRoot: paths.serverRoot, srcRoot: paths.srcRoot, stateDir },
    skip,

    // api.patch("services/mining/miningRuntime", "executeMiningCycle", { prefix, postfix, async, priority })
    // The export may be a dotted path ("InvBrokerService.prototype.Handle_GetInventory"), or "*"
    // for a module whose exports are one function.
    patch(target, exportPath, spec) {
      if (!spec || typeof spec !== "object") throw new Error(`${prefix} patch(${target}, ${exportPath}) needs { prefix, postfix }`);
      return host.addPatch(record, target, exportPath, spec);
    },
    // api.replace(target, exportPath, (original, ...args) => ...). One mod per export.
    replace(target, exportPath, fn) {
      if (typeof fn !== "function") throw new Error(`${prefix} replace(${target}, ${exportPath}) needs a function`);
      return host.addPatch(record, target, exportPath, { replace: fn });
    },

    hooks: {
      on: (name, fn, options) => host.hooks.on(record.id, record.index, name, fn, options),
      off: (name, fn) => host.hooks.off(record.id, name, fn),
      run: (name, value, ...args) => host.hooks.run(name, value, ...args),
      emit: (name, ...args) => host.hooks.emit(name, ...args),
    },

    mods: {
      has: (id) => host.isModActive(id),
      list: () => host.listMods(),
    },

    // Services between mods (lib/services.js). provide() returns a withdraw function; when()
    // returns a cancel function, and its callback may return a cleanup. Everything a mod
    // provides or attaches to is let go when it is disabled, fails or reloads.
    provide: (name, version, impl) => host.services.provide(record.id, name, version, impl),
    use: (name, version) => host.services.use(name, version),
    when: (name, version, fn) => host.services.when(record.id, name, version, fn),

    log: {
      info: (message) => host.log.info(`${prefix} ${message}`),
      warn: (message) => host.log.warn(`${prefix} ${message}`),
      error: (message) => host.log.error(`${prefix} ${message}`),
    },

    // _local/<mod-id>/, made on first use.
    stateDir() {
      fs.mkdirSync(stateDir, { recursive: true });
      return stateDir;
    },

    // A game module by its path under server/src, for init-time use. Look modules up where they
    // are used rather than holding them, so hot reloads reach the mod.
    require(target) {
      return require(paths.resolveTarget(target));
    },
  };
  return api;
}

module.exports = { createModApi };
