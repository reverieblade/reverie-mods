"use strict";

// Runs inside the test install (test/run.js) after probe.js, in a process started with
// REVERIE_TYPE_LAYER=server, so the type layer is on from boot as on a trial server. One pilot's
// Rifter, which has no Mining Hold or Ammo Hold of its own, goes through the game's own code:
// a Mining Hold Extension gives it a Mining Hold, the bay takes ore and refuses minerals, ore is
// placed and taken across the bays, the module cannot come off or go offline while the bay is
// full, the ship cannot undock overfull, the laser falls through and charges load from the Ammo
// Hold, deliveries count the bays, and NPC miners drop extensions.

const assert = require("assert");
const fs = require("fs");
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
    stopped = true; // each step needs the one before it
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}

const RIFTER = 587;
const VELDSPAR = 1230;
const TRITANIUM = 34;
const EMP_S = 185;
const MINING_HOLD = 134;
const AMMO_HOLD = 143;
const CARGO = 5;
const CHARACTER_ID = 140000911;
const STATION_ID = 60003760;
const SYSTEM_ID = 30000142;

const family = own("bayFamily");
const extension = (bay, size = "small", tier = "t1") => family.variants().find((v) => v.bay === bay && v.size === size && v.tier === tier);
const MINING_EXTENSION = extension("mining");
const AMMO_EXTENSION = extension("ammo");

const registry = game("services/inventory/itemTypeRegistry");
const itemStore = game("services/inventory/itemStore");
const fittingRuntime = game("_secondary/fitting/fittingRuntime");
const service = core.services.use("holds", "1");
const InvBroker = game("services/inventory/invBrokerService");
// The broker's methods, without its constructor's asset safety and observer work.
const broker = Object.create(InvBroker.prototype);
broker._boundContexts = new Map();

let ship = null;
let miningModule = null;
let ammoModule = null;
const session = { characterID: CHARACTER_ID, charid: CHARACTER_ID, stationid: STATION_ID, stationID: STATION_ID, solarsystemid2: SYSTEM_ID };

const refresh = () => {
  ship = itemStore.findItemById(ship.itemID);
  fittingRuntime.invalidateShipFittingSnapshot(CHARACTER_ID, ship.itemID);
  fittingRuntime.invalidateShipFittingSnapshot(0, ship.itemID);
};
const snapshot = () => fittingRuntime.getShipFittingSnapshot(CHARACTER_ID, ship.itemID, { shipItem: ship, forceRefresh: true });
const inFlag = (flag, typeID) => (itemStore.listContainerItems(null, ship.itemID, flag) || [])
  .filter((item) => typeID === undefined || Number(item.typeID) === typeID)
  .reduce((sum, item) => sum + Number(item.stacksize ?? item.quantity ?? 0), 0);
const setOnline = (module, online) => {
  const result = itemStore.updateInventoryItem(module.itemID, (item) => ({ ...item, moduleState: { ...(item.moduleState || {}), online } }));
  assert.ok(result && result.success, `module ${module.itemID} not updated: ${result && result.errorMsg}`);
  refresh();
};
const fit = (variant, flagID) => {
  const granted = itemStore.grantItemToCharacterLocation(CHARACTER_ID, ship.itemID, flagID, variant.typeID, 1, { singleton: 1 });
  assert.ok(granted && granted.success, `${variant.name} not fitted: ${granted && granted.errorMsg}`);
  const item = granted.data.items[0];
  const updated = itemStore.updateInventoryItem(item.itemID, (row) => ({ ...row, singleton: 1, moduleState: { online: true } }));
  assert.ok(updated && updated.success, `${variant.name} not onlined`);
  refresh();
  return itemStore.findItemById(item.itemID);
};
const stockOre = (flag, quantity, typeID = VELDSPAR) => {
  const granted = itemStore.grantItemToCharacterLocation(CHARACTER_ID, ship.itemID, flag, typeID, quantity);
  assert.ok(granted && granted.success, `no ${typeID} in ${flag}: ${granted && granted.errorMsg}`);
  return granted.data.items[0];
};
const emptyFlag = (flag) => {
  for (const item of itemStore.listContainerItems(null, ship.itemID, flag) || []) itemStore.removeInventoryItem(item.itemID);
  refresh();
};
// The user error a guard throws, as its text.
const refusalOf = (fn) => {
  try { fn(); } catch (error) {
    return JSON.stringify(error && (error.machoErrorResponse || error.payload || error.args || error.message || error));
  }
  return null;
};

