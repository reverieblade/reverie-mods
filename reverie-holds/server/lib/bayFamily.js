"use strict";

// The bay extensions (README.md, "What it adds"): low slot modules that grow a
// ship's special bays or give it one it does not have, the way an Expanded
// Cargohold grows the cargo hold. Ported from the Scarlet build's
// services/shipSystems/bayExtensionFamily.js with the same IDs, numbers and
// text, so a pilot who moves between the two sees the same modules.
//
// Each module adds a flat amount (attribute 7910, by size) and then a share of
// the bay (7911, by tier) to one bay: on a ship with no such bay the flat
// amount is the whole bay; on a ship built around one (a Retriever's mining
// hold) the share is what counts. Dogma applies modAdd before postPercent, so
// the share grows the flat amount too. Each costs top speed and structure like
// an Expanded Cargohold (CCP's own penalty effects, kept from the clone).
//
// Kinds x sizes x tiers: 7 bays, small/medium/large, tech 1, meta 1-4 (loot
// only) and tech 2. Only ever append kinds, sizes and tiers: the order is part
// of the ID scheme (typeID = FIRST_TYPE_ID + kind*20 + size*6 + tier).
//
// The same file builds a partner mod's module bay (moduleBay, moduleDroneBay):
// the two attributes and the bay's effect on a module of theirs, so a salvager
// carries a Salvage Hold and a Drone Field Assembler a drone bay.

const FIRST_TYPE_ID = 993_000;
const FIRST_BLUEPRINT_TYPE_ID = 993_500;
const FIRST_EFFECT_ID = 13_900;

const CLONE_SOURCE = 1317; // Expanded Cargohold I: low slot, online, speed and structure penalties
const CLONE_BLUEPRINT = 1318; // Expanded Cargohold I Blueprint
const CARGO_EFFECT_ID = 59; // cargoCapacityMultiply, the clone's cargo bonus (removed)
const CARGO_MULTIPLIER_ATTRIBUTE_ID = 149; // its cargo multiplier (removed)
const HULL_UPGRADES_SKILL = 3394;
const INDUSTRY_SKILL = 3380;
const MARKET_GROUP_ID = 1197; // Expanded Cargohold
const BLUEPRINT_MARKET_GROUP_ID = 335; // Hull Mods blueprints

// The salvage module family's price ladder (reverie-salvage), so a bay
// extension of a tier costs what a salvager of that tier does against its T1.
const PRICE_FACTOR = Object.freeze({ t1: 1, m1: 1.6, m2: 2.2, m3: 3, m4: 4, t2: 9 });

const ATTR = Object.freeze({
  power: 30,
  cpu: 50,
  structureMultiplier: 150,
  velocityMultiplier: 306,
  requiredSkill1: 182,
  requiredSkill1Level: 277,
  techLevel: 422,
  metaLevel: 633,
  metaGroupID: 1692,
  bayAdded: 7910,
  bayBonus: 7911,
  bandwidthAdded: 7912,
});
const SHIP_DRONE_CAPACITY = 283;
const SHIP_DRONE_BANDWIDTH = 1271;

// Their own group, a copy of Expanded Cargohold (765, category Module).
const GROUP = Object.freeze({ groupID: 990_051, name: "Bay Extension", templateGroupID: 765, categoryID: 7 });

// templateID: the CCP attribute each copies for its icon (Capacity).
const ATTRIBUTES = Object.freeze([
  { attributeID: ATTR.bayAdded, name: "bayExtensionCapacityAdded", templateID: 38, unitID: 9, highIsGood: true,
    displayText: "Bay Capacity Added",
    tooltip: "The capacity this module adds to its bay. A ship that lacks the bay gains one of this size." },
  { attributeID: ATTR.bayBonus, name: "bayExtensionCapacityBonus", templateID: 38, unitID: 105, highIsGood: true,
    displayText: "Bay Capacity Bonus",
    tooltip: "The percentage by which this module increases the total capacity of its bay, including the capacity it adds." },
  // The drone bay a working module brings (moduleDroneBay). templateID 1271 is
  // the hull's Drone Bandwidth, unit 128 megabits per second.
  { attributeID: ATTR.bandwidthAdded, name: "moduleDroneBandwidthAdded", templateID: 1271, unitID: 128, highIsGood: true,
    displayText: "Drone Bandwidth Added",
    tooltip: "The drone bandwidth this module adds to the ship. A ship that has no drone bandwidth gains this much." },
]);

