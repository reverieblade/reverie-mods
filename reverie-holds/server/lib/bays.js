"use strict";

// The bay table and the holds service (doc/REVERIE_HOLDS.md, "The holds
// service"; GUIDE.md for modders). One place decides where an item goes in a
// ship and where it is taken from, so the inventory window, the modules, the
// loot routing and other mods always agree on which bays a ship has and how
// much room each has left.
//
// A ship has a bay exactly when the bay's fitted size is above zero, wherever
// the size comes from: the hull, a module, a rig or a skill. Sizes are read
// from the ship's fitting snapshot (dogma with the fit applied), never from the
// hull type alone.
//
// EVE's own bays are in the table from the start. A mod adds its own with
// addBay(definition). Both look the same to every caller.
//
// Hot reload: the table is rebuilt from the definitions on every reload of the
// mod; nothing here keeps item state, which lives in the game's item store.

const { game, tryGame, layerData, log } = require("./game");

const toInt = (value, fallback = 0) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const EPSILON = 1e-6;

const CARGO_FLAG = 5;
const DRONE_BAY_FLAG = 87;
const FIGHTER_BAY_FLAG = 158;
const FUEL_BAY_FLAG = 133;
const MINING_FLAGS = Object.freeze([134, 135, 181, 182]);
const DRONE_CATEGORY_ID = 18;
const FIGHTER_CATEGORY_ID = 87;
const LOW_SLOT_FLAGS = new Set([11, 12, 13, 14, 15, 16, 17, 18]);

// The names the client gives EVE's bays.
const BAY_NAMES = Object.freeze({
  5: "Cargo Hold", 87: "Drone Bay", 133: "Fuel Bay", 134: "Mining Hold", 135: "Gas Hold",
  136: "Mineral Hold", 137: "Salvage Hold", 138: "Ship Hold", 139: "Small Ship Hold",
  140: "Medium Ship Hold", 141: "Large Ship Hold", 142: "Industrial Ship Hold", 143: "Ammo Hold",
  148: "Command Center Hold", 149: "Planetary Commodities Hold", 151: "Material Bay",
  154: "Quafe Bay", 158: "Fighter Bay", 174: "Corpse Bay", 176: "Booster Bay", 177: "Subsystem Bay",
  179: "Frigate Escape Bay", 181: "Ice Hold", 182: "Asteroid Hold", 183: "Mobile Depot Hold",
  185: "Infrastructure Hold", 188: "Expedition Hold",
});

// Among bays that take the same item, the higher priority is tried first:
// a hold made for one kind of item before a general one, and cargo last.
const PRIORITY = Object.freeze({ specialised: 80, kind: 70, general: 60, wide: 50, cargo: 0 });
// Holds that take many kinds of item and so come after every hold made for
// one kind: the Expedition Hold takes gas, salvage, commodities, probes and
// more, which the Mining, Salvage and Planetary Commodities Holds should get first.
const WIDE_FLAGS = new Set([188]);

// ---------------------------------------------------------------------------
// Game lookups, at each use so a hot reload of a game file reaches here.

const itemStore = () => game("services/inventory/itemStore");
const registry = () => game("services/inventory/specialShipHoldRegistry");
const miningInventory = () => game("services/mining/miningInventory");
const fuelBay = () => game("services/inventory/fuelBayInventory");
const fitting = () => game("services/fitting/liveFittingState");
// The hull's own value, for a resource state that has no attribute map.
const baseAttribute = (...args) => fitting().getShipBaseAttributeValue(...args);

function typeRecordOf(itemOrTypeID) {
  if (itemOrTypeID && typeof itemOrTypeID === "object" && toInt(itemOrTypeID.groupID) > 0) return itemOrTypeID;
  const typeID = toInt(itemOrTypeID && typeof itemOrTypeID === "object" ? itemOrTypeID.typeID : itemOrTypeID);
  if (typeID <= 0) return null;
  const types = tryGame("services/inventory/itemTypeRegistry");
  return types ? types.resolveItemByTypeID(typeID) || null : null;
}

