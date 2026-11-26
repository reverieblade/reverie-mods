"use strict";
// Type layers: every installed mod's new types, groups, attributes, names, icons and blueprints,
// composed into one file that the server applies (lib/typeLayer.js) and the client patch writes
// into the client (client/patch.js). See doc/REVERIE.md "Type layers".
//
// A mod names its layer in reverie.json, "client": { "layer": "defs/layer.js" }. The file exports
// build(ctx) and returns plain data (every key optional):
//
//   groups        [{ groupID, cloneFrom, name, nameMessageID, categoryID }]
//   marketGroups  [{ marketGroupID, cloneFrom, parentGroupID, nameMessageID, descriptionMessageID, iconID, hasTypes }]
//   attributes    [{ attributeID, cloneFrom, nameMessageID?, tooltipMessageID?, server: {server definition} }]
//   effects       [{ effectID, server: {server definition, also the client's} }]
//   types         [{ typeID, cloneFrom, client: {types.fsdbinary fields}, row: {server itemTypes row},
//                    dogma: {server typeDogma record} | null, skills: {skillTypeID: level} }]
//   typeEdits     [{ typeID, client: {fields}, row: {fields}, dogma: {setAttributes, removeAttributes,
//                    addEffects, removeEffects}, skills: {..} }]           (types the mod does not own)
//   blueprints    [{ blueprintTypeID, definition: {server definition}, client: {activities, maxProductionLimit} }]
//   blueprintEdits [{ blueprintTypeID, activities: {manufacturing, invention}, definition: {fields} }]
//   messages      { "<messageID>": "English text" }
//   icons         [{ iconID, resource: "res:/ui/texture/icons/..png", file: "client/assets/x.png" }]
//   clientData    any JSON, handed to the mod's in-game scripts as REVERIE_DATA["<mod id>"]
//   marketStock   [{ typeID, like, basePrice? }]   NPC sell stock for a type the mod adds or edits:
//                 the market sells it wherever it sells `like`, at that station's price times
//                 basePrice / like's base price (lib/marketStock.js). basePrice defaults to the
//                 type's own, from the layer or the game's data.
//
// ctx gives the server's raw static tables (before any layer), read from _local/gameStore/data:
//   ctx.itemType(typeID), ctx.itemTypes(), ctx.typeDogma(typeID), ctx.attributeType(id),
//   ctx.effectType(id), ctx.materials(typeID), ctx.blueprint(blueprintTypeID), ctx.mod, ctx.layers
//
// Checks: every new ID lies in the mod's claims and is not CCP's already; a type edit targets a type
// the mod lists in reverie.json "edits.types" or one that a mod it requires added; two mods editing
// one field of one type are reported and the later one in load order wins.

const fs = require("fs");
const path = require("path");
const paths = require("../lib/paths");
const catalog = require("../lib/catalog");
const order = require("../lib/order");
const claims = require("../lib/claims");
const { sha256, writeFileAtomic } = require("./resfiles");

const SCHEMA_VERSION = 1;
const LAYER_FILE = () => path.join(paths.reverieDir, "typeLayer.json");

