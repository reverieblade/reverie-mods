"use strict";

// Runs inside the test install (test/run.js) with the core preloaded as the game process and the
// type layer off. It loads the game modules the mod patches, without booting the world, checks
// each way in, then composes the type layer and saves it for workflow.js.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const core = globalThis[Symbol.for("reverie.core")];
const game = (relative) => require(core.paths.resolveTarget(relative));
const own = (name) => require(path.join(__dirname, "..", "server", "lib", name));
const MOD_DIR = path.join(__dirname, "..");
const WRAPPED = Symbol.for("reverie.wrapped");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok    ${name}`); } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}

check("the mod registered, declared its patches and is not idle", () => {
  assert.ok(core, "no core");
  const mod = core.status().mods.find((m) => m.id === "reverie-holds");
  assert.ok(mod, "mod not registered");
  assert.strictEqual(mod.state, "patched", `${mod.state}: ${mod.error}`);
  const entry = require(path.join(MOD_DIR, "server", "index.js"));
  assert.strictEqual(entry._testing.hasLocalBuild({ paths: { srcRoot: core.paths.srcRoot } }), false);
});

check("every patched export is wrapped, and no other mod holds one", () => {
  const broker = game("services/inventory/invBrokerService").prototype;
  for (const name of ["_validateShipBayMove", "_calculateCapacity", "_throwUnfitCargoOverflowUserError", "Handle_Add", "Handle_MultiAdd"]) {
    assert.ok(broker[name][WRAPPED], `InvBrokerService.${name}`);
  }
  assert.ok(game("services/ship/shipService").prototype.Handle_Undock[WRAPPED], "ShipService.Handle_Undock");
  assert.ok(game("services/structure/structureDockingService").prototype.Handle_Undock[WRAPPED], "StructureDockingService.Handle_Undock");
  const moduleOperation = game("services/dogma/dogmaService/moduleOperation");
  assert.ok(moduleOperation._throwModuleOnlineUserError[WRAPPED], "_throwModuleOnlineUserError");
  assert.ok(moduleOperation._resolveAmmoSourceHoldFlag[WRAPPED], "_resolveAmmoSourceHoldFlag");
  assert.ok(game("_secondary/fitting/fittingRuntime").getCargoOverflowWithoutItems[WRAPPED], "getCargoOverflowWithoutItems");
  assert.ok(game("services/mining/miningInventory").getPreferredMiningHoldFlagForType[WRAPPED], "getPreferredMiningHoldFlagForType");
  assert.ok(game("space/npc/npcLoot").rollNpcLootEntries[WRAPPED], "rollNpcLootEntries");
  const sync = fs.readFileSync(core.paths.resolveTarget("services/chat/commands/commandInventorySync"), "utf8");
  if (!sync.includes("buildRemovedItemNotificationState")) {
    assert.ok(game("services/chat/commands/commandInventorySync").syncInventoryChangesToSession[WRAPPED], "syncInventoryChangesToSession");
  }
  const problems = core.patcher.status().problems.filter((p) => p.modIDs.includes("reverie-holds"));
  assert.deepStrictEqual(problems, []);
});

check("the dogma mixin keeps the wrapped methods when the service is built from it", () => {
  // DogmaService copies moduleOperation's methods onto its prototype at load, after the wrap.
  const DogmaService = game("services/dogma/dogmaService");
  const proto = (DogmaService && DogmaService.prototype) || null;
  assert.ok(proto, "no DogmaService prototype");
  assert.ok(proto._resolveAmmoSourceHoldFlag && proto._resolveAmmoSourceHoldFlag[WRAPPED], "DogmaService.prototype._resolveAmmoSourceHoldFlag is CCP's own");
  assert.ok(proto._throwModuleOnlineUserError && proto._throwModuleOnlineUserError[WRAPPED], "DogmaService.prototype._throwModuleOnlineUserError is CCP's own");
});

check("the bay table has EVE's bays and leaves out the ones other systems manage", () => {
  const service = core.services.use("holds", "1");
  assert.ok(service, "no holds service");
  const flags = new Set(service.bays().map((bay) => bay.flag));
  for (const flag of [5, 87, 133, 134, 135, 136, 137, 143, 149, 158, 181, 182, 188]) assert.ok(flags.has(flag), `no bay ${flag}`);
  assert.ok(!flags.has(183), "the Mobile Depot Hold is its own system's");
  assert.strictEqual(service.bayName(134), "Mining Hold");
  assert.strictEqual(service.bayName(143), "Ammo Hold");
  assert.strictEqual(own("bayOverflow").bayName(5), "cargo hold");
  assert.ok(service.bays().every((bay) => bay.builtIn), "a mod bay before any mod added one");
});

check("the Mining Hold takes ore and ice, and the Ammo Hold charges", () => {
  const service = core.services.use("holds", "1");
  assert.strictEqual(service.accepts(134, 1230), true, "Veldspar in the Mining Hold");
  assert.strictEqual(service.accepts(134, 16262), true, "Clear Icicle in the Mining Hold");
  assert.strictEqual(service.accepts(134, 34), false, "Tritanium in the Mining Hold");
  assert.strictEqual(service.accepts(143, 185), true, "EMP S in the Ammo Hold");
  assert.strictEqual(service.accepts(143, 1230), false, "Veldspar in the Ammo Hold");
  assert.strictEqual(service.accepts(136, 34), true, "Tritanium in the Mineral Hold");
  assert.strictEqual(service.accepts(87, 2203), true, "Hornet in the Drone Bay");
});

check("addBay: a mod's own bay joins the table, is routed, and refuses EVE's flags", () => {
  const service = core.services.use("holds", "1");
  assert.throws(() => service.addBay({ mod: "test", flag: 134, name: "Not Mine" }), /from 192 to 255/);
  assert.throws(() => service.addBay({ mod: "test", flag: 155, name: "Fleet Hangar" }), /from 192 to 255/);
  const bay = service.addBay({ mod: "test", flag: 199, key: "dataStorage", name: "Data Storage", size: { base: 50 }, accepts: { categories: [17] } });
  try {
    assert.strictEqual(bay.builtIn, false);
    assert.strictEqual(service.bay(199).name, "Data Storage");
    assert.throws(() => service.addBay({ mod: "other", flag: 199, name: "Mine" }), /already test's Data Storage/);
    assert.strictEqual(service.accepts(199, 34), false, "Tritanium is a mineral, not a commodity");
  } finally {
    service.removeBays("test");
  }
  assert.strictEqual(service.bay(199), null, "the bay outlived removeBays");
});

check("deliveries ask the mod: the hook point is in agentMissionRuntime.js and answers for ships only", () => {
  const text = fs.readFileSync(core.paths.resolveTarget("services/agent/agentMissionRuntime"), "utf8");
  assert.ok(text.includes('"holds.deliveryStacks"'), "no holds.deliveryStacks hook point");
  const hooks = globalThis[Symbol.for("reverie.hooks")];
  assert.strictEqual(hooks.run("holds.deliveryStacks", null, 1, 60003760, 5, 34), null, "a station is not a ship");
  assert.strictEqual(hooks.run("holds.deliveryStacks", null, 1, 1, 4, 34), null, "the hangar is not the cargo hold");
});

check("NPC loot carries no extension while the type layer is off", () => {
  const entries = game("space/npc/npcLoot").rollNpcLootEntries(null, {
    random: () => 0.001, source: { npcTypeName: "Guristas Miner", npcGroupName: "Asteroid Guristas Frigate" },
  });
  assert.ok(!entries.some((entry) => Number(entry.typeID) >= 993000 && Number(entry.typeID) < 994000), "an extension dropped with no layer");
  assert.strictEqual(own("npcBayLoot").rollBayExtension({ npcTypeName: "Guristas Miner", npcGroupName: "Asteroid Guristas Frigate", random: () => 0.001 }), null);
});

check("NPCs are sized, ranked and given a role from their name and group", () => {
  const loot = own("npcBayLoot");
  assert.strictEqual(loot.classifySize("Asteroid Guristas Frigate", "Guristas Miner"), "frigate");
  assert.strictEqual(loot.classifySize("Mining Barge", "Retriever"), "cruiser");
  assert.strictEqual(loot.classifySize("Asteroid Serpentis Battleship", "Serpentis Admiral"), "battleship");
  assert.strictEqual(loot.classifySize("Industrial", "Badger"), "hauler");
  assert.strictEqual(loot.classifySize("Cargo Container", "Secure Container"), null);
  assert.strictEqual(loot.rankOf("Dread Guristas Irregular"), "faction");
  assert.strictEqual(loot.rankOf("Guristas Commander"), "elite");
  assert.strictEqual(loot.rankOf("Guristas Burner"), "burner");
  assert.strictEqual(loot.rankOf("Guristas Wrecker"), "common");
});

check("the launcher's Configure form (preferences.json) sets the tunables, live", () => {
  const settings = own("game");
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD_DIR, "evejs-launcher.mod.json"), "utf8"));
  const serverFields = manifest.settings.fields.filter((field) => settings.PREFERENCES[field.key[0]]);
  assert.strictEqual(serverFields.length, Object.keys(settings.PREFERENCES).length, "a tunable has no form field");
  for (const field of serverFields) assert.strictEqual(field.restart, "none", `${field.id} needs no restart`);
  const clientFields = manifest.settings.fields.filter((field) => !settings.PREFERENCES[field.key[0]]);
  for (const field of clientFields) assert.strictEqual(field.restart, "client", `${field.id} is read by the layer at the client patch`);
  assert.strictEqual(settings.flag("EVEJS_HOLDS_LOOT_TO_BAY", true), true);
  fs.writeFileSync(settings.PREFERENCES_FILE, JSON.stringify({ lootToBay: false, laserOverflow: true, extensionLoot: 2.5 }));
  try {
    assert.strictEqual(settings.flag("EVEJS_HOLDS_LOOT_TO_BAY", true), false);
    assert.strictEqual(settings.flag("EVEJS_HOLDS_LASER_OVERFLOW", false), true);
    assert.strictEqual(settings.number("EVEJS_BAY_EXTENSION_LOOT", 1), 2.5);
    assert.strictEqual(settings.flag("EVEJS_HOLDS_MODULE_OUTPUT_CAN", true), true, "an unsaved field keeps its default");
    assert.strictEqual(own("lootRouting").enabled(), false, "loot routing reads it at once");
  } finally {
    fs.unlinkSync(settings.PREFERENCES_FILE);
  }
  assert.strictEqual(settings.flag("EVEJS_HOLDS_LOOT_TO_BAY", true), true);
});

check("the mod's own pieces are what the README says: 126 extensions, 42 blueprints, 16 market groups, 7 icons", () => {
  const family = own("bayFamily");
  assert.strictEqual(family.variants().length, 126);
  assert.strictEqual(family.blueprints().length, 42);
  assert.strictEqual(family.marketGroups().length, 16);
  assert.strictEqual(Object.keys(family.ICONS).length, 7);
  const ids = family.variants().map((variant) => variant.typeID);
  assert.strictEqual(new Set(ids).size, 126, "two extensions share a type ID");
  for (const variant of family.variants()) {
    assert.ok(variant.name && variant.description, `${variant.typeID} has no name or description`);
    assert.ok(!/\b(?:is|are)\s+not\b.*;|:\s*[A-Z]/.test(variant.description.split("\n")[0]), `${variant.name}: colon or semicolon pivot`);
  }
});

let composed = null;
check("the composed type layer has every type with an icon the client can draw, and no errors", () => {
  const compose = require(path.join(core.paths.modsDir, "reverie-core", "client", "compose"));
  const { layer, errors } = compose.compose();
  assert.deepStrictEqual(errors, []);
  composed = layer;
  const types = layer.types.filter((type) => type.mod === "reverie-holds");
  assert.strictEqual(types.length, 168);
  const icons = new Map(layer.icons.filter((icon) => icon.mod === "reverie-holds").map((icon) => [Number(icon.iconID), icon]));
  assert.strictEqual(icons.size, 7);
  for (const icon of icons.values()) {
    // The layer names each file from the install's root.
    const file = path.resolve(core.paths.repoRoot, icon.file);
    const png = fs.readFileSync(file);
    assert.strictEqual(png.toString("latin1", 1, 4), "PNG", `${icon.file} is not a PNG`);
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 64], `${icon.file} is not 64 x 64`);
    assert.match(icon.resource, /^res:\/ui\/texture\/icons\/[\w]+\.png$/);
  }
  for (const type of types) {
    assert.ok(icons.has(Number(type.client.iconID)), `${type.typeID} ${type.client && type.row.name} has icon ${type.client.iconID}, which the layer does not draw`);
    assert.strictEqual(Number(type.row.iconID), Number(type.client.iconID), `${type.typeID}: the server and client icons differ`);
  }
  const groups = layer.marketGroups.filter((mg) => mg.mod === "reverie-holds");
  assert.strictEqual(groups.length, 16);
  for (const mg of groups.filter((g) => g.hasTypes)) {
    assert.ok(icons.has(Number(mg.iconID)), `market group ${mg.marketGroupID} has icon ${mg.iconID}`);
    assert.ok(types.some((type) => Number(type.client.marketGroupID) === Number(mg.marketGroupID)), `market group ${mg.marketGroupID} is empty`);
  }
  const stock = layer.marketStock.filter((entry) => entry.mod === "reverie-holds");
  assert.strictEqual(stock.length, 21, "tech 1 blueprints on the market");
  assert.strictEqual(layer.blueprints.filter((bp) => bp.mod === "reverie-holds").length, 42);
  const data = layer.clientData["reverie-holds"];
  assert.ok(data, "no client data");
  assert.strictEqual(data.bays.length, 8);
  assert.deepStrictEqual(data.meters, { show: true, perRow: 6, most: 12 });
  assert.deepStrictEqual(data.problems, []);
  assert.deepStrictEqual(data.customBays, []);
  assert.ok(layer.scripts.some((script) => script.mod === "reverie-holds" && /holds\.py$/.test(script.file || script.path || "")), "holds.py is not a client script");
  compose.save(layer);
});

check("after(): partner modules and ships get their bays, and a bad entry is skipped with a problem", () => {
  const compose = require(path.join(core.paths.modsDir, "reverie-core", "client", "compose"));
  const tables = compose.createTables();
  const layerModule = require(path.join(MOD_DIR, "defs", "layer.js"));
  const ctx = {
    ...tables,
    layers: { types: composed ? composed.types : [] },
    contributions: () => [{
      mod: "partner", version: "1.0.0", dir: MOD_DIR,
      data: {
        moduleBays: [{ typeID: 25861, bay: "salvage", m3: 500 }, { typeID: 25861, bay: "nonsense", m3: 5 }, { typeID: 1, bay: "fuel", m3: 0 }],
        shipBays: [{ bay: "fuel", sizes: { 587: 100, 34: 100 } }, { bay: "dataStorage", sizes: { 587: 25 } }],
        clientBays: [
          { flag: 199, invType: "ShipDataStorage", name: "Data Storage", allowCategories: [17], everyShip: true },
          { flag: 134, invType: "MyMiningHold", name: "Mine" },
          { flag: 200, invType: "ShipCargo", name: "CCP's" },
          { flag: 201, invType: "Not A Name", name: "Spaces" },
          { flag: 199, invType: "Another", name: "Twice" },
        ],
      },
    }],
  };
  const out = layerModule.after(ctx);
  const salvager = out.typeEdits.find((edit) => edit.typeID === 25861);
  assert.ok(salvager, "no module bay on Salvager I");
  assert.strictEqual(salvager.dogma.setAttributes[7910], 500);
  assert.deepStrictEqual(out.clientData.moduleBays["25861"], { bay: "salvage", m3: 500, mod: "partner" });
  const rifter = out.typeEdits.find((edit) => edit.typeID === 587);
  assert.ok(rifter && rifter.dogma.setAttributes[1549] === 100, "no Fuel Bay on the Rifter");
  assert.deepStrictEqual(out.clientData.shipBays, { dataStorage: { 587: 25 } });
  assert.deepStrictEqual(out.clientData.customBays.map((bay) => [bay.flag, bay.invType, bay.everyShip, bay.allowCategories]),
    [[199, "ShipDataStorage", true, [17]]]);
  const problems = out.clientData.problems.join("\n");
  assert.match(problems, /nonsense/);
  assert.match(problems, /names 34, which is not a ship/);
  assert.match(problems, /a flag from 192 to 255/);
  assert.match(problems, /an invType of its own/);
  assert.match(problems, /a flag partner has not taken/);
  assert.strictEqual(out.clientData.problems.length, 7, problems);
});

check("hooks registered by the mod, and none faulted", () => {
  const names = core.hooks.status().filter((h) => h.handlers.some((x) => x.mod === "reverie-holds")).map((h) => h.name).sort();
  assert.deepStrictEqual(names, ["holds.deliveryStacks"]);
  const faulted = core.hooks.status().flatMap((h) => h.handlers.filter((x) => x.faults > 0).map((x) => `${h.name} ${x.faults}`));
  assert.deepStrictEqual(faulted, []);
});

console.log(failures ? `${failures} failed` : "probe passed");
process.exit(failures ? 1 : 0);