function unitVolume(itemOrTypeID) {
  if (itemOrTypeID && typeof itemOrTypeID === "object" && toInt(itemOrTypeID.itemID) > 0) {
    try {
      return Math.max(0, toNumber(itemStore().getInventoryItemUnitVolume(itemOrTypeID), 0));
    } catch (_) { /* fall through to the type */ }
  }
  const type = typeRecordOf(itemOrTypeID);
  return Math.max(0, toNumber(type && type.volume, 0));
}

function stackVolume(item) {
  if (!item) return 0;
  const units = toInt(item.singleton) === 1 ? 1 : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
  return unitVolume(item) * units;
}

// ---------------------------------------------------------------------------
// The table.

const bays = new Map(); // flag -> bay
// The holds that EveJS's specialShipHoldRegistry defines join the table on its
// first use, never while mods are declaring patches: loading the registry then
// would leave another mod's patches on it late (core patcher, "late").
let registryHoldsAdded = false;

function addBuiltIn(bay) {
  bays.set(bay.flag, Object.freeze({ builtIn: true, routable: true, exclusive: false, mod: null, ...bay }));
}

function registerBuiltIns() {
  addBuiltIn({
    key: "cargo", flag: CARGO_FLAG, name: BAY_NAMES[CARGO_FLAG], priority: PRIORITY.cargo, routable: false,
    capacity: ({ resourceState }) => toNumber(resourceState && resourceState.cargoCapacity, 0),
    accepts: () => true,
  });
  addBuiltIn({
    key: "drone", flag: DRONE_BAY_FLAG, name: BAY_NAMES[DRONE_BAY_FLAG], priority: PRIORITY.kind, routable: false,
    capacity: ({ resourceState }) => toNumber(resourceState && resourceState.droneCapacity, 0),
    accepts: (type) => toInt(type && type.categoryID) === DRONE_CATEGORY_ID,
  });
  addBuiltIn({
    key: "fighter", flag: FIGHTER_BAY_FLAG, name: BAY_NAMES[FIGHTER_BAY_FLAG], priority: PRIORITY.kind, routable: false,
    capacity: ({ resourceState }) => toNumber(resourceState && resourceState.fighterCapacity, 0),
    accepts: (type) => toInt(type && type.categoryID) === FIGHTER_CATEGORY_ID,
  });
  addBuiltIn({
    key: "fuel", flag: FUEL_BAY_FLAG, name: BAY_NAMES[FUEL_BAY_FLAG], priority: PRIORITY.kind,
    capacity: ({ resourceState }) => toNumber(fuelBay().getFuelBayCapacity(resourceState), 0),
    accepts: (type) => fuelBay().isFuelBayCompatibleItem(type) === true,
  });
  for (const flag of MINING_FLAGS) {
    addBuiltIn({
      key: { 134: "mining", 135: "gas", 181: "ice", 182: "asteroid" }[flag], flag, name: BAY_NAMES[flag],
      priority: flag === 134 ? PRIORITY.general : PRIORITY.specialised,
      capacity: ({ resourceState }) => toNumber(miningInventory().getShipHoldCapacityByFlag(resourceState, flag), 0),
      accepts: (type) => miningInventory().isItemTypeAllowedInHoldFlag(type, flag) === true,
    });
  }
}

// Every other special hold EveJS knows (Mineral, Salvage, Ammo, Planetary,
// Expedition, the ship holds and the rest), sized and judged by its registry.
// A mod's own bay never sits on one of these flags (addBay refuses it), so a
// flag already in the table here is one of the built-ins above.
function ensureRegistryHolds() {
  if (registryHoldsAdded) return;
  registryHoldsAdded = true;
  let definitions = [];
  try {
    definitions = registry().SPECIAL_SHIP_HOLD_DEFINITIONS || [];
  } catch (_) {
    definitions = [];
  }
  for (const definition of definitions) {
    const flag = toInt(definition && definition.flagID);
    if (flag <= 0 || bays.has(flag) || definition.managedBy) continue;
    addBuiltIn({
      key: String(definition.key || `hold${flag}`), flag, name: BAY_NAMES[flag] || "Hold",
      priority: WIDE_FLAGS.has(flag) ? PRIORITY.wide : PRIORITY.kind,
      capacity: ({ resourceState, shipTypeID }) =>
        toNumber(registry().getSpecialShipHoldCapacity(resourceState, shipTypeID, flag, baseAttribute), 0),
      accepts: (type) => registry().isSpecialShipHoldItemAllowed(type, flag) === true,
    });
  }
}

