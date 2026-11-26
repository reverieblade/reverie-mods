"use strict";
// The server's half of the composed type layer (client/compose.js): the same new types, groups,
// attributes, effects, dogma and blueprints the client patch writes, applied to the server's
// static tables as they load. It is on only while the client was patched with this exact layer
// (_local/reverie/clientPatch.json names the layer's sha-256), so the server never knows a type
// the client cannot show. REVERIE_TYPE_LAYER=server turns it on without a local client, for a
// server whose players patch their own clients from the same layer.
//
// Two hook points carry it, both text regions the core puts into game files at install:
//   data.staticTable          services/_shared/referenceData.js normalizePayload (every static table)
//   data.blueprintDefinitions services/industry/industryStaticData.js ensureBlueprintCache
//
// Files are read by mtime, so a new layer is picked up by the next table load. Tables already
// cached keep what they had until a restart or applyLive().

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const paths = require("./paths");

const OWNER = "reverie-core";
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function createTypeLayer({ hooks, log }) {
  const files = {
    layer: path.join(paths.reverieDir, "typeLayer.json"),
    ledger: path.join(paths.reverieDir, "clientPatch.json"),
  };
  let seen = null;
  let current = { active: false, reason: "not read yet", layer: null };

  function stamp(file) {
    try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch (_) { return "none"; }
  }

  function read() {
    const key = `${stamp(files.layer)}|${stamp(files.ledger)}|${process.env.REVERIE_TYPE_LAYER || ""}`;
    if (key === seen) return current;
    seen = key;
    try {
      if (!fs.existsSync(files.layer)) { current = { active: false, reason: "no type layer composed", layer: null }; return current; }
      const bytes = fs.readFileSync(files.layer);
      const layer = JSON.parse(bytes.toString("utf8"));
      const hash = sha256(bytes);
      const forced = process.env.REVERIE_TYPE_LAYER === "server";
      const ledger = fs.existsSync(files.ledger) ? JSON.parse(fs.readFileSync(files.ledger, "utf8")) : null;
      const matches = Boolean(ledger && ledger.layerSha256 === hash);
      current = matches || forced
        ? { active: true, reason: matches ? "the client has this layer" : "REVERIE_TYPE_LAYER=server", layer, sha256: hash, index: indexLayer(layer) }
        : { active: false, reason: ledger ? "the client was patched with another layer; run the client patch again" : "the client is not patched yet", layer: null, sha256: hash };
    } catch (error) {
      current = { active: false, reason: `could not read the type layer: ${error.message}`, layer: null };
    }
    return current;
  }

  function indexLayer(layer) {
    return {
      typeEdits: new Map((layer.typeEdits || []).map((edit) => [Number(edit.typeID), edit])),
      blueprintEdits: new Map((layer.blueprintEdits || []).map((edit) => [Number(edit.blueprintTypeID), edit])),
    };
  }

  function editedDogma(record, edit) {
    const attributes = { ...(record.attributes || {}) };
    for (const id of edit.removeAttributes || []) delete attributes[String(id)];
    for (const [id, value] of Object.entries(edit.setAttributes || {})) attributes[String(id)] = Number(value);
    const removed = new Set((edit.removeEffects || []).map(Number));
    const effects = (record.effects || []).map(Number).filter((id) => !removed.has(id));
    for (const id of (edit.addEffects || []).map(Number)) if (!effects.includes(id)) effects.push(id);
    return { ...record, attributes, attributeCount: Object.keys(attributes).length, effects, effectCount: effects.length };
  }

  function reshapeItemTypes(payload, state) {
    if (!Array.isArray(payload.types)) return payload;
    const { layer, index } = state;
    const rows = payload.types.map((row) => {
      const edit = index.typeEdits.get(Number(row && row.typeID));
      return edit && Object.keys(edit.row || {}).length ? { ...row, ...edit.row } : row;
    });
    const have = new Set(rows.map((row) => Number(row && row.typeID)));
    for (const type of layer.types || []) {
      if (!have.has(Number(type.typeID))) {
        const edit = index.typeEdits.get(Number(type.typeID));
        rows.push({ ...type.row, ...((edit && edit.row) || {}) });
      }
    }
    return { ...payload, types: rows };
  }

  function reshapeTypeDogma(payload, state) {
    if (!payload.typesByTypeID) return payload;
    const { layer } = state;
    const attributeTypesByID = { ...(payload.attributeTypesByID || {}) };
    for (const attribute of layer.attributes || []) attributeTypesByID[String(attribute.attributeID)] = { ...attribute.server };
    const effectTypesByID = { ...(payload.effectTypesByID || {}) };
    for (const effect of layer.effects || []) effectTypesByID[String(effect.effectID)] = JSON.parse(JSON.stringify(effect.server));
    const typesByTypeID = { ...payload.typesByTypeID };
    for (const type of layer.types || []) if (type.dogma) typesByTypeID[String(type.typeID)] = JSON.parse(JSON.stringify(type.dogma));
    for (const edit of layer.typeEdits || []) {
      const record = typesByTypeID[String(edit.typeID)];
      if (record && edit.dogma) typesByTypeID[String(edit.typeID)] = editedDogma(record, edit.dogma);
    }
    return { ...payload, attributeTypesByID, effectTypesByID, typesByTypeID };
  }

  function reshapeBlueprints(definitions, state) {
    if (!Array.isArray(definitions)) return definitions;
    const { layer, index } = state;
    const out = definitions.map((definition) => {
      const edit = index.blueprintEdits.get(Number(definition && definition.blueprintTypeID));
      if (!edit) return definition;
      const activities = { ...(definition.activities || {}) };
      for (const [name, activity] of Object.entries(edit.activities || {})) {
        if (activity === null) delete activities[name];
        else activities[name] = JSON.parse(JSON.stringify(activity));
      }
      return { ...definition, ...(edit.definition || {}), activities };
    });
    const have = new Set(out.map((definition) => Number(definition && definition.blueprintTypeID)));
    for (const blueprint of layer.blueprints || []) {
      if (!have.has(Number(blueprint.blueprintTypeID))) out.push(JSON.parse(JSON.stringify(blueprint.definition)));
    }
    return out;
  }

  const stats = { itemTypes: 0, typeDogma: 0, blueprints: 0 };
  function onStaticTable(payload, context) {
    const state = read();
    if (!state.active || !payload || typeof payload !== "object") return payload;
    const tableName = context && context.tableName;
    if (tableName === "itemTypes") { stats.itemTypes += 1; return reshapeItemTypes(payload, state); }
    if (tableName === "typeDogma") { stats.typeDogma += 1; return reshapeTypeDogma(payload, state); }
    return payload;
  }
  function onBlueprints(definitions) {
    const state = read();
    if (!state.active) return definitions;
    stats.blueprints += 1;
    return reshapeBlueprints(definitions, state);
  }

  hooks.on(OWNER, 0, "data.staticTable", onStaticTable);
  hooks.on(OWNER, 0, "data.blueprintDefinitions", onBlueprints);

  // With the server running: drop the cached tables so the next read takes the current layer, and
  // bump the generation the item type registry checks (the core's region in itemTypeRegistry.js),
  // so its index of types, new ones included, is built again at the next lookup.
  const GENERATION = Symbol.for("reverie.typeLayer.generation");
  function applyLive() {
    seen = null;
    const state = read();
    const out = { active: state.active, reason: state.reason, cleared: [] };
    try { require(path.join(paths.srcRoot, "services", "_shared", "referenceData")).clearReferenceCache(["itemTypes", "typeDogma"]); out.cleared.push("itemTypes", "typeDogma"); } catch (error) { out.referenceData = error.message; }
    try { require(path.join(paths.srcRoot, "services", "industry", "industryStaticData")).clearIndustryStaticCaches(); out.cleared.push("industryBlueprints"); } catch (error) { out.industry = error.message; }
    globalThis[GENERATION] = (Number(globalThis[GENERATION]) || 0) + 1;
    out.cleared.push("itemTypeRegistry");
    return out;
  }

  function status() {
    const state = read();
    const layer = state.layer;
    return {
      active: state.active, reason: state.reason, sha256: state.sha256 || null, applied: { ...stats },
      mods: layer ? layer.mods : [], types: layer ? (layer.types || []).length : 0, typeEdits: layer ? (layer.typeEdits || []).length : 0,
      blueprints: layer ? (layer.blueprints || []).length : 0,
      hookSites: { staticTable: stats.itemTypes + stats.typeDogma > 0, blueprints: stats.blueprints > 0 },
    };
  }

  // The composed layer for mods and scripts (null while off).
  function current_() { const state = read(); return state.active ? state.layer : null; }

  if (log && process.env.REVERIE_QUIET !== "1") {
    const state = read();
    if (state.layer || state.sha256) log.info(`type layer ${state.active ? "on" : "off"}: ${state.reason}`);
  }
  return { status, applyLive, layer: current_, read, _testing: { reshapeItemTypes, reshapeTypeDogma, reshapeBlueprints, editedDogma } };
}

module.exports = { createTypeLayer };
