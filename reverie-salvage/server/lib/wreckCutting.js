"use strict";

// Reverie Salvage (README.md): cutting lasers work a wreck's HP down; hull
// panels (small wrecks holding alloys) and containers (the wreck's salvage
// parts) come off as it goes, and at 0 HP the wreck is gone. A salvager takes
// a panel apart a chunk per successful cycle.
//
// Two kinds of wreck: native NPC wrecks (nativeNpcStore records) and wrecks
// that are plain inventory items (salvage contracts, derelicts, mission wrecks,
// ship kills). inventoryWreckCutting.js gives the second kind a stand-in hull
// and a record of the same shape, kept on the item's customInfo, so the same
// code cuts both; the few item-side steps branch on record.inventoryWreck.
//
// Hooks (server/index.js): patches on miningRuntime.resolveMiningActivation
// and executeMiningCycle hand a cutter's activation and cycles here (a cutter
// is a mining laser by dogma), the salvage.cycle hook point in
// salvagerRuntime.executeSalvagerCycle hands panels here, and the
// salvage.rewardEntries hook scales a wreck's hull alloys by the HP left on it.
//
// Hot reload: no module state. Everything lives on the wreck records
// (record.cutting on a wreck being cut, record.wreckPanel on a panel), so
// `node mods/reverie-core/cli.js reload reverie-salvage` takes effect on the
// next cycle. Tunables: EVEJS_CUT_* (lib/game.js).

const catalog = require("./cuttingLaserCatalog");
const { game, number: tunableNumber, layerModelTypes } = require("./game");

const SALVAGING_SKILL = 25863;
const SALVAGER_I = 25861;
const SALVAGER_II = 30836;
const PANEL_NAMES = Object.freeze({ common: "Hull Plating", rare: "Core Section" });
// m3 of alloy at or above which a panel is a medium / large wreck in space
const PANEL_SIZE_LIMITS = Object.freeze({ medium: 400, large: 4000 });
const PANEL_WRECK_TYPES = Object.freeze({ small: 26935, medium: 26934, large: 26933 });
// Successful salvager cycles a panel takes, by its size.
const PANEL_CHUNKS = Object.freeze({ small: 1, medium: 2, large: 3 });

// The mod's own files by name; game files under server/src through Reverie.
const OWN = Object.freeze({
  "space/npc/npcAlloyLoot": "./npcAlloyLoot",
  "services/salvage/salvageHoldRouting": "./salvageHoldRouting",
});
function src(relative) {
  return OWN[relative] ? require(OWN[relative]) : game(relative);
}

function store() {
  return src("space/npc/nativeNpcStore");
}

function tunable(name, fallback) {
  return tunableNumber(name, fallback);
}

// What salvagerRuntime hands to mods (edits/salvagerRuntime.exports.js).
function salvagerInternals() {
  return src("space/modules/salvagerRuntime").reverieInternals || {};
}