// A mod's own bay lives on a flag of its own, 192 to 255 (GUIDE.md). CCP's
// holds all sit below 192, so the range alone keeps a mod off EVE's bays and
// addBay never has to load the game's hold table, which may run in a partner
// mod's patches() before every patch is in place.
const MOD_FLAG_MIN = 192;
const MOD_FLAG_MAX = 255;

// A bay of a mod's own (GUIDE.md, "Define it"). Returns the bay's record.
function addBay(definition, modID = null) {
  const def = definition || {};
  const flag = toInt(def.flag);
  if (flag < MOD_FLAG_MIN || flag > MOD_FLAG_MAX) {
    throw new Error(`holds.addBay: a bay's flag must be from ${MOD_FLAG_MIN} to ${MOD_FLAG_MAX}, not ${def.flag}`);
  }
  const existing = bays.get(flag);
  if (existing && existing.builtIn) throw new Error(`holds.addBay: flag ${flag} is EVE's ${existing.name}`);
  if (existing && existing.mod && modID && existing.mod !== modID) {
    throw new Error(`holds.addBay: flag ${flag} is already ${existing.mod}'s ${existing.name}`);
  }
  const key = String(def.key || `bay${flag}`);
  const size = def.size || {};
  const acceptList = def.accepts || {};
  const categories = new Set((acceptList.categories || []).map(Number));
  const groups = new Set((acceptList.groups || []).map(Number));
  const types = new Set((acceptList.types || []).map(Number));
  const test = typeof acceptList.test === "function" ? acceptList.test : (typeof def.accepts === "function" ? def.accepts : null);
  const bay = Object.freeze({
    builtIn: false,
    mod: modID,
    key,
    flag,
    name: String(def.name || key),
    priority: Number.isFinite(Number(def.priority)) ? Number(def.priority) : PRIORITY.kind,
    routable: def.routable !== false,
    exclusive: def.exclusive === true,
    refusal: def.refusal ? String(def.refusal) : `That item cannot be placed in the ${def.name || "bay"}.`,
    client: def.client || null,
    spill: def.spill || null,
    capacity: ({ resourceState, shipTypeID, fittedItems }) => {
      let total = 0;
      if (size.attribute) {
        const attributes = (resourceState && resourceState.attributes) || {};
        total += toNumber(attributes[size.attribute] ?? attributes[String(size.attribute)], 0);
      }
      if (typeof size.base === "function") total += toNumber(size.base(shipTypeID), 0);
      else if (Number.isFinite(Number(size.base))) total += Number(size.base);
      const shipBays = (layerData() || {}).shipBays || {};
      total += toNumber((shipBays[key] || {})[String(shipTypeID)], 0);
      if (size.moduleAttribute) total += moduleAttributeSum(fittedItems, size.moduleAttribute, size.slots);
      return Math.round(total * 1e6) / 1e6;
    },
    accepts: (type) => {
      if (!type) return false;
      if (types.has(toInt(type.typeID)) || groups.has(toInt(type.groupID)) || categories.has(toInt(type.categoryID))) return true;
      return test ? test(type) === true : false;
    },
  });
  bays.set(flag, bay);
  emitChanged({ reason: "addBay", flag });
  return bay;
}

function removeModBays(modID) {
  for (const [flag, bay] of [...bays]) {
    if (!bay.mod || bay.mod !== modID) continue;
    bays.delete(flag);
    emitChanged({ reason: "removeBay", flag });
  }
}

