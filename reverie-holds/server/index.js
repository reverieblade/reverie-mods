"use strict";

// Reverie's Holds and Bays, server side (README.md, GUIDE.md). Everything the
// mod changes in the game is declared here:
//
//   moves         a bay a module gives the ship takes items like one the hull
//                 was built with, and a mod's own bay has its rules and size
//   guards        no unfit, offline or undock while a bay would be left over
//                 its size
//   routing       Loot All into cargo sends items to their bay, mining lasers
//                 fall through from a full specialised hold to the Mining
//                 Hold, charges load from the Ammo Hold, deliveries count the
//                 bays an item could be in
//   loot          bay extensions drop from NPCs that would carry them
//   service       "holds" for other mods: the bay table, routes, placing and
//                 pulling items, and addBay for a bay of their own
//
// Hot reload: `node mods/reverie-core/cli.js reload reverie-holds` drops the
// mod's files and declares all of this again; every wrapper looks its library
// up per call. The text edit in agentMissionRuntime.js (deliveries) is the one
// part that needs a server start, since it lives in a game file.

const fs = require("fs");
const path = require("path");

const lib = (name) => require(`./lib/${name}`);
const toInt = (value, fallback = 0) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

const CARGO_FLAG = 5;
const HOOK_MARKER = "holds.deliveryStacks";
const EPSILON = 1e-6;

// This repository's own build already has all of this in its game files
// (services/inventory/bayOverflow.js and the bay extension family). Hooking it
// twice would refuse moves twice and drop extensions twice.
function hasLocalBuild(api) {
  return fs.existsSync(path.join(api.paths.srcRoot, "services", "inventory", "bayOverflow.js")) ||
    fs.existsSync(path.join(api.paths.srcRoot, "services", "shipSystems", "bayExtensionFamily.js"));
}

function fileHas(api, relative, marker) {
  try {
    return fs.readFileSync(path.join(api.paths.srcRoot, relative), "utf8").includes(marker);
  } catch (_) {
    return false;
  }
}

function characterFor(service, session, shipRecord) {
  if (service && typeof service._resolveShipDogmaCharacterID === "function") {
    try {
      const id = toInt(service._resolveShipDogmaCharacterID(session, shipRecord));
      if (id > 0) return id;
    } catch (_) { /* fall back to the session */ }
  }
  return toInt(session && (session.characterID || session.charid)) || toInt(shipRecord && shipRecord.ownerID);
}

function customNotify(api, text) {
  api.require("common/machoErrors").throwWrappedUserError("CustomNotify", { notify: String(text) });
}

// ---------------------------------------------------------------------------
// Moves into a bay, and the size the inventory window shows.

function patchMoves(api) {
  const bays = () => lib("bays");
  // EveJS sizes a special hold from the hull alone when it checks a move, so a
  // bay a module gives the ship refused everything. The fitted size decides
  // here. A mod's own bay gets its rules and its size checked the same way.
  api.replace("services/inventory/invBrokerService", "prototype._validateShipBayMove",
    function validateShipBayMove(original, session, shipRecord, item, destination) {
      const result = original(session, shipRecord, item, destination);
      if (!shipRecord || !item || !destination || toInt(destination.locationID) !== toInt(shipRecord.itemID)) return result;
      const flag = toInt(destination.flagID);
      const bay = bays().bayOf(flag);
      if (!bay || flag === CARGO_FLAG) return result;
      const characterID = characterFor(this, session, shipRecord);
      if (!bay.builtIn) {
        if (!result || result.success !== true) return result;
        if (!bays().accepts(flag, item)) {
          return { success: false, errorMsg: "SHIP_BAY_ITEM_NOT_ALLOWED", userMessage: bay.refusal };
        }
        if (!(bays().capacity(shipRecord, flag, { characterID }) > EPSILON)) {
          return { success: false, errorMsg: "SHIP_BAY_ITEM_NOT_ALLOWED", userMessage: `Your ship has no ${bay.name}.` };
        }
        return result;
      }
      if (result && result.success === false && result.errorMsg === "SHIP_BAY_ITEM_NOT_ALLOWED" &&
          api.require("services/inventory/specialShipHoldRegistry").isGenericSpecialShipHoldFlag(flag) &&
          bays().accepts(flag, item) && bays().capacity(shipRecord, flag, { characterID }) > EPSILON) {
        return { success: true };
      }
      return result;
    });

  // EveJS already shows every bay of its own at its fitted size. A mod's own
  // bay is unknown to it, and its default for an unknown flag is 1,000,000 m3,
  // so its size and contents are counted here for any bind that names a ship
  // (the ship's inventory, or the bay bound on its own as [shipID, flag]).
  api.replace("services/inventory/invBrokerService", "prototype._calculateCapacity",
    function calculateCapacity(original, session, boundContext, requestedFlag = null) {
      const flag = requestedFlag !== null && requestedFlag !== undefined ? toInt(requestedFlag)
        : boundContext && boundContext.flagID !== null && boundContext.flagID !== undefined ? toInt(boundContext.flagID) : 0;
      const bay = flag > 0 ? bays().bayOf(flag) : null;
      if (boundContext && bay && !bay.builtIn) {
        const ship = typeof this._getShipInventoryRecord === "function"
          ? this._getShipInventoryRecord(session, boundContext)
          : api.require("services/inventory/itemStore").findItemById(toInt(boundContext.inventoryID));
        if (ship && toInt(ship.categoryID) === 6) {
          const view = bays().view(ship, { characterID: characterFor(this, session, ship), reason: "holds.window" });
          return this._buildCapacityInfo(view ? view.capacity(flag) : 0, view ? view.used(flag) : 0);
        }
      }
      return original(session, boundContext, requestedFlag);
    });
}