// flag: the inventory flag of the bay. operation: 2 modAdd, 6 postPercent.
const KINDS = Object.freeze([
  { key: "mining", name: "Mining Hold", attributeID: 1556, flag: 134, alsoGrows: [3136, 1557, 3227], flat: [1000, 3000, 6000],
    holds: "ore, ice and gas", text: "Mining barges and mining frigates can carry more on each trip, while other hulls gain a place to store what their lasers extract." },
  { key: "fuel", name: "Fuel Bay", attributeID: 1549, flag: 133, alsoGrows: [], flat: [10, 50, 250],
    holds: "fuel blocks and isotopes", text: "A larger fuel bay allows a ship to remain in space for longer before it has to refuel." },
  { key: "expedition", name: "Expedition Hold", attributeID: 5944, flag: 188, alsoGrows: [], flat: [150, 600, 2500],
    holds: "probes, deployables, boosters, blueprints and other exploration supplies", text: "It is intended for long expeditions away from a station." },
  { key: "salvage", name: "Salvage Hold", attributeID: 1559, flag: 137, alsoGrows: [], flat: [1000, 4000, 12000],
    holds: "salvaged parts and hull alloys", text: "It keeps the bulky alloys cut from wrecks out of the cargo hold." },
  { key: "ammo", name: "Ammo Hold", attributeID: 1573, flag: 143, alsoGrows: [], flat: [100, 400, 1500],
    holds: "ammunition and charges", text: "Ammunition stored here does not take up room in the cargo hold." },
  { key: "mineral", name: "Mineral Hold", attributeID: 1558, flag: 136, alsoGrows: [], flat: [1000, 3000, 6000],
    holds: "minerals and other raw materials", text: "It is intended for pilots who refine their ore in the field and haul the minerals home." },
  { key: "planetary", name: "Planetary Commodities Hold", attributeID: 1653, flag: 149, alsoGrows: [], flat: [1000, 3000, 6000],
    holds: "planetary commodities", text: "It is intended for hauling between colonies and stations." },
]);
const KIND_INDEX = Object.freeze(Object.fromEntries(KINDS.map((kind, index) => [kind.key, index])));

// Each bay's icon takes over an icon ID (1642-1653, which CCP's data uses only
// as the icons of ancestries 2-13; those show ours instead), with its own 64 px
// file in client/assets. Every tier and the blueprints share it.
const ICONS = Object.freeze({
  mining: Object.freeze({ iconID: 1642, resource: "res:/ui/texture/icons/30_64_2.png", file: "client/assets/bay_mining.png" }),
  fuel: Object.freeze({ iconID: 1643, resource: "res:/ui/texture/icons/30_64_3.png", file: "client/assets/bay_fuel.png" }),
  expedition: Object.freeze({ iconID: 1644, resource: "res:/ui/texture/icons/30_64_4.png", file: "client/assets/bay_expedition.png" }),
  salvage: Object.freeze({ iconID: 1647, resource: "res:/ui/texture/icons/30_64_5.png", file: "client/assets/bay_salvage.png" }),
  ammo: Object.freeze({ iconID: 1648, resource: "res:/ui/texture/icons/30_64_8.png", file: "client/assets/bay_ammo.png" }),
  mineral: Object.freeze({ iconID: 1650, resource: "res:/ui/texture/icons/30_64_13.png", file: "client/assets/bay_mineral.png" }),
  planetary: Object.freeze({ iconID: 1651, resource: "res:/ui/texture/icons/30_64_12.png", file: "client/assets/bay_planetary.png" }),
});

// Market groups: a "Bay Extensions" folder under Hull Upgrades with one group
// per bay, and the same for the blueprints under Hull & Armor.
// IDs: folder FIRST + 0, bay groups FIRST + 1 + kind index.
const MARKET_GROUP_BASE = Object.freeze({ modules: 990_100, blueprints: 990_110 });
const MARKET_PARENTS = Object.freeze({ modules: 135, blueprints: 214 }); // Hull Upgrades; Blueprints > Hull & Armor
const marketGroupIDOf = (kind, side = "modules") => MARKET_GROUP_BASE[side] + 1 + KIND_INDEX[kind.key];