// The sum of a dogma attribute over the online fitted modules (in `slots`,
// default every fitted module).
function moduleAttributeSum(fittedItems, attributeID, slots = null) {
  let total = 0;
  const slotSet = Array.isArray(slots) ? new Set(slots.map(Number)) : slots === "low" ? LOW_SLOT_FLAGS : null;
  for (const item of Array.isArray(fittedItems) ? fittedItems : []) {
    if (!item || (slotSet && !slotSet.has(toInt(item.flagID)))) continue;
    let online = true;
    try { online = fitting().isModuleOnline(item); } catch (_) { online = true; }
    if (!online) continue;
    let attributes = {};
    try { attributes = fitting().getTypeDogmaAttributes(toInt(item.typeID)) || {}; } catch (_) { attributes = {}; }
    total += toNumber(attributes[attributeID] ?? attributes[String(attributeID)], 0);
  }
  return total;
}

const bayOf = (flag) => { ensureRegistryHolds(); return bays.get(toInt(flag)) || null; };
const bayName = (flag) => {
  const bay = bayOf(flag);
  return bay ? bay.name : "hold";
};
const list = () => { ensureRegistryHolds(); return [...bays.values()]; };

// ---------------------------------------------------------------------------
// Ships, fitting snapshots and room.

function shipOf(shipOrID) {
  if (shipOrID && typeof shipOrID === "object" && toInt(shipOrID.itemID) > 0) return shipOrID;
  const shipID = toInt(shipOrID);
  if (shipID <= 0) return null;
  try {
    return itemStore().findItemById(shipID) || null;
  } catch (_) {
    return null;
  }
}

// The fitting snapshot (fittingRuntime.getShipFittingSnapshot) of a ship, for
// the pilot `characterID` or its owner.
function snapshotOf(ship, characterID = 0, reason = "holds") {
  const shipItem = shipOf(ship);
  if (!shipItem) return null;
  try {
    return game("_secondary/fitting/fittingRuntime").getShipFittingSnapshot(
      toInt(characterID) || toInt(shipItem.ownerID), toInt(shipItem.itemID), { shipItem, reason },
    ) || null;
  } catch (error) {
    log().warn(`[reverie-holds] no fitting snapshot for ship ${shipItem.itemID}: ${error.message}`);
    return null;
  }
}

// A view of one ship that reads its snapshot and contents once.
function view(ship, options = {}) {
  const shipItem = shipOf(ship);
  if (!shipItem) return null;
  // A caller that only counts contents passes resourceState {} and no
  // snapshot is built.
  const snapshot = options.snapshot || (options.resourceState ? null : snapshotOf(shipItem, options.characterID, options.reason));
  const resourceState = (options.resourceState) || (snapshot && snapshot.resourceState) || null;
  const fittedItems = (snapshot && snapshot.fittedItems) || (resourceState && resourceState.fittedItems) || [];
  const sizeContext = { resourceState, shipTypeID: toInt(shipItem.typeID), fittedItems, shipItem };
  let contents = null;
  const items = () => {
    if (!contents) {
      try {
        contents = itemStore().listContainerItems(null, toInt(shipItem.itemID), null) || [];
      } catch (_) {
        contents = [];
      }
    }
    return contents;
  };
  const capacityCache = new Map();
  const capacity = (flag) => {
    const bay = bayOf(flag);
    if (!bay || !resourceState) return 0;
    if (!capacityCache.has(bay.flag)) {
      let value = 0;
      try { value = toNumber(bay.capacity(sizeContext), 0); } catch (error) {
        log().warn(`[reverie-holds] ${bay.name} capacity failed: ${error.message}`);
      }
      capacityCache.set(bay.flag, Math.max(0, value));
    }
    return capacityCache.get(bay.flag);
  };
  const usedCache = new Map();
  const used = (flag) => {
    const key = toInt(flag);
    if (!usedCache.has(key)) {
      let total = 0;
      for (const item of items()) if (toInt(item && item.flagID) === key) total += stackVolume(item);
      usedCache.set(key, Math.round(total * 1e6) / 1e6);
    }
    return usedCache.get(key);
  };
  const free = (flag) => Math.max(0, capacity(flag) - used(flag));
  const holding = (flag, typeID) => items().some((item) =>
    toInt(item && item.flagID) === toInt(flag) && (typeID === undefined || toInt(item.typeID) === toInt(typeID)));
  return { shipItem, snapshot, resourceState, capacity, used, free, items, holding };
}