function toInt(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function typeOf(typeID) {
  return src("services/inventory/itemTypeRegistry").resolveItemByTypeID(Number(typeID)) || null;
}

function unitVolume(typeID) {
  const volume = Number((typeOf(typeID) || {}).volume);
  return volume > 0 ? volume : 1;
}

function alloyVolume(alloys) {
  let total = 0;
  for (const [typeID, quantity] of Object.entries(alloys || {})) total += Number(quantity) * unitVolume(typeID);
  return total;
}

function alloyUnits(alloys) {
  let total = 0;
  for (const quantity of Object.values(alloys || {})) total += Number(quantity) || 0;
  return total;
}

function skillLevel(skillMap, typeID) {
  const record = skillMap instanceof Map ? skillMap.get(Number(typeID)) : null;
  if (!record) return 0;
  return Math.max(0, Math.min(5, toInt(record.effectiveSkillLevel ?? record.trainedSkillLevel ?? record.skillLevel, 0)));
}

function characterOf(entity) {
  if (!entity) return 0;
  return toInt(
    entity.session && entity.session.characterID
      ? entity.session.characterID
      : entity.characterID ?? entity.pilotCharacterID,
    0,
  );
}

function skillMapOf(entity) {
  const characterID = characterOf(entity);
  if (characterID <= 0) return new Map();
  try {
    return src("services/skills/skillState").getCachedCharacterSkillMap(characterID);
  } catch (_) {
    return new Map();
  }
}

function sceneNow(scene, fallback) {
  const value = Number(fallback);
  if (Number.isFinite(value) && value > 0) return value;
  return scene && typeof scene.getCurrentSimTimeMs === "function" ? scene.getCurrentSimTimeMs() : Date.now();
}

// ---------------------------------------------------------------------------
// What can be cut, and what is a panel.

function isCutterModule(moduleItem) {
  return Boolean(moduleItem) && catalog.isCutterType(moduleItem.typeID);
}

function isCutterEffectState(effectState) {
  return Boolean(effectState) && catalog.isCutterType(effectState.typeID);
}

function panelRecordOf(entity) {
  if (!entity || entity.nativeNpcWreck !== true) return null;
  const record = store().getNativeWreck(toInt(entity.itemID, 0));
  return record && record.wreckPanel ? record : null;
}

function isPanelEntity(entity) {
  return Boolean(panelRecordOf(entity));
}

// m3 of alloy left on a panel entity (0 if it is not one).
function panelVolume(entity) {
  const record = panelRecordOf(entity);
  return record ? alloyVolume(record.wreckPanel.alloys) : 0;
}

function hullMineralsOf(record) {
  const sourceTypeID = toInt(record && record.sourceTypeID, 0);
  if (sourceTypeID <= 0) return null;
  const sourceType = typeOf(sourceTypeID) || {};
  return src("space/npc/npcAlloyLoot").hullMinerals(sourceTypeID, sourceType.groupName, sourceType.name);
}

function inventoryCut() {
  return require("./inventoryWreckCutting");
}

// An inventory wreck (salvage contracts, derelicts, mission wrecks, ship
// kills) as a native-shaped record with a stand-in hull, or null.
function inventoryRecordOf(entity) {
  if (!entity || entity.nativeNpcWreck === true) return null;
  try {
    return inventoryCut().recordOf(entity);
  } catch (_) {
    return null;
  }
}

// A native NPC wreck of a ship, not a panel, or an inventory wreck with its
// stand-in hull (inventoryWreckCutting.js).
function cuttableRecordOf(entity) {
  if (entity && entity.nativeNpcWreck !== true) {
    const inventoryRecord = inventoryRecordOf(entity);
    return inventoryRecord && hullMineralsOf(inventoryRecord) ? inventoryRecord : null;
  }
  if (!entity || entity.nativeNpcWreck !== true) return null;
  const record = store().getNativeWreck(toInt(entity.itemID, 0));
  if (!record || record.wreckPanel) return null;
  return hullMineralsOf(record) ? record : null;
}

function wreckMaxHP(entity, record) {
  return Math.max(cutFloorHP(entity, record), hullCutHP(record));
}

// The least HP a cutter works through. Frigate and destroyer wrecks use their
// own numbers (pilot goals, 2026-11-17, doc/SALVAGE.md) in place of the wreck
// type's structure (700 and 1000): with the HP exponent at 0.73 their hull
// metal is under that, and a destroyer wreck took longer than a frigate's
// for no more metal. Bigger hulls keep the wreck's structure as the floor.
const CUT_FLOOR_HP = Object.freeze({ frigate: 655, destroyer: 425 });
function cutFloorHP(entity, record) {
  const sourceType = typeOf(record && record.sourceTypeID) || {};
  let size = null;
  try {
    size = src("space/npc/npcAlloyLoot").classifySize(sourceType.groupName, sourceType.name);
  } catch (_) {
    size = null;
  }
  return CUT_FLOOR_HP[size] ?? wreckStructureHP(entity, record);
}

function wreckStructureHP(entity, record) {
  const live = Number(entity && (entity.structureHP ?? entity.maxStructureHP));
  if (live > 0) return live;
  try {
    const value = Number(src("services/fitting/liveFittingState").getTypeAttributeMap(record.typeID)?.[9]);
    if (value > 0) return value;
  } catch (_) {
    // fall through
  }
  return 700;
}

// The HP a cutter works through grows with the hull, not the wreck type (every
// battleship wreck has 3500 structure): a battleship is about 200 times the
// metal of a frigate. Measured by the hull's mineral volume against a
// destroyer's (1010 m3 = 1000 HP), to the power EVEJS_CUT_HP_EXPONENT: 1 keeps
// metal per HP the same on every hull, 0 leaves the wreck's own structure.
// The default 0.73 is the Scarlet server's, played since 2026-11-17 (a
// Tempest is about 25,000 HP instead of 83,000).
const CUT_HP_REFERENCE = Object.freeze({ m3: 1010, hp: 1000 });
const CUT_HP_EXPONENT = 0.73;
// The share of a hull's minerals a perfect cutter frees, also the Scarlet
// server's since 2026-11-17 (0.6 gave three times the metal played there).
const CUT_RECOVERY = 0.2;
function hullCutHP(record) {
  const exponent = Math.max(0, tunable("EVEJS_CUT_HP_EXPONENT", CUT_HP_EXPONENT));
  const minerals = exponent > 0 ? hullMineralsOf(record) : null;
  if (!minerals) return 0;
  const volume = Object.values(minerals).reduce((sum, quantity) => sum + (Number(quantity) || 0) * 0.01, 0);
  return volume > 0 ? Math.round(CUT_HP_REFERENCE.hp * (volume / CUT_HP_REFERENCE.m3) ** exponent) : 0;
}

// A wreck someone is cutting stays: each cut keeps it at least
// EVEJS_CUT_WRECK_HOLD_MINUTES from now (a lone cutter on a battleship takes hours).
function cutKeepUntil(nowMs, current) {
  const minutes = Math.max(0, tunable("EVEJS_CUT_WRECK_HOLD_MINUTES", 30));
  const existing = Number(current) || 0;
  if (!(minutes > 0) || !(existing > 0)) return existing || null;
  return Math.max(existing, nowMs + minutes * 60_000);
}

// Share of the hull left on a wreck: 1 untouched, 0 cut away.
function hullLeftShare(record) {
  if (!record) return 1;
  if (record.cutting && Number(record.cutting.hpMax) > 0) {
    return Math.max(0, Math.min(1, Number(record.cutting.hpLeft) / Number(record.cutting.hpMax)));
  }
  const damage = Number(record.conditionState && record.conditionState.damage);
  return Number.isFinite(damage) ? Math.max(0, Math.min(1, 1 - damage)) : 1;
}

// The hull left by the live entity's damage (guns shoot the entity, not the record).
function entityHullShare(entity) {
  const damage = Number(entity && entity.conditionState && entity.conditionState.damage);
  return Number.isFinite(damage) ? Math.max(0, Math.min(1, 1 - damage)) : 1;
}

// ---------------------------------------------------------------------------
// Activation (from miningRuntime.resolveMiningActivation).

function resolveCutActivation(scene, entity, moduleItem, effectRecord, options = {}, helpers = {}) {
  const targetID = toInt(options && options.targetID, 0);
  if (targetID <= 0) return { matched: true, success: false, errorMsg: "TARGET_REQUIRED" };
  const targetEntity = scene.getEntityByID(targetID);
  if (!targetEntity || (helpers.canEntitiesInteractLocally && !helpers.canEntitiesInteractLocally(entity, targetEntity))) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  if (!cuttableRecordOf(targetEntity)) {
    return { matched: true, success: false, errorMsg: "TARGET_INVALID_FOR_MODULE" };
  }
  const targets = helpers.getTargetsForEntity ? helpers.getTargetsForEntity(scene, entity) : [];
  if (!targets.includes(targetID)) return { matched: true, success: false, errorMsg: "TARGET_NOT_LOCKED" };

  const commandTimeMs = sceneNow(scene);
  const snapshot = helpers.buildEntityMiningSnapshot(entity, moduleItem, effectRecord, { nowMs: commandTimeMs });
  if (!snapshot) return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  const distance = helpers.getMiningCommandSurfaceDistance(scene, entity, targetEntity, commandTimeMs);
  const rangeDecision = {
    desiredRange: snapshot.maxRangeMeters,
    actualDistance: distance,
    graceMeters: 1,
    sampledAtSimTimeMs: commandTimeMs,
  };
  if (distance > snapshot.maxRangeMeters + 1) {
    return { matched: true, success: false, errorMsg: "TARGET_OUT_OF_RANGE", data: { rangeDecision } };
  }
  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      mineableState: null,
      runtimeAttrs: {
        capNeed: snapshot.capNeed,
        durationMs: snapshot.durationMs,
        durationAttributeID: snapshot.durationAttributeID,
        reactivationDelayMs: snapshot.reactivationDelayMs,
        maxGroupActive: snapshot.maxGroupActive,
        weaponFamily: null,
        miningSnapshot: snapshot,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The cutting state on a wreck record, made at the first cut.

// A Field Reclaimer's minerals are a share of what the salvaging route brings
// home from the same wreck (2026-11-18): a Hull Panel Cutter I's alloys, taken
// apart by a Salvager I (its common / core shares) and refined at a station
// (REFERENCE_REFINE: base 0.5, Scrapmetal Processing V, 5% tax). Rolled from
// the hull at the first cut, as the cutters' potentials are; the reclaimer's
// reach per band is its share of these. MINERAL_BASIS marks a potential made
// this way: one without it (raw hull minerals, before 2026-11-18) is made
// again at the reclaimer's next cycle.
const REFERENCE_REFINE = 0.5 * 1.1 * 0.95;
const MINERAL_BASIS = "careful+salvager-1";
// Salvager I's shares (recoveryShares below), from the module family.
function salvagerOneShares() {
  try {
    const salvager = require("./salvageModuleFamily").FAMILIES.find((family) => family.key === "salvager");
    if (salvager && salvager.shares && salvager.shares.t1) return salvager.shares.t1;
  } catch (_) { /* fall back */ }
  return { common: 0.85, rare: 0.7 };
}
function mineralPotentialOf(record, left, random = Math.random) {
  const minerals = hullMineralsOf(record);
  const recovery = Math.max(0, Math.min(1, tunable("EVEJS_CUT_RECOVERY", CUT_RECOVERY)));
  const out = {};
  if (!minerals || !(left > 0)) return out;
  const careful = catalog.PROFILES.careful;
  const shares = salvagerOneShares();
  const repro = src("services/reprocessing/reprocessingStaticData");
  for (const drop of src("space/npc/npcAlloyLoot").hullAlloys(minerals, recovery * left, random,
    (mineralTypeID) => catalog.mineralReach(careful, mineralTypeID))) {
    const share = catalog.isRareAlloy(drop.typeID) ? shares.rare : shares.common;
    for (const row of repro.getTypeMaterials(drop.typeID) || []) {
      const typeID = Number(row.materialTypeID);
      const quantity = Number(row.quantity) || 0;
      if (quantity > 0) out[typeID] = (out[typeID] || 0) + drop.quantity * share * quantity * REFERENCE_REFINE;
    }
  }
  return out;
}

function startCutting(entity, record, characterID, profile = null) {
  const random = Math.random;
  const minerals = hullMineralsOf(record);
  const hpMax = wreckMaxHP(entity, record);
  const left = Math.min(hullLeftShare(record), entityHullShare(entity));
  // The potential is what a perfect cutter would keep: the recovery share
  // of the hull's minerals as alloys, less what earlier damage destroyed.
  const recovery = Math.max(0, Math.min(1, tunable("EVEJS_CUT_RECOVERY", CUT_RECOVERY)));
  const potential = {};
  for (const drop of src("space/npc/npcAlloyLoot").hullAlloys(minerals, recovery * left, random)) {
    potential[drop.typeID] = (potential[drop.typeID] || 0) + drop.quantity;
  }
  // The first cutter on a wreck sets how many of its salvage parts survive:
  // a careful cut or a breach keeps more, a Wreck Breaker ruins half.
  const factorValue = Number(profile && profile.partsFactor);
  const partsFactor = Number.isFinite(factorValue) && factorValue >= 0 ? factorValue : 1;
  // The wreck's salvage parts, rolled once and handed out in the containers.
  let salvage = [];
  try {
    salvage = salvagerInternals().buildSalvageRewardEntries(
      { ...entity },
      { skipHullAlloys: true },
    ).map((entry) => ({ itemType: toInt(entry.itemType, 0), quantity: toInt(entry.quantity, 0) }))
      .filter((entry) => entry.itemType > 0 && entry.quantity > 0);
  } catch (_) {
    salvage = [];
  }
  if (partsFactor !== 1) {
    salvage = salvage.map((entry) => {
      const quantity = entry.quantity * partsFactor;
      return { ...entry, quantity: Math.floor(quantity) + (random() < quantity % 1 ? 1 : 0) };
    }).filter((entry) => entry.quantity > 0);
  }
  return {
    hpMax,
    // The hull share at the first cut: every cutter's potential is taken
    // from it (cutPotential), whichever cutter comes first.
    left,
    hpLeft: hpMax * left,
    // The potential above is already what earlier damage left, so each cut
    // frees its share of the HP there was at the first cut (hpStart), not of
    // hpMax: against hpMax the damage would count twice (a wreck at half hull
    // gave a quarter of its metal).
    hpStart: hpMax * left,
    potential,
    potentialUnits: alloyUnits(potential),
    carry: {},
    minerals: mineralPotentialOf(record, left, random),
    mineralBasis: MINERAL_BASIS,
    mineralCarry: {},
    partsFactor,
    salvage,
    containersDropped: 0,
    panels: 0,
    cutByCharacterID: characterID,
    startedAtMs: Date.now(),
  };
}

function reachOf(profile, typeID) {
  return catalog.isRareAlloy(typeID) ? profile.rareReach : profile.commonReach;
}

// A cutter that frees metal by mineral band (catalog.reachesByMineral): the
// alloys its reach makes of the hull at the first cut, kept on the wreck per
// reach (each tier of each cutter has its own), so later cuts with it add
// their share of the same numbers. null for older profiles, which keep a
// share of each alloy in cutting.potential instead.
function cutPotential(cutting, record, profile) {
  if (!catalog.reachesByMineral(profile)) return null;
  const key = [profile.commonReach, profile.midReach, profile.rareReach].map(Number).join("/");
  cutting.potentials = cutting.potentials || {};
  if (cutting.potentials[key]) return cutting.potentials[key];
  const minerals = hullMineralsOf(record) || {};
  const recovery = Math.max(0, Math.min(1, tunable("EVEJS_CUT_RECOVERY", CUT_RECOVERY)));
  const startLeft = Number(cutting.left);
  const left = Number.isFinite(startLeft)
    ? startLeft
    : (cutting.hpMax > 0 ? Math.min(1, (Number(cutting.hpStart) || cutting.hpMax) / cutting.hpMax) : 1);
  const potential = {};
  for (const drop of src("space/npc/npcAlloyLoot").hullAlloys(minerals, recovery * left, Math.random,
    (mineralTypeID) => catalog.mineralReach(profile, mineralTypeID))) {
    potential[drop.typeID] = (potential[drop.typeID] || 0) + drop.quantity;
  }
  cutting.potentials[key] = potential;
  return potential;
}

// Nocxium, Zydrine, Megacyte and Morphite are the core minerals, as the core
// alloys are the ones keyed on them.
const RARE_MINERALS = new Set([38, 39, 40, 11399]);
function mineralReachOf(profile, typeID) {
  // A three-band profile (the Field Reclaimer since 2026-11-18) reaches by band.
  if (catalog.reachesByMineral(profile)) return catalog.mineralReach(profile, typeID);
  return RARE_MINERALS.has(Number(typeID)) ? profile.rareReach : profile.commonReach;
}

function expectedKeptVolume(profile, potential) {
  let total = 0;
  for (const [typeID, quantity] of Object.entries(potential || {})) {
    total += Number(quantity) * reachOf(profile, typeID) * unitVolume(typeID);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Panels.

function panelSize(volume) {
  if (volume >= PANEL_SIZE_LIMITS.large) return "large";
  if (volume >= PANEL_SIZE_LIMITS.medium) return "medium";
  return "small";
}

// A panel is one of the debris-model panel types (catalog.PANEL_TYPES) at a
// radius from its volume, which salvage.py scales the model to. Those types
// need the type layer's client edits (their name and debris model), so while
// the client lacks the layer a panel is the plain small, medium or large
// wreck at the parent's radius.
function panelLook(size, kind, volume) {
  const modelled = layerModelTypes();
  const choices = catalog.panelTypesOfKind(kind).filter((typeID) => modelled.has(typeID));
  if (choices.length > 0) {
    const pick = typeOf(choices[Math.floor(Math.random() * choices.length)]);
    if (pick) return { type: pick, radius: catalog.panelRadius(volume) };
  }
  const type = typeOf(PANEL_WRECK_TYPES[size]) || typeOf(PANEL_WRECK_TYPES.small);
  return type ? { type, radius: null } : null;
}

function offsetPosition(position, radius) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const distance = Math.max(0, Number(radius) || 0) + 150 + Math.random() * 450;
  return {
    x: Number(position && position.x || 0) + distance * Math.sin(phi) * Math.cos(theta),
    y: Number(position && position.y || 0) + distance * Math.sin(phi) * Math.sin(theta),
    z: Number(position && position.z || 0) + distance * Math.cos(phi),
  };
}

// Takes the whole units out of carry (up to `ratio` of each) into a panel.
function takeFromCarry(carry, ratio) {
  const alloys = {};
  for (const [typeID, quantity] of Object.entries(carry)) {
    const units = Math.floor(Number(quantity) * Math.min(1, ratio) + 1e-9);
    if (units <= 0) continue;
    alloys[typeID] = units;
    carry[typeID] = Number(quantity) - units;
  }
  return alloys;
}

function spawnPanel(scene, wreckEntity, wreckRecord, alloys, profileKey, nowMs) {
  const units = alloyUnits(alloys);
  if (units <= 0) return null;
  const volume = alloyVolume(alloys);
  const size = panelSize(volume);
  let rareUnits = 0;
  for (const [typeID, quantity] of Object.entries(alloys)) if (catalog.isRareAlloy(typeID)) rareUnits += quantity;
  // 15% core alloy by units makes it a core section: core alloys are worth
  // far more, and a Precision cutter's panels come out at about 20%.
  const kind = rareUnits >= units * 0.15 ? "rare" : "common";
  const look = panelLook(size, kind, volume);
  if (!look) return null;
  const wreckType = look.type;
  const sourceType = typeOf(wreckRecord.sourceTypeID) || {};
  const itemName = `${sourceType.name || "Ship"} ${PANEL_NAMES[kind]}`;
  const transient = wreckRecord.transient === true;
  const allocated = store().allocateWreckID({ transient });
  const panelID = toInt(allocated && allocated.success ? allocated.data : 0, 0);
  if (panelID <= 0) return null;
  const position = offsetPosition(wreckEntity.position || wreckRecord.position, wreckEntity.radius);
  const record = {
    ...JSON.parse(JSON.stringify(wreckRecord)),
    wreckID: panelID,
    typeID: toInt(wreckType.typeID, 0),
    groupID: toInt(wreckType.groupID, 0),
    categoryID: toInt(wreckType.categoryID, 0),
    itemName,
    sourceTypeID: 0,
    launcherID: toInt(wreckRecord.wreckID, 0),
    position,
    targetPoint: { ...position },
    velocity: { x: 0, y: 0, z: 0 },
    mode: "STOP",
    speedFraction: 0,
    ...(look.radius ? { radius: look.radius } : {}),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + src("services/inventory/spaceDebrisState").getSpaceDebrisLifetimeMs(),
    conditionState: { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 0, incapacitated: false },
    wreckPanel: {
      kind,
      size,
      profile: profileKey,
      sourceTypeID: toInt(wreckRecord.sourceTypeID, 0),
      fromWreckID: toInt(wreckRecord.wreckID, 0),
      alloys: { ...alloys },
      initial: { ...alloys },
      chunks: PANEL_CHUNKS[size],
    },
  };
  // A panel is not the death of anything: no birth-owner restore keys.
  delete record.cutting;
  delete record.miningCargoTransferKey;
  delete record.incursionDeathEventID;
  delete record.nativeDeathEntityID;
  delete record.sourceEntityID;
  delete record.inventoryWreck;
  const stored = store().upsertNativeWreck(record, { transient });
  if (!stored || stored.success === false) return null;
  const spawned = src("space/npc/nativeNpcWreckService").spawnNativeWreck(scene.systemID, panelID, {
    scene,
    broadcast: true,
    broadcastOptions: { freshAcquire: true },
  });
  if (!spawned || spawned.success === false) {
    store().removeNativeWreckCascade(panelID);
    return null;
  }
  return { panelID, itemName, size, kind, volume };
}

// ---------------------------------------------------------------------------
// Containers with the wreck's salvage parts.

// Puts an inventory item (a container) into the scene. The scene object has
// no spawner of its own; the space runtime does.
function spawnInventoryEntity(scene, itemID) {
  try {
    return src("space/runtime").spawnDynamicInventoryEntity(scene.sceneDescriptor || scene.systemID, itemID, {
      sceneDescriptor: scene.sceneDescriptor || undefined,
      broadcast: true,
      broadcastOptions: { freshAcquire: true },
    });
  } catch (error) {
    return { success: false, errorMsg: error.message };
  }
}

// options.withWreckCargo: the wreck's own cargo goes into the container too
// (a Hold Breacher), and the wreck shows as empty after.
function spawnSalvageContainer(scene, wreckEntity, wreckRecord, entries, ownerID, nowMs, options = {}) {
  const wreckID = toInt(wreckRecord && wreckRecord.wreckID, 0);
  const inventoryWreck = Boolean(wreckRecord && wreckRecord.inventoryWreck === true);
  const withCargo = options.withWreckCargo === true && (inventoryWreck
    ? inventoryCut().cargoOf(wreckID).length > 0
    : store().listNativeWreckItemsForWreck(wreckID).length > 0);
  if ((!entries.length && !withCargo) || ownerID <= 0) return null;
  const itemStore = src("services/inventory/itemStore");
  const lookup = src("services/inventory/itemTypeRegistry").resolveItemByName("Cargo Container");
  const containerType = lookup && lookup.success ? lookup.match : null;
  if (!containerType) return null;
  const position = offsetPosition(wreckEntity.position || wreckRecord.position, wreckEntity.radius);
  const scope = src("space/destiny/identity/interactionScope.js").buildChildEntityScopeMetadata({ ...wreckRecord, ...wreckEntity });
  const created = itemStore.createSpaceItemForOwner(ownerID, toInt(wreckRecord.systemID, scene.systemID), containerType, {
    ...scope,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    targetPoint: { ...position },
    mode: "STOP",
    speedFraction: 0,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + src("services/inventory/spaceDebrisState").getSpaceDebrisLifetimeMs(),
    launcherID: toInt(wreckRecord.wreckID, 0),
  });
  if (!created || !created.success || !created.data) return null;
  const containerID = toInt(created.data.itemID, 0);
  const granted = entries.length
    ? itemStore.grantItemsToCharacterLocation(ownerID, containerID, itemStore.ITEM_FLAGS.HANGAR, entries)
    : { success: true };
  if (!granted || !granted.success) {
    try { itemStore.removeInventoryItem(containerID, { removeContents: true }); } catch (_) { /* best effort */ }
    return null;
  }
  const spawned = spawnInventoryEntity(scene, containerID);
  if (!spawned || !spawned.success) {
    // Out of the scene it could never be opened: take it back.
    try { itemStore.removeInventoryItem(containerID, { removeContents: true }); } catch (_) { /* best effort */ }
    return null;
  }
  if (withCargo) {
    // Moved once the container is in space, so a failed spawn never loses the
    // cargo. The custody move grants everything before it retires any source
    // row; on a failure the cargo stays on the wreck.
    const moved = inventoryWreck
      ? inventoryCut().moveCargo(wreckID, containerID)
      : src("services/inventory/salvageItemCustody").transferNativeWreckLootToContainer(wreckRecord, containerID, ownerID);
    if (!moved || !moved.success) {
      src("utils/logger").warn(`[WreckCutting] breach of wreck ${wreckID}: cargo not moved (${moved && moved.errorMsg})`);
    } else if (!inventoryWreck) {
      // (an inventory wreck's contents follow the item store: nothing to refresh)
      try {
        src("space/npc/nativeNpcWreckService").refreshNativeWreckRuntimeEntity(scene.systemID, wreckID, { scene, broadcast: true });
      } catch (_) {
        // the wreck shows as full until its next refresh
      }
    }
  }
  return containerID;
}

// Splits the salvage roll over the containers: container k of n gets every
// n-th stack from k, the last one everything left.
function salvageShare(cutting, index, steps) {
  const left = cutting.salvage || [];
  if (index >= steps - 1) {
    cutting.salvage = [];
    return left;
  }
  const share = [];
  const keep = [];
  left.forEach((entry, position) => ((position % (steps - index)) === 0 ? share : keep).push(entry));
  cutting.salvage = keep;
  return share;
}

// ---------------------------------------------------------------------------
// The wreck at 0 HP.

function finishWreck(scene, wreckEntity, wreckID, nowMs) {
  if (wreckEntity && wreckEntity.nativeNpcWreck !== true) {
    return inventoryCut().finish(scene, wreckEntity, wreckID, nowMs, spawnInventoryEntity);
  }
  const salvager = salvagerInternals();
  if (store().listNativeWreckItemsForWreck(wreckID).length > 0) {
    // Its cargo goes into a container where it was, as when a salvager
    // finishes a wreck that still holds loot.
    const replaced = salvager.replaceNativeWreckWithLootContainer(scene, wreckEntity, nowMs, {});
    if (replaced && replaced.success && replaced.container) {
      const spawned = spawnInventoryEntity(scene, replaced.container.itemID);
      if (!spawned || !spawned.success) {
        src("utils/logger").warn(`[WreckCutting] loot container ${replaced.container.itemID} of wreck ${wreckID} not spawned: ${spawned && spawned.errorMsg}`);
      }
      salvager.removeSalvageSceneEntity(scene, wreckID);
      return true;
    }
  }
  const removed = src("space/npc/nativeNpcWreckService").destroyNativeWreck(wreckID, { scene, broadcast: true, nowMs });
  return Boolean(removed && removed.success);
}

function broadcastDamage(scene, entity, damage) {
  entity.conditionState = { ...(entity.conditionState || {}), damage };
  try {
    src("space/runtime/shipHealthState").broadcastDamageStateChange(scene, entity);
  } catch (_) {
    // the client shows the old damage until the next refresh
  }
}

// A Field Reclaimer's minerals (options.grant): whole units into the hold,
// core minerals first, as far as there is room; the rest waits for the next
// cycle. When the wreck is done (options.done) whatever is left, also from a
// reclaimer used earlier on it, goes into a container beside it.
function wholeUnits(carry) {
  const out = [];
  for (const [typeID, quantity] of Object.entries(carry || {})) {
    const units = Math.floor(Number(quantity) + 1e-9);
    if (units > 0) out.push({ itemType: Number(typeID), quantity: units });
  }
  return out;
}

// Where a Field Reclaimer's minerals go, in order: the ship's mineral hold (flag 136) when it
// has one, then the hold the mining runtime names for minerals (the cargo hold on most ships).
const MINERAL_HOLD_FLAG = 136;
function reclaimRooms(entity, helpers) {
  const rooms = [];
  const fallback = helpers.holdRoom(entity, 34);
  // A native NPC has no fitted holds; its cargo is unlimited.
  if (helpers.holdSpace && Number.isFinite(Number(fallback.availableVolume))) {
    const space = helpers.holdSpace(entity, MINERAL_HOLD_FLAG);
    if (space && space.capacity > 0 && fallback.flagID !== MINERAL_HOLD_FLAG) {
      rooms.push({ flagID: MINERAL_HOLD_FLAG, availableVolume: space.available });
    }
  }
  rooms.push(fallback);
  return rooms;
}

function reclaimToHold(scene, entity, wreckEntity, record, cutting, characterID, nowMs, helpers, options = {}) {
  const carry = cutting.mineralCarry || {};
  const whole = wholeUnits(carry);
  if (!whole.length) return null;
  const granted = [];
  if (options.grant && helpers.grantToHold && helpers.holdRoom) {
    // The mineral hold first (the reclaimer brings one of its own, salvageModuleFamily.js
    // `bay`), then the hold the minerals went to before, which is the cargo hold on most ships.
    const order = [...whole].sort((a, b) =>
      (RARE_MINERALS.has(b.itemType) ? 1 : 0) - (RARE_MINERALS.has(a.itemType) ? 1 : 0))
      .map((entry) => ({ ...entry }));
    for (const room of reclaimRooms(entity, helpers)) {
      let free = Math.max(0, Number(room.availableVolume) || 0);
      const fitting = [];
      for (const entry of order) {
        const each = unitVolume(entry.itemType);
        const units = Number.isFinite(free) ? Math.min(entry.quantity, Math.floor((free + 1e-6) / each)) : entry.quantity;
        if (units <= 0) continue;
        fitting.push({ itemType: entry.itemType, quantity: units });
        free -= units * each;
      }
      if (!fitting.length) continue;
      const result = helpers.grantToHold(entity, room.flagID, fitting);
      if (!(result && result.success)) continue;
      for (const entry of fitting) {
        carry[entry.itemType] = Number(carry[entry.itemType]) - entry.quantity;
        order.find((left) => left.itemType === entry.itemType).quantity -= entry.quantity;
        const before = granted.find((done) => done.itemType === entry.itemType);
        if (before) before.quantity += entry.quantity; else granted.push({ ...entry });
      }
    }
  }
  let containerID = null;
  if (options.done) {
    const left = wholeUnits(carry);
    if (left.length) containerID = spawnSalvageContainer(scene, wreckEntity, record, left, characterID, nowMs);
    cutting.mineralCarry = {};
  }
  return { granted, containerID };
}

// ---------------------------------------------------------------------------
// One cycle (from miningRuntime.executeMiningCycle).

function executeCutCycle(scene, entity, effectState, cycleBoundaryMs, options = {}, helpers = {}) {
  const efficiency = Math.min(1, Math.max(0, Number(options.efficiency ?? 1)));
  if (!(efficiency > 0)) return { success: false, stopReason: "cycle" };
  const profile = catalog.profileForType(effectState.typeID);
  if (!profile) return { success: false, stopReason: "module" };
  const targetID = toInt(effectState.targetID, 0);
  const targetEntity = scene.getEntityByID(targetID);
  const record = cuttableRecordOf(targetEntity);
  if (!record || (helpers.canEntitiesInteractLocally && !helpers.canEntitiesInteractLocally(entity, targetEntity))) {
    return { success: false, stopReason: "target" };
  }
  const targets = helpers.getTargetsForEntity ? helpers.getTargetsForEntity(scene, entity) : [];
  if (!targets.includes(targetID)) return { success: false, stopReason: "target" };
  const snapshot = options.preparedCycle && options.preparedCycle.snapshot;
  if (snapshot && helpers.getMiningCommandSurfaceDistance &&
      helpers.getMiningCommandSurfaceDistance(scene, entity, targetEntity, cycleBoundaryMs) > snapshot.maxRangeMeters + 1) {
    return { success: false, stopReason: "range" };
  }

  const reclaim = profile.mode === "reclaim";
  if (reclaim && helpers.holdRoom && !reclaimRooms(entity, helpers).some((room) => room.availableVolume > 0)) {
    return { success: false, stopReason: "cargo" };
  }

  const nowMs = sceneNow(scene, cycleBoundaryMs);
  const characterID = characterOf(entity);
  // Panels cut off an inventory wreck (a contract field, a derelict) are the
  // cutter's, as the salvage containers are.
  if (record.inventoryWreck && characterID > 0) record.ownerID = characterID;
  const cutting = record.cutting || startCutting(targetEntity, record, characterID, profile);
  // HP shot off since the last cut is gone, and the metal in it with it: only
  // a cut frees alloy, so lowering hpLeft here loses that share.
  cutting.hpLeft = Math.min(cutting.hpLeft, cutting.hpMax * entityHullShare(targetEntity));
  const skill = skillLevel(skillMapOf(entity), SALVAGING_SKILL);
  const speed = Math.max(0, tunable("EVEJS_CUT_SPEED", 1));
  const cut = Math.min(cutting.hpLeft, profile.hpPerCycle * (1 + 0.05 * skill) * speed * efficiency);
  // `fraction` is the share of the potential this cut loosens: of the HP the
  // wreck had when the potential was taken (hpStart), so the shares of all
  // cuts add up to the whole potential at 0 HP. HP shot off in between is
  // never cut, and its share is lost. Wrecks first cut before hpStart existed
  // keep counting against hpMax.
  const base = Number(cutting.hpStart) > 0 ? Number(cutting.hpStart) : cutting.hpMax;
  const fraction = base > 0 ? Math.min(1, cut / base) : 1;
  if (reclaim) {
    // A Field Reclaimer frees minerals, not alloys (a wreck cut before this
    // change has no mineral potential yet: it gets one from the hull left,
    // counted against the HP left now).
    if (!cutting.minerals || cutting.mineralBasis !== MINERAL_BASIS) {
      cutting.minerals = mineralPotentialOf(record, cutting.hpMax > 0 ? cutting.hpLeft / cutting.hpMax : 1);
      cutting.mineralBasis = MINERAL_BASIS;
      cutting.mineralHpStart = cutting.hpLeft;
    }
    const mineralBase = Number(cutting.mineralHpStart) > 0 ? Number(cutting.mineralHpStart) : base;
    const mineralFraction = mineralBase > 0 ? Math.min(1, cut / mineralBase) : 1;
    cutting.mineralCarry = cutting.mineralCarry || {};
    for (const [typeID, quantity] of Object.entries(cutting.minerals)) {
      cutting.mineralCarry[typeID] = (Number(cutting.mineralCarry[typeID]) || 0) + Number(quantity) * mineralFraction * mineralReachOf(profile, typeID);
    }
  } else {
    // By band, the cutter's own potential already holds its reach.
    const own = cutPotential(cutting, record, profile);
    for (const [typeID, quantity] of Object.entries(own || cutting.potential)) {
      cutting.carry[typeID] = (Number(cutting.carry[typeID]) || 0) + Number(quantity) * fraction * (own ? 1 : reachOf(profile, typeID));
    }
  }
  cutting.hpLeft = Math.max(0, cutting.hpLeft - cut);
  const done = cutting.hpLeft <= 1e-6;

  const reclaimed = reclaim || done
    ? reclaimToHold(scene, entity, targetEntity, record, cutting, characterID, nowMs, helpers, { grant: reclaim, done })
    : null;

  const ownPotential = reclaim ? null : cutPotential(cutting, record, profile);
  const keptVolume = ownPotential ? alloyVolume(ownPotential) : expectedKeptVolume(profile, cutting.potential);
  const panelTarget = Math.max(1, keptVolume / catalog.panelCount(profile, cutting.potentialUnits));
  const panels = [];
  let guard = 0;
  // A reclaimer makes no panels; alloys an earlier cutter freed still come
  // off when the wreck is done.
  while (guard++ < 20 && (!reclaim || done)) {
    const carried = alloyVolume(cutting.carry);
    if (!done && carried < panelTarget) break;
    if (done && alloyUnits(Object.fromEntries(Object.entries(cutting.carry).map(([k, v]) => [k, Math.floor(v + 1e-9)]))) <= 0) break;
    const alloys = takeFromCarry(cutting.carry, done ? 1 : panelTarget / carried);
    if (alloyUnits(alloys) <= 0) break;
    const panel = spawnPanel(scene, targetEntity, record, alloys, profile.key, nowMs);
    if (!panel) {
      // Put it back; the next cycle tries again.
      for (const [typeID, units] of Object.entries(alloys)) cutting.carry[typeID] = (cutting.carry[typeID] || 0) + units;
      break;
    }
    panels.push(panel);
    cutting.panels += 1;
    if (done) break;
  }

  const steps = Math.max(1, toInt(tunable("EVEJS_CUT_CONTAINERS", 2), 2));
  const damage = cutting.hpMax > 0 ? 1 - cutting.hpLeft / cutting.hpMax : 1;
  // Containers drop at steps of the cutting work (from hpStart), so a wreck
  // that came in half shot still drops them along the way, not at once.
  const progress = base > 0 ? 1 - cutting.hpLeft / base : 1;
  const containers = [];
  if (reclaimed && reclaimed.containerID) containers.push(reclaimed.containerID);
  if (profile.mode === "breach" && !cutting.breached) {
    // A Hold Breacher: every part left and the wreck's own cargo, in one
    // container, on its first cycle.
    const entries = cutting.salvage || [];
    const containerID = spawnSalvageContainer(scene, targetEntity, record, entries, characterID, nowMs, { withWreckCargo: true });
    cutting.breached = true;
    if (containerID) {
      containers.push(containerID);
      cutting.salvage = [];
      cutting.containersDropped = steps;
    }
  }
  while (cutting.containersDropped < steps && (done || progress + 1e-9 >= (cutting.containersDropped + 1) / steps)) {
    const share = salvageShare(cutting, cutting.containersDropped, steps);
    cutting.containersDropped += 1;
    const containerID = spawnSalvageContainer(scene, targetEntity, record, share, characterID, nowMs);
    if (containerID) containers.push(containerID);
    else if (share.length) cutting.salvage = [...(cutting.salvage || []), ...share];
  }

  if (done) {
    finishWreck(scene, targetEntity, targetID, nowMs);
    return {
      success: true,
      data: { targetID, cutHP: cut, panels, containers, reclaimed: reclaimed ? reclaimed.granted : [], depleted: true, transferredQuantity: 0 },
    };
  }
  const updated = {
    ...record,
    cutting,
    conditionState: { ...(record.conditionState || {}), damage },
  };
  const keepUntil = cutKeepUntil(nowMs, record.expiresAtMs ?? targetEntity.expiresAtMs);
  if (keepUntil) {
    updated.expiresAtMs = keepUntil;
    targetEntity.expiresAtMs = keepUntil;
  }
  if (record.inventoryWreck) inventoryCut().save(updated);
  else store().upsertNativeWreck(updated, { transient: record.transient === true });
  broadcastDamage(scene, targetEntity, damage);
  return {
    success: true,
    data: { targetID, cutHP: cut, hpLeft: cutting.hpLeft, panels, containers, reclaimed: reclaimed ? reclaimed.granted : [], transferredQuantity: 0 },
  };
}

// ---------------------------------------------------------------------------
// A salvager on a panel (from salvagerRuntime.executeSalvagerCycle, after a
// successful roll). Each success takes one chunk; the salvager keeps a share
// of it by its kind and the pilot's Salvaging skill, the rest is lost.

function recoveryShares(effectState, skillMap) {
  const typeID = toInt(effectState && effectState.typeID, 0);
  let common = 0.75;
  let rare = 0.5;
  // Every salvager in the module family (salvageModuleFamily.js) has its own
  // shares; Salvager I and II are in it. `rare` is for the core band only:
  // middle-band alloys (catalog.MID_ALLOYS) are kept at the plating share.
  const variant = require("./salvageModuleFamily").variantOf(typeID);
  if (variant && variant.shares) ({ common, rare } = variant.shares);
  else if (typeID === SALVAGER_I) { common = 0.85; rare = 0.7; }
  else if (typeID === SALVAGER_II) { common = 0.95; rare = 0.85; }
  const bonus = 0.02 * skillLevel(skillMap, SALVAGING_SKILL);
  return { common: Math.min(1, common + bonus), rare: Math.min(1, rare + bonus) };
}

function salvagePanelCycle(context) {
  const {
    scene, entity, targetEntity, effectState, characterID, rewardLocationID, shipID,
    cargoSnapshot, skillMap, nowMs, helpers,
  } = context;
  // Free room in the ship's Salvage Hold (salvage/salvageHoldRouting.js): it
  // fills before the cargo hold. 0 when the ship has none.
  const salvageHoldFree = rewardLocationID === shipID ? Math.max(0, Number(context.salvageHoldFree) || 0) : 0;
  let holdSplit = null;
  const record = panelRecordOf(targetEntity);
  if (!record) return { success: false, stopReason: "target" };
  const panel = record.wreckPanel;
  const alloys = panel.alloys || {};
  const chunksLeft = Math.max(1, toInt(panel.chunks, 1));
  let take = {};
  for (const [typeID, quantity] of Object.entries(alloys)) {
    const units = chunksLeft <= 1 ? quantity : Math.min(quantity, Math.ceil(Number((panel.initial || alloys)[typeID] || quantity) / Math.max(1, PANEL_CHUNKS[panel.size] || 1)));
    if (units > 0) take[typeID] = units;
  }
  const shares = recoveryShares(effectState, skillMap);
  const rewards = [];
  for (const [typeID, units] of Object.entries(take)) {
    const kept = units * (catalog.alloyBand(typeID) === 2 ? shares.rare : shares.common);
    const whole = Math.floor(kept) + (Math.random() < kept % 1 ? 1 : 0);
    if (whole > 0) rewards.push({ itemType: Number(typeID), quantity: whole });
  }
  // Only what fits the hold comes off; the rest stays on the panel. The hold is
  // filled a whole unit at a time, rare alloys first, then the smallest units
  // (scaling every stack by the room left rounded single units down to nothing,
  // so a panel with one bulky unit never came off at all).
  if (rewardLocationID === shipID && cargoSnapshot) {
    const volume = rewards.reduce((sum, entry) => sum + entry.quantity * unitVolume(entry.itemType), 0);
    const cargoRoom = Math.max(0, Number(cargoSnapshot.availableVolume) || 0);
    const room = cargoRoom + salvageHoldFree;
    const routing = src("services/salvage/salvageHoldRouting");
    if (volume <= room + 1e-6 && salvageHoldFree > 0) {
      // It all fits, but across two holds a bulky unit may fit in neither.
      holdSplit = routing.plan(rewards, cargoRoom, salvageHoldFree);
    }
    if (volume > room + 1e-6 || (holdSplit && holdSplit.left.length > 0)) {
      const order = [...rewards].sort((a, b) =>
        (catalog.isRareAlloy(b.itemType) ? 1 : 0) - (catalog.isRareAlloy(a.itemType) ? 1 : 0) ||
        unitVolume(a.itemType) - unitVolume(b.itemType));
      holdSplit = routing.plan(order, cargoRoom, salvageHoldFree);
      const fitting = holdSplit.fitted;
      if (!fitting.length) {
        const smallest = Math.min(...rewards.map((entry) => unitVolume(entry.itemType)));
        if (helpers && typeof helpers.cargoFull === "function") helpers.cargoFull(smallest, room);
        return { success: false, stopReason: "cargo" };
      }
      // The panel gives up all of a stack that fitted whole, and a matching
      // share of one that fitted in part; a stack lost to the salvager's
      // share stays on the panel this time.
      const partialTake = {};
      for (const [typeID, units] of Object.entries(take)) {
        const wanted = rewards.find((entry) => entry.itemType === Number(typeID));
        const got = fitting.find((entry) => entry.itemType === Number(typeID));
        if (!wanted || !got) continue;
        partialTake[typeID] = got.quantity >= wanted.quantity ? units : Math.min(units, Math.ceil(units * got.quantity / wanted.quantity));
      }
      take = partialTake;
      rewards.length = 0;
      rewards.push(...fitting);
    }
  }
  if (rewards.length) {
    const itemStore = src("services/inventory/itemStore");
    const granted = holdSplit && holdSplit.hold.length > 0
      ? src("services/salvage/salvageHoldRouting").grantPlan(characterID, shipID, holdSplit)
      : itemStore.grantItemsToCharacterLocation(characterID, rewardLocationID, itemStore.ITEM_FLAGS.CARGO_HOLD, rewards);
    if (!granted || !granted.success) return { success: false, stopReason: "cargo" };
    if (helpers && typeof helpers.syncRewards === "function") helpers.syncRewards((granted.data && granted.data.changes) || []);
  }
  const left = {};
  for (const [typeID, quantity] of Object.entries(alloys)) {
    const remaining = quantity - (take[typeID] || 0);
    if (remaining > 0) left[typeID] = remaining;
  }
  if (helpers && typeof helpers.notify === "function") helpers.notify(rewards);
  if (alloyUnits(left) <= 0) {
    src("space/npc/nativeNpcWreckService").destroyNativeWreck(record.wreckID, { scene, broadcast: true, nowMs });
    return { success: false, stopReason: "target", data: { targetID: record.wreckID, salvaged: true, rewards, panel: true } };
  }
  store().upsertNativeWreck({
    ...record,
    wreckPanel: { ...panel, alloys: left, chunks: Math.max(1, chunksLeft - 1) },
  }, { transient: record.transient === true });
  return { success: true, data: { targetID: record.wreckID, salvaged: false, rewards, panel: true } };
}

// What's left of a cut wreck's salvage parts, for a salvager used on it
// directly (the containers already took the rest).
function remainingSalvageEntries(record) {
  return record && record.cutting ? (record.cutting.salvage || []).map((entry) => ({ ...entry })) : null;
}

// ---------------------------------------------------------------------------
// GM (POST /v1/gm/salvage, tool gm_salvage). Test cycles skip the lock and
// range checks, so a bot anywhere in the wreck's scene can run them.
//   action=wrecks (characterID): native wrecks in that pilot's scene, with
//     their cutting state or panel contents
//   action=cut (characterID, wreckID, typeID = cutter, cycles = 1)
//   action=salvage (characterID, panelID, typeID = salvager, cycles = 1):
//     every cycle succeeds (no roll); goes into the pilot's ship cargo

function gmPilot(body, context) {
  const characterID = Number(body.characterID) || 0;
  const row = (context.connected ? context.connected() : []).find((entry) => entry.characterID === characterID);
  if (!row) throw new Error("characterID is not connected");
  const scene = src("space/runtime").getSceneForSession(row.session);
  const shipID = Number(row.session._space && row.session._space.shipID) || 0;
  const entity = scene && shipID ? scene.getEntityByID(shipID) : null;
  if (!entity) throw new Error("that character is not in space");
  return { row, scene, entity, characterID, shipID };
}

function describeWreck(scene, record, from) {
  const entity = scene.getEntityByID(record.wreckID);
  const position = (entity && entity.position) || record.position || {};
  const km = from && from.position
    ? Math.round(Math.hypot(position.x - from.position.x, position.y - from.position.y, position.z - from.position.z) / 100) / 10
    : null;
  const out = {
    wreckID: record.wreckID,
    name: record.itemName,
    typeID: record.typeID,
    sourceTypeID: record.sourceTypeID || null,
    inScene: Boolean(entity),
    km,
    items: record.inventoryWreck
      ? inventoryCut().cargoOf(record.wreckID).length
      : store().listNativeWreckItemsForWreck(record.wreckID).length,
    ...(record.inventoryWreck ? { inventoryWreck: true, standIn: (typeOf(record.sourceTypeID) || {}).name || null } : {}),
    expiresInMin: record.expiresAtMs ? Math.round((record.expiresAtMs - Date.now()) / 60000) : null,
  };
  if (record.cutting) {
    out.cutting = {
      hpLeft: Math.round(record.cutting.hpLeft),
      hpMax: record.cutting.hpMax,
      potential: record.cutting.potential,
      potentialM3: Math.round(alloyVolume(record.cutting.potential)),
      carry: Object.fromEntries(Object.entries(record.cutting.carry || {}).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      panels: record.cutting.panels,
      containersDropped: record.cutting.containersDropped,
      salvageLeft: (record.cutting.salvage || []).length,
      ...(record.cutting.partsFactor !== undefined && record.cutting.partsFactor !== 1 ? { partsFactor: record.cutting.partsFactor } : {}),
      ...(record.cutting.potentials ? {
        potentials: Object.fromEntries(Object.entries(record.cutting.potentials).map(([reach, alloys]) =>
          [reach, { m3: Math.round(alloyVolume(alloys)), alloys: Object.fromEntries(Object.entries(alloys).map(([k, v]) => [k, Math.round(v)])) }])),
      } : {}),
      ...(record.cutting.breached ? { breached: true } : {}),
      ...(Object.keys(record.cutting.mineralCarry || {}).length
        ? { mineralCarry: Object.fromEntries(Object.entries(record.cutting.mineralCarry).map(([k, v]) => [k, Math.round(v * 100) / 100])) }
        : {}),
    };
  }
  if (record.wreckPanel) {
    out.panel = { ...record.wreckPanel, m3: Math.round(alloyVolume(record.wreckPanel.alloys)) };
  }
  return out;
}

// The type, family and bot actions of the repo's own build (types,
// applyTypes, dogma, family, bots) come with the type layer and the bot-jobs
// service; these are the ones that work on a clean EveJS.
function gm(body = {}, context = {}) {
  const action = String(body.action || "wrecks");
  const { scene, entity, characterID, shipID } = gmPilot(body, context);
  const cycles = Math.max(1, Math.min(100, toInt(body.cycles, 1)));
  if (action === "wrecks") {
    const wrecks = store().listNativeWrecks()
      .filter((record) => Number(record.systemID) === Number(scene.systemID) && scene.getEntityByID(record.wreckID))
      .map((record) => describeWreck(scene, record, entity));
    // Inventory wrecks (contracts, derelicts, mission wrecks, ship kills) with their stand-in hulls.
    for (const other of scene.dynamicEntities.values()) {
      const record = inventoryRecordOf(other);
      if (record) wrecks.push(describeWreck(scene, record, entity));
    }
    wrecks.sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
    return { systemID: scene.systemID, count: wrecks.length, wrecks: wrecks.slice(0, Math.max(1, toInt(body.limit, 30))) };
  }
  if (action === "cut") {
    const wreckID = toInt(body.wreckID, 0);
    const typeID = toInt(body.typeID, 5241);
    if (!catalog.isCutterType(typeID)) throw new Error(`typeID ${typeID} is not a cutter (${Object.keys(catalog.CUTTER_TYPES).join(", ")})`);
    const hold = require("./cutHelpers").cutHelpers();
    const results = [];
    for (let index = 0; index < cycles; index += 1) {
      const result = executeCutCycle(scene, entity, { typeID, targetID: wreckID, moduleID: 0 }, sceneNow(scene), {}, {
        getTargetsForEntity: () => [wreckID],
        holdRoom: hold.holdRoom,
        grantToHold: hold.grantToHold,
      });
      results.push({
        success: result.success,
        stopReason: result.stopReason || null,
        cutHP: result.data && Math.round(result.data.cutHP),
        hpLeft: result.data && result.data.hpLeft !== undefined ? Math.round(result.data.hpLeft) : null,
        panels: result.data && result.data.panels,
        containers: result.data && result.data.containers,
        reclaimed: result.data && result.data.reclaimed && result.data.reclaimed.length ? result.data.reclaimed : undefined,
        depleted: Boolean(result.data && result.data.depleted),
      });
      if (!result.success || (result.data && result.data.depleted)) break;
    }
    const record = store().getNativeWreck(wreckID) || inventoryRecordOf(scene.getEntityByID(wreckID));
    return { results, wreck: record ? describeWreck(scene, record, entity) : "gone" };
  }
  if (action === "salvage") {
    const panelID = toInt(body.panelID, 0);
    const typeID = toInt(body.typeID, SALVAGER_I);
    const results = [];
    for (let index = 0; index < cycles; index += 1) {
      const targetEntity = scene.getEntityByID(panelID);
      if (!targetEntity) { results.push({ error: "panel not in scene" }); break; }
      const result = salvagePanelCycle({
        scene, entity, targetEntity, effectState: { typeID }, characterID,
        rewardLocationID: shipID, shipID, cargoSnapshot: null, skillMap: skillMapOf(entity),
        nowMs: sceneNow(scene), helpers: {},
      });
      results.push({ success: result.success, stopReason: result.stopReason || null, rewards: result.data && result.data.rewards });
      if (!result.success) break;
    }
    const record = store().getNativeWreck(panelID);
    return { results, panel: record ? describeWreck(scene, record, entity) : "gone" };
  }
  if (action === "debris") {
    // What came off a wreck: panels and containers launched from it.
    const wreckID = toInt(body.wreckID, 0);
    const ids = new Set(String(body.itemIDs || "").split(",").map((id) => toInt(id, 0)).filter((id) => id > 0));
    const debris = [];
    for (const other of scene.dynamicEntities.values()) {
      if (!other || (toInt(other.launcherID, 0) !== wreckID && !ids.has(toInt(other.itemID, 0)))) continue;
      let contents = null;
      if (other.nativeNpcWreck !== true) {
        try {
          contents = src("services/inventory/simulationInventoryProjection").listContainerItems(null, toInt(other.itemID, 0), null)
            .map((item) => ({ typeID: item.typeID, quantity: item.stacksize ?? item.quantity }));
        } catch (error) {
          contents = error.message;
        }
      }
      debris.push({ itemID: toInt(other.itemID, 0), kind: other.kind, name: other.itemName || null, typeID: other.typeID, contents });
    }
    return { wreckID, count: debris.length, debris };
  }
  if (action === "respawn") {
    // Containers in space (inventory) from a wreck that are missing from the
    // scene: put them in.
    const wreckID = toInt(body.wreckID, 0);
    const ids = new Set(String(body.itemIDs || "").split(",").map((id) => toInt(id, 0)).filter((id) => id > 0));
    const items = src("services/inventory/simulationInventoryProjection").listContainerItems(null, toInt(scene.systemID, 0), null) || [];
    const results = [];
    if (body.find === true || body.find === "true") {
      // Dry run: every container in this system's space that the scene lacks.
      return {
        missing: items
          .filter((item) => item && item.categoryID !== 6 && /container/i.test(String(item.itemName || "")) && !scene.getEntityByID(toInt(item.itemID, 0)))
          .map((item) => ({ itemID: toInt(item.itemID, 0), typeID: item.typeID, name: item.itemName, ownerID: item.ownerID,
            launcherID: item.launcherID || null, createdAtMs: item.createdAtMs || (item.spaceState && item.spaceState.createdAtMs) || null,
            contents: (src("services/inventory/simulationInventoryProjection").listContainerItems(null, toInt(item.itemID, 0), null) || []).length })),
      };
    }
    for (const item of items) {
      const itemID = toInt(item.itemID, 0);
      if (!(ids.has(itemID) || (wreckID > 0 && toInt(item.launcherID, 0) === wreckID))) continue;
      if (scene.getEntityByID(itemID)) { results.push({ itemID, already: true }); continue; }
      const spawned = spawnInventoryEntity(scene, itemID);
      results.push({ itemID, typeID: item.typeID, spawned: Boolean(spawned && spawned.success), errorMsg: spawned && spawned.errorMsg || null });
    }
    return { wreckID, results };
  }
  throw new Error("action must be wrecks, cut, salvage, debris or respawn");
}

module.exports = {
  gm,
  isCutterModule,
  isCutterEffectState,
  isPanelEntity,
  panelVolume, // bot salvagers: when what came off fills the hold
  hullCutHP,
  inventoryRecordOf,
  cuttableRecordOf, // bot salvagers (playerbots/playerBotSalvageRuns.js)
  hullLeftShare,
  remainingSalvageEntries,
  resolveCutActivation,
  executeCutCycle,
  salvagePanelCycle,
  _testing: { panelSize, panelLook, takeFromCarry, salvageShare, recoveryShares, expectedKeptVolume, mineralPotentialOf, reclaimToHold, reclaimRooms },
};