function marketGroups() {
  const out = [];
  for (const side of ["modules", "blueprints"]) {
    out.push({
      marketGroupID: MARKET_GROUP_BASE[side], parentGroupID: MARKET_PARENTS[side], hasTypes: false,
      templateMarketGroupID: side === "modules" ? MARKET_GROUP_ID : BLUEPRINT_MARKET_GROUP_ID, iconID: null,
      name: "Bay Extensions",
      description: side === "modules"
        ? "Modules that increase the capacity of a ship's specialized bays, or add a bay to a ship that lacks one."
        : "Blueprints for bay extensions.",
    });
    for (const kind of KINDS) {
      out.push({
        marketGroupID: marketGroupIDOf(kind, side), parentGroupID: MARKET_GROUP_BASE[side], hasTypes: true,
        templateMarketGroupID: side === "modules" ? MARKET_GROUP_ID : BLUEPRINT_MARKET_GROUP_ID, iconID: ICONS[kind.key].iconID,
        name: `${kind.name} Extensions`,
        description: side === "modules"
          ? `Modules that increase the capacity of a ship's ${kind.name.toLowerCase()}, which stores ${kind.holds}.`
          : `Blueprints for ${kind.name.toLowerCase()} extensions.`,
      });
    }
  }
  return out;
}

// Fitting by size, like armour plates (100mm 5/10, 400mm 30/20, 800mm 200/25):
// a small one is a real cost on a frigate (Rifter 41 PG), a medium takes a
// third of a barge's grid (Retriever 83), a large fits only the big haulers
// (Badger 185), the Orca and battleships.
const SIZES = Object.freeze([
  { key: "small", name: "Small", power: 5, cpu: 20, price: 15_000, buildScale: 1, time: 600 },
  { key: "medium", name: "Medium", power: 25, cpu: 35, price: 45_000, buildScale: 3, time: 1200 },
  { key: "large", name: "Large", power: 120, cpu: 50, price: 135_000, buildScale: 8, time: 2400 },
]);
const SIZE_INDEX = Object.freeze(Object.fromEntries(SIZES.map((size, index) => [size.key, index])));

// metaGroupID 1 Tech I, 2 Tech II. Meta names are our own.
const TIERS = Object.freeze([
  { key: "t1", metaGroupID: 1, metaLevel: 0, techLevel: 1, flat: 1, bonus: 5, cpu: 1, power: 1, velocity: 0.85, structure: 0.8, skill: 1 },
  { key: "m1", prefix: "Upgraded", metaGroupID: 1, metaLevel: 1, techLevel: 1, flat: 1.05, bonus: 5.5, cpu: 0.97, power: 1, velocity: 0.85, structure: 0.8, skill: 1 },
  { key: "m2", prefix: "Reinforced", metaGroupID: 1, metaLevel: 2, techLevel: 1, flat: 1.1, bonus: 6, cpu: 0.94, power: 1, velocity: 0.85, structure: 0.8, skill: 1 },
  { key: "m3", prefix: "Experimental", metaGroupID: 1, metaLevel: 3, techLevel: 1, flat: 1.15, bonus: 6.5, cpu: 0.91, power: 1, velocity: 0.85, structure: 0.8, skill: 1 },
  { key: "m4", prefix: "Prototype", metaGroupID: 1, metaLevel: 4, techLevel: 1, flat: 1.2, bonus: 7, cpu: 0.88, power: 1, velocity: 0.85, structure: 0.8, skill: 1 },
  { key: "t2", metaGroupID: 2, metaLevel: 5, techLevel: 2, flat: 1.25, bonus: 7.5, cpu: 1.15, power: 1.5, velocity: 0.82, structure: 0.77, skill: 4 },
]);
const TIER_INDEX = Object.freeze(Object.fromEntries(TIERS.map((tier, index) => [tier.key, index])));

const TIER_TEXT = Object.freeze({
  t1: "",
  m1: "This upgraded production model offers slightly more room and is easier to fit.",
  m2: "This reinforced model has stronger bracing, which allows the bay to be packed more tightly.",
  m3: "This experimental layout makes more room available within the same frame.",
  m4: "This prototype design never entered full production.",
  t2: "This Tech II model offers more room and a larger capacity bonus, at a higher cost in fitting, velocity and hull strength.",
});

const effectIDOf = (kind) => FIRST_EFFECT_ID + KIND_INDEX[kind.key];
const kindOf = (key) => KINDS[KIND_INDEX[key]] || null;

