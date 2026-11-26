"use strict";

// Load order, by the launcher's rules: `requires` must be installed and enabled and loads first,
// `loadAfter` and `loadBefore` order against enabled mods and are ignored otherwise, `conflicts`
// keeps a pair from running together even when only one side declares it, and the saved order is
// kept wherever the edges allow. IDs compare without case.
//
// The launcher refuses to start when the set is wrong. The server start this repo uses has no one
// to ask, so here a mod that cannot load is left out, with the reason, and the rest still load.

function key(id) { return String(id).toLowerCase(); }

// mods: catalog records. savedOrder: IDs. Returns { order: [records], skipped: [{ id, reason }] }.
function resolve(mods, savedOrder = []) {
  const candidates = mods.filter((mod) => mod.enabled && mod.kind === "loader" && mod.errors.length === 0);
  const skipped = [];
  const skip = (mod, reason) => { skipped.push({ id: mod.id, reason }); active.delete(key(mod.id)); };
  const active = new Map(candidates.map((mod) => [key(mod.id), mod]));
  const savedIndex = new Map(savedOrder.map((id, index) => [key(id), index]));
  const rank = (mod) => (savedIndex.has(key(mod.id)) ? savedIndex.get(key(mod.id)) : Number.MAX_SAFE_INTEGER);
  const byRank = (a, b) => (rank(a) - rank(b)) || a.id.localeCompare(b.id);

  for (const mod of mods) {
    if (mod.enabled && mod.errors.length) skipped.push({ id: mod.id, reason: mod.errors.join("; ") });
  }

  // Two folders with one ID: neither is trusted.
  const seen = new Map();
  for (const mod of candidates) {
    const id = key(mod.id);
    if (seen.has(id)) { skip(mod, `another folder (${seen.get(id).folder}) has the same id`); skip(seen.get(id), `another folder (${mod.folder}) has the same id`); }
    else seen.set(id, mod);
  }

  // Conflicts: the mod later in the saved order gives way.
  for (const mod of [...active.values()].sort(byRank)) {
    if (!active.has(key(mod.id))) continue;
    for (const other of [...active.values()]) {
      if (other === mod) continue;
      const declared = mod.conflicts.some((id) => key(id) === key(other.id)) || other.conflicts.some((id) => key(id) === key(mod.id));
      if (declared) skip(other, `conflicts with ${mod.id}`);
    }
  }

  // Requirements, repeated until nothing changes, since leaving one out can strand another. A
  // requirement on a mod that is not a loader (Reverie Client Data is a client package) is met
  // when that mod is installed: the launcher keeps its on and off state and enforces `requires`
  // for it itself, and it has no load order.
  const installedOther = new Set(mods.filter((mod) => mod.kind && mod.kind !== "loader" && mod.errors.length === 0).map((mod) => key(mod.id)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const mod of [...active.values()]) {
      const missing = mod.requires.filter((id) => !active.has(key(id)) && !installedOther.has(key(id)));
      if (missing.length) { skip(mod, `requires ${missing.join(", ")}, which is not installed and enabled`); changed = true; }
    }
  }

  // Edges, then a topological sort that always takes the best-ranked ready mod.
  const after = new Map([...active.keys()].map((id) => [id, new Set()])); // id -> ids it must follow
  const edge = (first, second) => { if (active.has(first) && active.has(second) && first !== second) after.get(second).add(first); };
  for (const mod of active.values()) {
    const id = key(mod.id);
    for (const other of mod.requires) edge(key(other), id);
    for (const other of mod.loadAfter) edge(key(other), id);
    for (const other of mod.loadBefore) edge(id, key(other));
  }
  const order = [];
  const placed = new Set();
  const pending = new Set(active.keys());
  while (pending.size) {
    const ready = [...pending].map((id) => active.get(id)).filter((mod) => [...after.get(key(mod.id))].every((id) => placed.has(id)));
    if (!ready.length) break;
    ready.sort(byRank);
    const next = ready[0];
    order.push(next);
    placed.add(key(next.id));
    pending.delete(key(next.id));
  }
  for (const id of pending) {
    const mod = active.get(id);
    skipped.push({ id: mod.id, reason: `its load order forms a cycle with ${[...after.get(id)].filter((other) => pending.has(other)).join(", ")}` });
  }
  return { order, skipped };
}

module.exports = { resolve };
