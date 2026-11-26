"use strict";
// Writes the composed type layer (client/compose.js) into an EVE client, and takes it out again.
//
// What it changes, each as a new file in ResFiles with the index line pointed at it:
//   res:/staticdata/{types,groups,dogmaattributes,dogmaeffects,typedogma,marketgroups,requiredskillsfortypes}.fsdbinary
//   res:/localizationfsd/localization_fsd_<language>.pickle    the layer's names and descriptions
//   res:/staticdata/blueprints.static                        recipes, and the product index
//   res:/staticdata/blueprintsbymaterialtypeids.pickle       which blueprints use a material
//   each icon's res:/ui/texture/icons/... png
//
// Every build starts from CCP's file, read back through the ledger when Reverie patched it
// before, so applying twice gives the same bytes and a layer with fewer mods leaves nothing behind.
// A resource the layer no longer needs gets CCP's line back. The ledger is
// _local/reverie/clientPatch.json. The client must be closed.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfsd = require("./cfsd");
const pickle = require("./pickle");
const paths = require("../lib/paths");
const { Indexes, md5, sha256, writeFileAtomic, clientIsRunning } = require("./resfiles");

const LEDGER_FILE = () => path.join(paths.reverieDir, "clientPatch.json");
const FSD = ["types", "groups", "dogmaattributes", "dogmaeffects", "typedogma", "marketgroups"];
const SKILLS = "requiredskillsfortypes";
const fsdResource = (name) => `res:/staticdata/${name}.fsdbinary`;
const localizationResource = (language) => `res:/localizationfsd/localization_fsd_${language}.pickle`;
const BLUEPRINTS = "res:/staticdata/blueprints.static";
const MATERIALS = "res:/staticdata/blueprintsbymaterialtypeids.pickle";

const clone = (value) => JSON.parse(JSON.stringify(value));