function readTable(name) {
  const file = path.join(paths.localDir, "gameStore", "data", name, "data.json");
  if (!fs.existsSync(file)) throw new Error(`${file} is missing; run the EveJS setup first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// The server's static tables, read once and only when a layer asks.
function createTables() {
  const cache = new Map();
  const table = (name) => {
    if (!cache.has(name)) cache.set(name, readTable(name));
    return cache.get(name);
  };
  let typeIndex = null;
  let materialIndex = null;
  let blueprintIndex = null;
  return {
    itemTypes: () => table("itemTypes").types || [],
    itemType(typeID) {
      if (!typeIndex) typeIndex = new Map((table("itemTypes").types || []).map((row) => [Number(row.typeID), row]));
      return typeIndex.get(Number(typeID)) || null;
    },
    typeDogma: (typeID) => (table("typeDogma").typesByTypeID || {})[String(typeID)] || null,
    attributeType: (id) => (table("typeDogma").attributeTypesByID || {})[String(id)] || null,
    effectType: (id) => (table("typeDogma").effectTypesByID || {})[String(id)] || null,
    materials(typeID) {
      if (!materialIndex) materialIndex = new Map((table("reprocessingStatic").reprocessingTypes || []).map((row) => [Number(row.typeID), row.materials || []]));
      return materialIndex.get(Number(typeID)) || [];
    },
    blueprint(blueprintTypeID) {
      if (!blueprintIndex) blueprintIndex = new Map((table("industryBlueprints").blueprintDefinitions || []).map((row) => [Number(row.blueprintTypeID), row]));
      return blueprintIndex.get(Number(blueprintTypeID)) || null;
    },
  };
}

function inClaims(mod, kind, id) {
  const list = mod.reverie && mod.reverie.claims && mod.reverie.claims[kind];
  if (!Array.isArray(list)) return false;
  return list.some((item) => (Array.isArray(item) ? id >= item[0] && id <= item[1] : id === item));
}

// The installed mods with a layer, in load order. A disabled mod keeps its layer, so items of its
// types already in the database stay known types; only removal takes a layer out.
function layerMods(modsDir = paths.modsDir) {
  const all = catalog.discover(modsDir).map((mod) => ({ ...mod, enabled: mod.kind === "loader" && mod.errors.length === 0 }));
  const { order: loaded, skipped } = order.resolve(all, catalog.readConfig().order);
  const withLayer = loaded.filter((mod) => mod.reverie && mod.reverie.client && mod.reverie.client.layer);
  return { mods: withLayer, all: loaded, skipped };
}

const asList = (value, label, mod) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${mod.id}: layer ${label} must be a list`);
  return value;
};