// ---------------------------------------------------------------------------
// The module comes off: unfit, offline, undock.

function patchGuards(api) {
  const overflow = () => lib("bayOverflow");
  // Every caller of this (unfit, strip fitting, destroy fitted item, trade,
  // offline) now hears about the other bays too, after the cargo hold.
  api.patch("_secondary/fitting/fittingRuntime", "getCargoOverflowWithoutItems", {
    postfix(ctx, result, [snapshot, itemIDs, addedCargoVolume]) {
      if (result) return undefined;
      const added = Number(addedCargoVolume) > 0 ? { [CARGO_FLAG]: Number(addedCargoVolume) } : {};
      return overflow().overflowWithoutItems(snapshot, itemIDs, added) || undefined;
    },
  });
  api.replace("services/inventory/invBrokerService", "prototype._throwUnfitCargoOverflowUserError",
    function throwUnfitOverflow(original, data) {
      if (data && data.bayName && toInt(data.flagID) !== CARGO_FLAG) customNotify(api, overflow().refusalText(data, "removed"));
      return original(data);
    });
  api.replace("services/dogma/dogmaService/moduleOperation", "_throwModuleOnlineUserError",
    function throwModuleOnline(original, errorMsg, moduleItem, data, ...rest) {
      if (errorMsg === "CARGO_WOULD_OVERFLOW" && data && data.bayName && toInt(data.flagID) !== CARGO_FLAG) {
        return this._throwCustomNotifyUserError(overflow().refusalText(data, "put offline"));
      }
      return original(errorMsg, moduleItem, data, ...rest);
    });

  // A ship whose bays hold more than their size stays docked until the excess
  // is moved out. Bots are never refused.
  const refuseUndock = (session, shipItem) => {
    const text = shipItem ? overflow().undockRefusal(session, shipItem) : "";
    if (text) customNotify(api, text);
  };
  api.replace("services/ship/shipService", "prototype.Handle_Undock", function handleUndock(original, args, session, kwargs) {
    const character = api.require("services/character/characterState");
    refuseUndock(session, character.getActiveShipRecord(session && session.characterID));
    return original(args, session, kwargs);
  });
  api.replace("services/structure/structureDockingService", "prototype.Handle_Undock", function handleUndock(original, args, session, kwargs) {
    const shipID = toInt(args && args[1]) || toInt(session && (session.shipID || session.shipid));
    if (shipID > 0) refuseUndock(session, api.require("services/inventory/itemStore").findItemById(shipID));
    return original(args, session, kwargs);
  });
}

// ---------------------------------------------------------------------------
// Where items go and where they are taken from.