function readLedger() {
  const file = LEDGER_FILE();
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// CCP's line behind the current one, through the ledger.
function baseLine(indexes, ledger, resource, { optional = false } = {}) {
  const current = indexes.find(resource);
  if (!current) {
    if (optional) return null;
    throw new Error(`${resource} is not in the client's resource index.`);
  }
  const entry = ledger && ledger.resources && ledger.resources[resource];
  if (!entry) return current;
  if (current === entry.patched || current === entry.original) return entry.original;
  throw new Error(`${resource} was changed by another tool after Reverie patched it; restore that tool's patch first.`);
}

// ------------------------------------------------------------------ records

function withFields(schema, record, values, label) {
  const rec = clone(record);
  let bits = rec._bits >>> 0;
  for (const [name, value] of Object.entries(values)) {
    const field = schema.byName[name];
    if (!field) throw new Error(`${label}: the client has no field ${name}`);
    const present = value !== null && value !== undefined;
    rec[name] = present ? (field.kind === "bool" ? (value ? 1 : 0) : value) : (field.kind === "list" ? [] : field.kind === "str" ? "" : 0);
    if (field.opt) bits = present ? (bits | (1 << field.bit)) >>> 0 : (bits & ~(1 << field.bit)) >>> 0;
    else if (!present) throw new Error(`${label}: field ${name} is required`);
  }
  rec._bits = bits;
  return rec;
}

function attributeRecord(template, attribute) {
  const S = cfsd.SCHEMAS.dogmaattributes;
  const def = attribute.server || {};
  const values = {
    attributeID: Number(attribute.attributeID),
    name: String(def.name || def.attributeName || `attribute${attribute.attributeID}`),
    description: def.description ? String(def.description) : null,
    defaultValue: Number(def.defaultValue) || 0,
    published: def.published ? 1 : 0,
    stackable: def.stackable ? 1 : 0,
    highIsGood: def.highIsGood ? 1 : 0,
    dataType: Number(def.dataType) || template.dataType,
    displayWhenZero: def.displayWhenZero ? 1 : 0,
  };
  for (const name of ["unitID", "categoryID", "maxAttributeID", "minAttributeID", "chargeRechargeTimeID"]) {
    values[name] = def[name] ? Number(def[name]) : null;
  }
  // The template's icon; its own name and tooltip when the layer gives message IDs, else CCP's.
  values.iconID = template.iconID || null;
  if (attribute.nameMessageID) { values.displayNameID = Number(attribute.nameMessageID); values.tooltipTitleID = Number(attribute.nameMessageID); }
  if (attribute.tooltipMessageID) values.tooltipDescriptionID = Number(attribute.tooltipMessageID);
  return withFields(S, template, values, `attribute ${attribute.attributeID}`);
}

function modifierRecord(mod) {
  const present = [];
  const rec = { domain: String(mod.domain), func: String(mod.func) };
  for (const name of ["effectID", "groupID", "modifiedAttributeID", "modifyingAttributeID", "operation", "skillTypeID"]) {
    const value = mod[name];
    if (value === null || value === undefined) { rec[name] = 0; continue; }
    rec[name] = Number(value);
    present.push(name);
  }
  return { _bits: cfsd.bitsOf(cfsd.MODIFIER, present), domain: rec.domain, func: rec.func, effectID: rec.effectID,
    groupID: rec.groupID, modifiedAttributeID: rec.modifiedAttributeID, modifyingAttributeID: rec.modifyingAttributeID,
    operation: rec.operation, skillTypeID: rec.skillTypeID };
}

function effectRecord(effect) {
  const S = cfsd.SCHEMAS.dogmaeffects;
  const def = effect.server || {};
  const optionalIDs = ["iconID", "dischargeAttributeID", "durationAttributeID", "distribution", "rangeAttributeID",
    "falloffAttributeID", "trackingSpeedAttributeID", "resistanceAttributeID", "fittingUsageChanceAttributeID",
    "npcUsageChanceAttributeID", "npcActivationChanceAttributeID"];
  const present = ["modifierInfo"];
  const rec = {};
  for (const field of S.fields) rec[field.name] = field.kind === "str" ? "" : field.kind === "list" ? [] : 0;
  rec.effectName = String(def.name || def.effectName);
  rec.effectID = Number(effect.effectID);
  rec.effectCategory = Number(def.effectCategoryID ?? def.effectCategory) || 0;
  rec.modifierInfo = (def.modifierInfo || []).map(modifierRecord);
  for (const name of optionalIDs) {
    if (def[name] !== null && def[name] !== undefined) { rec[name] = Number(def[name]); present.push(name); }
  }
  for (const name of ["disallowAutoRepeat", "electronicChance", "isAssistance", "isOffensive", "isWarpSafe",
    "propulsionChance", "published", "rangeChance"]) rec[name] = def[name] ? 1 : 0;
  rec._bits = cfsd.bitsOf(S, present);
  const ordered = { _bits: rec._bits };
  for (const field of S.fields) ordered[field.name] = rec[field.name];
  return ordered;
}

const sortAttributes = (list) => list.sort((a, b) => a.attributeID - b.attributeID);

// The client's record for a server dogma record, keeping the template's effect flags.
function dogmaFromServer(template, server) {
  const attributes = sortAttributes(Object.entries(server.attributes || {}).map(([id, value]) => ({ value: Number(value), attributeID: Number(id) })));
  const flags = new Map(((template && template.dogmaEffects) || []).map((e) => [e.effectID, e.isDefault]));
  const effects = [...new Set((server.effects || []).map(Number))].map((effectID) => ({ effectID, isDefault: flags.get(effectID) || 0 }));
  return { dogmaAttributes: attributes, dogmaEffects: effects };
}

function editDogma(rec, edit) {
  const remove = new Set((edit.removeAttributes || []).map(Number));
  const set = new Map(Object.entries(edit.setAttributes || {}).map(([id, value]) => [Number(id), Number(value)]));
  const attributes = rec.dogmaAttributes.filter((a) => !remove.has(a.attributeID) && !set.has(a.attributeID));
  for (const [attributeID, value] of set) attributes.push({ value, attributeID });
  const removeEffects = new Set((edit.removeEffects || []).map(Number));
  const effects = rec.dogmaEffects.filter((e) => !removeEffects.has(e.effectID));
  for (const effectID of (edit.addEffects || []).map(Number)) {
    if (!effects.some((e) => e.effectID === effectID)) effects.push({ effectID, isDefault: 0 });
  }
  return { dogmaAttributes: sortAttributes(attributes), dogmaEffects: effects };
}

// ------------------------------------------------------------------ the static data files

function buildFsd(indexes, ledger, layer) {
  const originals = {};
  const decoded = {};
  for (const name of FSD) {
    const line = baseLine(indexes, ledger, fsdResource(name));
    const buffer = indexes.read(line);
    decoded[name] = cfsd.decode(buffer, cfsd.SCHEMAS[name]);
    if (!cfsd.encode(decoded[name]).equals(buffer)) {
      throw new Error(`The codec does not reproduce the client's ${name}.fsdbinary (a client update changed its layout?); nothing was written.`);
    }
    originals[name] = { line, buffer };
  }
  const before = Object.fromEntries(FSD.map((name) => [name, cfsd.decode(originals[name].buffer, cfsd.SCHEMAS[name])]));
  const changed = Object.fromEntries(FSD.map((name) => [name, new Set()]));
  const add = (name, key, rec) => {
    if (decoded[name].records.has(key)) throw new Error(`The client's ${name} already has ${key}; a mod's IDs clash with CCP's.`);
    cfsd.put(decoded[name], key, rec);
    changed[name].add(key);
  };
  const edit = (name, key, rec) => {
    if (!decoded[name].records.has(key)) throw new Error(`The client's ${name} has no ${key} to edit.`);
    cfsd.put(decoded[name], key, rec);
    changed[name].add(key);
  };
  const get = (name, key, why) => {
    const rec = decoded[name].records.get(Number(key));
    if (!rec) throw new Error(`The client's ${name} has no ${key} (${why}).`);
    return rec;
  };

  for (const group of layer.groups) {
    const source = get("groups", group.cloneFrom, `group ${group.groupID} copies it`);
    if (group.categoryID && source.categoryID !== Number(group.categoryID)) throw new Error(`group ${group.cloneFrom} is not in category ${group.categoryID}`);
    add("groups", Number(group.groupID), withFields(cfsd.SCHEMAS.groups, source, {
      groupID: Number(group.groupID), groupNameID: Number(group.nameMessageID),
      ...(group.iconID !== undefined ? { iconID: group.iconID } : {}),
    }, `group ${group.groupID}`));
  }
  const ownMarketGroups = new Set(layer.marketGroups.map((mg) => Number(mg.marketGroupID)));
  for (const mg of layer.marketGroups) {
    const source = get("marketgroups", mg.cloneFrom, `market group ${mg.marketGroupID} copies it`);
    if (!decoded.marketgroups.records.has(Number(mg.parentGroupID)) && !ownMarketGroups.has(Number(mg.parentGroupID))) {
      throw new Error(`market group ${mg.marketGroupID}'s parent ${mg.parentGroupID} does not exist`);
    }
    add("marketgroups", Number(mg.marketGroupID), withFields(cfsd.SCHEMAS.marketgroups, source, {
      nameID: Number(mg.nameMessageID), descriptionID: mg.descriptionMessageID ? Number(mg.descriptionMessageID) : null,
      iconID: mg.iconID || source.iconID || null, parentGroupID: Number(mg.parentGroupID), hasTypes: mg.hasTypes ? 1 : 0,
    }, `market group ${mg.marketGroupID}`));
  }
  for (const attribute of layer.attributes) {
    const template = get("dogmaattributes", attribute.cloneFrom, `attribute ${attribute.attributeID} copies it`);
    add("dogmaattributes", Number(attribute.attributeID), attributeRecord(template, attribute));
  }
  for (const effect of layer.effects) add("dogmaeffects", Number(effect.effectID), effectRecord(effect));

  const typeSchema = cfsd.SCHEMAS.types;
  for (const type of layer.types) {
    const source = get("types", type.cloneFrom, `type ${type.typeID} copies it`);
    add("types", Number(type.typeID), withFields(typeSchema, source, { ...(type.client || {}), typeID: Number(type.typeID) }, `type ${type.typeID}`));
  }
  for (const typeEdit of layer.typeEdits) {
    if (!Object.keys(typeEdit.client || {}).length) continue;
    const rec = get("types", typeEdit.typeID, "a mod edits it");
    edit("types", Number(typeEdit.typeID), withFields(typeSchema, rec, typeEdit.client, `type ${typeEdit.typeID}`));
  }
  for (const type of layer.types) {
    if (!type.dogma) continue;
    const template = decoded.typedogma.records.get(Number(type.cloneFrom)) || null;
    add("typedogma", Number(type.typeID), dogmaFromServer(template, type.dogma));
  }
  for (const typeEdit of layer.typeEdits) {
    const d = typeEdit.dogma || {};
    if (!Object.keys(d.setAttributes || {}).length && !(d.removeAttributes || []).length && !(d.addEffects || []).length && !(d.removeEffects || []).length) continue;
    edit("typedogma", Number(typeEdit.typeID), editDogma(get("typedogma", typeEdit.typeID, "a mod edits its dogma"), d));
  }
  for (const key of changed.typedogma) {
    const rec = decoded.typedogma.records.get(key);
    for (const a of rec.dogmaAttributes) if (!decoded.dogmaattributes.records.has(a.attributeID)) throw new Error(`type ${key} uses attribute ${a.attributeID}, which the client does not have`);
    for (const e of rec.dogmaEffects) if (!decoded.dogmaeffects.records.has(e.effectID)) throw new Error(`type ${key} uses effect ${e.effectID}, which the client does not have`);
  }

  const outputs = [];
  for (const name of FSD) {
    if (!changed[name].size) continue;
    const dec = decoded[name];
    const bytes = cfsd.encode(dec);
    const back = cfsd.decode(bytes, dec.schema);
    assert.strictEqual(back.records.size, dec.records.size, `${name}: record count`);
    assert.strictEqual(bytes.readBigUInt64LE(16), name === "types" || name === "typedogma" ? cfsd.checksum(bytes) : cfsd.checksumSlow(bytes), `${name}: checksum`);
    for (const key of changed[name]) assert.deepStrictEqual(back.records.get(key), dec.records.get(key), `${name} ${key} reads back differently`);
    for (const [key, rec] of before[name].records) {
      if (!changed[name].has(key)) assert.deepStrictEqual(back.records.get(key), rec, `${name} ${key} changed unexpectedly`);
    }
    assert(cfsd.encode(back).equals(bytes), `${name}: encoding is not stable`);
    outputs.push({ resource: fsdResource(name), original: originals[name].line, buffer: bytes, summary: `${changed[name].size} records` });
  }

  // Required skills, which the client checks fitting against.
  const wanted = new Map();
  for (const type of layer.types) if (type.skills && Object.keys(type.skills).length) wanted.set(Number(type.typeID), type.skills);
  for (const typeEdit of layer.typeEdits) if (typeEdit.skills) wanted.set(Number(typeEdit.typeID), typeEdit.skills);
  if (wanted.size) {
    const line = baseLine(indexes, ledger, fsdResource(SKILLS));
    const buffer = indexes.read(line);
    const dict = cfsd.decodeInnerDicts(buffer);
    if (!cfsd.encodeInnerDicts(dict).equals(buffer)) throw new Error("The codec does not reproduce the client's requiredskillsfortypes.fsdbinary; nothing was written.");
    const newTypes = new Set(layer.types.map((type) => Number(type.typeID)));
    for (const [typeID, skills] of wanted) {
      if (newTypes.has(typeID) && dict.entries.has(typeID)) throw new Error(`requiredskillsfortypes already has ${typeID}; a mod's IDs clash with CCP's.`);
      cfsd.putInnerDict(dict, typeID, Object.fromEntries(Object.entries(skills).map(([s, l]) => [String(s), Number(l)])));
    }
    const bytes = cfsd.encodeInnerDicts(dict);
    const afterSkills = cfsd.readInnerDicts(bytes);
    for (const [typeID, skills] of wanted) {
      const got = afterSkills.get(typeID);
      assert(got && got.length === Object.keys(skills).length, `required skills of ${typeID} missing`);
    }
    assert.strictEqual(bytes.readBigUInt64LE(16), cfsd.checksumSlow(bytes), "requiredskillsfortypes checksum");
    outputs.push({ resource: fsdResource(SKILLS), original: line, buffer: bytes, summary: `${wanted.size} types` });
  }
  return outputs;
}

// ------------------------------------------------------------------ names

function buildLocalization(indexes, ledger, layer, languages) {
  const messages = layer.messages || {};
  const ids = Object.keys(messages);
  if (!ids.length) return [];
  const outputs = [];
  for (const language of languages) {
    const resource = localizationResource(language);
    const line = baseLine(indexes, ledger, resource, { optional: language !== "en-us" });
    if (!line) continue;
    const buffer = indexes.read(line);
    const table = pickle.readMessages(buffer);
    const clash = ids.filter((id) => table.has(Number(id)));
    if (clash.length) throw new Error(`Message IDs ${clash.slice(0, 10).join(", ")} are already used in the client's ${language} names.`);
    // Every language gets the English text: a name in English reads better than a missing one.
    const bytes = pickle.addMessages(buffer, messages);
    if (pickle.readMessages(bytes).size !== table.size + ids.length) throw new Error(`${language} names: the count is wrong after writing.`);
    outputs.push({ resource, original: line, buffer: bytes, summary: `${ids.length} names` });
  }
  return outputs;
}

// ------------------------------------------------------------------ blueprints

function withSqlite(buffer, use) {
  const { DatabaseSync } = require("node:sqlite");
  const work = path.join(os.tmpdir(), `reverie-blueprints-${process.pid}-${Date.now()}.static`);
  fs.writeFileSync(work, buffer);
  let db = null;
  try {
    db = new DatabaseSync(work);
    const result = use(db);
    db.close();
    db = null;
    return { result, bytes: fs.readFileSync(work) };
  } finally {
    if (db) try { db.close(); } catch (_) { /* closed */ }
    for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(`${work}${suffix}`, { force: true });
  }
}

const productsOf = (activities) => [activities.manufacturing, activities.invention].filter(Boolean)
  .flatMap((activity) => (activity.products || []).map((product) => Number(product.typeID))).filter((id) => id > 0);
const inputsOf = (activities) => [activities.manufacturing, activities.invention].filter(Boolean)
  .flatMap((activity) => (activity.materials || []).map((material) => Number(material.typeID)));

function buildBlueprints(indexes, ledger, layer) {
  if (!layer.blueprints.length && !layer.blueprintEdits.length) return { outputs: [], touched: [] };
  const line = baseLine(indexes, ledger, BLUEPRINTS);
  const touched = []; // [{ id, activities }]
  const { bytes } = withSqlite(indexes.read(line), (db) => {
    const getRow = db.prepare("SELECT value, time FROM cache WHERE key = ?");
    const update = db.prepare("UPDATE cache SET value = ? WHERE key = ?");
    const insert = db.prepare("INSERT INTO cache (key, value, time) VALUES (?, ?, ?)");
    db.exec("BEGIN");
    for (const edit of layer.blueprintEdits) {
      const row = getRow.get(String(edit.blueprintTypeID));
      if (!row) throw new Error(`The client has no blueprint ${edit.blueprintTypeID} to edit.`);
      const value = JSON.parse(row.value);
      value.activities = value.activities || {};
      for (const [name, activity] of Object.entries(edit.activities || {})) {
        if (activity === null) delete value.activities[name];
        else value.activities[name] = clone(activity);
      }
      update.run(JSON.stringify(value), String(edit.blueprintTypeID));
      touched.push({ id: Number(edit.blueprintTypeID), activities: value.activities });
    }
    for (const blueprint of layer.blueprints) {
      const id = String(blueprint.blueprintTypeID);
      if (getRow.get(id)) throw new Error(`The client already has blueprint ${id}; a mod's IDs clash with CCP's.`);
      const client = blueprint.client || {};
      const template = getRow.get(String(blueprint.cloneFrom));
      if (!template) throw new Error(`The client has no blueprint ${blueprint.cloneFrom} to time blueprint ${id} by.`);
      insert.run(id, JSON.stringify({ activities: client.activities, blueprintTypeID: Number(id), maxProductionLimit: client.maxProductionLimit }), template.time);
      touched.push({ id: Number(id), activities: client.activities });
    }
    // The product index the client finds a type's blueprint by.
    const dropIndex = db.prepare("DELETE FROM indexes WHERE value = ?");
    const indexOwner = db.prepare("SELECT value FROM indexes WHERE key = ?");
    const addIndex = db.prepare("INSERT INTO indexes (key, value) VALUES (?, ?)");
    for (const { id } of touched) dropIndex.run(String(id));
    for (const { id, activities } of touched) {
      for (const typeID of productsOf(activities)) {
        const key = `productTypeID.${typeID}`;
        const owner = indexOwner.get(key);
        if (owner) throw new Error(`${key} already points at blueprint ${owner.value}; not adding ${id}.`);
        addIndex.run(key, String(id));
      }
    }
    db.exec("COMMIT");
  });
  // Read back.
  withSqlite(bytes, (db) => {
    for (const { id, activities } of touched) {
      const row = db.prepare("SELECT value FROM cache WHERE key = ?").get(String(id));
      assert(row, `blueprint ${id} is missing after writing`);
      assert.deepStrictEqual(JSON.parse(row.value).activities, JSON.parse(JSON.stringify(activities)), `blueprint ${id} reads back differently`);
      for (const typeID of productsOf(activities)) {
        const owner = db.prepare("SELECT value FROM indexes WHERE key = ?").get(`productTypeID.${typeID}`);
        assert(owner && Number(owner.value) === id, `productTypeID.${typeID} does not point at ${id}`);
      }
    }
  });
  const outputs = [{ resource: BLUEPRINTS, original: line, buffer: bytes, summary: `${touched.length} blueprints` }];

  // The materials index, rebuilt from CCP's: each touched blueprint under its own inputs only.
  const materialsLine = baseLine(indexes, ledger, MATERIALS, { optional: true });
  if (materialsLine) {
    const index = pickle.loads(indexes.read(materialsLine));
    if (!(index instanceof Map)) throw new Error("blueprintsbymaterialtypeids.pickle is not a dict");
    const ours = new Set(touched.map((t) => t.id));
    for (const [material, list] of [...index]) {
      const kept = list.filter((bp) => !ours.has(Number(bp)));
      if (kept.length) index.set(material, kept); else index.delete(material);
    }
    for (const { id, activities } of touched) {
      for (const material of [...new Set(inputsOf(activities))].sort((a, b) => a - b)) {
        if (!index.has(material)) index.set(material, []);
        index.get(material).push(id);
      }
    }
    const pickled = pickle.dumps(index);
    const back = pickle.loads(pickled);
    for (const { id, activities } of touched) {
      for (const material of inputsOf(activities)) assert((back.get(material) || []).includes(id), `blueprint ${id} missing under material ${material}`);
    }
    outputs.push({ resource: MATERIALS, original: materialsLine, buffer: pickled, summary: `${back.size} materials` });
  }
  return { outputs, touched };
}

// ------------------------------------------------------------------ icons

function buildIcons(indexes, ledger, layer) {
  return layer.icons.map((icon) => {
    const line = baseLine(indexes, ledger, icon.resource);
    indexes.read(line); // CCP's file is there and intact
    const buffer = fs.readFileSync(path.resolve(paths.repoRoot, icon.file));
    if (sha256(buffer) !== icon.sha256) throw new Error(`${icon.file} changed after the layer was composed; compose again.`);
    return { resource: icon.resource, original: line, buffer, summary: `icon ${icon.iconID}` };
  });
}

// ------------------------------------------------------------------ plan, apply, restore

function plan({ tq, layer, layerSha256, languages = ["en-us"] }) {
  const indexes = new Indexes(tq);
  const ledger = readLedger();
  if (ledger && ledger.client && path.resolve(ledger.client).toLowerCase() !== path.resolve(tq).toLowerCase()) {
    throw new Error(`Reverie's client patch is installed in ${ledger.client}; restore it there before patching ${tq}.`);
  }
  const outputs = [
    ...buildFsd(indexes, ledger, layer),
    ...buildLocalization(indexes, ledger, layer, languages),
    ...buildBlueprints(indexes, ledger, layer).outputs,
    ...buildIcons(indexes, ledger, layer),
  ];
  const wanted = new Set(outputs.map((o) => o.resource));
  const dropped = Object.entries((ledger && ledger.resources) || {}).filter(([resource]) => !wanted.has(resource))
    .map(([resource, entry]) => ({ resource, ...entry }));
  return { indexes, ledger, outputs, dropped, layerSha256, languages };
}

function apply(built, { dryRun = false, log = console.log } = {}) {
  const { indexes, outputs, dropped } = built;
  if (!dryRun && clientIsRunning(indexes.tq)) throw new Error("The EVE client is running; close every client first.");
  const resources = {};
  for (const output of outputs) {
    const patched = indexes.write(output.original, output.buffer, { dryRun });
    const current = indexes.find(output.resource);
    if (!dryRun) indexes.replace(current, patched);
    resources[output.resource] = { original: output.original, patched };
    log(`  ${output.resource}: ${output.summary}${current === patched ? " (unchanged)" : ""}`);
  }
  for (const entry of dropped) {
    const current = indexes.find(entry.resource);
    if (current === entry.patched && !dryRun) indexes.replace(current, entry.original);
    log(`  ${entry.resource}: back to the client's own file`);
  }
  if (dryRun) return { dryRun: true, resources };
  // The ledger first, so a failure after it still knows every original.
  const ledger = {
    schemaVersion: 1, client: indexes.tq, layerSha256: built.layerSha256, languages: built.languages,
    appliedAt: new Date().toISOString(), resources,
  };
  if (Object.keys(resources).length) writeFileAtomic(LEDGER_FILE(), `${JSON.stringify(ledger, null, 2)}\n`);
  indexes.save();
  if (!Object.keys(resources).length) fs.rmSync(LEDGER_FILE(), { force: true });
  return ledger;
}

// Every line Reverie changed goes back to the one it replaced. A line another tool changed
// since is left and reported.
function restore({ tq, dryRun = false, log = console.log } = {}) {
  const ledger = readLedger();
  if (!ledger) { log("  Reverie has not patched this client."); return { restored: 0, left: [] }; }
  const target = tq || ledger.client;
  const indexes = new Indexes(target);
  if (!dryRun && clientIsRunning(indexes.tq)) throw new Error("The EVE client is running; close every client first.");
  let restored = 0;
  const left = [];
  for (const [resource, entry] of Object.entries(ledger.resources || {})) {
    const current = indexes.find(resource);
    if (current === entry.original) continue;
    if (current !== entry.patched) { left.push(resource); log(`  ${resource}: changed by another tool since, left as it is`); continue; }
    if (!dryRun) indexes.replace(current, entry.original);
    restored += 1;
    log(`  ${resource}: the client's own file again`);
  }
  if (!dryRun) {
    indexes.save();
    if (!left.length) fs.rmSync(LEDGER_FILE(), { force: true });
    else writeFileAtomic(LEDGER_FILE(), `${JSON.stringify({ ...ledger, resources: Object.fromEntries(left.map((r) => [r, ledger.resources[r]])) }, null, 2)}\n`);
  }
  return { restored, left };
}

// What the client has now, against the ledger and a composed layer's hash.
function status({ tq, layerSha256 } = {}) {
  const ledger = readLedger();
  if (!ledger) return { installed: false, matchesLayer: false, lines: [] };
  const target = tq || ledger.client;
  let indexes = null;
  try { indexes = new Indexes(target); } catch (error) { return { installed: true, client: target, error: error.message, matchesLayer: false, lines: [] }; }
  const lines = Object.entries(ledger.resources || {}).map(([resource, entry]) => {
    const current = indexes.find(resource);
    return { resource, state: current === entry.patched ? "patched" : current === entry.original ? "original" : "changed by another tool" };
  });
  const inPlace = lines.every((l) => l.state === "patched");
  return { installed: true, client: ledger.client, appliedAt: ledger.appliedAt, layerSha256: ledger.layerSha256, inPlace,
    matchesLayer: Boolean(layerSha256) && ledger.layerSha256 === layerSha256 && inPlace, lines };
}

module.exports = { LEDGER_FILE, readLedger, plan, apply, restore, status, md5,
  _testing: { withFields, attributeRecord, effectRecord, dogmaFromServer, editDogma, buildFsd, buildLocalization, buildBlueprints } };
