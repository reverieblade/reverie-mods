"use strict";

// Services between mods. One mod provides a named, versioned object (the holds mod provides
// "holds", the bot mod provides "bot-jobs"); another mod uses it when it is there and does
// without it when it is not. when() is the usual way in: the callback runs as soon as a
// matching provider exists, may return a cleanup, and the cleanup runs when the provider goes
// away (disabled, failed, reloaded) or the user mod does. A provider that comes back is
// attached again, so partners follow each other through live reloads in any load order.
//
// Versions: a provider at 1.4.2 serves a request for 1, 1.3 or 1.4.2, and never 2 or 1.5.
// A request with no version takes any provider.
//
// Game files reach the same registry with no core loaded:
//
//   const services = globalThis[Symbol.for("reverie.services")];
//   const jobs = services ? services.use("bot-jobs", 1) : null;

const GLOBAL_KEY = Symbol.for("reverie.services");
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseVersion(text) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(text).trim());
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function satisfies(have, want) {
  if (want === undefined || want === null || want === "" || want === "*") return true;
  const a = parseVersion(have);
  const b = parseVersion(want);
  if (!a || !b) return false;
  return a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]));
}

function isThenable(value) {
  return value && typeof value.then === "function";
}

function createServices({ log }) {
  const providers = new Map(); // name -> { modID, version, impl }
  const watchers = [];         // { modID, name, want, fn, bound }

  function runCleanup(watcher, cleanup) {
    if (typeof cleanup !== "function") return;
    try {
      const out = cleanup();
      if (isThenable(out)) out.then(null, (error) => log.error(`[${watcher.modID}] cleanup for ${watcher.name} failed: ${error && error.stack || error}`));
    } catch (error) { log.error(`[${watcher.modID}] cleanup for ${watcher.name} failed: ${error && error.stack || error}`); }
  }

  function attach(watcher, provider) {
    const bound = { provider, cleanup: null, detached: false };
    watcher.bound = bound;
    let out;
    try { out = watcher.fn(provider.impl, { mod: provider.modID, version: provider.version }); } catch (error) {
      log.error(`[${watcher.modID}] could not attach to ${watcher.name} from ${provider.modID}: ${error && error.stack || error}`);
      return;
    }
    if (isThenable(out)) {
      // An async attach: a detach that comes before it settles runs the cleanup once it does.
      out.then((cleanup) => { if (bound.detached) runCleanup(watcher, cleanup); else bound.cleanup = cleanup; },
        (error) => log.error(`[${watcher.modID}] could not attach to ${watcher.name} from ${provider.modID}: ${error && error.stack || error}`));
    } else {
      bound.cleanup = out;
    }
  }

  function detach(watcher) {
    const bound = watcher.bound;
    if (!bound) return;
    watcher.bound = null;
    bound.detached = true;
    runCleanup(watcher, bound.cleanup);
  }

  function offerTo(provider, name) {
    for (const watcher of watchers) {
      if (watcher.name === name && !watcher.bound && satisfies(provider.version, watcher.want)) attach(watcher, provider);
    }
  }

  function withdraw(modID, name) {
    const provider = providers.get(name);
    if (!provider || provider.modID !== modID) return false;
    // Users let go in the reverse of the order they attached.
    for (const watcher of [...watchers].reverse()) {
      if (watcher.bound && watcher.bound.provider === provider) detach(watcher);
    }
    providers.delete(name);
    return true;
  }

  function provide(modID, name, version, impl) {
    if (!NAME.test(String(name))) throw new Error(`service name "${name}" must be lower case letters, digits, dot, dash or underscore`);
    if (!parseVersion(version)) throw new Error(`service ${name}: version "${version}" must be a number like 1, 1.2 or 1.2.3`);
    if (!impl || (typeof impl !== "object" && typeof impl !== "function")) throw new Error(`service ${name}: the provided value must be an object or function`);
    const existing = providers.get(name);
    if (existing && existing.modID !== modID) throw new Error(`service ${name} is already provided by ${existing.modID}`);
    if (existing) withdraw(modID, name);
    const provider = { modID, name, version: String(version).trim(), impl };
    providers.set(name, provider);
    offerTo(provider, name);
    return () => withdraw(modID, name);
  }

  function use(name, want) {
    const provider = providers.get(name);
    return provider && satisfies(provider.version, want) ? provider.impl : null;
  }

  function has(name, want) {
    return Boolean(use(name, want));
  }

  function when(modID, name, want, fn) {
    if (typeof want === "function") { fn = want; want = undefined; }
    if (typeof fn !== "function") throw new Error(`when(${name}) needs a function`);
    if (want !== undefined && want !== null && want !== "*" && !parseVersion(want)) throw new Error(`when(${name}): version "${want}" must be a number like 1 or 1.2`);
    const watcher = { modID, name, want, fn, bound: null };
    watchers.push(watcher);
    const provider = providers.get(name);
    if (provider && satisfies(provider.version, want)) attach(watcher, provider);
    return () => {
      detach(watcher);
      const at = watchers.indexOf(watcher);
      if (at >= 0) watchers.splice(at, 1);
    };
  }

  // A mod going away: what others use from it is withdrawn first, while it still works, then
  // its own attachments are let go.
  function removeMod(modID) {
    for (const provider of [...providers.values()]) {
      if (provider.modID === modID) withdraw(modID, provider.name);
    }
    for (const watcher of [...watchers].reverse()) {
      if (watcher.modID !== modID) continue;
      detach(watcher);
      watchers.splice(watchers.indexOf(watcher), 1);
    }
  }

  function status() {
    return {
      provided: [...providers.values()].map((p) => ({ name: p.name, version: p.version, mod: p.modID })),
      used: watchers.map((w) => ({ mod: w.modID, name: w.name, want: w.want === undefined ? "*" : String(w.want), from: w.bound ? w.bound.provider.modID : null })),
    };
  }

  const registry = { provide, use, has, when, withdraw, removeMod, status };
  globalThis[GLOBAL_KEY] = Object.freeze({ use, has });
  return registry;
}

module.exports = { createServices, satisfies, parseVersion, GLOBAL_KEY };