function capacity(ship, flag, options = {}) {
  const v = view(ship, options);
  return v ? v.capacity(flag) : 0;
}

function used(ship, flag) {
  const v = view(ship, { resourceState: {} });
  return v ? v.used(flag) : 0;
}

function free(ship, flag, options = {}) {
  const v = view(ship, options);
  return v ? v.free(flag) : 0;
}

// Whether a bay takes this item or type (an EVE bay by its own rules).
function accepts(flag, itemOrTypeID) {
  const bay = bayOf(flag);
  if (!bay) return false;
  const type = typeRecordOf(itemOrTypeID);
  if (!type) return false;
  try {
    return bay.accepts(type) === true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Placing and pulling.

// The bays an item of this type goes to, in order, with their room: the bays
// that take it and that the ship has, specialised before general, then cargo
// unless a bay that takes it is exclusive or options.cargo is false.
function route(ship, typeID, options = {}) {
  const v = options.view || view(ship, options);
  if (!v) return [];
  const type = typeRecordOf(typeID);
  if (!type) return [];
  const out = [];
  let exclusive = false;
  for (const bay of list()) {
    if (bay.flag === CARGO_FLAG || (!bay.routable && !(options.flags || []).includes(bay.flag))) continue;
    if (Array.isArray(options.only) && !options.only.includes(bay.flag)) continue;
    let takes = false;
    try { takes = bay.accepts(type) === true; } catch (_) { takes = false; }
    if (!takes) continue;
    const cap = v.capacity(bay.flag);
    if (!(cap > EPSILON)) continue;
    // Exclusive only on a ship that has the bay: one without it keeps cargo.
    if (bay.exclusive) exclusive = true;
    out.push({ flag: bay.flag, key: bay.key, name: bay.name, priority: bay.priority, capacity: cap, used: v.used(bay.flag), free: v.free(bay.flag) });
  }
  out.sort((a, b) => (b.priority - a.priority) || (a.flag - b.flag));
  if (!exclusive && options.cargo !== false) {
    out.push({ flag: CARGO_FLAG, key: "cargo", name: BAY_NAMES[CARGO_FLAG], priority: PRIORITY.cargo,
      capacity: v.capacity(CARGO_FLAG), used: v.used(CARGO_FLAG), free: v.free(CARGO_FLAG) });
  }
  return out;
}

// The flags to take an item of this type from, in the route's order: every bay
// that takes it and holds some (even at zero size, so a bay that lost its
// module can still be emptied), then cargo.
function sources(ship, typeID, options = {}) {
  const v = options.view || view(ship, options);
  if (!v) return [CARGO_FLAG];
  const type = typeRecordOf(typeID);
  const flags = [];
  const seen = new Set();
  for (const step of route(ship, typeID, { ...options, view: v, cargo: false, flags: [DRONE_BAY_FLAG, FIGHTER_BAY_FLAG] })) {
    flags.push(step.flag);
    seen.add(step.flag);
  }
  for (const bay of list()) {
    if (seen.has(bay.flag) || bay.flag === CARGO_FLAG) continue;
    if (v.holding(bay.flag, typeID) && type && accepts(bay.flag, type)) {
      flags.push(bay.flag);
      seen.add(bay.flag);
    }
  }
  flags.push(CARGO_FLAG);
  return flags;
}

// What the ship holds of a type in each source flag: [{ flag, quantity }].
// Counts what itemStore.takeItemTypeFromCharacterLocation can take: the ship
// owner's own items, never a blueprint copy (singleton 2), by quantity.
function holdings(ship, typeID, options = {}) {
  const v = options.view || view(ship, options);
  if (!v) return [];
  const ownerID = toInt(v.shipItem.ownerID);
  const out = [];
  for (const flag of options.sources || sources(ship, typeID, { ...options, view: v })) {
    let quantity = 0;
    for (const item of v.items()) {
      if (toInt(item && item.flagID) !== flag || toInt(item.typeID) !== toInt(typeID)) continue;
      if (toInt(item.ownerID) !== ownerID || toInt(item.singleton) === 2) continue;
      quantity += toInt(item.singleton) === 1 ? 1 : Math.max(0, toInt(item.quantity ?? item.stacksize, 0));
    }
    if (quantity > 0) out.push({ flag, quantity });
  }
  return out;
}

function sessionFor(characterID, given) {
  if (given) return given;
  const sessions = tryGame("services/chat/sessionRegistry");
  try {
    return sessions && typeof sessions.findSessionByCharacterID === "function"
      ? sessions.findSessionByCharacterID(toInt(characterID)) || null
      : null;
  } catch (_) {
    return null;
  }
}

// Tells the pilot's client about item changes, including a stack used up
// whole, which is sent as a move to the junk location so no ghost stays in the
// window (census point 9).
function syncChanges(session, changes = []) {
  if (!session) return;
  const character = tryGame("services/character/characterState");
  const store = itemStore();
  if (!character || typeof character.syncInventoryItemForSession !== "function") return;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change) continue;
    if (change.removed === true && !change.item && change.previousData) {
      const removedState = typeof store.buildRemovedItemNotificationState === "function"
        ? store.buildRemovedItemNotificationState(change.previousData) : null;
      if (removedState) character.syncInventoryItemForSession(session, removedState, change.previousData, { emitCfgLocation: true });
      continue;
    }
    if (!change.item) continue;
    character.syncInventoryItemForSession(session, change.item,
      change.previousData || change.previousState || { locationID: 0, flagID: change.item.flagID }, { emitCfgLocation: true });
  }
}

