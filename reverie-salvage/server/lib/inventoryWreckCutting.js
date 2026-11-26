"use strict";

// Reverie Salvage (README.md): wrecks that are inventory items
// rather than native NPC wrecks. Salvage contracts, derelict fleets, agent and
// station mission wrecks and player or bot ship kills all put their wrecks out
// as plain items of a wreck type, with no ship behind them. A cutter needs the
// hull's minerals, so each such wreck gets a stand-in hull: a T1 ship of its
// race (from the cartel or empire in its name) and size (from its wreck type).
// "Blood Large Wreck" is cut as an Apocalypse, "Gallente Rookie ship Wreck" as
// an Incursus. Salvagers use the same stand-in for the hull alloys.
//
// wreckCutting.js works on a record shaped like a native wreck record; this
// file builds one from the item (recordOf), keeps the cutting state on the
// item's customInfo under evejsWreckCut (save), and does the item side of
// what the cutter does to a native wreck (cargoOf, moveCargo, finish).
//
// Hot reload: no module state except the name lookup cache, which only holds
// resolved type IDs, so a reload of the mod applies a change.

const { game } = require("./game");

const CUT_KEY = "evejsWreckCut";

// race -> size -> hull name (T1, all with a recipe in the client data)
const STAND_IN_HULLS = Object.freeze({
  amarr: { frigate: "Punisher", destroyer: "Coercer", cruiser: "Omen", battlecruiser: "Harbinger", battleship: "Apocalypse", hauler: "Bestower", barge: "Procurer" },
  caldari: { frigate: "Merlin", destroyer: "Cormorant", cruiser: "Caracal", battlecruiser: "Drake", battleship: "Raven", hauler: "Badger", barge: "Procurer" },
  gallente: { frigate: "Incursus", destroyer: "Catalyst", cruiser: "Thorax", battlecruiser: "Brutix", battleship: "Megathron", hauler: "Iteron Mark V", barge: "Procurer" },
  minmatar: { frigate: "Rifter", destroyer: "Thrasher", cruiser: "Stabber", battlecruiser: "Hurricane", battleship: "Tempest", hauler: "Mammoth", barge: "Procurer" },
});

function src(relative) {
  return game(relative);
}