check("the type layer is on from boot and the extensions are server types", () => {
  const status = core.typeLayer.status();
  assert.strictEqual(status.active, true, status.reason);
  assert.ok(own("game").layerData(), "the mod's client data is not in the layer");
  const type = registry.resolveItemByTypeID(MINING_EXTENSION.typeID);
  assert.ok(type, "no Mining Hold Extension type");
  assert.strictEqual(type.name, MINING_EXTENSION.name);
  assert.strictEqual(Number(type.groupID), family.GROUP.groupID);
  const attributes = game("services/fitting/liveFittingState").getTypeDogmaAttributes(MINING_EXTENSION.typeID) || {};
  assert.ok(Number(attributes[family.ATTR.bayAdded]) > 0, "no Bay Capacity Added");
});

check("the pilot has a Rifter in Jita 4-4", () => {
  const wrote = game("gameStore/index").write("characters", `/${CHARACTER_ID}`, {
    characterID: CHARACTER_ID, characterName: "Holds Pilot", stationID: STATION_ID, solarSystemID: SYSTEM_ID,
  });
  assert.ok(wrote && wrote.success !== false, `no pilot: ${wrote && wrote.errorMsg}`);
  const spawned = itemStore.spawnShipInStationHangar(CHARACTER_ID, STATION_ID, registry.resolveItemByTypeID(RIFTER));
  assert.ok(spawned && spawned.success, `no Rifter: ${spawned && spawned.errorMsg}`);
  ship = spawned.data;
  assert.strictEqual(Number(ship.typeID), RIFTER);
  assert.strictEqual(service.capacity(ship, MINING_HOLD, { characterID: CHARACTER_ID }), 0, "a Rifter with a Mining Hold of its own");
});

// EveJS checks a mining hold's item kind in _validateShipBayMove and its room afterwards, from
// the fitted size _calculateCapacity gives (the same number the inventory window shows).
const windowCapacity = (flag) => Object.fromEntries(
  broker._calculateCapacity(session, { kind: "shipInventory", inventoryID: ship.itemID, flagID: flag }, flag).args.entries).capacity;

check("the Rifter has no room in a Mining Hold or Ammo Hold it does not have", () => {
  assert.strictEqual(windowCapacity(MINING_HOLD), 0);
  const charges = stockOre(CARGO, 10, EMP_S);
  const refused = broker._validateShipBayMove(session, ship, charges, { locationID: ship.itemID, flagID: AMMO_HOLD });
  assert.strictEqual(refused && refused.success, false, `charges went into an Ammo Hold the Rifter lacks: ${JSON.stringify(refused)}`);
  emptyFlag(CARGO);
});

let holdSize = 0;
check("a Mining Hold Extension gives the Rifter a Mining Hold, and the hold takes ore and refuses minerals", () => {
  miningModule = fit(MINING_EXTENSION, 11);
  holdSize = service.capacity(ship, MINING_HOLD, { characterID: CHARACTER_ID });
  assert.ok(holdSize > 0, "no Mining Hold with the module online");
  assert.strictEqual(windowCapacity(MINING_HOLD), holdSize, "the window shows another size");
  console.log(`      Mining Hold ${holdSize} m3 from ${MINING_EXTENSION.name}`);
  const ore = stockOre(CARGO, 10);
  const accepted = broker._validateShipBayMove(session, ship, ore, { locationID: ship.itemID, flagID: MINING_HOLD });
  assert.deepStrictEqual(accepted, { success: true });
  const mineral = stockOre(CARGO, 10, TRITANIUM);
  const refused = broker._validateShipBayMove(session, ship, mineral, { locationID: ship.itemID, flagID: MINING_HOLD });
  assert.strictEqual(refused && refused.success, false, "Tritanium went into the Mining Hold");
  emptyFlag(CARGO);
  setOnline(miningModule, false);
  assert.strictEqual(service.capacity(ship, MINING_HOLD, { characterID: CHARACTER_ID }), 0, "the hold stayed with the module offline");
  setOnline(miningModule, true);
});

check("placing: ore fills the Mining Hold first, then cargo, in whole units, and the rest comes back", () => {
  const each = Number(registry.resolveItemByTypeID(VELDSPAR).volume);
  const cargo = service.capacity(ship, CARGO, { characterID: CHARACTER_ID });
  const fitsHold = Math.floor(holdSize / each);
  const fitsCargo = Math.floor(cargo / each);
  const asked = fitsHold + fitsCargo + 7;
  const result = service.grant(ship, [{ typeID: VELDSPAR, quantity: asked }], { characterID: CHARACTER_ID });
  assert.deepStrictEqual(result.placed.map((p) => [p.flag, p.quantity]), [[MINING_HOLD, fitsHold], [CARGO, fitsCargo]]);
  assert.deepStrictEqual(result.left, [{ typeID: VELDSPAR, quantity: 7 }]);
  assert.strictEqual(inFlag(MINING_HOLD, VELDSPAR), fitsHold);
  assert.strictEqual(inFlag(CARGO, VELDSPAR), fitsCargo);
});

