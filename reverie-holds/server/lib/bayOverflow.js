"use strict";

// When the module comes off (doc/REVERIE_HOLDS.md): no bay of a ship, not only
// the cargo hold, may be left holding more than its size when a fitted item
// that enlarges it stops applying. A pilot could otherwise fill a bay a module
// gave the ship, then unfit, offline, trash or trade the module and keep the
// cargo. EveJS already refuses that for the cargo hold
// (fittingRuntime.getCargoOverflowWithoutItems), and every caller of that
// function (unfit, strip fitting, destroy fitted item, trade, offline) asks
// this file too through the mod's postfix on it.
//
// The same sizes answer whether a ship is overfull, which stops an undock.
//
// Ported from the Scarlet build's services/inventory/bayOverflow.js. Sizes and
// names come from the bay table (bays.js), so a bay another mod adds is
// guarded the same way as EVE's own.

const bays = require("./bays");

const toInt = (value, fallback = 0) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};
const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const EPSILON = 1e-7;

// The bay's name as a sentence uses it: "the cargo hold", "the Mining Hold".
function bayName(flagID) {
  const flag = toInt(flagID);
  if (flag === bays.CARGO_FLAG) return "cargo hold";
  return bays.bayName(flag);
}

// The size of one bay in a fitted resource state, or null for a flag the bay
// table does not know (fitting slots, the ship and fleet hangars).
function bayCapacity(resourceState, shipTypeID, flagID, fittedItems = null) {
  const bay = bays.bayOf(flagID);
  if (!bay || !resourceState) return null;
  try {
    return Math.max(0, toNumber(bay.capacity({
      resourceState,
      shipTypeID: toInt(shipTypeID),
      fittedItems: fittedItems || resourceState.fittedItems || [],
    }), 0));
  } catch (_) {
    return null;
  }
}

// { flagID: m3 used } for every bay of the ship the table knows that holds anything.
function usedByBay(shipID) {
  const used = new Map();
  const view = bays.view(toInt(shipID), { resourceState: {} });
  if (!view) return used;
  for (const item of view.items()) {
    const flag = toInt(item && item.flagID);
    if (!bays.bayOf(flag)) continue;
    used.set(flag, (used.get(flag) || 0) + bays.stackVolume(item));
  }
  return used;
}

// The first bay that would be left over its size if these fitted items stopped
// applying, or null. `snapshot` is the ship's fitting from before the change
// (fittingRuntime.getShipFittingSnapshot). addedByFlag is volume the same
// change puts into a bay, such as the module itself unfitted to cargo. A bay
// that is already over its size for another reason does not block a change
// that leaves its size alone. Returns { flagID, bayName, used, capacityBefore,
// capacityAfter }.
function overflowWithoutItems(snapshot, itemIDs, addedByFlag = {}) {
  if (!snapshot || typeof snapshot.buildResourceStateForItems !== "function") return null;
  const leaving = new Set((Array.isArray(itemIDs) ? itemIDs : [itemIDs]).map((id) => toInt(id)));
  const fittedItems = Array.isArray(snapshot.fittedItems) ? snapshot.fittedItems : [];
  const remainingItems = fittedItems.filter((item) => !leaving.has(toInt(item && item.itemID)));
  if (remainingItems.length === fittedItems.length) return null;
  const shipID = toInt(snapshot.shipID || (snapshot.shipItem && snapshot.shipItem.itemID));
  const shipTypeID = toInt(snapshot.shipItem && snapshot.shipItem.typeID);
  const used = usedByBay(shipID);
  for (const [flag, extra] of Object.entries(addedByFlag || {})) {
    if (toNumber(extra, 0) > 0) used.set(toInt(flag), (used.get(toInt(flag)) || 0) + toNumber(extra, 0));
  }
  if (used.size === 0) return null;
  const after = snapshot.buildResourceStateForItems(remainingItems);
  if (!after) return null;
  for (const [flag, usedM3] of [...used.entries()].sort((a, b) => a[0] - b[0])) {
    if (!(usedM3 > EPSILON)) continue;
    const capacityBefore = bayCapacity(snapshot.resourceState, shipTypeID, flag, fittedItems);
    const capacityAfter = bayCapacity(after, shipTypeID, flag, remainingItems);
    if (capacityBefore === null || capacityAfter === null) continue;
    if (capacityAfter >= capacityBefore - EPSILON || usedM3 <= capacityAfter + EPSILON) continue;
    return { flagID: flag, bayName: bayName(flag), used: usedM3, capacityBefore, capacityAfter };
  }
  return null;
}