function compose({ modsDir, only } = {}) {
  const { mods, all, skipped } = layerMods(modsDir);
  const chosen = only ? mods.filter((mod) => only.includes(mod.id)) : mods;
  const errors = [];
  const notes = [];
  const claimCheck = claims.check(all);
  errors.push(...claimCheck.errors);
  const tables = createTables();
  const out = {
    schemaVersion: SCHEMA_VERSION, mods: [], groups: [], marketGroups: [], attributes: [], effects: [], types: [],
    typeEdits: [], blueprints: [], blueprintEdits: [], messages: {}, icons: [], clientData: {}, scripts: [], marketStock: [],
  };
  const owner = { types: new Map(), groups: new Map(), marketGroups: new Map(), attributes: new Map(), effects: new Map(), messages: new Map(), icons: new Map(), resources: new Map() };
  const typeEdits = new Map(); // typeID -> { typeID, client, row, dogma, skills, by: { field: mod } }
  const blueprintEdits = new Map();

  for (const mod of chosen) {
    const file = path.join(mod.dir, mod.reverie.client.layer);
    let layer;
    try {
      const exported = require(file);
      if (typeof exported.build !== "function") throw new Error(`${mod.reverie.client.layer} does not export build(ctx)`);
      layer = exported.build({ ...tables, mod: { id: mod.id, version: mod.version, dir: mod.dir }, layers: out }) || {};
    } catch (error) {
      errors.push(`${mod.id}: its type layer failed: ${error && error.stack || error}`);
      continue;
    }
    const requires = new Set(mod.requires.map((id) => id.toLowerCase()));
    const claim = (kind, id, label, existsInCcp) => {
      if (!Number.isInteger(id) || id <= 0) { errors.push(`${mod.id}: ${label} has no valid ID`); return false; }
      if (!inClaims(mod, kind, id)) { errors.push(`${mod.id}: ${label} ${id} is outside its ${kind} claims in reverie.json`); return false; }
      const taken = owner[kind].get(id);
      if (taken) { errors.push(`${mod.id}: ${label} ${id} is also added by ${taken}`); return false; }
      if (existsInCcp) { errors.push(`${mod.id}: ${label} ${id} already exists in the game's own data`); return false; }
      owner[kind].set(id, mod.id);
      return true;
    };
    try {
      for (const group of asList(layer.groups, "groups", mod)) {
        if (claim("groups", Number(group.groupID), "group", false)) out.groups.push({ ...group, mod: mod.id });
      }
      for (const mg of asList(layer.marketGroups, "marketGroups", mod)) {
        if (claim("marketGroups", Number(mg.marketGroupID), "market group", false)) out.marketGroups.push({ ...mg, mod: mod.id });
      }
      for (const attribute of asList(layer.attributes, "attributes", mod)) {
        const id = Number(attribute.attributeID);
        if (claim("attributes", id, "attribute", Boolean(tables.attributeType(id)))) out.attributes.push({ ...attribute, mod: mod.id });
      }
      for (const effect of asList(layer.effects, "effects", mod)) {
        const id = Number(effect.effectID);
        if (claim("effects", id, "effect", Boolean(tables.effectType(id)))) out.effects.push({ ...effect, mod: mod.id });
      }
      for (const type of asList(layer.types, "types", mod)) {
        const id = Number(type.typeID);
        if (!type.cloneFrom || !tables.itemType(type.cloneFrom)) { errors.push(`${mod.id}: type ${id} copies ${type.cloneFrom}, which does not exist`); continue; }
        if (!type.row || Number(type.row.typeID) !== id) { errors.push(`${mod.id}: type ${id} has no server row with its own typeID`); continue; }
        if (claim("types", id, "type", Boolean(tables.itemType(id)))) out.types.push({ ...type, mod: mod.id });
      }
      for (const blueprint of asList(layer.blueprints, "blueprints", mod)) {
        const id = Number(blueprint.blueprintTypeID);
        if (!out.types.some((type) => Number(type.typeID) === id && type.mod === mod.id)) {
          errors.push(`${mod.id}: blueprint ${id} has no type of its own in the layer`);
          continue;
        }
        if (tables.blueprint(id)) { errors.push(`${mod.id}: blueprint ${id} already exists in the game's own data`); continue; }
        if (!blueprint.cloneFrom || !tables.blueprint(blueprint.cloneFrom)) { errors.push(`${mod.id}: blueprint ${id} needs cloneFrom, a blueprint the game has`); continue; }
        if (!blueprint.definition || !blueprint.client || !blueprint.client.activities) { errors.push(`${mod.id}: blueprint ${id} needs a server definition and client activities`); continue; }
        out.blueprints.push({ ...blueprint, mod: mod.id });
      }
      const editable = new Set(((mod.reverie.edits && mod.reverie.edits.types) || []).map(Number));
      const mayEdit = (typeID) => {
        if (editable.has(typeID)) return true;
        const added = owner.types.get(typeID);
        return Boolean(added && (added === mod.id || requires.has(added.toLowerCase())));
      };
      for (const edit of asList(layer.typeEdits, "typeEdits", mod)) {
        const id = Number(edit.typeID);
        if (!mayEdit(id)) { errors.push(`${mod.id}: edits type ${id}, which it does not list in reverie.json edits.types`); continue; }
        if (!tables.itemType(id) && !owner.types.has(id)) { errors.push(`${mod.id}: edits type ${id}, which does not exist`); continue; }
        const current = typeEdits.get(id) || { typeID: id, client: {}, row: {}, dogma: { setAttributes: {}, removeAttributes: [], addEffects: [], removeEffects: [] }, skills: null, by: {} };
        for (const part of ["client", "row"]) {
          for (const [field, value] of Object.entries(edit[part] || {})) {
            const label = `${part}.${field}`;
            if (current.by[label] && current.by[label] !== mod.id && JSON.stringify(current[part][field]) !== JSON.stringify(value)) {
              notes.push(`type ${id} ${label}: ${mod.id} replaces ${current.by[label]}'s value`);
            }
            current[part][field] = value;
            current.by[label] = mod.id;
          }
        }
        const dogma = edit.dogma || {};
        for (const [attributeID, value] of Object.entries(dogma.setAttributes || {})) {
          current.dogma.setAttributes[String(attributeID)] = Number(value);
          current.dogma.removeAttributes = current.dogma.removeAttributes.filter((other) => Number(other) !== Number(attributeID));
        }
        for (const attributeID of dogma.removeAttributes || []) {
          delete current.dogma.setAttributes[String(attributeID)];
          if (!current.dogma.removeAttributes.includes(Number(attributeID))) current.dogma.removeAttributes.push(Number(attributeID));
        }
        for (const effectID of dogma.addEffects || []) {
          current.dogma.removeEffects = current.dogma.removeEffects.filter((other) => other !== Number(effectID));
          if (!current.dogma.addEffects.includes(Number(effectID))) current.dogma.addEffects.push(Number(effectID));
        }
        for (const effectID of dogma.removeEffects || []) {
          current.dogma.addEffects = current.dogma.addEffects.filter((other) => other !== Number(effectID));
          if (!current.dogma.removeEffects.includes(Number(effectID))) current.dogma.removeEffects.push(Number(effectID));
        }
        if (edit.skills) current.skills = { ...edit.skills };
        typeEdits.set(id, current);
      }
      for (const edit of asList(layer.blueprintEdits, "blueprintEdits", mod)) {
        const id = Number(edit.blueprintTypeID);
        if (!mayEdit(id)) { errors.push(`${mod.id}: edits blueprint ${id}, which it does not list in reverie.json edits.types`); continue; }
        if (!tables.blueprint(id)) { errors.push(`${mod.id}: edits blueprint ${id}, which the game does not have`); continue; }
        const current = blueprintEdits.get(id) || { blueprintTypeID: id, activities: {}, definition: {}, mods: [] };
        if (current.mods.length) notes.push(`blueprint ${id}: ${mod.id} edits it after ${current.mods.join(", ")}`);
        Object.assign(current.activities, edit.activities || {});
        Object.assign(current.definition, edit.definition || {});
        current.mods.push(mod.id);
        blueprintEdits.set(id, current);
      }
      for (const [key, text] of Object.entries(layer.messages || {})) {
        const id = Number(key);
        if (typeof text !== "string" || !text) { errors.push(`${mod.id}: message ${key} has no text`); continue; }
        if (claim("messages", id, "message", false)) out.messages[String(id)] = text;
      }
      for (const icon of asList(layer.icons, "icons", mod)) {
        const id = Number(icon.iconID);
        const resource = String(icon.resource || "").toLowerCase();
        if (!resource.startsWith("res:/") || !resource.endsWith(".png")) { errors.push(`${mod.id}: icon ${id} needs a res:/ .png resource`); continue; }
        if (owner.resources.has(resource)) { errors.push(`${mod.id}: icon resource ${icon.resource} is also used by ${owner.resources.get(resource)}`); continue; }
        const absolute = path.resolve(mod.dir, String(icon.file || ""));
        if (!absolute.startsWith(path.resolve(mod.dir) + path.sep) || !fs.existsSync(absolute)) { errors.push(`${mod.id}: icon ${id}'s file ${icon.file} is missing from the mod`); continue; }
        const png = fs.readFileSync(absolute);
        const isPng = png.length > 24 && png.readUInt32BE(0) === 0x89504e47 && png.toString("ascii", 12, 16) === "IHDR";
        if (!isPng || png.readUInt32BE(16) !== 64 || png.readUInt32BE(20) !== 64) { errors.push(`${mod.id}: ${icon.file} is not a 64 by 64 PNG`); continue; }
        if (!claim("icons", id, "icon", false)) continue;
        owner.resources.set(resource, mod.id);
        out.icons.push({ iconID: id, resource: icon.resource, file: path.relative(paths.repoRoot, absolute).split(path.sep).join("/"), sha256: sha256(png), mod: mod.id });
      }
      for (const stock of asList(layer.marketStock, "marketStock", mod)) {
        const id = Number(stock.typeID);
        const like = Number(stock.like);
        if (!mayEdit(id)) { errors.push(`${mod.id}: stocks type ${id} on the market, which it neither adds nor lists in edits.types`); continue; }
        const likeRow = tables.itemType(like);
        if (!likeRow) { errors.push(`${mod.id}: stocks type ${id} like ${stock.like}, which the game does not have`); continue; }
        const own = out.types.find((type) => Number(type.typeID) === id);
        const edited = typeEdits.get(id);
        const basePrice = Number(stock.basePrice) || Number(own && own.row && own.row.basePrice) ||
          Number(edited && edited.row.basePrice) || Number((tables.itemType(id) || {}).basePrice) || 0;
        const likeBasePrice = Number(likeRow.basePrice) || 0;
        if (!(basePrice > 0) || !(likeBasePrice > 0)) { errors.push(`${mod.id}: stocks type ${id} like ${like}, and one of them has no base price`); continue; }
        const taken = out.marketStock.find((other) => other.typeID === id);
        if (taken) { errors.push(`${mod.id}: type ${id} is already stocked by ${taken.mod}`); continue; }
        out.marketStock.push({ typeID: id, like, basePrice, likeBasePrice, mod: mod.id });
      }
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (layer.clientData !== undefined) out.clientData[mod.id] = layer.clientData;
    for (const script of (mod.reverie.client && mod.reverie.client.scripts) || []) {
      const absolute = path.resolve(mod.dir, script);
      if (!fs.existsSync(absolute)) { errors.push(`${mod.id}: client script ${script} is missing`); continue; }
      out.scripts.push({ mod: mod.id, file: script, sha256: sha256(fs.readFileSync(absolute)) });
    }
    out.mods.push({ id: mod.id, version: mod.version });
  }

  // Every attribute and effect the composed dogma uses must exist somewhere.
  const attributeKnown = (id) => Boolean(tables.attributeType(id)) || out.attributes.some((a) => Number(a.attributeID) === Number(id));
  const effectKnown = (id) => Boolean(tables.effectType(id)) || out.effects.some((e) => Number(e.effectID) === Number(id));
  for (const type of out.types) {
    if (!type.dogma) continue;
    for (const id of Object.keys(type.dogma.attributes || {})) if (!attributeKnown(id)) errors.push(`${type.mod}: type ${type.typeID} uses unknown attribute ${id}`);
    for (const id of type.dogma.effects || []) if (!effectKnown(id)) errors.push(`${type.mod}: type ${type.typeID} uses unknown effect ${id}`);
  }
  for (const edit of typeEdits.values()) {
    for (const id of Object.keys(edit.dogma.setAttributes)) if (!attributeKnown(id)) errors.push(`type ${edit.typeID}'s edit sets unknown attribute ${id}`);
    for (const id of edit.dogma.addEffects) if (!effectKnown(id)) errors.push(`type ${edit.typeID}'s edit adds unknown effect ${id}`);
  }
  out.typeEdits = [...typeEdits.values()].sort((a, b) => a.typeID - b.typeID);
  out.blueprintEdits = [...blueprintEdits.values()].sort((a, b) => a.blueprintTypeID - b.blueprintTypeID);
  return { layer: out, errors, notes, skipped };
}

function serialize(layer) {
  return Buffer.from(`${JSON.stringify(layer, null, 1)}\n`, "utf8");
}

// Writes _local/reverie/typeLayer.json when it changed; returns { bytes, sha256, changed }.
function save(layer) {
  const bytes = serialize(layer);
  const file = LAYER_FILE();
  const changed = !fs.existsSync(file) || !fs.readFileSync(file).equals(bytes);
  if (changed) writeFileAtomic(file, bytes);
  return { bytes, sha256: sha256(bytes), changed, file };
}

module.exports = { SCHEMA_VERSION, LAYER_FILE, compose, serialize, save, layerMods, inClaims, createTables };