check("taking: all or nothing, from the Mining Hold before cargo, and giveBack returns it", () => {
  const have = inFlag(MINING_HOLD, VELDSPAR) + inFlag(CARGO, VELDSPAR);
  const refused = service.take(ship, { typeID: VELDSPAR, quantity: have + 1, characterID: CHARACTER_ID });
  assert.strictEqual(refused.success, false);
  assert.strictEqual(refused.available, have);
  assert.strictEqual(inFlag(MINING_HOLD, VELDSPAR) + inFlag(CARGO, VELDSPAR), have, "a refused take took something");
  const inHold = inFlag(MINING_HOLD, VELDSPAR);
  const taken = service.take(ship, { typeID: VELDSPAR, quantity: inHold + 3, characterID: CHARACTER_ID });
  assert.strictEqual(taken.success, true);
  assert.deepStrictEqual(taken.receipt.taken.map((t) => [t.flag, t.quantity]), [[MINING_HOLD, inHold], [CARGO, 3]]);
  assert.strictEqual(service.giveBack(taken.receipt, inHold + 3, { characterID: CHARACTER_ID }), inHold + 3);
  assert.strictEqual(inFlag(MINING_HOLD, VELDSPAR), inHold);
  // A take that comes up short part way puts back what it had already taken.
  const store = game("services/inventory/itemStore");
  const realTake = store.takeItemTypeFromCharacterLocation;
  store.takeItemTypeFromCharacterLocation = (owner, location, flag, ...rest) =>
    (Number(flag) === CARGO ? { success: false, errorMsg: "TEST_SHORT" } : realTake(owner, location, flag, ...rest));
  const inCargo = inFlag(CARGO, VELDSPAR);
  try {
    const short = service.take(ship, { typeID: VELDSPAR, quantity: inHold + 3, characterID: CHARACTER_ID });
    assert.strictEqual(short.success, false);
    assert.strictEqual(short.receipt, null);
    assert.strictEqual(inFlag(MINING_HOLD, VELDSPAR), inHold, "a short take kept what it took from the Mining Hold");
    assert.strictEqual(inFlag(CARGO, VELDSPAR), inCargo);
  } finally {
    store.takeItemTypeFromCharacterLocation = realTake;
  }
  emptyFlag(CARGO);
});

check("guards: the extension cannot be removed or put offline while the Mining Hold holds ore", () => {
  const snap = snapshot();
  const overflow = fittingRuntime.getCargoOverflowWithoutItems(snap, [miningModule.itemID], 0);
  assert.ok(overflow, "no overflow reported for removing the module");
  assert.strictEqual(overflow.flagID, MINING_HOLD);
  assert.strictEqual(overflow.bayName, "Mining Hold");
  assert.ok(overflow.capacityAfter < overflow.used);
  const text = own("bayOverflow").refusalText(overflow, "removed");
  assert.match(text, /^That module cannot be removed while the Mining Hold is this full\./);
  const thrown = refusalOf(() => broker._throwUnfitCargoOverflowUserError(overflow));
  assert.ok(thrown && /Mining Hold/.test(thrown), `unfit refusal: ${thrown}`);
  const moduleOperation = game("services/dogma/dogmaService/moduleOperation");
  const host = { _throwCustomNotifyUserError: (message) => { throw new Error(message); } };
  const offline = refusalOf(() => moduleOperation._throwModuleOnlineUserError.call(host, "CARGO_WOULD_OVERFLOW", miningModule, overflow));
  assert.ok(offline && /cannot be put offline while the Mining Hold/.test(offline), `offline refusal: ${offline}`);
  // An empty hold lets the module go.
  const keep = inFlag(MINING_HOLD, VELDSPAR);
  emptyFlag(MINING_HOLD);
  assert.strictEqual(fittingRuntime.getCargoOverflowWithoutItems(snapshot(), [miningModule.itemID], 0), null, "an empty hold still refused");
  stockOre(MINING_HOLD, keep);
  refresh();
});