function patchRouting(api) {
  const bays = () => lib("bays");
  const game = () => lib("game");

  // Loot All. Salvage 0.3.0 and later stands aside for this; an older one
  // that loaded first keeps its own Salvage Hold routing, and the core logs it.
  api.replace("services/inventory/invBrokerService", "prototype.Handle_Add", function handleAdd(original, ...args) {
    return lib("lootRouting").handleAdd.call(this, original, ...args);
  });
  api.replace("services/inventory/invBrokerService", "prototype.Handle_MultiAdd", function handleMultiAdd(original, ...args) {
    return lib("lootRouting").handleMultiAdd.call(this, original, ...args);
  });

  // Mining lasers fill the hold made for what they mine, as in EVE, then the
  // Mining Hold when that one is full (a Mining Hold Extension on an ice
  // ship). With every hold full the laser stops, or spills into cargo when
  // the pilot turned laserOverflow on.
  api.patch("services/mining/miningInventory", "getPreferredMiningHoldFlagForType", {
    postfix(ctx, flagID, [resourceState, itemOrTypeID]) {
      const chosen = toInt(flagID);
      if (chosen <= 0 || !resourceState) return undefined;
      const fitted = Array.isArray(resourceState.fittedItems) ? resourceState.fittedItems : [];
      const shipID = toInt(resourceState.signatureRadiusCalculation && resourceState.signatureRadiusCalculation.shipID) ||
        toInt((fitted.find((item) => item && toInt(item.locationID) > 0) || {}).locationID);
      if (shipID <= 0) return undefined;
      const view = bays().view(shipID, { resourceState });
      if (!view) return undefined;
      const each = bays().unitVolume(itemOrTypeID);
      const fits = (flag) => view.capacity(flag) > EPSILON && view.free(flag) + EPSILON >= each;
      if (fits(chosen)) return undefined;
      if (chosen !== 134 && bays().accepts(134, itemOrTypeID) && fits(134)) return 134;
      return game().flag("EVEJS_HOLDS_LASER_OVERFLOW", false) ? null : undefined;
    },
  });

  // LoadAmmo names the hold the charges lie in; a reload with none named in
  // the ship looks in cargo. When cargo has none and a bay does (the Ammo
  // Hold), the charges come from there.
  api.patch("services/dogma/dogmaService/moduleOperation", "_resolveAmmoSourceHoldFlag", {
    postfix(ctx, flagID, [shipID, chargeRequests]) {
      if (toInt(flagID) !== CARGO_FLAG) return undefined;
      const store = api.require("services/inventory/itemStore");
      const typeIDs = new Set();
      for (const request of Array.isArray(chargeRequests) ? chargeRequests : []) {
        const item = store.findItemById(toInt(request && request.itemID));
        const typeID = toInt(item ? item.typeID : request && request.typeID);
        if (typeID > 0) typeIDs.add(typeID);
      }
      if (!typeIDs.size) return undefined;
      const view = bays().view(toInt(shipID), { resourceState: {} });
      if (!view) return undefined;
      for (const typeID of typeIDs) {
        const where = bays().holdings(toInt(shipID), typeID, { view });
        if (where.some((h) => h.flag === CARGO_FLAG)) return undefined;
        const bay = where.find((h) => h.flag !== CARGO_FLAG);
        if (bay) return bay.flag;
      }
      return undefined;
    },
  });

  // Deliveries and courier checks that look in a ship's cargo hold count the
  // bays the item could be in (the mod's edit to agentMissionRuntime.js).
  api.hooks.on("holds.deliveryStacks", (value, characterID, locationID, flagID, typeID) => {
    if (toInt(flagID) !== CARGO_FLAG) return undefined;
    const store = api.require("services/inventory/itemStore");
    const ship = store.findItemById(toInt(locationID));
    if (!ship || toInt(ship.categoryID) !== 6) return undefined;
    const out = [];
    // Never the drones or fighters a pilot flies with: a delivery counts what
    // was put away in a bay, as cargo would have held it.
    const flying = new Set([bays().DRONE_BAY_FLAG, bays().FIGHTER_BAY_FLAG]);
    for (const flag of bays().sources(ship, typeID, { resourceState: {} })) {
      if (flying.has(flag)) continue;
      for (const item of store.listContainerItems(toInt(characterID), toInt(locationID), flag)) {
        if (toInt(item && item.typeID) === toInt(typeID)) out.push(item);
      }
    }
    return out;
  });
}

// A stack used up whole comes back from the item store as { removed,
// previousData, item: null }, and EveJS's sync skipped it, leaving a ghost
// stack in the client's window. Only where the game file does not already
// send it.
function patchSync(api) {
  if (fileHas(api, "services/chat/commands/commandInventorySync.js", "buildRemovedItemNotificationState")) return;
  api.patch("services/chat/commands/commandInventorySync", "syncInventoryChangesToSession", {
    prefix(ctx, [session, changes]) {
      const removed = (Array.isArray(changes) ? changes : []).filter((c) => c && c.removed === true && !c.item && c.previousData);
      if (removed.length) lib("bays").syncChanges(session, removed);
      return undefined;
    },
  });
}

