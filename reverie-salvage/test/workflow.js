"use strict";

// Runs inside the test install (test/run.js) after probe.js, in a process started with
// REVERIE_TYPE_LAYER=server, so the type layer is on from boot as it is on a trial server. It
// follows one pilot's way from the market to alloys, in order, through the game's own code:
// the cutter blueprint, its materials, the cutter's dogma as fitting reads it, the mining
// snapshot an activation builds, cutting a Rifter wreck down to nothing, salvaging every panel
// it gave into the Salvage Hold, and refining those alloys at a station.

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
    stopped = true; // each step needs the one before it
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  }
}
function spyOn(object, key, fake) {
  const before = object[key];
  object[key] = fake;
  return () => { object[key] = before; };
}

const CUTTER = 5241; // Hull Panel Cutter I
const CUTTER_BLUEPRINT = 28751;
const SALVAGER_I = 25861;
const RIFTER = 587;
const SALVAGE_HOLD = 137;
const CHARACTER_ID = 140000901;
const SHIP_ID = 990000000901;
const SYSTEM_ID = 30000142;

const registry = game("services/inventory/itemTypeRegistry");
const ref = game("services/_shared/referenceData");
const industry = game("services/industry/industryStaticData");

check("the type layer is on from boot", () => {
  const status = core.typeLayer.status();
  assert.strictEqual(status.active, true, status.reason);
  assert.ok(status.mods.some((mod) => mod.id === "reverie-salvage"), "salvage is not in the layer");
});

check("1. the market: the cutter blueprint is a published blueprint the layer stocks", () => {
  const blueprint = registry.resolveItemByTypeID(CUTTER_BLUEPRINT);
  assert.ok(blueprint, "no blueprint type");
  assert.strictEqual(blueprint.name, "Hull Panel Cutter I Blueprint");
  assert.strictEqual(Number(blueprint.categoryID), 9, "not a blueprint category");
  assert.ok(blueprint.published !== false && blueprint.published !== 0, "not published");
  const stock = core.typeLayer.layer().marketStock || [];
  assert.ok(stock.some((entry) => entry.typeID === CUTTER_BLUEPRINT), "not stocked");
});

let materials = [];
check("2. building: the blueprint makes the cutter from materials that all exist", () => {
  const definition = industry.getBlueprintDefinitionByTypeID(CUTTER_BLUEPRINT);
  assert.ok(definition, "no blueprint definition");
  assert.strictEqual(definition.productTypeID, CUTTER);
  const manufacturing = definition.activities && definition.activities.manufacturing;
  assert.ok(manufacturing && Number(manufacturing.time) > 0, "no manufacturing time");
  materials = manufacturing.materials || [];
  assert.ok(materials.length > 0, "no materials");
  for (const material of materials) {
    const type = registry.resolveItemByTypeID(Number(material.typeID));
    assert.ok(type, `material ${material.typeID} is not a type`);
    assert.ok(Number(material.quantity) > 0, `material ${material.typeID} quantity ${material.quantity}`);
  }
  for (const skill of manufacturing.skills || []) assert.ok(registry.resolveItemByTypeID(Number(skill.typeID)), `skill ${skill.typeID}`);
  assert.strictEqual(industry.getBlueprintDefinitionByProductTypeID(CUTTER).blueprintTypeID, CUTTER_BLUEPRINT);
});

check("2b. research: every tech 1 cutter blueprint researches, copies and invents a tech 2 blueprint that builds", () => {
  const exists = (list, what) => {
    for (const entry of list || []) assert.ok(registry.resolveItemByTypeID(Number(entry.typeID)), `${what} ${entry.typeID} is not a type`);
  };
  // The three original cutters' blueprints and the three new kinds'.
  for (const [t1Blueprint, t2Blueprint, t2Product] of [[28751, 992505, 992005], [22922, 992525, 992025], [28749, 992545, 992045],
    [992560, 992565, 992065], [992580, 992585, 992085], [992600, 992605, 992105]]) {
    const definition = industry.getBlueprintDefinitionByTypeID(t1Blueprint);
    assert.ok(definition, `no definition for ${t1Blueprint}`);
    const activities = definition.activities || {};
    for (const key of ["research_material", "research_time", "copying"]) {
      assert.ok(activities[key] && Number(activities[key].time) > 0, `${t1Blueprint} has no ${key}`);
    }
    const invention = activities.invention;
    assert.ok(invention, `${t1Blueprint} has no invention`);
    assert.strictEqual(Number(invention.products[0].typeID), t2Blueprint, `${t1Blueprint} invents ${invention.products[0].typeID}`);
    assert.ok(invention.products[0].probability > 0 && invention.products[0].probability < 1);
    exists(invention.materials, "datacore");
    exists(invention.skills, "invention skill");
    const t2 = industry.getBlueprintDefinitionByTypeID(t2Blueprint);
    assert.ok(t2, `no tech 2 blueprint ${t2Blueprint}`);
    assert.strictEqual(Number(t2.productTypeID), t2Product);
    assert.ok(!t2.activities.invention, `${t2Blueprint} invents again`);
    exists(t2.activities.manufacturing.materials, "tech 2 material");
    assert.ok(registry.resolveItemByTypeID(t2Product), `tech 2 product ${t2Product}`);
  }
});

