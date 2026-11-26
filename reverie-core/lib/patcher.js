"use strict";

// The shared patch layer. The core puts one hook on Node's ".js" loader. Each time a file
// finishes loading (the first time, and again on every hot reload), the hook wraps the exports
// that mods asked to patch, before the require that loaded it returns. So every caller, including
// one that destructures the exports, gets the wrapped function, and a reload is wrapped like the
// first load. Game files are never edited, and launcher mods that wrap Module._load themselves
// keep working beside this.
//
// A wrapped export runs, for each call:
//   prefixes   in order (higher priority first, then load order); one may return skip(value)
//              to stand in for the original
//   the core   the one replacement if a mod gave one (it gets the original), else the original
//   postfixes  in reverse order; each may return a new result (undefined keeps it)
// Prefix and postfix errors are logged against the mod and the call goes on as if that patch
// were absent. A replacement is the function itself, so its errors propagate.

const Module = require("module");
const path = require("path");
const paths = require("./paths");

const WRAPPED = Symbol.for("reverie.wrapped");
const ORIGINAL = Symbol.for("reverie.original");
const LOADER_HOOK = Symbol.for("reverie.loaderHook");
const FAULT_LOG_FIRST = 5;
const FAULT_LOG_EVERY = 1000;

class Skip {
  constructor(value) { this.value = value; }
}
function skip(value) { return new Skip(value); }

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function createPatcher({ log }) {
  const byFile = new Map(); // normalized file -> Map(exportPath -> entry)
  const problems = new Map(); // key -> { modIDs, label, message }
  let sequence = 0;
  let installed = false;

  function labelOf(file, exportPath) {
    const relative = path.relative(paths.srcRoot, file).split(path.sep).join("/");
    const name = relative.startsWith("..") ? file : relative.replace(/\.js$/, "");
    return `${name}#${exportPath}`;
  }

  function entryFor(file, exportPath) {
    const key = paths.normalize(file);
    let map = byFile.get(key);
    if (!map) { map = new Map(); byFile.set(key, map); }
    let entry = map.get(exportPath);
    if (!entry) {
      entry = { file, exportPath, label: labelOf(file, exportPath), patches: [], replacement: null, applied: 0 };
      map.set(exportPath, entry);
    }
    return entry;
  }

  function noteProblem(entry, kind, message, extraModIDs = []) {
    const key = `${entry.label}|${kind}`;
    const modIDs = [...new Set([...entry.patches.map((p) => p.modID), ...(entry.replacement ? [entry.replacement.modID] : []), ...extraModIDs])];
    if (!problems.has(key)) log.warn(`${entry.label}: ${message} (${modIDs.join(", ")})`);
    problems.set(key, { label: entry.label, kind, modIDs, message });
  }
  function clearProblem(entry, kind) { problems.delete(`${entry.label}|${kind}`); }

  function fault(patch, entry, phase, error) {
    patch.faults += 1;
    if (patch.faults <= FAULT_LOG_FIRST || patch.faults % FAULT_LOG_EVERY === 0) {
      log.error(`[${patch.modID}] ${phase} on ${entry.label} failed (${patch.faults}): ${error && error.stack || error}`);
    }
  }

  function invoke(entry, original, thisArg, args) {
    const list = entry.patches;
    const replacement = entry.replacement;
    if (list.length === 0 && !replacement) return original.apply(thisArg, args);
    const contexts = new Array(list.length);
    const contextAt = (index) => contexts[index] ||
      (contexts[index] = { mod: list[index].modID, target: entry.label, thisArg, state: {} });
    let result;
    let skipped = false;
    for (let index = 0; index < list.length; index += 1) {
      const patch = list[index];
      if (!patch.prefix) continue;
      let out;
      try { out = patch.prefix(contextAt(index), args); } catch (error) { fault(patch, entry, "prefix", error); continue; }
      if (out instanceof Skip) { skipped = true; result = out.value; break; }
    }
    if (!skipped) {
      result = replacement
        ? replacement.fn.call(thisArg, (...callArgs) => original.apply(thisArg, callArgs), ...args)
        : original.apply(thisArg, args);
    }
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const patch = list[index];
      if (!patch.postfix) continue;
      const ctx = contextAt(index);
      if (patch.async && isThenable(result)) {
        result = Promise.resolve(result).then((value) => {
          try {
            const out = patch.postfix(ctx, value, args);
            return out === undefined ? value : out;
          } catch (error) { fault(patch, entry, "postfix", error); return value; }
        });
        continue;
      }
      try {
        const out = patch.postfix(ctx, result, args);
        if (out !== undefined) result = out;
      } catch (error) { fault(patch, entry, "postfix", error); }
    }
    return result;
  }

  function wrap(entry, original) {
    const wrapper = function reveriePatched(...args) {
      if (new.target) return Reflect.construct(original, args, new.target);
      return invoke(entry, original, this, args);
    };
    for (const key of Object.keys(original)) {
      try { wrapper[key] = original[key]; } catch (_) { /* read-only static */ }
    }
    try { Object.defineProperty(wrapper, "name", { value: original.name, configurable: true }); } catch (_) { /* keep */ }
    try { Object.defineProperty(wrapper, "length", { value: original.length, configurable: true }); } catch (_) { /* keep */ }
    if (original.prototype) wrapper.prototype = original.prototype;
    wrapper[WRAPPED] = entry;
    wrapper[ORIGINAL] = original;
    return wrapper;
  }

  function applyEntry(module, entry) {
    if (entry.exportPath === "*") {
      const current = module.exports;
      if (typeof current !== "function") { noteProblem(entry, "missing", "module.exports is not a function"); return false; }
      if (current[WRAPPED] === entry) return true;
      module.exports = wrap(entry, current);
      entry.applied += 1;
      clearProblem(entry, "missing");
      return "new";
    }
    const keys = entry.exportPath.split(".");
    let holder = module.exports;
    for (let index = 0; index < keys.length - 1 && holder != null; index += 1) holder = holder[keys[index]];
    const last = keys[keys.length - 1];
    if (holder == null || (typeof holder !== "object" && typeof holder !== "function")) {
      noteProblem(entry, "missing", "the module has no such export");
      return false;
    }
    const current = holder[last];
    if (typeof current !== "function") {
      noteProblem(entry, "missing", current === undefined ? "the module has no such export" : "the export is not a function");
      return false;
    }
    if (current[WRAPPED] === entry) return true;
    const wrapper = wrap(entry, current);
    try { holder[last] = wrapper; } catch (_) { /* tried below */ }
    if (holder[last] !== wrapper) {
      try { Object.defineProperty(holder, last, { value: wrapper, writable: true, configurable: true, enumerable: true }); } catch (_) { /* reported below */ }
    }
    if (holder[last] !== wrapper) { noteProblem(entry, "missing", "the export cannot be replaced (a getter or a frozen object)"); return false; }
    entry.applied += 1;
    clearProblem(entry, "missing");
    return "new";
  }

  function applyFile(module, filename) {
    const map = byFile.get(paths.normalize(filename));
    if (!map) return;
    for (const entry of map.values()) {
      try { applyEntry(module, entry); } catch (error) { log.error(`patching ${entry.label} failed: ${error && error.stack || error}`); }
    }
  }

  function cachedModule(file) {
    const direct = require.cache[file];
    if (direct) return direct;
    const key = paths.normalize(file);
    for (const [name, module] of Object.entries(require.cache)) {
      if (paths.normalize(name) === key) return module;
    }
    return null;
  }

  function install() {
    if (installed) return;
    const extensions = Module._extensions;
    const previous = extensions[".js"];
    if (previous && previous[LOADER_HOOK]) { installed = true; return; }
    const hook = function reverieJsLoader(module, filename) {
      const out = previous.apply(this, arguments);
      if (byFile.size > 0) applyFile(module, filename);
      return out;
    };
    hook[LOADER_HOOK] = true;
    extensions[".js"] = hook;
    installed = true;
  }

  // spec: { prefix, postfix, async, priority } or { replace }.
  function add(modID, modIndex, target, exportPath, spec) {
    const file = paths.resolveTarget(target);
    const name = String(exportPath || "").trim();
    if (!name) throw new Error(`patch on ${target} names no export`);
    const entry = entryFor(file, name);
    if (typeof spec.replace === "function") {
      if (entry.replacement && entry.replacement.modID !== modID) {
        noteProblem(entry, "replace", `${modID} and ${entry.replacement.modID} both replace it; ${entry.replacement.modID} keeps it`, [modID]);
        return false;
      }
      entry.replacement = { modID, fn: spec.replace };
    } else {
      if (typeof spec.prefix !== "function" && typeof spec.postfix !== "function") {
        throw new Error(`patch on ${entry.label} has no prefix or postfix`);
      }
      entry.patches.push({
        modID, modIndex, seq: sequence += 1,
        priority: Number.isFinite(Number(spec.priority)) ? Number(spec.priority) : 0,
        prefix: typeof spec.prefix === "function" ? spec.prefix : null,
        postfix: typeof spec.postfix === "function" ? spec.postfix : null,
        async: spec.async === true,
        faults: 0,
      });
      entry.patches.sort((a, b) => (b.priority - a.priority) || (a.modIndex - b.modIndex) || (a.seq - b.seq));
    }
    // A module that loaded before the patch was declared is wrapped now. Callers that already
    // took the function out of its exports keep the old one, so this is reported. An export
    // that is already wrapped (a mod reloaded live) needs nothing: wrappers read the list per call.
    const loaded = cachedModule(file);
    if (loaded && loaded.loaded && applyEntry(loaded, entry) === "new") {
      noteProblem(entry, "late", "patched after the module had loaded; callers that took the function earlier keep the unpatched one");
    }
    return true;
  }

  function removeMod(modID) {
    for (const map of byFile.values()) {
      for (const entry of map.values()) {
        entry.patches = entry.patches.filter((patch) => patch.modID !== modID);
        if (entry.replacement && entry.replacement.modID === modID) entry.replacement = null;
      }
    }
    for (const [key, problem] of problems) {
      if (problem.modIDs.length === 1 && problem.modIDs[0] === modID) problems.delete(key);
    }
  }

  function status() {
    const entries = [];
    for (const map of byFile.values()) {
      for (const entry of map.values()) {
        entries.push({
          target: entry.label,
          applied: entry.applied,
          patches: entry.patches.map((p) => ({ mod: p.modID, priority: p.priority, prefix: Boolean(p.prefix), postfix: Boolean(p.postfix), faults: p.faults })),
          replacedBy: entry.replacement ? entry.replacement.modID : null,
        });
      }
    }
    return { installed, entries, problems: [...problems.values()] };
  }

  return { install, add, removeMod, status, skip };
}

module.exports = { createPatcher, skip, Skip, WRAPPED, ORIGINAL };