function toInt(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function itemStore() {
  return src("services/inventory/itemStore");
}

function registry() {
  return src("services/inventory/itemTypeRegistry");
}

function parseInfo(item) {
  return src("space/runtime/inventoryCustomInfo").parseInventoryCustomInfo(item) || {};
}

function raceOf(text) {
  if (/\b(amarr|blood|sansha|sanshas|imperial|khanid|ammatar)\b/.test(text)) return "amarr";
  if (/\b(caldari|guristas|mordu|mordus|state)\b/.test(text)) return "caldari";
  if (/\b(gallente|serpentis|federation|intaki)\b/.test(text)) return "gallente";
  return "minmatar"; // Angel, Minmatar, rogue drones and anything unnamed
}

function sizeOf(text) {
  if (/\b(titan|supercarrier|carrier|dreadnought|freighter|capital|force auxiliary)\b/.test(text)) return "battleship";
  if (/\b(mining barge|exhumer)\b/.test(text)) return "barge";
  if (/\b(hauler|industrial|transport)\b/.test(text)) return "hauler";
  if (/\bbattle\s*cruiser\b/.test(text)) return "battlecruiser";
  if (/\b(battleship|large|hive)\b/.test(text)) return "battleship";
  if (/\b(cruiser|medium)\b/.test(text)) return "cruiser";
  if (/\bdestroyer\b/.test(text)) return "destroyer";
  return "frigate"; // small, frigate, rookie ship, shuttle
}

const hullIDs = new Map();
function hullTypeID(name) {
  if (hullIDs.has(name)) return hullIDs.get(name);
  const ship = (registry().listExactItemMatchesByName(name) || []).find((match) => Number(match.categoryID) === 6);
  const typeID = ship ? toInt(ship.typeID, 0) : 0;
  hullIDs.set(name, typeID);
  return typeID;
}

// The stand-in hull's typeID for a wreck item (0 when none resolves).
function standInHull(item) {
  const type = registry().resolveItemByTypeID(toInt(item && item.typeID, 0)) || {};
  const typeText = String(type.name || "").toLowerCase();
  const text = `${typeText} ${String(item && item.itemName || "").toLowerCase()}`;
  const race = raceOf(text);
  // The wreck type says the size; the item's own name only when the type does not.
  const size = /\b(small|medium|large|frigate|destroyer|cruiser|battle|hauler|industrial|barge|exhumer|carrier|dreadnought|titan|freighter|rookie|shuttle)\b/.test(typeText)
    ? sizeOf(typeText)
    : sizeOf(text);
  return hullTypeID(STAND_IN_HULLS[race][size]) || hullTypeID(STAND_IN_HULLS.minmatar[size]) || 0;
}

function isWreckItem(item) {
  if (!item) return false;
  const type = registry().resolveItemByTypeID(toInt(item.typeID, 0)) || {};
  return String(type.groupName || item.groupName || "").trim().toLowerCase() === "wreck";
}

// A record shaped like a native wreck record for an inventory wreck in space,
// or null (a native wreck, a container, a wreck already salvaged).
function recordOf(entity) {
  if (!entity || entity.nativeNpcWreck === true || entity.kind !== "wreck") return null;
  if (entity.salvaged === true || entity.salvageComplete === true) return null;
  const itemID = toInt(entity.itemID, 0);
  const item = itemID > 0 ? itemStore().findItemById(itemID) : null;
  if (!isWreckItem(item)) return null;
  const saved = parseInfo(item)[CUT_KEY] || {};
  const sourceTypeID = toInt(saved.sourceTypeID, 0) || standInHull(item);
  if (sourceTypeID <= 0) return null;
  const type = registry().resolveItemByTypeID(toInt(item.typeID, 0)) || {};
  let scope = {};
  try {
    scope = src("space/destiny/identity/interactionScope.js").buildChildEntityScopeMetadata(entity) || {};
  } catch (_) {
    scope = {};
  }
  const position = entity.position || (item.spaceState && item.spaceState.position) || { x: 0, y: 0, z: 0 };
  const record = {
    ...scope,
    inventoryWreck: true,
    wreckID: itemID,
    typeID: toInt(item.typeID, 0),
    groupID: toInt(type.groupID ?? item.groupID, 0),
    categoryID: toInt(type.categoryID ?? item.categoryID, 0),
    itemName: String(entity.itemName || item.itemName || type.name || "Wreck"),
    sourceTypeID,
    ownerID: toInt(item.ownerID, 0),
    systemID: toInt(entity.systemID, 0) || toInt(item.locationID, 0),
    position: { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 },
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    mode: "STOP",
    speedFraction: 0,
    radius: Math.max(0, Number(entity.radius) || 0),
    lootAbandoned: false,
    transient: false,
    conditionState: saved.conditionState || entity.conditionState || { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 0, incapacitated: false },
  };
  if (saved.cutting) record.cutting = saved.cutting;
  return record;
}

// Keeps the cutting state (and the stand-in, so it never changes) on the item.
function save(record) {
  const itemID = toInt(record && record.wreckID, 0);
  if (itemID <= 0) return { success: false, errorMsg: "WRECK_NOT_FOUND" };
  return itemStore().updateInventoryItem(itemID, (item) => {
    const info = parseInfo(item);
    info[CUT_KEY] = {
      sourceTypeID: toInt(record.sourceTypeID, 0),
      cutting: record.cutting || null,
      conditionState: record.conditionState || null,
    };
    // A wreck being cut stays (wreckCutting.cutKeepUntil); one that never expired still never does.
    const keepUntil = Number(record.expiresAtMs) || 0;
    const expiresAtMs = Number(item.expiresAtMs) > 0 && keepUntil > Number(item.expiresAtMs) ? keepUntil : item.expiresAtMs;
    return { ...item, customInfo: JSON.stringify(info), expiresAtMs };
  });
}

function cargoOf(wreckID) {
  try {
    return src("services/inventory/simulationInventoryProjection").listContainerItems(null, toInt(wreckID, 0), null) || [];
  } catch (_) {
    return [];
  }
}

// A Hold Breacher: the wreck's cargo into the container beside it.
function moveCargo(wreckID, containerID) {
  const store = itemStore();
  let moved = 0;
  for (const item of cargoOf(wreckID)) {
    const result = store.moveItemToLocation(toInt(item.itemID, 0), toInt(containerID, 0), store.ITEM_FLAGS.HANGAR);
    if (!result || !result.success) return { success: false, errorMsg: (result && result.errorMsg) || "LOOT_TRANSFER_FAILED", moved };
    moved += 1;
  }
  return { success: true, moved };
}

// The wreck at 0 HP: cargo left goes into a loot container where it was (as
// when a salvager finishes it), and the wreck item and its ball are gone.
// spawnInventoryEntity is wreckCutting's (scene, itemID) spawner.
function finish(scene, wreckEntity, wreckID, nowMs, spawnInventoryEntity) {
  const salvager = src("space/modules/salvagerRuntime").reverieInternals || {};
  const log = src("utils/logger");
  if (cargoOf(wreckID).length > 0 && typeof salvager.replaceInventoryWreckWithLootContainer === "function") {
    const replaced = salvager.replaceInventoryWreckWithLootContainer(scene, wreckEntity, nowMs, {});
    if (replaced && replaced.success && replaced.containerID) {
      const spawned = spawnInventoryEntity(scene, replaced.containerID);
      if (!spawned || !spawned.success) {
        log.warn(`[WreckCutting] loot container ${replaced.containerID} of wreck ${wreckID} not spawned: ${spawned && spawned.errorMsg}`);
      }
      salvager.removeSalvageSceneEntity(scene, wreckID);
      return true;
    }
  }
  const removed = itemStore().removeInventoryItem(toInt(wreckID, 0), { removeContents: true });
  salvager.removeSalvageSceneEntity(scene, wreckID);
  return Boolean(removed && removed.success);
}

module.exports = {
  CUT_KEY,
  recordOf,
  save,
  cargoOf,
  moveCargo,
  finish,
  standInHull,
  _testing: { raceOf, sizeOf },
};