// Places items in a ship along each item's route. entries: [{ typeID,
// quantity, options? }]. Checks the room at every step and never drops what
// does not fit: that comes back in `left` for the caller to deal with.
// Returns { placed: [{ flag, typeID, quantity }], left: [{ typeID, quantity }] }.
function grant(ship, entries, options = {}) {
  const shipItem = shipOf(ship);
  const placed = [];
  const left = [];
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!shipItem) return { placed, left: list.map((e) => ({ typeID: toInt(e.typeID), quantity: toInt(e.quantity) })) };
  const ownerID = toInt(shipItem.ownerID);
  const v = view(shipItem, options);
  const freeByFlag = new Map();
  const freeOf = (flag) => (freeByFlag.has(flag) ? freeByFlag.get(flag) : v.free(flag));
  const session = sessionFor(options.characterID || ownerID, options.session);
  for (const entry of list) {
    const typeID = toInt(entry.typeID);
    let remaining = Math.max(0, toInt(entry.quantity));
    const each = unitVolume(typeID);
    const steps = route(shipItem, typeID, { ...options, view: v });
    for (const step of steps) {
      if (remaining <= 0) break;
      const room = freeOf(step.flag);
      const fits = each > 0 ? Math.min(remaining, Math.floor((room + EPSILON) / each)) : remaining;
      if (fits <= 0) continue;
      const result = itemStore().grantItemsToCharacterLocation(ownerID, toInt(shipItem.itemID), step.flag,
        [{ itemType: typeID, quantity: fits, ...(entry.options ? { options: entry.options } : {}) }]);
      if (!result || !result.success) {
        log().warn(`[reverie-holds] grant of ${fits} x ${typeID} to ${step.name} failed: ${result && result.errorMsg}`);
        continue;
      }
      syncChanges(session, result.data && result.data.changes);
      freeByFlag.set(step.flag, room - fits * each);
      placed.push({ flag: step.flag, typeID, quantity: fits });
      remaining -= fits;
    }
    if (remaining > 0) left.push({ typeID, quantity: remaining });
  }
  if (placed.length) emitChanged({ reason: "grant", shipID: toInt(shipItem.itemID), purpose: options.purpose || null });
  return { placed, left };
}