check("undock: an overfull Mining Hold keeps a pilot docked, never a bot", () => {
  assert.strictEqual(own("bayOverflow").undockRefusal(session, ship), "", "refused with the module online");
  setOnline(miningModule, false); // burned out or forced offline
  const text = own("bayOverflow").undockRefusal(session, ship);
  assert.match(text, /^Your ship cannot undock while the Mining Hold carries more than it has room for\./);
  assert.strictEqual(own("bayOverflow").undockRefusal({ ...session, _playerBotActor: true }, ship), "", "a bot was refused");
  const sources = service.sources(ship, VELDSPAR, { resourceState: {} });
  assert.ok(sources.includes(MINING_HOLD), "a bay at zero size cannot be emptied");
  setOnline(miningModule, true);
});

check("mining: a full hold keeps the laser on it, or spills into cargo with laserOverflow on", () => {
  const inventory = game("services/mining/miningInventory");
  const rs = () => snapshot().resourceState;
  // Room left: the hold the game picks stands.
  emptyFlag(MINING_HOLD);
  assert.strictEqual(inventory.getPreferredMiningHoldFlagForType(rs(), VELDSPAR), MINING_HOLD);
  const each = Number(registry.resolveItemByTypeID(VELDSPAR).volume);
  stockOre(MINING_HOLD, Math.floor(holdSize / each));
  refresh();
  assert.strictEqual(inventory.getPreferredMiningHoldFlagForType(rs(), VELDSPAR), MINING_HOLD, "the base rule changed");
  const prefs = own("game").PREFERENCES_FILE;
  fs.writeFileSync(prefs, JSON.stringify({ laserOverflow: true }));
  try {
    assert.strictEqual(inventory.getPreferredMiningHoldFlagForType(rs(), VELDSPAR), null, "a full hold with laserOverflow on");
  } finally {
    fs.unlinkSync(prefs);
  }
});

check("ammo: a reload finds charges in the Ammo Hold when cargo has none", () => {
  ammoModule = fit(AMMO_EXTENSION, 12);
  assert.ok(service.capacity(ship, AMMO_HOLD, { characterID: CHARACTER_ID }) > 0, "no Ammo Hold");
  // EveJS sizes the Ammo Hold from the hull alone when it checks a move; the mod's fix lets the
  // fitted size decide, and the hold's own rules still stand.
  const charges = stockOre(CARGO, 10, EMP_S);
  assert.deepStrictEqual(broker._validateShipBayMove(session, ship, charges, { locationID: ship.itemID, flagID: AMMO_HOLD }), { success: true });
  const ore = stockOre(CARGO, 10);
  const refused = broker._validateShipBayMove(session, ship, ore, { locationID: ship.itemID, flagID: AMMO_HOLD });
  assert.strictEqual(refused && refused.success, false, "ore went into the Ammo Hold");
  emptyFlag(CARGO);
  const placed = service.grant(ship, [{ typeID: EMP_S, quantity: 100 }], { characterID: CHARACTER_ID });
  assert.deepStrictEqual(placed.placed.map((p) => p.flag), [AMMO_HOLD], "charges did not go to the Ammo Hold");
  const moduleOperation = game("services/dogma/dogmaService/moduleOperation");
  assert.strictEqual(moduleOperation._resolveAmmoSourceHoldFlag(ship.itemID, [{ typeID: EMP_S }]), AMMO_HOLD);
  stockOre(CARGO, 10, EMP_S);
  assert.strictEqual(moduleOperation._resolveAmmoSourceHoldFlag(ship.itemID, [{ typeID: EMP_S }]), CARGO, "cargo comes first when it has them");
  emptyFlag(CARGO);
});

check("loot: Loot All from a can sends ore to the Mining Hold and the rest to cargo", () => {
  emptyFlag(MINING_HOLD);
  const can = { ore: { itemID: 9900001, typeID: VELDSPAR, quantity: 50, stacksize: 50, singleton: 0, locationID: 9900000 },
    mineral: { itemID: 9900002, typeID: TRITANIUM, quantity: 50, stacksize: 50, singleton: 0, locationID: 9900000 } };
  const fake = Object.create(broker);
  fake._findTransferSourceItem = (itemID) => ({ item: Object.values(can).find((item) => item.itemID === Number(itemID)) || null });
  fake._resolveShipDogmaCharacterID = () => CHARACTER_ID;
  const picked = own("lootRouting").pickBays(fake, session, { shipRecord: ship, sourceID: 9900000 }, [9900001, 9900002]);
  assert.deepStrictEqual([...picked], [[9900001, MINING_HOLD]]);
});