// Every bay of the ship that holds more than its size now: [{ flagID, bayName,
// used, capacity }]. Used before an undock.
function overfullBays(characterID, shipItem) {
  const shipID = toInt(shipItem && shipItem.itemID);
  if (shipID <= 0) return [];
  const used = usedByBay(shipID);
  if (used.size === 0) return [];
  const snapshot = bays.snapshotOf(shipItem, characterID, "holds.undock");
  if (!snapshot || !snapshot.resourceState) return [];
  const out = [];
  for (const [flag, usedM3] of [...used.entries()].sort((a, b) => a[0] - b[0])) {
    const capacity = bayCapacity(snapshot.resourceState, toInt(shipItem.typeID), flag, snapshot.fittedItems);
    if (capacity === null || !(usedM3 > capacity + 1e-6)) continue;
    out.push({ flagID: flag, bayName: bayName(flag), used: usedM3, capacity });
  }
  return out;
}

const m3Text = (value) => Number((Number(value) || 0).toFixed(2)).toLocaleString("en-US");

// The refusal for removing or offlining a module. `action` is "removed" or
// "put offline".
function refusalText(overflow, action = "removed") {
  const name = overflow && overflow.bayName ? overflow.bayName : "cargo hold";
  return `That module cannot be ${action === "removed" ? "removed" : "put offline"} while the ${name} is this full. ` +
    `The ${name} carries ${m3Text(overflow && overflow.used)} m3 and the ship would be left with room for ` +
    `${m3Text(overflow && overflow.capacityAfter)} m3. Move some of it out first.`;
}

function undockRefusalText(list) {
  const overfull = Array.isArray(list) ? list : [];
  if (overfull.length === 0) return "";
  const closing = "Move the excess into the station before you undock.";
  if (overfull.length === 1) {
    const bay = overfull[0];
    return `Your ship cannot undock while the ${bay.bayName} carries more than it has room for. ` +
      `It carries ${m3Text(bay.used)} m3 and has room for ${m3Text(bay.capacity)} m3. ${closing}`;
  }
  const parts = overfull.map((bay) => `The ${bay.bayName} carries ${m3Text(bay.used)} m3 and has room for ${m3Text(bay.capacity)} m3.`);
  return `Your ship cannot undock while its holds carry more than they have room for. ${parts.join(" ")} ${closing}`;
}

// A bot never has an undock refused: it cannot move cargo by hand, and a
// refused undock would leave it waiting.
function isBotSession(session) {
  return Boolean(session && (session._playerBotActor === true || session.sessionType === "playerbot" ||
    session.sessionType === "playerbot-actor" || (session.socket && session.socket.playerBotSink === true)));
}

// The refusal text for an undock, or "" when the ship may go.
function undockRefusal(session, shipItem) {
  if (!session || isBotSession(session) || !shipItem) return "";
  const overfull = overfullBays(session.characterID || session.charid, shipItem);
  return overfull.length ? undockRefusalText(overfull) : "";
}

module.exports = {
  undockRefusal,
  isBotSession,
  bayName,
  bayCapacity,
  usedByBay,
  overflowWithoutItems,
  overfullBays,
  refusalText,
  undockRefusalText,
};