let effectRecord = null;
check("3. fitting: the cutter's dogma, as fitting reads it, is the cutter's and not a mining laser's", () => {
  const type = registry.resolveItemByTypeID(CUTTER);
  assert.strictEqual(type.name, "Hull Panel Cutter I");
  assert.strictEqual(Number(type.groupID), 990050);
  const attributes = game("services/fitting/liveFittingState").getTypeAttributeMap(CUTTER) || {};
  assert.strictEqual(attributes[77], undefined, "fitting still sees a mining amount");
  assert.ok(Number(attributes[7900]) > 0, "fitting does not see the cut rate (attribute 7900)");
  assert.ok(Number(attributes[50]) > 0 && Number(attributes[30]) > 0, "no CPU or power grid need");
  assert.ok(Number(attributes[54]) > 0, "no range");
  assert.ok(Number(attributes[73]) > 0, "no cycle time");
  const skill = Number(attributes[182]);
  assert.ok(skill > 0 && registry.resolveItemByTypeID(skill), `required skill ${skill}`);
  const dogma = ref.readStaticTable("typeDogma");
  const effects = (dogma.typesByTypeID[String(CUTTER)].effects || []).map(Number);
  assert.ok(effects.includes(12), "not a high slot module (effect 12)");
  const miningDogma = game("services/mining/miningDogma");
  const records = effects.map((id) => dogma.effectTypesByID[String(id)]).filter(Boolean);
  effectRecord = records.find((record) => miningDogma.isMiningEffectRecord(record, { typeID: CUTTER })) || null;
  assert.ok(effectRecord, `no effect the mining runtime takes, in ${effects}`);
});

let snapshot = null;
check("4. activation: the mining snapshot is built for a cutter with no mining amount", () => {
  snapshot = game("services/mining/miningDogma").buildMiningModuleSnapshot({
    shipItem: { itemID: SHIP_ID, typeID: RIFTER, ownerID: CHARACTER_ID, flagID: 4 },
    moduleItem: { itemID: SHIP_ID + 1, typeID: CUTTER, locationID: SHIP_ID, flagID: 27, ownerID: CHARACTER_ID, online: true, singleton: 1, quantity: 1 },
    effectRecord,
    fittedItems: [],
    skillMap: new Map(),
  });
  assert.ok(snapshot, "no snapshot: the activation would fail with UNSUPPORTED_MODULE");
  assert.ok(Number(snapshot.maxRangeMeters) > 0, `range ${snapshot.maxRangeMeters}`);
  assert.ok(Number(snapshot.durationMs) > 0, `duration ${snapshot.durationMs}`);
  assert.ok(own("cuttingLaserCatalog").profileForType(CUTTER), "no cutting profile");
});

// A scene with a ship and a Rifter wreck, and the scene-side calls answered here.
const npcStore = game("space/npc/nativeNpcStore");
const wreckService = game("space/npc/nativeNpcWreckService");
const entities = new Map();
const scene = {
  systemID: SYSTEM_ID,
  getEntityByID: (id) => entities.get(Number(id)) || null,
  getCurrentSimTimeMs: () => Date.now(),
};
const ship = { itemID: SHIP_ID, typeID: RIFTER, characterID: CHARACTER_ID, systemID: SYSTEM_ID, position: { x: 0, y: 0, z: 0 }, radius: 40 };
entities.set(SHIP_ID, ship);
const restores = [];
restores.push(spyOn(wreckService, "spawnNativeWreck", (systemID, wreckID) => {
  const record = npcStore.getNativeWreck(Number(wreckID));
  if (!record) return { success: false, errorMsg: "NO_RECORD" };
  entities.set(Number(wreckID), { itemID: Number(wreckID), typeID: record.typeID, nativeNpcWreck: true, position: record.position, radius: record.radius || 20 });
  return { success: true };
}));
restores.push(spyOn(wreckService, "destroyNativeWreck", (wreckID) => {
  entities.delete(Number(wreckID));
  try { npcStore.removeNativeWreckCascade(Number(wreckID)); } catch (_) { /* gone */ }
  return { success: true };
}));