check("deliveries: an agent counts ore in the Mining Hold as in the cargo hold", () => {
  emptyFlag(MINING_HOLD);
  stockOre(MINING_HOLD, 25);
  stockOre(CARGO, 5);
  const hooks = globalThis[Symbol.for("reverie.hooks")];
  const stacks = hooks.run("holds.deliveryStacks", null, CHARACTER_ID, ship.itemID, CARGO, VELDSPAR);
  assert.ok(Array.isArray(stacks), "the hook gave no stacks");
  assert.strictEqual(stacks.reduce((sum, item) => sum + Number(item.stacksize ?? item.quantity), 0), 30);
  emptyFlag(CARGO);
});

check("a mod's own bay: sized by the ship, shown in the window, and refused when the ship has none", () => {
  const bay = service.addBay({ mod: "test", flag: 199, key: "dataStorage", name: "Data Storage", size: { base: (typeID) => (typeID === RIFTER ? 40 : 0) },
    accepts: { types: [TRITANIUM] }, refusal: "Data Storage takes data." });
  try {
    assert.strictEqual(bay.flag, 199);
    assert.strictEqual(service.capacity(ship, 199, { characterID: CHARACTER_ID }), 40);
    const info = broker._calculateCapacity(session, { kind: "shipInventory", inventoryID: ship.itemID, flagID: 199 }, 199);
    const entries = Object.fromEntries(info.args.entries);
    assert.deepStrictEqual(entries, { capacity: 40, used: 0 });
    // The bay bound on its own ([shipID, 199]) has the same size, not the
    // game's 1,000,000 m3 for a flag it does not know.
    const direct = broker._calculateCapacity(session, { kind: "boundInventory", inventoryID: ship.itemID, flagID: 199 }, null);
    assert.deepStrictEqual(Object.fromEntries(direct.args.entries), { capacity: 40, used: 0 });
    const ore = stockOre(CARGO, 10);
    const refused = broker._validateShipBayMove(session, ship, ore, { locationID: ship.itemID, flagID: 199 });
    assert.deepStrictEqual(refused, { success: false, errorMsg: "SHIP_BAY_ITEM_NOT_ALLOWED", userMessage: "Data Storage takes data." });
    const mineral = stockOre(CARGO, 10, TRITANIUM);
    assert.deepStrictEqual(broker._validateShipBayMove(session, ship, mineral, { locationID: ship.itemID, flagID: 199 }), { success: true });
    assert.deepStrictEqual(service.route(ship, TRITANIUM, { characterID: CHARACTER_ID }).map((step) => step.flag), [199, CARGO]);
    emptyFlag(CARGO);
  } finally {
    service.removeBays("test");
  }
});

check("NPC miners drop bay extensions with the layer on, only from tables that roll random loot", () => {
  const loot = game("space/npc/npcLoot");
  const source = { npcTypeName: "Guristas Miner", npcGroupName: "Asteroid Guristas Frigate" };
  const always = () => 0.001;
  const extensionIn = (entries) => entries.find((entry) => family.variantOf(entry.typeID)) || null;
  assert.strictEqual(extensionIn(loot.rollNpcLootEntries(null, { random: always, source })), null, "an NPC with no loot table dropped one");
  assert.strictEqual(extensionIn(loot.rollNpcLootEntries({ lootTableID: "test", disableRandomLoot: true }, { random: always, source })), null,
    "a table with random loot off dropped one");
  assert.strictEqual(extensionIn(loot.rollNpcLootEntries({ lootTableID: "test", minEntries: 0, maxEntries: 0 }, { random: always, source })), null,
    "a table of no entries dropped one");
  // A seeded roll replays.
  const seeded = (seed) => extensionIn(loot.rollNpcLootEntries({ lootTableID: "test", minEntries: 1, maxEntries: 1 }, { source: { ...source, seed } }));
  for (const seed of ["a", "b", "c", "d"]) {
    const first = seeded(seed);
    const again = seeded(seed);
    assert.strictEqual(first && first.typeID, again && again.typeID, `seed ${seed} rolled differently`);
  }
  let found = null;
  for (let i = 0; i < 200 && !found; i += 1) {
    let n = i;
    const random = () => { n = (n * 9301 + 49297) % 233280; return n / 233280 / 20; };
    found = extensionIn(loot.rollNpcLootEntries({ lootTableID: "test", minEntries: 1, maxEntries: 1 }, { random, source }));
  }
  assert.ok(found, "no extension in 200 rolls");
  assert.ok(found.itemType && found.itemType.typeID === found.typeID, "the entry carries no type");
  console.log(`      dropped ${found.name}`);
});

console.log(failures ? `${failures} failed` : "workflow passed");
process.exit(failures ? 1 : 0);