// A working module that carries a bay of its own: the module's dogma takes the
// two bay attributes and the bay's effect, exactly as an extension does. The
// flat is never stacking-penalised and the share is 0. Several such modules
// add up, and a ship without the bay gains one.
function moduleBay(kindKey, m3) {
  const kind = kindOf(kindKey);
  if (!kind) throw new Error(`bay family: no bay kind ${kindKey}`);
  return {
    kind: kind.key,
    name: kind.name,
    flag: kind.flag,
    m3: Number(m3),
    effectID: effectIDOf(kind),
    attributes: { [ATTR.bayAdded]: Number(m3), [ATTR.bayBonus]: 0 },
  };
}

// A drone bay and the bandwidth to fly from it, carried by a working module.
// The drone bay is not one of the special holds, so it has an effect of its
// own instead of a kind: the bay volume rides the same attribute as the other
// module bays (7910) and the bandwidth has its own (7912). Both are our
// attributes and not the hull's 283 and 1271.
const DRONE_BAY_EFFECT_ID = FIRST_EFFECT_ID + 7;
const DRONE_BAY_FLAG = 87;
function moduleDroneBay(m3, mbit) {
  return {
    kind: "drone",
    name: "Drone Bay",
    flag: DRONE_BAY_FLAG,
    m3: Number(m3),
    mbit: Number(mbit),
    effectID: DRONE_BAY_EFFECT_ID,
    attributes: { [ATTR.bayAdded]: Number(m3), [ATTR.bayBonus]: 0, [ATTR.bandwidthAdded]: Number(mbit) },
  };
}

// The effect IDs that put a bay on the ship, by flag.
function bayEffectFlags() {
  const out = new Map(KINDS.map((kind) => [effectIDOf(kind), kind.flag]));
  out.set(DRONE_BAY_EFFECT_ID, DRONE_BAY_FLAG);
  return out;
}

function typeIDOf(kind, size, tier) {
  return FIRST_TYPE_ID + KIND_INDEX[kind.key] * 20 + SIZE_INDEX[size.key] * TIERS.length + TIER_INDEX[tier.key];
}

function nameOf(kind, size, tier) {
  const base = `${size.name} ${kind.name} Extension`;
  if (tier.key === "t1") return `${base} I`;
  if (tier.key === "t2") return `${base} II`;
  return `${tier.prefix} ${base}`;
}

// The effects: one per kind, on the ship, and the drone bay's.
function effects() {
  const out = {};
  const mod = (attributeID, operation, modifyingAttributeID) =>
    ({ domain: "shipID", modifiedAttributeID: attributeID, operation, modifyingAttributeID, func: "ItemModifier" });
  // effectCategoryID 4 (online), as CCP's own cargoCapacityMultiply (59): the
  // bay is there only while the module is online, so an offline extension
  // neither keeps its bay nor frees its CPU and powergrid for other modules.
  const effect = (effectID, name, modifierInfo) => ({
    effectID, name, displayName: "", description: "", guid: "",
    effectCategoryID: 4, iconID: null, dischargeAttributeID: null, durationAttributeID: null, distribution: null,
    rangeAttributeID: null, falloffAttributeID: null, trackingSpeedAttributeID: null, resistanceAttributeID: null,
    fittingUsageChanceAttributeID: null, npcUsageChanceAttributeID: null, npcActivationChanceAttributeID: null,
    published: false, isOffensive: false, isAssistance: false, isWarpSafe: false, disallowAutoRepeat: false,
    electronicChance: false, propulsionChance: false, rangeChance: false,
    modifierInfo,
  });
  for (const kind of KINDS) {
    const effectID = effectIDOf(kind);
    out[effectID] = effect(effectID, `bayExtension${kind.key[0].toUpperCase()}${kind.key.slice(1)}`, [
      mod(kind.attributeID, 2, ATTR.bayAdded),
      mod(kind.attributeID, 6, ATTR.bayBonus),
      ...kind.alsoGrows.map((attributeID) => mod(attributeID, 6, ATTR.bayBonus)),
    ]);
  }
  out[DRONE_BAY_EFFECT_ID] = effect(DRONE_BAY_EFFECT_ID, "moduleDroneBay", [
    mod(SHIP_DRONE_CAPACITY, 2, ATTR.bayAdded),
    mod(SHIP_DRONE_BANDWIDTH, 2, ATTR.bandwidthAdded),
  ]);
  return out;
}

