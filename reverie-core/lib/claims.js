"use strict";

// What each mod's reverie.json says it owns, checked across the enabled mods. Two mods claiming
// the same type ID, group, attribute, message, inventory flag and so on would overwrite each
// other in the client's files and in the database, so that is an error. Two mods editing the same
// CCP type is allowed, since the later one wins, and is reported.
//
// claims: { kind: [id, [low, high], ...] } with kinds types, groups, categories, attributes,
// effects, marketGroups, messages, icons, graphics, flags.

const KINDS = ["types", "groups", "categories", "attributes", "effects", "marketGroups", "messages", "icons", "graphics", "flags"];

function ranges(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (Array.isArray(item) && item.length === 2 && Number.isInteger(item[0]) && Number.isInteger(item[1]) && item[0] <= item[1]) out.push([item[0], item[1]]);
    else if (Number.isInteger(item)) out.push([item, item]);
    else out.push(null);
  }
  return out;
}

function show([low, high]) { return low === high ? String(low) : `${low}-${high}`; }

// mods: catalog records in load order. Returns { errors: [], notes: [] } as strings.
function check(mods) {
  const errors = [];
  const notes = [];
  const owned = new Map(KINDS.map((kind) => [kind, []])); // kind -> [{ mod, range }]
  for (const mod of mods) {
    const claims = mod.reverie && mod.reverie.claims;
    if (!claims) continue;
    for (const kind of Object.keys(claims)) {
      if (!KINDS.includes(kind)) { errors.push(`${mod.id}: unknown claim kind "${kind}"`); continue; }
      for (const range of ranges(claims[kind])) {
        if (!range) { errors.push(`${mod.id}: a ${kind} claim is not an ID or a [low, high] pair`); continue; }
        for (const other of owned.get(kind)) {
          if (other.mod !== mod.id && range[0] <= other.range[1] && other.range[0] <= range[1]) {
            errors.push(`${kind} ${show(range)} claimed by ${mod.id} overlaps ${show(other.range)} claimed by ${other.mod}`);
          }
        }
        owned.get(kind).push({ mod: mod.id, range });
      }
    }
  }
  const editors = new Map(); // "kind id" -> [mod ids]
  for (const mod of mods) {
    const edits = mod.reverie && mod.reverie.edits;
    if (!edits) continue;
    for (const kind of Object.keys(edits)) {
      if (!Array.isArray(edits[kind])) continue;
      for (const id of edits[kind]) {
        const name = `${kind} ${id}`;
        editors.set(name, [...(editors.get(name) || []), mod.id]);
      }
    }
  }
  for (const [name, list] of editors) {
    if (list.length > 1) notes.push(`${name} is edited by ${list.join(", ")}; ${list[list.length - 1]} loads last and wins where they differ`);
  }
  return { errors, notes };
}

module.exports = { check, KINDS };