function patchLoot(api) {
  api.patch("space/npc/npcLoot", "rollNpcLootEntries", {
    postfix(ctx, entries, [lootTable, options]) {
      if (!Array.isArray(entries)) return undefined;
      // Only where the table rolls random modules: none without a table, or
      // where it turns random loot off.
      if (!lootTable || lootTable.disableRandomLoot === true ||
          (toInt(lootTable.minEntries ?? 1) === 0 && toInt(lootTable.maxEntries ?? 1) === 0)) return undefined;
      const opts = options || {};
      const source = { ...(opts.source || {}) };
      // The game's own random source, so a seeded roll replays; a seed of our
      // own beside the table's, so this roll is not the table's first draw.
      const rng = api.require("common/random");
      source.random = opts.random || source.random ||
        (source.seed !== undefined && source.seed !== null ? rng.createRng(`${source.seed}:reverie-holds`) : rng.random);
      const registry = api.require("services/inventory/itemTypeRegistry");
      if (toInt(source.npcTypeID) > 0 && (!source.npcTypeName || !source.npcGroupName)) {
        const npcType = registry.resolveItemByTypeID(toInt(source.npcTypeID));
        if (npcType) {
          source.npcTypeName = source.npcTypeName || npcType.name;
          source.npcGroupName = source.npcGroupName || npcType.groupName;
        }
      }
      const drop = lib("npcBayLoot").rollBayExtension(source);
      const itemType = drop ? registry.resolveItemByTypeID(drop.typeID) : null;
      if (!itemType) return undefined;
      return [...entries, { itemType, typeID: itemType.typeID, name: itemType.name, quantity: drop.quantity, singleton: 0 }];
    },
  });
}

// ---------------------------------------------------------------------------
// The service other mods use (GUIDE.md).

function provideService(api) {
  const bays = () => lib("bays");
  api.provide("holds", "1.0.0", {
    // The bay table.
    bays: () => bays().list().map(({ key, flag, name, priority, routable, exclusive, builtIn, mod }) =>
      ({ key, flag, name, priority, routable, exclusive, builtIn, mod })),
    bay: (flag) => bays().bayOf(flag),
    bayName: (flag) => bays().bayName(flag),
    // A bay of a mod's own: { key, flag, name, size, accepts, refusal,
    // exclusive, priority, routable }. definition.mod names the mod.
    addBay: (definition) => bays().addBay(definition, definition && definition.mod ? String(definition.mod) : null),
    removeBays: (modID) => bays().removeModBays(modID),
    // Sizes and room, from the fitted ship.
    capacity: (ship, flag, options) => bays().capacity(ship, flag, options),
    used: (ship, flag) => bays().used(ship, flag),
    free: (ship, flag, options) => bays().free(ship, flag, options),
    accepts: (flag, itemOrTypeID) => bays().accepts(flag, itemOrTypeID),
    // Where an item goes and where it is taken from.
    route: (ship, typeID, options) => bays().route(ship, typeID, options),
    sources: (ship, typeID, options) => bays().sources(ship, typeID, options),
    holdings: (ship, typeID, options) => bays().holdings(ship, typeID, options),
    grant: (ship, entries, options) => bays().grant(ship, entries, options),
    take: (ship, request) => bays().take(ship, request),
    giveBack: (receipt, quantity, options) => bays().giveBack(receipt, quantity, options),
    // The guards.
    overflowWithoutItems: (snapshot, itemIDs, addedByFlag) => lib("bayOverflow").overflowWithoutItems(snapshot, itemIDs, addedByFlag),
    overfullBays: (characterID, shipItem) => lib("bayOverflow").overfullBays(characterID, shipItem),
    // Settings.
    moduleOutputCan: () => lib("game").flag("EVEJS_HOLDS_MODULE_OUTPUT_CAN", true),
  });
}

// ---------------------------------------------------------------------------

function patches(api) {
  if (hasLocalBuild(api)) {
    api.log.warn("this build already has bay extensions in its own files (services/inventory/bayOverflow.js); the mod stays idle");
    return;
  }
  lib("bays").reset();
  patchMoves(api);
  patchGuards(api);
  patchRouting(api);
  patchSync(api);
  patchLoot(api);
  provideService(api);
}

// The type layer's after pass, contributions and edits.categories came with
// core 0.3.0. An older core builds the extensions but none of the bays other
// mods give, and refuses the hull edits.
function coreTooOld(version) {
  const [major, minor] = String(version || "0").split(".").map((part) => toInt(part));
  return major === 0 && minor < 3;
}

function init(api) {
  if (hasLocalBuild(api)) return;
  if (coreTooOld(api.coreVersion)) {
    api.log.warn(`Reverie Core ${api.coreVersion} is older than 0.3.0; update it in the launcher, or bays from other mods and the hull edits are left out`);
  }
  if (!fileHas(api, "services/agent/agentMissionRuntime.js", HOOK_MARKER)) {
    api.log.warn("agentMissionRuntime.js has no Reverie hook point; enable the mod through the launcher or `cli.js enable reverie-holds` so deliveries count the bays");
  }
  const data = lib("game").layerData();
  if (!data) {
    api.log.warn("the type layer is off, so the server knows none of the bay extensions; patch the client through the launcher to turn it on");
    return;
  }
  for (const problem of Array.isArray(data.problems) ? data.problems : []) api.log.warn(`skipped a bay from another mod: ${problem}`);
}

function dispose() {
  // Nothing held: patches, hooks and the service are let go by the core.
}

module.exports = { patches, init, dispose, _testing: { hasLocalBuild, coreTooOld } };