function buildVariant(kind, size, tier) {
  const typeID = typeIDOf(kind, size, tier);
  const t1TypeID = typeIDOf(kind, size, TIERS[TIER_INDEX.t1]);
  const flat = Math.round(kind.flat[SIZE_INDEX[size.key]] * tier.flat);
  const description = [
    `Increases the capacity of the ship's ${kind.name.toLowerCase()} by ${flat.toLocaleString("en-US")} m3 and then by a further ${tier.bonus}% of the total, at the expense of maximum velocity and hull strength. A ship that has no ${kind.name.toLowerCase()} gains one of that size.`,
    `The ${kind.name.toLowerCase()} stores ${kind.holds}. ${kind.text}`,
    `This ${size.name.toLowerCase()} model is designed for use on ${size.key === "small" ? "frigates and destroyers" : size.key === "medium" ? "cruisers, barges and haulers" : "battleships and large haulers"}.`,
    TIER_TEXT[tier.key],
  ].filter(Boolean).join("\n\n");
  return {
    typeID,
    family: `bay:${kind.key}`,
    kind: "bay",
    bay: kind.key,
    flag: kind.flag,
    size: size.key,
    tier: tier.key,
    name: nameOf(kind, size, tier),
    description,
    cloneFrom: CLONE_SOURCE,
    variationParentTypeID: typeID === t1TypeID ? 0 : t1TypeID,
    metaGroupID: tier.metaGroupID,
    metaLevel: tier.metaLevel,
    techLevel: tier.techLevel,
    priceFactor: PRICE_FACTOR[tier.key],
    basePrice: Math.round(size.price * PRICE_FACTOR[tier.key]),
    skills: [[HULL_UPGRADES_SKILL, tier.skill]],
    icon: ICONS[kind.key],
    groupID: GROUP.groupID,
    marketGroupID: marketGroupIDOf(kind),
    effectID: effectIDOf(kind),
    flat,
    bonus: tier.bonus,
    attributes: {
      [ATTR.power]: Math.max(1, Math.round(size.power * tier.power)),
      [ATTR.cpu]: Math.max(1, Math.round(size.cpu * tier.cpu)),
      [ATTR.velocityMultiplier]: tier.velocity,
      [ATTR.structureMultiplier]: tier.structure,
      [ATTR.requiredSkill1]: HULL_UPGRADES_SKILL,
      [ATTR.requiredSkill1Level]: tier.skill,
      [ATTR.techLevel]: tier.techLevel,
      [ATTR.metaLevel]: tier.metaLevel,
      [ATTR.metaGroupID]: tier.metaGroupID,
      [ATTR.bayAdded]: flat,
      [ATTR.bayBonus]: tier.bonus,
      [CARGO_MULTIPLIER_ATTRIBUTE_ID]: null,
      // Tech II types use CCP's tech II colour scheme.
      ...(tier.key === "t2" ? { 1768: 11347 } : {}),
    },
    addEffects: [effectIDOf(kind)],
    removeEffects: [CARGO_EFFECT_ID],
  };
}

let built = null;
function variants() {
  if (built) return built;
  const list = [];
  for (const kind of KINDS) for (const size of SIZES) for (const tier of TIERS) list.push(buildVariant(kind, size, tier));
  const ids = new Set();
  for (const variant of list) {
    if (ids.has(variant.typeID)) throw new Error(`bay family: type ID ${variant.typeID} used twice`);
    ids.add(variant.typeID);
  }
  built = Object.freeze(list.map((variant) => Object.freeze(variant)));
  return built;
}

let byTypeID = null;
function variantOf(typeID) {
  if (!byTypeID) byTypeID = new Map(variants().map((variant) => [variant.typeID, variant]));
  return byTypeID.get(Number(typeID)) || null;
}

// ---------------------------------------------------------------------------
// Blueprints: tech 1 and tech 2 for every kind and size. Meta variants come
// from loot only. Tech 1 is plain minerals by size; tech 2 is the tech 1
// module, more minerals and a few of CCP's salvaged compounds, invented from
// the tech 1 blueprint the way Expanded Cargohold II is.

const T1_MATERIALS = Object.freeze([[34, 1200], [35, 400], [36, 120], [37, 30]]);
const T2_MATERIALS = Object.freeze([[11724, 2], [11736, 2], [11735, 1], [38, 12], [39, 4]]);
const INVENTION = Object.freeze({
  time: 13800,
  materials: [[20424, 2], [20418, 2]], // Datacore - Mechanical Engineering, Datacore - Electronic Engineering
  skills: [[11452, 1], [11453, 1], [21791, 1]], // Mechanical Engineering, Electronic Engineering, Minmatar Encryption Methods
  probability: 0.34,
  runs: 10,
});