let wreckID = 0;
const panels = [];
check("5. cutting: a Hull Panel Cutter I cuts a Rifter wreck to nothing and leaves alloy panels", () => {
  const allocated = npcStore.allocateWreckID({ transient: true });
  wreckID = Number(allocated && allocated.success ? allocated.data : 0);
  assert.ok(wreckID > 0, "no wreck ID");
  const now = Date.now();
  const stored = npcStore.upsertNativeWreck({
    wreckID, typeID: 26557, groupID: 186, categoryID: 2, itemName: "Rifter Wreck", sourceTypeID: RIFTER, ownerID: 1000127,
    systemID: SYSTEM_ID, position: { x: 2000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, createdAtMs: now, expiresAtMs: now + 3600000,
    conditionState: { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 0, incapacitated: false },
  }, { transient: true });
  assert.ok(stored && stored.success !== false, `wreck not stored: ${stored && stored.errorMsg}`);
  entities.set(wreckID, { itemID: wreckID, typeID: 26557, nativeNpcWreck: true, position: { x: 2000, y: 0, z: 0 }, radius: 30 });
  const cutting = own("wreckCutting");
  const helpers = { getTargetsForEntity: () => [...entities.keys()].filter((id) => id !== SHIP_ID) };
  let cycles = 0;
  let last = null;
  while (cycles < 200) {
    cycles += 1;
    last = cutting.executeCutCycle(scene, ship, { typeID: CUTTER, targetID: wreckID }, Date.now(), { efficiency: 1, preparedCycle: { snapshot } }, helpers);
    assert.ok(last && last.success, `cycle ${cycles} stopped: ${last && last.stopReason}`);
    panels.push(...(last.data.panels || []));
    if (last.data.depleted) break;
  }
  assert.ok(last.data.depleted, `the wreck was not cut away in ${cycles} cycles`);
  assert.ok(!entities.has(wreckID), "the wreck is still in space");
  assert.ok(panels.length > 0, "no panels");
  const alloys = new Set(own("cuttingLaserCatalog").ALLOY_TYPE_IDS.map(Number));
  const modelled = new Set([75781, 80246, 80247, 90038]);
  for (const panel of panels) {
    const record = npcStore.getNativeWreck(panel.panelID);
    assert.ok(record && record.wreckPanel, `panel ${panel.panelID} has no record`);
    assert.ok(modelled.has(Number(record.typeID)), `panel type ${record.typeID} is not a layer debris model`);
    assert.strictEqual(Number(record.groupID), 186, "a panel is not a wreck to the salvager");
    for (const typeID of Object.keys(record.wreckPanel.alloys)) assert.ok(alloys.has(Number(typeID)), `panel holds ${typeID}`);
  }
  console.log(`      ${cycles} cycles, ${panels.length} panels`);
});

const itemStore = game("services/inventory/itemStore");
check("6. salvaging: a Salvager I takes every panel apart into the Salvage Hold", () => {
  // The pilot, in the throwaway store: the item store grants only to a character it knows.
  const wrote = game("gameStore/index").write("characters", `/${CHARACTER_ID}`, {
    characterID: CHARACTER_ID, characterName: "Workflow Pilot", shipID: SHIP_ID, shipTypeID: RIFTER, solarSystemID: SYSTEM_ID,
  });
  assert.ok(wrote && wrote.success !== false, `no pilot: ${wrote && wrote.errorMsg}`);
  const cutting = own("wreckCutting");
  for (const panel of panels) {
    let guard = 0;
    for (;;) {
      assert.ok(guard++ < 10, `panel ${panel.panelID} never came apart`);
      const result = cutting.salvagePanelCycle({
        scene, entity: ship, targetEntity: entities.get(panel.panelID), effectState: { typeID: SALVAGER_I },
        characterID: CHARACTER_ID, rewardLocationID: SHIP_ID, shipID: SHIP_ID,
        cargoSnapshot: { availableVolume: 1e6 }, salvageHoldFree: 1e6, skillMap: new Map(), nowMs: Date.now(), helpers: {},
      });
      if (result.success) continue;
      assert.strictEqual(result.stopReason, "target", `salvaging stopped: ${result.stopReason}`);
      assert.ok(result.data && result.data.salvaged, "the panel was not finished");
      break;
    }
    assert.ok(!entities.has(panel.panelID), `panel ${panel.panelID} is still in space`);
  }
  const inHold = itemStore.listCharacterItems(CHARACTER_ID, { locationID: SHIP_ID, flagID: SALVAGE_HOLD }) || [];
  const alloys = new Set(own("cuttingLaserCatalog").ALLOY_TYPE_IDS.map(Number));
  const held = inHold.filter((item) => alloys.has(Number(item.typeID)));
  assert.ok(held.length > 0, `no alloys in the Salvage Hold: ${JSON.stringify(inHold.map((item) => [item.typeID, item.flagID]))}`);
  const byType = new Map();
  for (const item of held) byType.set(Number(item.typeID), (byType.get(Number(item.typeID)) || 0) + 1);
  for (const [typeID, stacks] of byType) assert.strictEqual(stacks, 1, `type ${typeID} is in ${stacks} stacks`);
  console.log(`      ${held.map((item) => `${item.stacksize ?? item.quantity} ${registry.resolveItemByTypeID(item.typeID).name}`).join(", ")}`);
});

check("7. refining: every alloy in the hold refines into minerals at a station", () => {
  const repro = game("services/reprocessing/reprocessingStaticData");
  const inHold = itemStore.listCharacterItems(CHARACTER_ID, { locationID: SHIP_ID, flagID: SALVAGE_HOLD }) || [];
  for (const item of inHold) {
    const rows = repro.getTypeMaterials(Number(item.typeID)) || [];
    assert.ok(rows.length > 0, `${item.typeID} refines into nothing`);
    const type = registry.resolveItemByTypeID(Number(item.typeID));
    assert.ok(Number(type.portionSize || 1) >= 1, "no portion size");
  }
});

check("8. loot: cutters and salvagers sit in the loot tables' module pools beside every other module", () => {
  const loot = game("space/npc/npcLoot");
  loot._testing.clearRuleCandidateCache();
  const ids = (selector) => new Set(loot._testing.getRuleCandidatePool(selector).map((row) => Number(row.typeID)));
  const small = ids({ kind: "module", sizeBand: "small" });
  const large = ids({ kind: "module", sizeBand: "large" });
  // T1 and meta models in the low-tier pools of every size; T2, faction, deadspace, officer and civilian not.
  for (const typeID of [5241, 992001, 992004, 5243, 5235, 992060, 992080, 992100, SALVAGER_I, 992121]) {
    assert.ok(small.has(typeID), `${typeID} not in the small module pool`);
    assert.ok(large.has(typeID), `${typeID} not in the large module pool`);
  }
  for (const typeID of [992005, 30836, 992006, 992007, 992008, 992012, 992013]) assert.ok(!small.has(typeID), `${typeID} in the low-tier pool`);
  assert.ok(small.size > 30, `the pool is only ${small.size} types, so gear would be most of it`);
  // Faction, deadspace and officer models in the tables that name them (clean EveJS's Angel tables).
  const domination = ids({ kind: "module", grade: "faction", nameIncludes: ["Domination"] });
  for (const typeID of [992007, 992027, 992047, 992127]) assert.ok(domination.has(typeID), `${typeID} not with the Domination modules`);
  const gist = ids({ kind: "module", grade: "deadspace", nameIncludes: ["Gist"] });
  for (const typeID of [992008, 992011, 992131]) assert.ok(gist.has(typeID), `${typeID} not with the Gist modules`);
  const officers = ids({ kind: "module", grade: "officer", nameIncludes: ["Gotan", "Hakim", "Mizuro", "Tobias"] });
  for (const typeID of [992012, 992032, 992052, 992132]) assert.ok(officers.has(typeID), `${typeID} not with the officer modules`);
  // Not in the ammo or tank pools.
  assert.ok(!ids({ kind: "utility", sizeBand: "small" }).has(5241));
  // How much of each pool is salvage gear, for the drop rates in the README.
  const family = own("salvageModuleFamily");
  const share = (set) => `${[...set].filter((typeID) => family.variantOf(typeID)).length} of ${set.size}`;
  const pools = {
    small, medium: ids({ kind: "module", sizeBand: "medium" }), large, any: ids({ kind: "module" }),
    commander: ids({ kind: "module", grade: "faction" }), Domination: domination, Gist: gist, officers,
  };
  console.log(`      gear in the module pools: ${Object.entries(pools).map(([name, set]) => `${name} ${share(set)}`).join(", ")}`);
  // The player's setting takes them out again, at the next roll.
  const prefs = own("game").PREFERENCES_FILE;
  require("fs").writeFileSync(prefs, JSON.stringify({ gearInLoot: false }));
  try {
    loot.rollNpcLootEntries(null, { random: () => 0.99, source: {} });
    assert.ok(!ids({ kind: "module", sizeBand: "small" }).has(5241), "still in the pool with the setting off");
  } finally {
    require("fs").unlinkSync(prefs);
  }
  loot.rollNpcLootEntries(null, { random: () => 0.99, source: {} });
  assert.ok(ids({ kind: "module", sizeBand: "small" }).has(5241), "not back in the pool with the setting on");
});

for (const restore of restores.reverse()) restore();
console.log(failures ? `${failures} failed` : "workflow passed");
process.exit(failures ? 1 : 0);
