"use strict";

// Named hook points, for places that wrapping an export cannot reach (one function in a file
// calling another directly). A call site asks the bus through the global symbol, so the game
// runs the same with no core loaded:
//
//   const hooks = globalThis[Symbol.for("reverie.hooks")];
//   entries = hooks ? hooks.run("salvage.rewardEntries", entries, context) : entries;
//
// run() passes a value through every handler in order; a handler returns the new value or
// undefined to keep it. emit() only notifies. Handler errors are logged and skipped.

const GLOBAL_KEY = Symbol.for("reverie.hooks");

function createHooks({ log }) {
  const handlers = new Map(); // name -> [{ modID, modIndex, priority, seq, fn, faults }]
  let sequence = 0;

  function on(modID, modIndex, name, fn, options = {}) {
    if (typeof fn !== "function") throw new Error(`hook ${name}: handler is not a function`);
    const list = handlers.get(name) || [];
    list.push({ modID, modIndex, priority: Number(options.priority) || 0, seq: sequence += 1, fn, faults: 0 });
    list.sort((a, b) => (b.priority - a.priority) || (a.modIndex - b.modIndex) || (a.seq - b.seq));
    handlers.set(name, list);
    return () => off(modID, name, fn);
  }

  function off(modID, name, fn) {
    const list = handlers.get(name);
    if (!list) return;
    const kept = list.filter((h) => !(h.modID === modID && (!fn || h.fn === fn)));
    if (kept.length) handlers.set(name, kept); else handlers.delete(name);
  }

  function removeMod(modID) {
    for (const name of [...handlers.keys()]) off(modID, name, null);
  }

  function fault(handler, name, error) {
    handler.faults += 1;
    if (handler.faults <= 5 || handler.faults % 1000 === 0) {
      log.error(`[${handler.modID}] hook ${name} failed (${handler.faults}): ${error && error.stack || error}`);
    }
  }

  function run(name, value, ...args) {
    const list = handlers.get(name);
    if (!list) return value;
    let current = value;
    for (const handler of list) {
      try {
        const out = handler.fn(current, ...args);
        if (out !== undefined) current = out;
      } catch (error) { fault(handler, name, error); }
    }
    return current;
  }

  function emit(name, ...args) {
    const list = handlers.get(name);
    if (!list) return;
    for (const handler of list) {
      try { handler.fn(...args); } catch (error) { fault(handler, name, error); }
    }
  }

  function has(name) { return handlers.has(name); }

  function status() {
    return [...handlers.entries()].map(([name, list]) => ({ name, handlers: list.map((h) => ({ mod: h.modID, faults: h.faults })) }));
  }

  const bus = { run, emit, has, on, off, removeMod, status };
  // The public face for call sites: run, emit and has only.
  globalThis[GLOBAL_KEY] = Object.freeze({ run, emit, has });
  return bus;
}

module.exports = { createHooks, GLOBAL_KEY };
