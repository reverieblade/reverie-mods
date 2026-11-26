"use strict";

// Loot All sends items to their bay (README.md, "Placing items").
//
// In space, when a pilot moves items from somewhere else (a wreck, a
// container, a jettisoned can) into the ship's cargo hold, by Loot All or by
// dragging, every stack a bay of the ship takes and has room for goes to that
// bay instead: ore to the Mining Hold, salvage to the Salvage Hold, charges to
// the Ammo Hold. The bay is chosen by the holds service's route, so a bay
// another mod adds takes part too. Everything else goes to cargo as asked.
//
// The pilot's own choice stands in every other case:
//   - a move between the ship's own holds;
//   - a drop onto any hold other than the plain cargo hold;
//   - anything done while docked.
//
// It replaces InvBrokerService.prototype.Handle_Add and Handle_MultiAdd
// (server/index.js) and calls the original once for each bay chosen, so every
// rule the game checks on a move still applies. Generalised from
// reverie-salvage's salvageHoldLootRouting.js, which stands aside when this mod
// is installed.
//
// Setting lootToBay (tunable EVEJS_HOLDS_LOOT_TO_BAY): off sends everything to
// cargo again.

const { flag, log } = require("./game");
const bays = require("./bays");

const CARGO_FLAG = 5;
const EPSILON = 1e-6;

const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

function enabled() {
  return flag("EVEJS_HOLDS_LOOT_TO_BAY", true);
}

// The ship record when this call is loot going into the plain cargo hold of a
// ship in space from somewhere other than that ship; null otherwise.
function lootTarget(service, args, session, kwargs) {
  if (!session || toInt(session.stationid) > 0 || toInt(session.structureid) > 0) return null;
  const bound = service._getBoundContext(session);
  if (!bound || bound.kind !== "shipInventory") return null;
  const explicit = service._extractKwarg(kwargs, "flag");
  const flagID = explicit !== undefined && explicit !== null ? toInt(explicit) : toInt(bound.flagID);
  if (flagID !== CARGO_FLAG) return null;
  const shipID = toInt(bound.inventoryID);
  const sourceID = toInt(args && args.length > 1 ? args[1] : 0);
  if (shipID <= 0 || sourceID <= 0 || sourceID === shipID) return null;
  const shipRecord = service._getShipInventoryRecord(session, bound);
  if (!shipRecord || toInt(shipRecord.itemID) !== shipID) return null;
  return { shipRecord, sourceID };
}

function movedVolume(item, quantity) {
  const each = bays.unitVolume(item);
  const stack = toInt(item && item.singleton) === 1 ? 1 : Math.max(1, toInt(item && (item.stacksize ?? item.quantity), 1));
  return each * (quantity > 0 ? Math.min(quantity, stack) : stack);
}

// itemID -> the bay flag each stack goes to, for the stacks that go to a bay
// other than cargo: the first bay on the stack's route that takes it whole.
// A stack is never split between bays, so the pilot sees whole stacks move.
function pickBays(service, session, target, itemIDs, quantity = 0) {
  const picked = new Map();
  const characterID = typeof service._resolveShipDogmaCharacterID === "function"
    ? service._resolveShipDogmaCharacterID(session, target.shipRecord)
    : toInt(session.characterID || session.charid);
  const view = bays.view(target.shipRecord, { characterID, reason: "holds.loot" });
  if (!view || !view.resourceState) return picked;
  const freeLeft = new Map();
  const freeOf = (flagID) => (freeLeft.has(flagID) ? freeLeft.get(flagID) : view.free(flagID));
  for (const itemID of itemIDs) {
    const found = service._findTransferSourceItem(itemID, target.sourceID);
    const item = found && found.item;
    if (!item) continue;
    const volume = movedVolume(item, quantity);
    for (const step of bays.route(target.shipRecord, item.typeID, { view, cargo: false })) {
      const room = freeOf(step.flag);
      if (volume > room + EPSILON) continue;
      picked.set(itemID, step.flag);
      freeLeft.set(step.flag, room - volume);
      break;
    }
  }
  return picked;
}

function handleAdd(original, args, session, kwargs) {
  let toFlag = 0;
  try {
    const target = enabled() ? lootTarget(this, args, session, kwargs) : null;
    if (target) {
      const itemID = toInt(args && args[0]);
      const quantity = toInt(this._extractKwarg(kwargs, "qty") ?? this._extractKwarg(kwargs, "quantity"));
      if (itemID > 0) toFlag = pickBays(this, session, target, [itemID], quantity).get(itemID) || 0;
    }
  } catch (error) {
    toFlag = 0;
    log().warn(`[reverie-holds] Loot routing skipped for Add: ${error.message}`);
  }
  return toFlag
    ? original.call(this, args, session, { ...(kwargs || {}), flag: toFlag })
    : original.call(this, args, session, kwargs);
}

function handleMultiAdd(original, args, session, kwargs) {
  let byFlag = null;
  let rest = null;
  try {
    const target = enabled() ? lootTarget(this, args, session, kwargs) : null;
    if (target) {
      const itemIDs = [...new Set(this._normalizeItemIdList(args && args.length > 0 ? args[0] : []))];
      const picked = pickBays(this, session, target, itemIDs);
      if (picked.size) {
        byFlag = new Map();
        for (const [itemID, flagID] of picked) {
          if (!byFlag.has(flagID)) byFlag.set(flagID, []);
          byFlag.get(flagID).push(itemID);
        }
        rest = itemIDs.filter((itemID) => !picked.has(itemID));
      }
    }
  } catch (error) {
    byFlag = null;
    log().warn(`[reverie-holds] Loot routing skipped for MultiAdd: ${error.message}`);
  }
  if (!byFlag) return original.call(this, args, session, kwargs);
  const withItems = (itemIDs) => [itemIDs, ...args.slice(1)];
  // The cargo batch goes first. The game checks a Loot All's room up front and
  // refuses the whole batch when it does not fit, so a refusal here leaves
  // everything where it was. The bay batches were sized to fit by pickBays.
  let result = null;
  if (rest.length) result = original.call(this, withItems(rest), session, kwargs);
  for (const [flagID, itemIDs] of byFlag) {
    const moved = original.call(this, withItems(itemIDs), session, { ...(kwargs || {}), flag: flagID });
    if (!rest.length) result = moved;
  }
  return result;
}

module.exports = { handleAdd, handleMultiAdd, lootTarget, pickBays, enabled };
