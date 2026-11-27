"use strict";

// Runs inside the test install (test/run.js) with the test mod test/fixtures/reverie-specimen
// enabled beside Holds and the type layer on from boot. That mod does what GUIDE.md tells a
// modder to do for a bay of their own, and nothing else: its layer adds a module and an
// attribute and hands Holds a client bay, a hull size and a module bay; its server side adds a
// Specimen Bay on flag 200 through the holds service and listens on holds.changed. This checks
// that the rest of Holds treats that bay as one of its own: sizes, the inventory window, moves,
// routes, placing and pulling, Loot All, the unfit, offline and undock guards, deliveries, bills
// of materials as a field assembler would take them, the events, a live reload of Holds, and the
// bay going away with the mod.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const core = globalThis[Symbol.for("reverie.core")];
const game = (relative) => require(core.paths.resolveTarget(relative));
// Holds' own files are looked up per use: a live reload below replaces them.
const own = (name) => require(path.join(__dirname, "..", "server", "lib", name));
const service = () => core.services.use("holds", "1.1");

let failures = 0;
let stopped = false;
async function check(name, fn) {
  if (stopped) { console.log(`--    skipped: ${name}`); return; }
  try { await fn(); console.log(`ok    ${name}`); } catch (error) {
    failures += 1;
    stopped = true;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}

const FIXTURE = "reverie-specimen";
const FIXTURE_DIR = path.join(__dirname, "..", "..", FIXTURE);
const fixture = require(path.join(FIXTURE_DIR, "defs", "layer.js"));
const SPECIMEN = 200;
const RIFTER = 587;
const MERLIN = 603;
const TRITANIUM = 34;
const VELDSPAR = 1230;
const METAL_SCRAPS = 15331;
const CARGO = 5;
const PYERITE = 35;
const HOBGOBLIN = 2454;
const MINING_HOLD = 134;
const MINERAL_HOLD = 136;
const DRONE_BAY = 87;
const AMMO_HOLD = 143;
const EXPEDITION_HOLD = 188;
const FULLERITE_C50 = 30370;
const CHARACTER_ID = 140000913;
const STATION_ID = 60003760;
const SYSTEM_ID = 30000142;
const heard = () => globalThis[Symbol.for("reverie-specimen.heard")] || [];

const registry = game("services/inventory/itemTypeRegistry");
const itemStore = game("services/inventory/itemStore");
const fittingRuntime = game("_secondary/fitting/fittingRuntime");
const liveFitting = game("services/fitting/liveFittingState");
const InvBroker = game("services/inventory/invBrokerService");
const broker = Object.create(InvBroker.prototype);
broker._boundContexts = new Map();
const session = { characterID: CHARACTER_ID, charid: CHARACTER_ID, stationid: STATION_ID, stationID: STATION_ID, solarsystemid2: SYSTEM_ID };

let ship = null;
let locker = null;
const refresh = () => {
  ship = itemStore.findItemById(ship.itemID);
  fittingRuntime.invalidateShipFittingSnapshot(CHARACTER_ID, ship.itemID);
  fittingRuntime.invalidateShipFittingSnapshot(0, ship.itemID);
};
const snapshot = () => fittingRuntime.getShipFittingSnapshot(CHARACTER_ID, ship.itemID, { shipItem: ship, forceRefresh: true });
const capacity = (flag, of = ship) => service().capacity(of, flag, { characterID: CHARACTER_ID });
const windowCapacity = (flag) => Object.fromEntries(
  broker._calculateCapacity(session, { kind: "shipInventory", inventoryID: ship.itemID, flagID: flag }, flag).args.entries).capacity;
const inFlag = (flag, typeID) => (itemStore.listContainerItems(null, ship.itemID, flag) || [])
  .filter((item) => typeID === undefined || Number(item.typeID) === typeID)
  .reduce((sum, item) => sum + Number(item.stacksize ?? item.quantity ?? 0), 0);
const stock = (flag, typeID, quantity) => {
  const granted = itemStore.grantItemToCharacterLocation(CHARACTER_ID, ship.itemID, flag, typeID, quantity);
  assert.ok(granted && granted.success, `no ${typeID} in ${flag}: ${granted && granted.errorMsg}`);
  return granted.data.items[0];
};
const emptyFlag = (flag) => {
  for (const item of itemStore.listContainerItems(null, ship.itemID, flag) || []) itemStore.removeInventoryItem(item.itemID);
  refresh();
};
const fit = (typeID, flagID) => {
  const granted = itemStore.grantItemToCharacterLocation(CHARACTER_ID, ship.itemID, flagID, typeID, 1, { singleton: 1 });
  assert.ok(granted && granted.success, `${typeID} not fitted: ${granted && granted.errorMsg}`);
  const item = granted.data.items[0];
  const updated = itemStore.updateInventoryItem(item.itemID, (row) => ({ ...row, singleton: 1, moduleState: { online: true } }));
  assert.ok(updated && updated.success, `${typeID} not onlined`);
  refresh();
  return itemStore.findItemById(item.itemID);
};
const setOnline = (module, online) => {
  const result = itemStore.updateInventoryItem(module.itemID, (item) => ({ ...item, moduleState: { ...(item.moduleState || {}), online } }));
  assert.ok(result && result.success, `module ${module.itemID} not updated`);
  refresh();
};
const spawn = (typeID) => {
  const spawned = itemStore.spawnShipInStationHangar(CHARACTER_ID, STATION_ID, registry.resolveItemByTypeID(typeID));
  assert.ok(spawned && spawned.success, `no ship ${typeID}: ${spawned && spawned.errorMsg}`);
  return spawned.data;
};
const flags = (steps) => steps.map((step) => step.flag);

async function main() {
  await check("the test mod is loaded and attached to the holds service", () => {
    assert.ok(core.typeLayer.status().active, core.typeLayer.status().reason);
    const states = Object.fromEntries(core.status().mods.map((mod) => [mod.id, mod.state]));
    for (const id of ["reverie-holds", FIXTURE]) assert.ok(["patched", "running"].includes(states[id]), `${id} is ${states[id]}`);
    const used = core.services.status().used.find((entry) => entry.mod === FIXTURE && entry.name === "holds");
    assert.ok(used && used.from === "reverie-holds", `the test mod is not attached: ${JSON.stringify(used)}`);
    const bay = service().bays().find((entry) => entry.flag === SPECIMEN);
    assert.deepStrictEqual(bay && { key: bay.key, mod: bay.mod, exclusive: bay.exclusive, builtIn: bay.builtIn },
      { key: "specimen", mod: FIXTURE, exclusive: true, builtIn: false });
    assert.strictEqual(service().bayName(SPECIMEN), "Specimen Bay");
  });

  await check("the layer passes the test mod's client bay, hull size and module bay to Holds, and skips its mistakes", () => {
    const data = own("game").layerData();
    assert.ok(data, "Holds has no layer data");
    const custom = (data.customBays || []).filter((bay) => bay.mod === FIXTURE);
    assert.deepStrictEqual(custom.map((bay) => [bay.flag, bay.invType, bay.name, bay.openLabel, bay.allowGroups]),
      [[SPECIMEN, "ShipSpecimenBay", "Specimen Bay", "Open Specimen Bay", [18]]]);
    assert.strictEqual(Number(data.shipBays.specimen[String(RIFTER)]), 100);
    assert.deepStrictEqual(data.moduleBays[String(fixture.SCANNER)], { bay: "ammo", m3: 250, mod: FIXTURE });
    const problems = (data.problems || []).filter((text) => text.startsWith(`${FIXTURE}:`));
    assert.strictEqual(problems.length, 3, `problems: ${JSON.stringify(data.problems)}`);
    assert.ok(problems.some((text) => /"flag":150/.test(text) && /a flag from 192 to 255/.test(text)));
    assert.ok(problems.some((text) => /"ShipCargo"/.test(text) && /an invType of its own/.test(text)));
    assert.ok(problems.some((text) => /"nonsense"/.test(text)));
    assert.strictEqual(Number((liveFitting.getTypeDogmaAttributes(fixture.LOCKER) || {})[fixture.SPECIMEN_ATTRIBUTE]), 300);
    assert.strictEqual(Number((liveFitting.getTypeDogmaAttributes(fixture.SCANNER) || {})[own("bayFamily").ATTR.bayAdded]), 250);
  });

  await check("a Rifter has a 100 m3 Specimen Bay from the hull size, and the window shows it", () => {
    const wrote = game("gameStore/index").write("characters", `/${CHARACTER_ID}`, {
      characterID: CHARACTER_ID, characterName: "Specimen Pilot", stationID: STATION_ID, solarSystemID: SYSTEM_ID,
    });
    assert.ok(wrote && wrote.success !== false, `no pilot: ${wrote && wrote.errorMsg}`);
    ship = spawn(RIFTER);
    assert.strictEqual(capacity(SPECIMEN), 100);
    assert.strictEqual(windowCapacity(SPECIMEN), 100);
    assert.strictEqual(capacity(SPECIMEN, spawn(MERLIN)), 0, "a Merlin has a Specimen Bay");
  });

  await check("a Specimen Locker in a low slot adds 300 m3 while online, and none from a high slot", () => {
    locker = fit(fixture.LOCKER, 11);
    assert.strictEqual(capacity(SPECIMEN), 400);
    assert.strictEqual(windowCapacity(SPECIMEN), 400);
    setOnline(locker, false);
    assert.strictEqual(capacity(SPECIMEN), 100);
    setOnline(locker, true);
    const high = fit(fixture.LOCKER, 27);
    assert.strictEqual(capacity(SPECIMEN), 400, "a locker in a high slot counted");
    itemStore.removeInventoryItem(high.itemID);
    refresh();
  });

  await check("the test mod's own module carries one of EVE's bays: a Sample Scanner gives a 250 m3 Ammo Hold", () => {
    assert.strictEqual(capacity(AMMO_HOLD), 0);
    fit(fixture.SCANNER, 12);
    assert.strictEqual(capacity(AMMO_HOLD), 250);
    assert.strictEqual(windowCapacity(AMMO_HOLD), 250);
  });

  await check("moves: the bay takes minerals and scrap (its test) and refuses ore with the mod's own words", () => {
    for (const typeID of [TRITANIUM, METAL_SCRAPS]) {
      const item = stock(CARGO, typeID, 5);
      assert.deepStrictEqual(broker._validateShipBayMove(session, ship, item, { locationID: ship.itemID, flagID: SPECIMEN }), { success: true }, `${typeID} refused`);
    }
    const ore = stock(CARGO, VELDSPAR, 5);
    assert.deepStrictEqual(broker._validateShipBayMove(session, ship, ore, { locationID: ship.itemID, flagID: SPECIMEN }),
      { success: false, errorMsg: "SHIP_BAY_ITEM_NOT_ALLOWED", userMessage: "The Specimen Bay only takes minerals and scrap." });
    assert.strictEqual(service().accepts(SPECIMEN, METAL_SCRAPS), true);
    assert.strictEqual(service().accepts(SPECIMEN, VELDSPAR), false);
    emptyFlag(CARGO);
  });

  await check("routes: exclusive keeps minerals out of cargo on a ship with the bay, and a ship without it keeps cargo", () => {
    assert.deepStrictEqual(flags(service().route(ship, TRITANIUM, { characterID: CHARACTER_ID })), [SPECIMEN]);
    assert.ok(!flags(service().route(ship, VELDSPAR, { characterID: CHARACTER_ID })).includes(SPECIMEN));
    const merlin = spawn(MERLIN);
    assert.deepStrictEqual(flags(service().route(merlin, TRITANIUM, { characterID: CHARACTER_ID })), [CARGO]);
    assert.deepStrictEqual(service().grant(merlin, [{ typeID: TRITANIUM, quantity: 10 }], { characterID: CHARACTER_ID }).placed.map((p) => p.flag), [CARGO]);
  });

  await check("placing and pulling: grant fills the bay and hands back what does not fit, take and giveBack use it", () => {
    const before = heard().length;
    const each = Number(registry.resolveItemByTypeID(TRITANIUM).volume);
    const fits = Math.floor(400 / each + 1e-6);
    const result = service().grant(ship, [{ typeID: TRITANIUM, quantity: fits + 5 }], { characterID: CHARACTER_ID });
    assert.deepStrictEqual(result.placed.map((p) => [p.flag, p.quantity]), [[SPECIMEN, fits]]);
    assert.deepStrictEqual(result.left, [{ typeID: TRITANIUM, quantity: 5 }]);
    assert.strictEqual(inFlag(SPECIMEN, TRITANIUM), fits);
    assert.strictEqual(service().used(ship, SPECIMEN), Math.round(fits * each * 1e6) / 1e6);
    const taken = service().take(ship, { typeID: TRITANIUM, quantity: 50, characterID: CHARACTER_ID });
    assert.strictEqual(taken.success, true);
    assert.deepStrictEqual(taken.receipt.taken, [{ flag: SPECIMEN, quantity: 50 }]);
    assert.strictEqual(service().giveBack(taken.receipt, 50, { characterID: CHARACTER_ID }), 50);
    assert.strictEqual(inFlag(SPECIMEN, TRITANIUM), fits);
    const reasons = heard().slice(before).map((detail) => detail && detail.reason);
    assert.deepStrictEqual(reasons, ["grant", "take", "giveBack"], `holds.changed told the test mod ${JSON.stringify(reasons)}`);
  });

  await check("guards: the locker cannot come off or go offline while the bay is this full, and an overfull bay keeps the pilot docked", () => {
    const overflow = fittingRuntime.getCargoOverflowWithoutItems(snapshot(), [locker.itemID], 0);
    assert.ok(overflow, "no overflow for removing the locker");
    assert.strictEqual(overflow.flagID, SPECIMEN);
    assert.strictEqual(overflow.bayName, "Specimen Bay");
    assert.strictEqual(overflow.capacityAfter, 100);
    assert.match(own("bayOverflow").refusalText(overflow, "put offline"), /^That module cannot be put offline while the Specimen Bay is this full\./);
    assert.strictEqual(own("bayOverflow").undockRefusal(session, ship), "");
    setOnline(locker, false);
    assert.match(own("bayOverflow").undockRefusal(session, ship), /^Your ship cannot undock while the Specimen Bay carries more than it has room for\./);
    assert.ok(service().sources(ship, TRITANIUM, { resourceState: {} }).includes(SPECIMEN), "an overfull bay cannot be emptied");
    setOnline(locker, true);
  });

  await check("deliveries count minerals in the Specimen Bay as in the cargo hold", () => {
    stock(CARGO, TRITANIUM, 7);
    const hooks = globalThis[Symbol.for("reverie.hooks")];
    const stacks = hooks.run("holds.deliveryStacks", null, CHARACTER_ID, ship.itemID, CARGO, TRITANIUM);
    assert.strictEqual((stacks || []).reduce((sum, item) => sum + Number(item.stacksize ?? item.quantity), 0), inFlag(SPECIMEN, TRITANIUM) + 7);
    emptyFlag(CARGO);
  });

  await check("Loot All sends minerals and scrap from a can to the Specimen Bay and leaves ore for cargo", () => {
    emptyFlag(SPECIMEN);
    const can = [
      { itemID: 9900031, typeID: TRITANIUM, quantity: 100, stacksize: 100, singleton: 0, locationID: 9900030 },
      { itemID: 9900032, typeID: METAL_SCRAPS, quantity: 2, stacksize: 2, singleton: 0, locationID: 9900030 },
      { itemID: 9900033, typeID: VELDSPAR, quantity: 20, stacksize: 20, singleton: 0, locationID: 9900030 },
    ];
    const fake = Object.create(broker);
    fake._findTransferSourceItem = (itemID) => ({ item: can.find((item) => item.itemID === Number(itemID)) || null });
    fake._resolveShipDogmaCharacterID = () => CHARACTER_ID;
    const picked = own("lootRouting").pickBays(fake, session, { shipRecord: ship, sourceID: 9900030 }, can.map((item) => item.itemID));
    assert.deepStrictEqual([...picked], [[9900031, SPECIMEN], [9900032, SPECIMEN]]);
  });

  await check("bills of materials: an assembler finds minerals in the Specimen Bay, a Mineral Hold and cargo, takes all or none, and gives back from saved receipts", () => {
    const family = own("bayFamily");
    const mineral = fit(family.variants().find((v) => v.bay === "mineral" && v.size === "small" && v.tier === "t1").typeID, 13);
    assert.ok(capacity(MINERAL_HOLD) > 0, "no Mineral Hold from the extension");
    stock(SPECIMEN, TRITANIUM, 200);
    stock(MINERAL_HOLD, TRITANIUM, 100);
    stock(CARGO, TRITANIUM, 50);
    stock(CARGO, PYERITE, 40);
    stock(DRONE_BAY, HOBGOBLIN, 1);
    refresh();
    const counts = () => [SPECIMEN, MINERAL_HOLD, CARGO].map((flag) => [inFlag(flag, TRITANIUM), inFlag(flag, PYERITE)]);
    const start = counts();
    const bill = [{ typeID: TRITANIUM, quantity: 250 }, { typeID: PYERITE, quantity: 40 }, { typeID: TRITANIUM, quantity: 50 }];

    const found = service().materials(ship, bill, { characterID: CHARACTER_ID });
    assert.strictEqual(found.complete, true, JSON.stringify(found.missing));
    const trit = found.lines.find((line) => line.typeID === TRITANIUM);
    assert.strictEqual(trit.quantity, 300, "the bill's two Tritanium lines were not merged");
    assert.strictEqual(trit.available, 350);
    assert.deepStrictEqual(trit.where.map((h) => h.flag).sort(), [CARGO, MINERAL_HOLD, SPECIMEN].sort());
    assert.strictEqual(found.plan.reduce((sum, p) => sum + (p.typeID === TRITANIUM ? p.quantity : 0), 0), 300);
    const each = Number(registry.resolveItemByTypeID(TRITANIUM).volume);
    assert.ok(Object.values(found.freed).reduce((a, b) => a + b, 0) >= 300 * each - 1e-6, `freed ${JSON.stringify(found.freed)}`);

    const short = service().takeMaterials(ship, [{ typeID: TRITANIUM, quantity: 351 }, { typeID: PYERITE, quantity: 1 }], { characterID: CHARACTER_ID });
    assert.deepStrictEqual([short.success, short.missing], [false, [{ typeID: TRITANIUM, quantity: 1 }]]);
    assert.deepStrictEqual(counts(), start, "a short bill took something");

    const drone = service().materials(ship, [{ typeID: HOBGOBLIN, quantity: 1 }], { characterID: CHARACTER_ID });
    assert.deepStrictEqual(drone.missing, [{ typeID: HOBGOBLIN, quantity: 1 }], "a drone in the drone bay counted as a material");
    assert.strictEqual(service().materials(ship, [{ typeID: TRITANIUM, quantity: 51 }], { characterID: CHARACTER_ID, from: [CARGO] }).complete, false,
      "from: [cargo] looked past cargo");

    const taken = service().takeMaterials(ship, bill, { characterID: CHARACTER_ID });
    assert.strictEqual(taken.success, true, JSON.stringify(taken.missing));
    const totals = (rows) => rows.reduce((sum, row) => sum + row[0], 0);
    assert.strictEqual(totals(counts()), 50);
    assert.strictEqual(inFlag(CARGO, PYERITE), 0);
    // An assembler keeps its job on disk; the receipts must survive that.
    const back = service().giveBackMaterials(JSON.parse(JSON.stringify(taken.receipts)), { characterID: CHARACTER_ID });
    assert.deepStrictEqual(back, { given: [{ typeID: TRITANIUM, quantity: 300 }, { typeID: PYERITE, quantity: 40 }], left: [] });
    assert.deepStrictEqual(counts(), start, "the materials did not go back where they came from");

    for (const flag of [SPECIMEN, MINERAL_HOLD, CARGO, DRONE_BAY]) emptyFlag(flag);
    itemStore.removeInventoryItem(mineral.itemID);
    refresh();
  });

  await check("priorities: gas goes to the Mining Hold before the Expedition Hold, and service.priorities has the numbers", () => {
    const family = own("bayFamily");
    const extension = (bay) => family.variants().find((v) => v.bay === bay && v.size === "small" && v.tier === "t1");
    const second = spawn(RIFTER);
    const keep = ship;
    ship = second;
    fit(extension("mining").typeID, 11);
    fit(extension("expedition").typeID, 12);
    const route = flags(service().route(ship, FULLERITE_C50, { characterID: CHARACTER_ID }));
    ship = keep;
    refresh();
    assert.ok(route.includes(MINING_HOLD) && route.includes(EXPEDITION_HOLD), `gas route ${JSON.stringify(route)}`);
    assert.ok(route.indexOf(MINING_HOLD) < route.indexOf(EXPEDITION_HOLD), `gas route ${JSON.stringify(route)}`);
    assert.deepStrictEqual(service().priorities, { specialised: 80, kind: 70, general: 60, wide: 50, cargo: 0 });
  });

  await check("a live reload of Holds gives the test mod its bay back with no restart", async () => {
    const out = await core.reloadMod("reverie-holds");
    assert.ok(["patched", "running"].includes(out.result), `reload: ${JSON.stringify(out)}`);
    assert.ok(service().bays().some((bay) => bay.flag === SPECIMEN && bay.mod === FIXTURE), "the Specimen Bay did not come back");
    refresh();
    assert.strictEqual(capacity(SPECIMEN), 400);
    assert.strictEqual(windowCapacity(SPECIMEN), 400);
  });

  await check("disabling the test mod live takes its bay away and gives cargo its minerals back", async () => {
    const before = heard().length;
    fs.renameSync(path.join(FIXTURE_DIR, "loader.js"), path.join(FIXTURE_DIR, "loader.js.disabled"));
    const out = await core.reloadMod(FIXTURE);
    assert.strictEqual(out.result, "disabled");
    assert.ok(!service().bays().some((bay) => bay.flag === SPECIMEN), "the Specimen Bay stayed");
    assert.deepStrictEqual(flags(service().route(ship, TRITANIUM, { characterID: CHARACTER_ID })), [CARGO]);
    assert.ok(heard().slice(before).some((detail) => detail && detail.reason === "removeBay" && detail.flag === SPECIMEN),
      "holds.changed did not tell of the bay going");
  });
}

main().then(() => {
  console.log(failures ? `${failures} failed` : "framework passed");
  process.exit(failures ? 1 : 0);
}, (error) => {
  console.log(`FAIL  ${error && error.stack || error}`);
  process.exit(1);
});
