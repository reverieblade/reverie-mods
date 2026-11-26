"use strict";

// Salvage goes to the salvage hold first (2026-11-17), the way ore goes to a
// mining ship's ore hold.
//
// When a salvager takes a wreck or a hull panel apart, every reward the
// Salvage Hold accepts (specialShipHoldRegistry: salvaged parts, alloys and
// compounds, Metal Scraps) fills that hold first, a whole unit at a time. What
// does not fit, and anything the hold refuses, goes to the cargo hold as
// before. A ship with no salvage hold behaves as it always did. The hold may be
// the hull's own (Noctis) or one a Salvage Hold Extension adds
// (doc/BAY_EXTENSIONS.md): the size comes from the fitted ship.
//
// Callers: the salvage.extraRoom and salvage.rewardSplit hooks in
// space/modules/salvagerRuntime.js (plain wrecks, server/index.js) and
// wreckCutting.js salvagePanelCycle (hull panels). No state.
//
// Tunable EVEJS_SALVAGE_HOLD_AUTO: 0 sends everything to cargo again.

const { game, flag } = require("./game");

const SALVAGE_HOLD_FLAG = 137;

const src = (relative) => game(relative);
const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

function enabled() {
  return flag("EVEJS_SALVAGE_HOLD_AUTO", true);
}

function unitVolume(typeID) {
  const type = src("services/inventory/itemTypeRegistry").resolveItemByTypeID(toInt(typeID));
  return Math.max(0, Number(type && type.volume) || 0);
}

function holdAccepts(typeID) {
  try {
    return src("services/inventory/specialShipHoldRegistry")
      .isSpecialShipHoldItemAllowed(toInt(typeID), SALVAGE_HOLD_FLAG) === true;
  } catch (_) {
    return false;
  }
}

function usedVolume(items) {
  let sum = 0;
  for (const item of items || []) {
    if (!item) continue;
    const units = toInt(item.singleton) === 1 ? 1 : Math.max(0, toInt(item.stacksize ?? item.quantity));
    sum += Math.max(0, Number(item.volume) || 0) * units;
  }
  return sum;
}

// Free room in the ship's salvage hold, in m3. 0 when the ship has none, when
// the feature is off, or when the size cannot be read.
function holdFree(characterID, shipItem) {
  const shipID = toInt(shipItem && shipItem.itemID);
  if (!enabled() || toInt(characterID) <= 0 || shipID <= 0) return 0;
  try {
    const registry = src("services/inventory/specialShipHoldRegistry");
    const snapshot = src("_secondary/fitting/fittingRuntime").getShipFittingSnapshot(toInt(characterID), shipID, {
      shipItem,
      reason: "salvage.holdRouting",
    });
    const resourceState = snapshot && snapshot.resourceState ? snapshot.resourceState : null;
    const { getShipBaseAttributeValue } = src("services/fitting/liveFittingState");
    const capacity = Number(registry.getSpecialShipHoldCapacity(
      resourceState, shipItem.typeID, SALVAGE_HOLD_FLAG, getShipBaseAttributeValue,
    )) || 0;
    if (!(capacity > 0)) return 0;
    const used = usedVolume(src("services/inventory/itemStore")
      .listContainerItems(toInt(characterID), shipID, SALVAGE_HOLD_FLAG));
    return Math.max(0, Math.round((capacity - used) * 1e6) / 1e6);
  } catch (_) {
    return 0;
  }
}

// Split reward entries ({ itemType, quantity }) between the salvage hold and
// the cargo hold, whole units only, in the order given. `left` is what fits in
// neither; `fitted` is hold + cargo merged back per type, in the same order.
function plan(entries, cargoFree, salvageFree) {
  let holdRoom = Math.max(0, Number(salvageFree) || 0);
  let cargoRoom = Math.max(0, Number(cargoFree) || 0);
  const out = { hold: [], cargo: [], left: [], fitted: [] };
  for (const entry of entries || []) {
    const typeID = toInt(entry && entry.itemType);
    let quantity = Math.max(0, toInt(entry && entry.quantity));
    if (typeID <= 0 || quantity <= 0) continue;
    const each = unitVolume(typeID);
    const take = (room) => (each > 0 ? Math.min(quantity, Math.floor((room + 1e-6) / each)) : quantity);
    let fitted = 0;
    if (holdRoom > 0 && holdAccepts(typeID)) {
      const units = take(holdRoom);
      if (units > 0) {
        out.hold.push({ ...entry, itemType: typeID, quantity: units });
        holdRoom -= units * each;
        quantity -= units;
        fitted += units;
      }
    }
    if (quantity > 0) {
      const units = take(cargoRoom);
      if (units > 0) {
        out.cargo.push({ ...entry, itemType: typeID, quantity: units });
        cargoRoom -= units * each;
        quantity -= units;
        fitted += units;
      }
    }
    if (fitted > 0) out.fitted.push({ ...entry, itemType: typeID, quantity: fitted });
    if (quantity > 0) out.left.push({ ...entry, itemType: typeID, quantity });
  }
  return out;
}

// Grant a plan's cargo and hold parts into the ship. Returns the item store's
// shape, { success, data: { changes } }, with both grants' changes together.
// If the hold grant fails, its entries go to cargo instead.
function grantPlan(characterID, shipID, split) {
  const itemStore = src("services/inventory/itemStore");
  const changes = [];
  const grant = (flagID, entries) => {
    if (!entries || !entries.length) return true;
    const result = itemStore.grantItemsToCharacterLocation(toInt(characterID), toInt(shipID), flagID, entries);
    if (!result || !result.success) return false;
    changes.push(...((result.data && result.data.changes) || []));
    return true;
  };
  if (!grant(itemStore.ITEM_FLAGS.CARGO_HOLD, split && split.cargo)) {
    return { success: false, errorMsg: "SALVAGE_CARGO_GRANT_FAILED", data: { changes } };
  }
  if (!grant(SALVAGE_HOLD_FLAG, split && split.hold) &&
      !grant(itemStore.ITEM_FLAGS.CARGO_HOLD, split && split.hold)) {
    return { success: false, errorMsg: "SALVAGE_HOLD_GRANT_FAILED", data: { changes } };
  }
  return { success: true, data: { changes } };
}

module.exports = { SALVAGE_HOLD_FLAG, enabled, holdAccepts, holdFree, plan, grantPlan };
