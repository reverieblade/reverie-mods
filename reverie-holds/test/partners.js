"use strict";

// Runs inside the test install (test/run.js) when Reverie's Salvage and Reclamation sits beside
// this mod, with both enabled and the type layer on from boot. Salvage hands Holds its module
// bays: a Salvager I gives a Rifter a Salvage Hold that takes salvage and scrap, and salvage
// leaves Loot All to Holds, which sends salvage to that hold.

const assert = require("assert");
const path = require("path");

const core = globalThis[Symbol.for("reverie.core")];
const game = (relative) => require(core.paths.resolveTarget(relative));
const own = (name) => require(path.join(__dirname, "..", "server", "lib", name));

let failures = 0;
let stopped = false;
function check(name, fn) {
  if (stopped) { console.log(`--    skipped: ${name}`); return; }
  try { fn(); console.log(`ok    ${name}`); } catch (error) {
    failures += 1;
    stopped = true;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}

const RIFTER = 587;
const SALVAGER_I = 25861;
const SALVAGER_II = 30836;
const METAL_SCRAPS = 15331;
const ALLOYED_TRITANIUM_BAR = 25595;
const VELDSPAR = 1230;
const SALVAGE_HOLD = 137;
const CARGO = 5;
const HIGH_SLOT = 27;
const CHARACTER_ID = 140000912;
const STATION_ID = 60003760;
const SYSTEM_ID = 30000142;

const family = own("bayFamily");
const registry = game("services/inventory/itemTypeRegistry");
const itemStore = game("services/inventory/itemStore");
const fittingRuntime = game("_secondary/fitting/fittingRuntime");
const liveFitting = game("services/fitting/liveFittingState");
const service = core.services.use("holds", "1");
const InvBroker = game("services/inventory/invBrokerService");
const broker = Object.create(InvBroker.prototype);
broker._boundContexts = new Map();
const session = { characterID: CHARACTER_ID, charid: CHARACTER_ID, stationid: STATION_ID, stationID: STATION_ID, solarsystemid2: SYSTEM_ID };

let ship = null;
const refresh = () => {
  ship = itemStore.findItemById(ship.itemID);
  fittingRuntime.invalidateShipFittingSnapshot(CHARACTER_ID, ship.itemID);
  fittingRuntime.invalidateShipFittingSnapshot(0, ship.itemID);
};
const grant = (flag, typeID, quantity, options = {}) => {
  const granted = itemStore.grantItemToCharacterLocation(CHARACTER_ID, ship.itemID, flag, typeID, quantity, options);
  assert.ok(granted && granted.success, `no ${typeID} in ${flag}: ${granted && granted.errorMsg}`);
  return granted.data.items[0];
};
const windowCapacity = (flag) => Object.fromEntries(
  broker._calculateCapacity(session, { kind: "shipInventory", inventoryID: ship.itemID, flagID: flag }, flag).args.entries).capacity;

check("both mods are loaded and Holds alone replaces Loot All", () => {
  assert.ok(core.typeLayer.status().active, core.typeLayer.status().reason);
  const states = Object.fromEntries(core.status().mods.map((mod) => [mod.id, mod.state]));
  for (const id of ["reverie-holds", "reverie-salvage"]) assert.ok(["patched", "running"].includes(states[id]), `${id} is ${states[id]}`);
  const entries = core.patcher.status().entries;
  for (const name of ["Handle_Add", "Handle_MultiAdd"]) {
    const entry = entries.find((e) => e.target.endsWith(`prototype.${name}`) && /invBrokerService/.test(e.target));
    assert.ok(entry, `${name} is not patched`);
    assert.strictEqual(entry.replacedBy, "reverie-holds");
  }
  assert.deepStrictEqual(core.patcher.status().problems, []);
});

check("Salvager I and II carry a Salvage Hold of 500 and 750 m3", () => {
  const data = own("game").layerData();
  assert.strictEqual(data.moduleBays[String(SALVAGER_I)].bay, "salvage");
  for (const [typeID, m3] of [[SALVAGER_I, 500], [SALVAGER_II, 750]]) {
    const attributes = liveFitting.getTypeDogmaAttributes(typeID) || {};
    assert.strictEqual(Number(attributes[family.ATTR.bayAdded]), m3, `${typeID} adds ${attributes[family.ATTR.bayAdded]}`);
  }
  const reclaimers = Object.values(data.moduleBays).filter((bay) => bay.bay === "mineral");
  assert.deepStrictEqual(reclaimers.map((bay) => bay.m3).sort(), [1000, 1500]);
});

check("a Salvager I fitted to a Rifter gives it a 500 m3 Salvage Hold", () => {
  const wrote = game("gameStore/index").write("characters", `/${CHARACTER_ID}`, {
    characterID: CHARACTER_ID, characterName: "Salvage Pilot", stationID: STATION_ID, solarSystemID: SYSTEM_ID,
  });
  assert.ok(wrote && wrote.success !== false, `no pilot: ${wrote && wrote.errorMsg}`);
  const spawned = itemStore.spawnShipInStationHangar(CHARACTER_ID, STATION_ID, registry.resolveItemByTypeID(RIFTER));
  assert.ok(spawned && spawned.success, `no Rifter: ${spawned && spawned.errorMsg}`);
  ship = spawned.data;
  assert.strictEqual(windowCapacity(SALVAGE_HOLD), 0);
  const module = grant(HIGH_SLOT, SALVAGER_I, 1, { singleton: 1 });
  itemStore.updateInventoryItem(module.itemID, (row) => ({ ...row, singleton: 1, moduleState: { online: true } }));
  refresh();
  assert.strictEqual(service.capacity(ship, SALVAGE_HOLD, { characterID: CHARACTER_ID }), 500);
  assert.strictEqual(windowCapacity(SALVAGE_HOLD), 500);
});

check("the Salvage Hold takes salvage and scrap and refuses ore", () => {
  for (const typeID of [ALLOYED_TRITANIUM_BAR, METAL_SCRAPS]) {
    const item = grant(CARGO, typeID, 5);
    assert.deepStrictEqual(broker._validateShipBayMove(session, ship, item, { locationID: ship.itemID, flagID: SALVAGE_HOLD }), { success: true }, `${typeID} refused`);
  }
  const ore = grant(CARGO, VELDSPAR, 5);
  const refused = broker._validateShipBayMove(session, ship, ore, { locationID: ship.itemID, flagID: SALVAGE_HOLD });
  assert.strictEqual(refused && refused.success, false, "ore went into the Salvage Hold");
});

check("Loot All sends salvage to the Salvage Hold and leaves ore for cargo", () => {
  const can = [
    { itemID: 9900011, typeID: ALLOYED_TRITANIUM_BAR, quantity: 20, stacksize: 20, singleton: 0, locationID: 9900010 },
    { itemID: 9900012, typeID: VELDSPAR, quantity: 20, stacksize: 20, singleton: 0, locationID: 9900010 },
  ];
  const fake = Object.create(broker);
  fake._findTransferSourceItem = (itemID) => ({ item: can.find((item) => item.itemID === Number(itemID)) || null });
  fake._resolveShipDogmaCharacterID = () => CHARACTER_ID;
  const picked = own("lootRouting").pickBays(fake, session, { shipRecord: ship, sourceID: 9900010 }, [9900011, 9900012]);
  assert.deepStrictEqual([...picked], [[9900011, SALVAGE_HOLD]]);
});

console.log(failures ? `${failures} failed` : "partners passed");
process.exit(failures ? 1 : 0);