function blueprintTypeIDOf(kind, size, tech) {
  return FIRST_BLUEPRINT_TYPE_ID + KIND_INDEX[kind.key] * 10 + SIZE_INDEX[size.key] * 2 + (tech === 2 ? 1 : 0);
}

let builtBlueprints = null;
function blueprints() {
  if (builtBlueprints) return builtBlueprints;
  const list = [];
  for (const kind of KINDS) {
    for (const size of SIZES) {
      const t1 = variantOf(typeIDOf(kind, size, TIERS[TIER_INDEX.t1]));
      const t2 = variantOf(typeIDOf(kind, size, TIERS[TIER_INDEX.t2]));
      const t1BlueprintTypeID = blueprintTypeIDOf(kind, size, 1);
      const t2BlueprintTypeID = blueprintTypeIDOf(kind, size, 2);
      const scale = (pairs) => pairs.map(([typeID, quantity]) => [typeID, Math.max(1, Math.round(quantity * size.buildScale))]);
      const marketGroupID = marketGroupIDOf(kind, "blueprints");
      list.push({
        typeID: t1BlueprintTypeID, productTypeID: t1.typeID, family: t1.family, tier: "t1",
        name: `${t1.name} Blueprint`, techLevel: 1, metaGroupID: 1, icon: ICONS[kind.key], marketGroupID,
        manufacturing: { time: size.time, materials: scale(T1_MATERIALS), skills: [[INDUSTRY_SKILL, 1]] },
        invention: { ...INVENTION, productTypeID: t2BlueprintTypeID },
      });
      list.push({
        typeID: t2BlueprintTypeID, productTypeID: t2.typeID, family: t2.family, tier: "t2",
        name: `${t2.name} Blueprint`, techLevel: 2, metaGroupID: 2, icon: ICONS[kind.key], marketGroupID,
        inventedFrom: t1BlueprintTypeID,
        manufacturing: {
          time: size.time * 2,
          materials: [[t1.typeID, 1], ...scale(T2_MATERIALS)],
          skills: [[INDUSTRY_SKILL, 5], [11452, 1], [11453, 1]],
        },
      });
    }
  }
  const ids = new Set();
  for (const blueprint of list) {
    if (ids.has(blueprint.typeID)) throw new Error(`bay family: blueprint ID ${blueprint.typeID} used twice`);
    ids.add(blueprint.typeID);
  }
  builtBlueprints = Object.freeze(list);
  return builtBlueprints;
}

const materialList = (pairs) => pairs.map(([typeID, quantity]) => ({ quantity, typeID }));
const skillList = (pairs) => pairs.map(([typeID, level]) => ({ level, typeID }));

function manufacturingActivity(blueprint) {
  const m = blueprint.manufacturing;
  return {
    materials: materialList(m.materials),
    products: [{ quantity: 1, typeID: blueprint.productTypeID }],
    skills: skillList(m.skills),
    time: m.time,
  };
}

function inventionActivity(invention) {
  return {
    materials: materialList(invention.materials),
    products: [{ probability: invention.probability, quantity: invention.runs, typeID: invention.productTypeID }],
    skills: skillList(invention.skills),
    time: invention.time,
  };
}

module.exports = {
  FIRST_TYPE_ID,
  FIRST_BLUEPRINT_TYPE_ID,
  FIRST_EFFECT_ID,
  CLONE_SOURCE,
  CLONE_BLUEPRINT,
  MARKET_GROUP_ID,
  BLUEPRINT_MARKET_GROUP_ID,
  PRICE_FACTOR,
  ATTR,
  GROUP,
  ATTRIBUTES,
  KINDS,
  SIZES,
  TIERS,
  ICONS,
  MARKET_GROUP_BASE,
  DRONE_BAY_EFFECT_ID,
  DRONE_BAY_FLAG,
  kindOf,
  effectIDOf,
  marketGroupIDOf,
  marketGroups,
  effects,
  bayEffectFlags,
  moduleBay,
  moduleDroneBay,
  variants,
  variantOf,
  blueprints,
  blueprintTypeIDOf,
  manufacturingActivity,
  inventionActivity,
};
