"use strict";

// Loot that the Salvage Hold accepts goes there by itself (2026-11-17).
//
// In space, when a pilot moves items from somewhere else (a wreck, a
// container, a jettisoned can) into the ship's cargo hold, by Loot All or by
// dragging, every stack the Salvage Hold accepts and has room for goes into
// that hold instead. Everything else goes to cargo as asked.
//
// The pilot's own choice stands in every other case:
//   - a move between the ship's own holds (salvage hold to cargo, say);
//   - a drop onto any hold other than the plain cargo hold;
//   - anything done while docked.
//
// It works by replacing InvBrokerService.prototype.Handle_Add and
// Handle_MultiAdd through Reverie (server/index.js, api.replace) and asking
// for flag 137 on the stacks that qualify. The rules (what the hold accepts,
// its free room, the EVEJS_SALVAGE_HOLD_AUTO switch) are in
// salvageHoldRouting.js, looked up per call.

const { game } = require("./game");

const CARGO_FLAG = 5;

const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const routing = () => require("./salvageHoldRouting");
const log = () => game("utils/logger");

// The ship record when this call is loot going into the plain cargo hold of a
// ship in space from somewhere other than that ship; null otherwise.
function lootTarget(service, args, session, kwargs) {
  if (!session || toInt(session.stationid) > 0 || toInt(session.structureid) > 0) return null;
  const bound = service._getBoundContext(session);
  if (!bound || bound.kind !== "shipInventory") return null;
  const explicit = service._extractKwarg(kwargs, "flag");
  const flagID = explicit !== undefined ? toInt(explicit) : toInt(bound.flagID);
  if (flagID !== CARGO_FLAG) return null;
  const shipID = toInt(bound.inventoryID);
  const sourceID = toInt(args && args.length > 1 ? args[1] : 0);
  if (shipID <= 0 || sourceID <= 0 || sourceID === shipID) return null;
  const shipRecord = service._getShipInventoryRecord(session, bound);
  if (!shipRecord || toInt(shipRecord.itemID) !== shipID) return null;
  return { shipRecord, sourceID };
}

function stackVolume(item, quantity) {
  let each = Number(item && item.volume);
  if (!(each >= 0)) {
    const type = game("services/inventory/itemTypeRegistry").resolveItemByTypeID(toInt(item && item.typeID));
    each = Math.max(0, Number(type && type.volume) || 0);
  }
  const stack = toInt(item && item.singleton) === 1 ? 1 : Math.max(1, toInt(item && (item.stacksize ?? item.quantity), 1));
  return each * (quantity > 0 ? Math.min(quantity, stack) : stack);
}

// Of itemIDs, the ones to send to the salvage hold: accepted by it, and
// fitting whole in the room left. Order is kept.
function pickForHold(service, session, target, itemIDs, quantity = 0) {
  const rules = routing();
  const characterID = typeof service._resolveShipDogmaCharacterID === "function"
    ? service._resolveShipDogmaCharacterID(session, target.shipRecord)
    : toInt(session.characterID || session.charid);
  let free = rules.holdFree(characterID, target.shipRecord);
  const picked = [];
  if (!(free > 0)) return picked;
  for (const itemID of itemIDs) {
    const found = service._findTransferSourceItem(itemID, target.sourceID);
    const item = found && found.item;
    if (!item || !rules.holdAccepts(item.typeID)) continue;
    const volume = stackVolume(item, quantity);
    if (volume > free + 1e-6) continue;
    picked.push(itemID);
    free -= volume;
  }
  return picked;
}

function wrapAdd(original) {
  return function salvageHoldAdd(args, session, kwargs) {
    let toHold = false;
    try {
      const target = lootTarget(this, args, session, kwargs);
      if (target) {
        const itemID = toInt(args && args[0]);
        const quantity = toInt(this._extractKwarg(kwargs, "qty") ?? this._extractKwarg(kwargs, "quantity"));
        toHold = itemID > 0 && pickForHold(this, session, target, [itemID], quantity).length === 1;
      }
    } catch (error) {
      toHold = false;
      try { log().warn(`[SalvageHoldLoot] Add routing skipped: ${error.message}`); } catch (_) { /* no log */ }
    }
    return toHold
      ? original.call(this, args, session, { ...(kwargs || {}), flag: routing().SALVAGE_HOLD_FLAG })
      : original.call(this, args, session, kwargs);
  };
}

function wrapMultiAdd(original) {
  return function salvageHoldMultiAdd(args, session, kwargs) {
    let forHold = [];
    let rest = null;
    try {
      const target = lootTarget(this, args, session, kwargs);
      if (target) {
        const itemIDs = [...new Set(this._normalizeItemIdList(args && args.length > 0 ? args[0] : []))];
        forHold = pickForHold(this, session, target, itemIDs);
        const inHold = new Set(forHold);
        rest = itemIDs.filter((itemID) => !inHold.has(itemID));
      }
    } catch (error) {
      forHold = [];
      try { log().warn(`[SalvageHoldLoot] MultiAdd routing skipped: ${error.message}`); } catch (_) { /* no log */ }
    }
    if (!forHold.length) return original.call(this, args, session, kwargs);
    const withItems = (itemIDs) => [itemIDs, ...args.slice(1)];
    const holdResult = original.call(this, withItems(forHold), session, {
      ...(kwargs || {}), flag: routing().SALVAGE_HOLD_FLAG,
    });
    if (!rest.length) return holdResult;
    return original.call(this, withItems(rest), session, kwargs);
  };
}

// Replacements in Reverie's shape: (original, ...args), called with the
// service as `this`.
function handleAdd(original, args, session, kwargs) {
  return wrapAdd(original).call(this, args, session, kwargs);
}

function handleMultiAdd(original, args, session, kwargs) {
  return wrapMultiAdd(original).call(this, args, session, kwargs);
}

module.exports = { handleAdd, handleMultiAdd, lootTarget, pickForHold };
