"use strict";

// What wreckCutting.js needs from the mining runtime to run a cutter, built
// from the internals the mod's text edit adds to miningRuntime.js
// (edits/miningRuntime.exports.js, reverieInternals) and from game modules
// that export what they need. Built per call, so a hot reload of any of them
// reaches the next cycle.

const { game } = require("./game");

const toInt = (value, fallback = 0) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const round6 = (value) => Math.round(value * 1e6) / 1e6;

function cutHelpers() {
  const mining = game("services/mining/miningRuntime");
  const inner = typeof mining.reverieInternals === "function" ? mining.reverieInternals() : {};
  const { canEntitiesInteractLocally } = game("space/destiny/identity/interactionScope");
  const { isNativeNpcEntity } = game("space/npc/npcEquipment");
  const { getShipHoldCapacityByFlag } = game("services/mining/miningInventory");
  const itemStore = game("services/inventory/itemStore");
  return {
    buildEntityMiningSnapshot: inner.buildEntityMiningSnapshot,
    getTargetsForEntity: inner.getTargetsForEntity,
    getMiningCommandSurfaceDistance: inner.getMiningCommandSurfaceDistance,
    canEntitiesInteractLocally,
    // A Field Reclaimer puts minerals straight into the hold.
    holdRoom(entity, typeID) {
      if (isNativeNpcEntity(entity)) return { flagID: itemStore.ITEM_FLAGS.CARGO_HOLD, availableVolume: Number.POSITIVE_INFINITY };
      return inner.resolveDestinationFlagForPlayer(entity, typeID);
    },
    grantToHold(entity, flagID, entries) {
      const granted = itemStore.grantItemsToCharacterLocation(inner.resolveEntityCharacterID(entity), toInt(entity.itemID), flagID, entries);
      if (granted && granted.success && granted.data && entity.session) {
        inner.syncMinedOreChangesToSession(entity.session, toInt(entity.itemID), granted.data.changes);
      }
      return granted;
    },
    // Any hold's size and free room with the fit applied.
    holdSpace(entity, flagID) {
      const snapshot = inner.getPlayerShipStorageSnapshot(entity);
      if (!snapshot || !snapshot.resourceState) return { capacity: 0, used: 0, available: 0 };
      const flag = toInt(flagID);
      const capacity = flag === itemStore.ITEM_FLAGS.CARGO_HOLD
        ? toNumber(snapshot.resourceState.cargoCapacity)
        : toNumber(getShipHoldCapacityByFlag(snapshot.resourceState, flag));
      const used = toNumber(snapshot.usedByFlag && snapshot.usedByFlag.get(flag));
      return { capacity, used, available: Math.max(0, round6(capacity - used)) };
    },
  };
}

// True when the text edit that hands these internals over is in place.
function available() {
  try {
    return typeof game("services/mining/miningRuntime").reverieInternals === "function";
  } catch (_) {
    return false;
  }
}

module.exports = { cutHelpers, available };