// Takes `quantity` of a type from a ship, across its sources in order. Takes
// nothing unless all of it is there. Returns { success, receipt, available }.
function take(ship, request = {}) {
  const shipItem = shipOf(ship);
  const typeID = toInt(request.typeID);
  const quantity = Math.max(0, toInt(request.quantity));
  if (!shipItem || typeID <= 0) return { success: false, available: 0, receipt: null };
  const ownerID = toInt(shipItem.ownerID);
  const have = holdings(shipItem, typeID, { ...request, resourceState: request.resourceState || {} });
  const available = have.reduce((sum, h) => sum + h.quantity, 0);
  if (available < quantity) return { success: false, available, receipt: null };
  const session = sessionFor(request.characterID || ownerID, request.session);
  const taken = [];
  let remaining = quantity;
  for (const { flag, quantity: there } of have) {
    if (remaining <= 0) break;
    const n = Math.min(there, remaining);
    const result = itemStore().takeItemTypeFromCharacterLocation(ownerID, toInt(shipItem.itemID), flag, typeID, n);
    if (!result || !result.success) break;
    syncChanges(session, result.data && result.data.changes);
    taken.push({ flag, quantity: n });
    remaining -= n;
  }
  const receipt = { shipID: toInt(shipItem.itemID), ownerID, typeID, taken };
  if (remaining > 0) {
    // All or nothing: put back what was taken before the shortfall.
    const owed = quantity - remaining;
    const given = owed > 0 ? giveBack(receipt, owed, { session }) : 0;
    if (given < owed) log().warn(`[reverie-holds] take of ${quantity} x ${typeID} from ship ${receipt.shipID} fell short and could give back only ${given} of ${owed}`);
    return { success: false, available, receipt: null };
  }
  if (taken.length) emitChanged({ reason: "take", shipID: receipt.shipID });
  return { success: true, available, receipt };
}

// Returns items a module took and could not use to the bays they came from,
// most recent first, up to what the receipt took. Returns the quantity given back.
function giveBack(receipt, quantity, options = {}) {
  if (!receipt || !Array.isArray(receipt.taken)) return 0;
  let remaining = Math.max(0, toInt(quantity));
  const session = sessionFor(options.characterID || receipt.ownerID, options.session);
  let given = 0;
  for (const part of [...receipt.taken].reverse()) {
    if (remaining <= 0) break;
    const n = Math.min(part.quantity, remaining);
    const result = itemStore().grantItemsToCharacterLocation(receipt.ownerID, receipt.shipID, part.flag, [{ itemType: receipt.typeID, quantity: n }]);
    if (!result || !result.success) continue;
    syncChanges(session, result.data && result.data.changes);
    part.quantity -= n;
    remaining -= n;
    given += n;
  }
  if (given) emitChanged({ reason: "giveBack", shipID: receipt.shipID });
  return given;
}

// ---------------------------------------------------------------------------
// Bills of materials, for a module that builds or refines from what the ship
// carries (a field assembler): every type in the bill is looked for in every
// bay that takes it or holds it, a mod's own bays included, then cargo. Never
// the drone or fighter bay: those hold what the pilot flies with.

function billOf(bill) {
  const merged = new Map();
  for (const line of Array.isArray(bill) ? bill : [bill]) {
    const typeID = toInt(line && line.typeID);
    const quantity = Math.max(0, toInt(line && line.quantity));
    if (typeID > 0 && quantity > 0) merged.set(typeID, (merged.get(typeID) || 0) + quantity);
  }
  return [...merged].map(([typeID, quantity]) => ({ typeID, quantity }));
}

function materialSources(ship, typeID, options) {
  const flying = new Set([DRONE_BAY_FLAG, FIGHTER_BAY_FLAG]);
  const all = sources(ship, typeID, options).filter((flag) => !flying.has(flag));
  // options.from narrows the search to some flags, in its own order.
  if (!Array.isArray(options.from)) return all;
  const allowed = new Set(all);
  return options.from.map((flag) => toInt(flag)).filter((flag) => allowed.has(flag));
}

