"use strict";

// Runs inside the test install (test/run.js) with the core preloaded as the game process. It loads
// the game modules the mod patches, without booting the world, and checks each way in.

const assert = require("assert");
const path = require("path");

const core = globalThis[Symbol.for("reverie.core")];
const game = (relative) => require(core.paths.resolveTarget(relative));
const own = (name) => require(path.join(__dirname, "..", "server", "lib", name));
const WRAPPED = Symbol.for("reverie.wrapped");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok    ${name}`); } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}
// Swap one export for a spy for the length of fn.
function spyOn(object, key, fake, fn) {
  const before = object[key];
  const calls = [];
  object[key] = (...args) => { calls.push(args); return fake(...args); };
  try { fn(calls); } finally { object[key] = before; }
}

check("the mod registered and declared its patches", () => {
  assert.ok(core, "no core");
  const mod = core.status().mods.find((m) => m.id === "reverie-salvage");
  assert.ok(mod, "mod not registered");
  assert.strictEqual(mod.state, "patched", `${mod.state}: ${mod.error}`);
});

const salvager = game("space/modules/salvagerRuntime");
const mining = game("services/mining/miningRuntime");

check("the file edits are in: salvagerRuntime and miningRuntime hand over their internals", () => {
  assert.strictEqual(typeof salvager.reverieInternals.buildSalvageRewardEntries, "function");
  assert.strictEqual(typeof salvager.reverieInternals.removeSalvageSceneEntity, "function");
  assert.strictEqual(typeof mining.reverieInternals, "function");
  const inner = mining.reverieInternals();
  for (const name of ["buildEntityMiningSnapshot", "getTargetsForEntity", "getMiningCommandSurfaceDistance", "resolveDestinationFlagForPlayer",
    "resolveEntityCharacterID", "syncMinedOreChangesToSession", "getPlayerShipStorageSnapshot"]) {
    assert.strictEqual(typeof inner[name], "function", name);
  }
  assert.ok(own("cutHelpers").available());
});

check("the mining snapshot lets a cutter with no mining amount through, and nothing else", () => {
  const text = require("fs").readFileSync(core.paths.resolveTarget("services/mining/miningDogma"), "utf8");
  assert.ok(text.includes('"mining.allowNoYield"'), "miningDogma.js has no allowNoYield hook point");
  const hooks = globalThis[Symbol.for("reverie.hooks")];
  assert.strictEqual(hooks.run("mining.allowNoYield", false, { moduleItem: { typeID: 5241 } }), true);
  assert.strictEqual(hooks.run("mining.allowNoYield", false, { moduleItem: { typeID: 992085 } }), true); // Field Reclaimer II
  assert.strictEqual(hooks.run("mining.allowNoYield", false, { moduleItem: { typeID: 483 } }), false); // Miner II
  assert.strictEqual(hooks.run("mining.allowNoYield", false, {}), false);
});

check("every patched export is wrapped", () => {
  assert.ok(mining.resolveMiningActivation[WRAPPED], "resolveMiningActivation");
  assert.ok(mining.executeMiningCycle[WRAPPED], "executeMiningCycle");
  assert.ok(game("space/npc/npcLoot").rollNpcLootEntries[WRAPPED], "rollNpcLootEntries");
  assert.ok(game("space/runtime/combatDestruction").destroyCombatEntity[WRAPPED], "destroyCombatEntity");
  const holds = game("services/inventory/specialShipHoldRegistry");
  assert.ok(holds.isSpecialShipHoldItemAllowed[WRAPPED], "isSpecialShipHoldItemAllowed");
  assert.ok(holds.getSpecialShipHoldRestrictionMessage[WRAPPED], "getSpecialShipHoldRestrictionMessage");
  const broker = game("services/inventory/invBrokerService");
  assert.ok(broker.prototype.Handle_Add[WRAPPED], "Handle_Add");
  assert.ok(broker.prototype.Handle_MultiAdd[WRAPPED], "Handle_MultiAdd");
  const problems = core.patcher.status().problems.filter((p) => p.modIDs.includes("reverie-salvage"));
  assert.deepStrictEqual(problems, []);
});

check("the salvage chance gets the bonus (30% base, +15)", () => {
  assert.strictEqual(salvager._testing.calculateSalvageChancePercent(30, 0), 45);
  assert.strictEqual(salvager._testing.calculateSalvageChancePercent(95, 0), 100);
});

check("a hull panel's access difficulty follows its size", () => {
  const record = { wreckPanel: { size: "medium" }, typeID: 26934 };
  assert.strictEqual(salvager._testing.resolveAccessDifficultyBase({ typeID: 26934 }, null, record), 20);
  record.wreckPanel.size = "large";
  assert.strictEqual(salvager._testing.resolveAccessDifficultyBase({ typeID: 26934 }, null, record), 10);
});

check("a salvaged wreck gives metal scrap on top of CCP's roll", () => {
  const wreck = { kind: "wreck", typeID: 26557, itemName: "Guristas Frigate Wreck" };
  const entries = salvager._testing.buildSalvageRewardEntries(wreck, { callbacks: { random: () => 0.5 } });
  assert.ok(Array.isArray(entries) && entries.length > 0, JSON.stringify(entries));
  assert.ok(entries.some((entry) => Number(entry.itemType) === 15331), `no Metal Scraps in ${JSON.stringify(entries)}`);
});

check("an empty wreck happens less often (0.35 of CCP's chance)", () => {
  // random 0.1: CCP's small-wreck empty chance is 0.22, times 0.35 is 0.077, so not empty.
  const wreck = { kind: "wreck", typeID: 26557, itemName: "Guristas Frigate Wreck" };
  const entries = salvager._testing.buildSalvageRewardEntries(wreck, { callbacks: { random: () => 0.1 } });
  assert.ok(entries.length > 0);
});

check("NPC scavengers carry alloys in their cargo", () => {
  const entries = game("space/npc/npcLoot").rollNpcLootEntries(null, {
    random: () => 0.01,
    source: { npcTypeName: "Guristas Salvager", npcGroupName: "Asteroid Guristas Frigate" },
  });
  const alloys = new Set(own("cuttingLaserCatalog").ALLOY_TYPE_IDS.map(Number));
  const found = entries.filter((entry) => alloys.has(Number(entry.typeID)));
  assert.ok(found.length > 0, `no alloys in ${JSON.stringify(entries.map((e) => [e.typeID, e.quantity]))}`);
  for (const entry of found) {
    assert.ok(entry.itemType && entry.itemType.typeID === entry.typeID, "entry carries its type");
    assert.ok(entry.quantity >= 1);
  }
  const warship = game("space/npc/npcLoot").rollNpcLootEntries(null, {
    random: () => 0.01,
    source: { npcTypeName: "Guristas Despoiler", npcGroupName: "Asteroid Guristas Frigate" },
  });
  assert.ok(!warship.some((entry) => alloys.has(Number(entry.typeID))), "a warship carries none");
});

check("the loot tables' selectors ask the mod, which leaves CCP's types alone while the type layer is off", () => {
  const text = require("fs").readFileSync(core.paths.resolveTarget("space/npc/npcLoot"), "utf8");
  assert.ok(text.includes('"loot.selectorKind"'), "npcLoot.js has no selectorKind hook point");
  const hooks = globalThis[Symbol.for("reverie.hooks")];
  // The layer is off in this test, so 5241 is still CCP's mining laser and Salvager I is CCP's.
  assert.strictEqual(hooks.run("loot.selectorKind", null, { typeID: 5241 }, "module", {}), null);
  assert.strictEqual(hooks.run("loot.selectorKind", null, { typeID: 25861 }, "module", {}), null);
  assert.strictEqual(hooks.run("loot.selectorKind", null, { typeID: 2046 }, "module", {}), null); // Damage Control I
  const loot = game("space/npc/npcLoot");
  const pool = loot._testing.getRuleCandidatePool({ kind: "module", sizeBand: "small" }).map((row) => Number(row.typeID));
  assert.ok(!pool.includes(5241) && !pool.includes(25861), "no salvage gear in the module pool without the layer");
});

check("the launcher's Configure form (preferences.json) sets the tunables, live", () => {
  const fs = require("fs");
  const settings = own("game");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "evejs-launcher.mod.json"), "utf8"));
  const fields = manifest.settings.fields;
  // Every form field has a tunable, and every default is the code's own.
  const defaults = { EVEJS_SALVAGE_CHANCE_BONUS: 15, EVEJS_SALVAGE_EMPTY_FACTOR: 0.35, EVEJS_SALVAGE_SCRAP: 1, EVEJS_SALVAGE_ALLOYS: 0,
    EVEJS_SALVAGE_HULL_RECOVERY: 0, EVEJS_CUT_SPEED: 1, EVEJS_CUT_RECOVERY: 0.2, EVEJS_CUT_CONTAINERS: 2, EVEJS_CUT_WRECK_HOLD_MINUTES: 30 };
  for (const field of fields) {
    const entry = settings.PREFERENCES[field.key[0]];
    assert.ok(entry, `${field.id} has no tunable`);
    if (entry[1] === null) assert.strictEqual(field.default, true, field.id);
    else assert.ok(Math.abs(field.default * entry[1] - defaults[entry[0]]) < 1e-9, `${field.id} default ${field.default} is not ${defaults[entry[0]]}`);
  }
  assert.strictEqual(fields.length, Object.keys(settings.PREFERENCES).length);
  assert.strictEqual(settings.number("EVEJS_SALVAGE_CHANCE_BONUS", 15), 15);
  fs.writeFileSync(settings.PREFERENCES_FILE, JSON.stringify({ salvageChanceBonus: 25, emptyWreckPct: 50, gearInLoot: false }));
  try {
    assert.strictEqual(settings.number("EVEJS_SALVAGE_CHANCE_BONUS", 15), 25);
    assert.strictEqual(settings.number("EVEJS_SALVAGE_EMPTY_FACTOR", 0.35), 0.5);
    assert.strictEqual(settings.flag("EVEJS_SALVAGE_GEAR_LOOT", true), false);
    assert.strictEqual(settings.number("EVEJS_CUT_SPEED", 1), 1, "an unsaved field keeps its default");
    assert.strictEqual(salvager._testing.calculateSalvageChancePercent(30, 0), 55, "the salvager reads it at once");
  } finally {
    fs.unlinkSync(settings.PREFERENCES_FILE);
  }
  // mtime resolution: a later stat sees the file gone.
  assert.strictEqual(settings.number("EVEJS_SALVAGE_CHANCE_BONUS", 15), 15);
});

check("the Salvage Hold takes scrap and says what it takes", () => {
  const holds = game("services/inventory/specialShipHoldRegistry");
  assert.strictEqual(holds.isSpecialShipHoldItemAllowed(15331, 137), true);
  assert.strictEqual(holds.isSpecialShipHoldItemAllowed(30497, 137), true);
  assert.notStrictEqual(holds.isSpecialShipHoldItemAllowed(34, 137), true, "Tritanium is not salvage");
  assert.match(holds.getSpecialShipHoldRestrictionMessage(137), /salvage materials, alloys and scrap/);
});

check("salvage is split between the Salvage Hold and cargo in whole units", () => {
  const routing = own("salvageHoldRouting");
  const split = routing.plan([{ itemType: 15331, quantity: 10 }, { itemType: 34, quantity: 5 }], 1000, 1000);
  assert.deepStrictEqual(split.hold.map((e) => [e.itemType, e.quantity]), [[15331, 10]]);
  assert.deepStrictEqual(split.cargo.map((e) => [e.itemType, e.quantity]), [[34, 5]]);
  assert.deepStrictEqual(split.left, []);
});

check("a cutter's activation and cycle go to wreck cutting; a mining laser's do not", () => {
  const cutting = own("wreckCutting");
  spyOn(cutting, "executeCutCycle", () => ({ success: false, stopReason: "spy" }), (calls) => {
    const scene = { getEntityByID: () => null, getCurrentSimTimeMs: () => 1000 };
    const result = mining.executeMiningCycle(scene, { itemID: 1 }, { typeID: 5241, targetID: 9 }, 1000, {});
    assert.strictEqual(result.stopReason, "spy");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][4].efficiency, 1);
    // Out of capacitor: the original stops the cycle itself, and the cutter is not asked.
    assert.strictEqual(mining.executeMiningCycle(scene, { itemID: 1 }, { typeID: 5241, targetID: 9 }, 1000, { efficiency: 0 }).stopReason, "cycle");
    assert.strictEqual(calls.length, 1);
  });
  spyOn(cutting, "resolveCutActivation", () => ({ matched: true, success: false, errorMsg: "SPY" }), (calls) => {
    const scene = { getEntityByID: () => null, getCurrentSimTimeMs: () => 1000 };
    const effectRecord = { effectID: 67, name: "miningLaser", effectName: "miningLaser", guid: "effects.Mining" };
    const result = mining.resolveMiningActivation(scene, { itemID: 1 }, { typeID: 5241, itemID: 2 }, effectRecord, { targetID: 9 });
    if (mining.isMiningEffectRecord(effectRecord, { typeID: 5241 })) {
      assert.strictEqual(result.errorMsg, "SPY");
      assert.strictEqual(calls.length, 1);
    } else {
      assert.strictEqual(calls.length, 0, "a record that is not mining went to the cutter");
    }
  });
  assert.strictEqual(cutting.isCutterEffectState({ typeID: 483 }), false, "Miner II is not a cutter");
});

check("guns on a native wreck destroy it through the wreck service", () => {
  const wrecks = game("space/npc/nativeNpcWreckService");
  spyOn(wrecks, "destroyNativeWreck", () => ({ success: true, spy: true }), (calls) => {
    const scene = { getCurrentSimTimeMs: () => 5000 };
    const result = game("space/runtime/combatDestruction").destroyCombatEntity(scene, { nativeNpcWreck: true, itemID: 77 }, {});
    assert.strictEqual(result.spy, true);
    assert.strictEqual(calls[0][0], 77);
    assert.strictEqual(calls[0][1].nowMs, 5000);
  });
});

check("the salvage service answers for other mods and bots", () => {
  const service = core.services.use("salvage", "1");
  assert.ok(service, "no salvage service");
  assert.strictEqual(service.isCutterType(5241), true);
  assert.strictEqual(service.isCutterType(483), false);
  // The three tech 1 cutters and the module family's 43 others.
  const cutters = service.cutterTypes();
  assert.ok([5235, 5241, 5243, 992005, 992060, 992105].every((id) => cutters.includes(id)), JSON.stringify(cutters));
  assert.strictEqual(cutters.length, 46);
  assert.strictEqual(service.isCutterType(992080), true); // Field Reclaimer I
  assert.strictEqual(service.isCutterType(992120), false); // Salvager family
  assert.ok(service.salvagerTypes().includes(25861) && service.salvagerTypes().includes(30836));
  assert.strictEqual(service.moduleVariant(992005).name, "Hull Panel Cutter II");
  assert.strictEqual(service.salvageHoldAccepts(15331), true);
  const minerals = service.hullMinerals(587); // Rifter
  assert.ok(minerals && minerals[34] > 0, `Rifter hull minerals ${JSON.stringify(minerals)}`);
  const alloys = service.hullAlloys(minerals, 0.6, () => 0.5);
  const known = new Set(service.alloyTypeIDs().map(Number));
  assert.ok(alloys.length > 0 && alloys.every((drop) => known.has(Number(drop.typeID)) && drop.quantity > 0), JSON.stringify(alloys));
  assert.strictEqual(service.hullMinerals(15331), null, "Metal Scraps is not a hull");
});

check("a Rifter wreck's cutting HP comes from its hull and starts whole", () => {
  const cutting = own("wreckCutting");
  const record = { sourceTypeID: 587, typeID: 26557 };
  const hp = cutting.hullCutHP(record);
  assert.ok(hp > 0 && hp < 1000, `Rifter cut HP ${hp}`);
  assert.strictEqual(cutting.hullLeftShare(record), 1);
  assert.strictEqual(cutting.hullLeftShare({ cutting: { hpMax: 800, hpLeft: 200 } }), 0.25);
});

check("hooks registered by the mod", () => {
  const names = core.hooks.status().filter((h) => h.handlers.some((x) => x.mod === "reverie-salvage")).map((h) => h.name).sort();
  assert.deepStrictEqual(names, ["loot.selectorKind", "mining.allowNoYield", "salvage.accessDifficultyBase", "salvage.cargoFull", "salvage.chanceBonus", "salvage.cycle",
    "salvage.emptyFactor", "salvage.extraRoom", "salvage.rewardEntries", "salvage.rewardSplit"]);
  const faulted = core.hooks.status().flatMap((h) => h.handlers.filter((x) => x.faults > 0).map((x) => `${h.name} ${x.faults}`));
  assert.deepStrictEqual(faulted, []);
});

// The type layer as a clean server gets it: composed from the installed mods, then read through
// the core's hook points in referenceData and industryStaticData. REVERIE_TYPE_LAYER=server
// stands in for a patched client (the ledger), which this test has none of.
check("the composed type layer reaches the server's tables through the core's hook points", () => {
  const compose = require(path.join(core.paths.modsDir, "reverie-core", "client", "compose"));
  const { layer, errors } = compose.compose();
  assert.deepStrictEqual(errors, []);
  assert.ok(layer.mods.some((mod) => mod.id === "reverie-salvage"), "salvage has no layer");
  // Every tech 1 cutter blueprint is sold where Salvager I Blueprint is, priced against it.
  const stock = new Map(layer.marketStock.map((entry) => [entry.typeID, entry]));
  const t1Family = [...stock.keys()].filter((id) => id >= 992500);
  assert.deepStrictEqual([28751, 22922, 28749].map((id) => stock.has(id)), [true, true, true], "an original cutter blueprint is not stocked");
  assert.strictEqual(t1Family.length, 3, `family tech 1 blueprints stocked: ${t1Family}`);
  assert.strictEqual(layer.marketStock.length, 6);
  for (const entry of layer.marketStock) {
    assert.strictEqual(entry.like, 25862);
    assert.strictEqual(entry.likeBasePrice, 332640);
    assert.strictEqual(entry.mod, "reverie-salvage");
  }
  assert.strictEqual(stock.get(28751).basePrice, 332640);
  assert.strictEqual(stock.get(22922).basePrice, 415800);
  assert.strictEqual(stock.get(t1Family[0]).basePrice, 498960);
  assert.ok(!stock.has(992505), "a tech 2 blueprint is on the market");
  compose.save(layer);
  const registry = game("services/inventory/itemTypeRegistry");
  assert.strictEqual(registry.resolveItemByTypeID(5241).name, "Dual Diode Mining Laser I");
  assert.strictEqual(registry.resolveItemByTypeID(992005), null, "a family type before the layer is on");
  const { panelLook } = own("wreckCutting")._testing;
  const plain = panelLook("small", "common", 100);
  assert.strictEqual(plain.type.typeID, 26935, "a panel took a debris model before the client had it");
  assert.strictEqual(plain.radius, null);
  process.env.REVERIE_TYPE_LAYER = "server";
  try {
    const live = core.typeLayer.applyLive();
    assert.strictEqual(live.active, true, live.reason);
    // The item type index the server built before is built again, new types included, with no restart.
    assert.strictEqual(registry.resolveItemByTypeID(992005).name, "Hull Panel Cutter II");
    assert.strictEqual(registry.resolveItemByTypeID(5241).name, "Hull Panel Cutter I");
    assert.strictEqual(registry.resolveItemByTypeID(992505).name, "Hull Panel Cutter II Blueprint");
    const common = panelLook("small", "common", 100);
    assert.ok([75781, 80246].includes(common.type.typeID), `common panel ${common.type.typeID}`);
    assert.ok(common.radius > 0, "no panel radius");
    assert.ok([80247, 90038].includes(panelLook("large", "rare", 5000).type.typeID), "rare panel");
    const ref = game("services/_shared/referenceData");
    const rows = ref.readStaticRows("itemTypes");
    const row = (id) => rows.find((r) => Number(r.typeID) === id);
    assert.strictEqual(row(5241).name, "Hull Panel Cutter I");
    assert.strictEqual(row(5241).groupID, 990050);
    assert.strictEqual(row(28751).basePrice, 332640, "the cutter blueprint keeps the ORE Miner's price");
    assert.strictEqual(row(992005).name, "Hull Panel Cutter II");
    assert.strictEqual(row(992085).name, "Field Reclaimer II");
    assert.strictEqual(row(75781).name, "Hull Plating");
    const dogma = ref.readStaticTable("typeDogma");
    const cutter = dogma.typesByTypeID["5241"].attributes;
    assert.strictEqual(cutter["77"], undefined, "the cutter still mines");
    assert.strictEqual(cutter["7900"], 300);
    assert.ok(dogma.attributeTypesByID["7904"], "no cutter attribute 7904");
    const industry = game("services/industry/industryStaticData");
    assert.strictEqual(industry.getBlueprintDefinitionByTypeID(28751).productTypeID, 5241);
    assert.strictEqual(industry.getBlueprintDefinitionByProductTypeID(992005).blueprintTypeID, 992505);
    assert.ok(industry.getBlueprintDefinitionByTypeID(992580), "no Field Reclaimer I Blueprint");
  } finally {
    delete process.env.REVERIE_TYPE_LAYER;
    core.typeLayer.applyLive();
  }
  assert.strictEqual(registry.resolveItemByTypeID(992005), null, "a family type outlived the layer");
  assert.strictEqual(registry.resolveItemByTypeID(5241).name, "Dual Diode Mining Laser I");
});

console.log(failures ? `${failures} failed` : "probe passed");
process.exit(failures ? 1 : 0);