// What the ship has of each line in a bill: { complete, lines: [{ typeID,
// quantity, available, missing, where: [{ flag, quantity }] }], missing:
// [{ typeID, quantity }], plan: [{ flag, typeID, quantity }], freed: { flag: m3 } }.
// plan and freed are what takeMaterials would take and the room it would leave,
// so a caller can check its product fits before taking anything.
function materials(ship, bill, options = {}) {
  const v = options.view || view(ship, { ...options, resourceState: options.resourceState || {} });
  const lines = [];
  const missing = [];
  const plan = [];
  const freed = {};
  for (const { typeID, quantity } of billOf(bill)) {
    const where = v ? holdings(ship, typeID, { ...options, view: v, sources: materialSources(ship, typeID, { ...options, view: v }) }) : [];
    const available = where.reduce((sum, h) => sum + h.quantity, 0);
    const short = Math.max(0, quantity - available);
    lines.push({ typeID, quantity, available, missing: short, where });
    if (short > 0) missing.push({ typeID, quantity: short });
    let remaining = quantity;
    for (const h of where) {
      if (remaining <= 0) break;
      const n = Math.min(h.quantity, remaining);
      plan.push({ flag: h.flag, typeID, quantity: n });
      freed[h.flag] = (freed[h.flag] || 0) + n * unitVolume(typeID);
      remaining -= n;
    }
  }
  return { complete: missing.length === 0, lines, missing, plan: missing.length ? [] : plan, freed: missing.length ? {} : freed };
}

// Takes a whole bill or nothing. Returns { success, receipts, missing }; the
// receipts are plain data a caller may save to disk and hand to
// giveBackMaterials later (a cancelled job).
function takeMaterials(ship, bill, options = {}) {
  const shipItem = shipOf(ship);
  if (!shipItem) return { success: false, receipts: [], missing: billOf(bill) };
  const check = materials(shipItem, bill, options);
  if (!check.complete) return { success: false, receipts: [], missing: check.missing };
  const receipts = [];
  // Each take looks at the ship afresh: a view given for the check is stale after the first.
  const { view: _checked, ...rest } = options;
  for (const line of check.lines) {
    const result = take(shipItem, { ...rest, typeID: line.typeID, quantity: line.quantity,
      sources: line.where.map((h) => h.flag) });
    if (!result.success) {
      giveBackMaterials(receipts, options);
      return { success: false, receipts: [], missing: [{ typeID: line.typeID, quantity: Math.max(0, line.quantity - toInt(result.available)) }] };
    }
    receipts.push(result.receipt);
  }
  return { success: true, receipts, missing: [] };
}

// Gives back everything the receipts still hold, to the bays it came from.
// Returns { given: [{ typeID, quantity }], left: [{ typeID, quantity }] };
// what is left (a bay since filled up or gone) is the caller's to place, in a
// can or through grant.
function giveBackMaterials(receipts, options = {}) {
  const given = [];
  const left = [];
  for (const receipt of Array.isArray(receipts) ? receipts : [receipts]) {
    if (!receipt || !Array.isArray(receipt.taken)) continue;
    const owed = receipt.taken.reduce((sum, part) => sum + Math.max(0, toInt(part.quantity)), 0);
    if (owed <= 0) continue;
    const n = giveBack(receipt, owed, options);
    if (n > 0) given.push({ typeID: toInt(receipt.typeID), quantity: n });
    if (n < owed) left.push({ typeID: toInt(receipt.typeID), quantity: owed - n });
  }
  return { given, left };
}

// ---------------------------------------------------------------------------
// The holds.changed hook point.

function emitChanged(detail) {
  const hooks = globalThis[Symbol.for("reverie.hooks")];
  if (hooks && typeof hooks.emit === "function") hooks.emit("holds.changed", detail);
}

function reset() {
  bays.clear();
  registryHoldsAdded = false;
  registerBuiltIns();
}

registerBuiltIns();

module.exports = {
  CARGO_FLAG,
  DRONE_BAY_FLAG,
  FIGHTER_BAY_FLAG,
  FUEL_BAY_FLAG,
  BAY_NAMES,
  PRIORITY,
  addBay,
  removeModBays,
  bayOf,
  bayName,
  list,
  shipOf,
  snapshotOf,
  view,
  capacity,
  used,
  free,
  accepts,
  route,
  sources,
  holdings,
  grant,
  take,
  giveBack,
  materials,
  takeMaterials,
  giveBackMaterials,
  syncChanges,
  stackVolume,
  unitVolume,
  typeRecordOf,
  moduleAttributeSum,
  reset,
};
