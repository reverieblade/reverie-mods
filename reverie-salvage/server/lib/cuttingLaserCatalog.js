"use strict";

// Reverie Salvage (README.md): the cutting lasers and what each one does to a
// wreck. Three unused mining-laser types carry them, moved to their own Hull
// Cutter group with cutting numbers in place of the mining ones. The type
// layer (defs/layer.js) gives the client and the server their names,
// descriptions and icons from CUTTER_TYPES below.
//
// A wreck's hull holds a potential: the alloys its hull minerals make
// (npcAlloyLoot.hullAlloys at fraction 1). Every cycle cuts off part of the
// wreck's HP; that fraction of the potential comes loose, and each profile
// reaches a share of the common and of the rare alloys in it. What it reaches
// comes off as hull panels (small wrecks a salvager takes apart); the rest is
// lost. The profile also sets how many panels a hull of a given size gives.

// Alloys keyed on Tritanium, Pyerite, Mexallon or Isogen are the plating
// ("common"); those keyed on Nocxium, Zydrine, Megacyte or Morphite are the
// core ("rare").
const COMMON_ALLOYS = Object.freeze([11725, 11737, 11739, 11741, 11740, 11732, 11738]);
const RARE_ALLOYS = Object.freeze([11724, 11736, 11734, 11735, 11733]);

// Three bands (pilot goals, 2026-11-17, doc/SALVAGE.md "Pilot goals"): a
// cutter reaches a share of each band of the hull's minerals, and alloys form
// on what it freed. Plating: Tritanium, Pyerite. Middle: Mexallon, Isogen,
// Nocxium. Core: Zydrine, Megacyte, Morphite. The alloys keyed on middle
// minerals (Crystal on Mexallon, Dark on Nocxium; Motley in loot) are the
// middle band; a salvager keeps them at its plating share.
const MINERAL_BAND = Object.freeze({ 34: 0, 35: 0, 36: 1, 37: 1, 38: 1, 39: 2, 40: 2, 11399: 2 });
const MID_ALLOYS = Object.freeze([11741, 11735, 11733]);

// hpPerCycle: wreck HP cut per 60 s cycle at no skill.
// commonReach / midReach / rareReach: share of the hull's plating / middle /
// core minerals the cut frees (alloys form on it).
// partsFactor: the wreck's salvage parts roll, times this (a careful cut keeps
// more of them, smashing ruins half).
// panels: count for the reference hull (45 units of alloy potential, a Rifter)
// plus perDoubling for every doubling of potential above it.
const PROFILES = Object.freeze({
  careful: Object.freeze({
    key: "careful",
    hpPerCycle: 300,
    commonReach: 0.6,
    midReach: 0.45,
    rareReach: 0.15,
    partsFactor: 1.25,
    panels: 4,
    perDoubling: 1.5,
  }),
  precision: Object.freeze({
    key: "precision",
    hpPerCycle: 480,
    commonReach: 0.2,
    midReach: 0.1,
    rareReach: 0.95,
    panels: 2,
    perDoubling: 0.6,
  }),
  breaker: Object.freeze({
    key: "breaker",
    hpPerCycle: 810,
    commonReach: 0.6,
    midReach: 0,
    rareReach: 0,
    partsFactor: 0.5,
    panels: 1,
    perDoubling: 0.4,
  }),
});
const REFERENCE_POTENTIAL_UNITS = 45;

// typeID -> the cutter it became. The names and descriptions go to the client
// patch; the server keeps its own copy in salvageTypesReshape.
const CUTTER_TYPES = Object.freeze({
  5241: Object.freeze({
    profile: "careful",
    name: "Hull Panel Cutter I",
    description:
      "A low-power cutting beam built on a mining laser frame. It dismantles a wreck slowly, " +
      "lifting the hull away one plate at a time, which preserves more of the salvageable parts " +
      "and yields a large number of panels, most of them hull plating and mid-hull sections.\n\nCan only be used on wrecks. The " +
      "panels it leaves must be processed with a salvager. The cargo the wreck was carrying, along with parts such as " +
      "rig components, is released in containers as the hull is cut away.",
  }),
  5243: Object.freeze({
    profile: "precision",
    name: "Precision Hull Cutter I",
    description:
      "A narrow, focused cutting beam designed to reach the reinforced core of a ship, " +
      "where the rare alloys are found. It cuts through a wreck at a steady pace and leaves " +
      "few panels, although most of them are core sections, and much of the ordinary plating is " +
      "burned away in the process.\n\nCan only be used on wrecks. The panels it leaves must be processed with a salvager.",
  }),
  5235: Object.freeze({
    profile: "breaker",
    name: "Wreck Breaker I",
    description:
      "A wide, powerful beam that shears a wreck into a few large slabs of hull plating " +
      "nearly three times faster than a panel cutter. Everything beneath the plating is lost, " +
      "and the violence of the cut destroys half of the salvageable parts.\n\nCan only be used on wrecks. The slabs it leaves must be processed with a " +
      "salvager, and the slabs cut from a large hull require a large hold.",
  }),
});

// The cutters' blueprints. CCP has none, so three unpublished mining laser
// blueprints nothing in the game uses are taken over. Each one makes a cutter
// from minerals with Industry I, on the Salvager blueprints market beside
// Salvager I Blueprint. The client patches carry both halves: the blueprint
// type's name and market group (tools/ClientMods/patch_ship_systems.js, through
// salvageClientEdits) and its recipe in blueprints.static
// (tools/BotIronman/patch_client_blueprints.js, which records the recipes it
// wrote; the server applies those, industry/blueprintRecipeReshape.js).
// Recipes start from Miner I's (1324 Tritanium, 481 Pyerite, 119 Mexallon).
// priceFactor sets each blueprint's base price against Salvager I Blueprint's,
// since the base prices CCP left on the old types (92,720 to 3,500,000 ISK)
// belong to what they were before.
const INDUSTRY_SKILL = 3380;
const CUTTER_BLUEPRINTS = Object.freeze({
  28751: Object.freeze({ // was ORE Miner Blueprint
    productTypeID: 5241,
    name: "Hull Panel Cutter I Blueprint",
    priceFactor: 1,
    time: 900,
    materials: Object.freeze([[34, 1324], [35, 481], [36, 119], [37, 60]]),
  }),
  22922: Object.freeze({ // was 'Habitat' Miner I Blueprint
    productTypeID: 5243,
    name: "Precision Hull Cutter I Blueprint",
    priceFactor: 1.25,
    time: 1200,
    materials: Object.freeze([[34, 1100], [35, 400], [36, 150], [37, 90], [38, 12]]),
  }),
  28749: Object.freeze({ // was ORE Deep Core Mining Laser Blueprint
    productTypeID: 5235,
    name: "Wreck Breaker I Blueprint",
    priceFactor: 1,
    time: 900,
    materials: Object.freeze([[34, 2400], [35, 700], [36, 160]]),
  }),
});
const CUTTER_BLUEPRINT_MARKET_GROUP_ID = 1712; // Salvager blueprints (Salvager I Blueprint's group)

// The manufacturing activity a cutter blueprint gets, in the client's
// blueprints.static shape (the server's definitions use the same one).
function cutterBlueprintManufacturing(blueprintTypeID) {
  const blueprint = CUTTER_BLUEPRINTS[Number(blueprintTypeID)];
  if (!blueprint) return null;
  return {
    materials: blueprint.materials.map(([typeID, quantity]) => ({ quantity, typeID })),
    products: [{ quantity: 1, typeID: blueprint.productTypeID }],
    skills: [{ level: 1, typeID: INDUSTRY_SKILL }],
    time: blueprint.time,
  };
}

// Hull panels in space. Four wreck types no ship, NPC or site ever leaves
// (CCP test and event leftovers) become the panels: two looks of plating and
// two of core section. The client patch gives each a model from CCP's ship
// debris set (graphicID) and a name; modelRadius is that model's own bounding
// radius (its sof hull's boundingSphere), which the in-game script
// (tools/ClientMods/ingame/evejs_salvage.py) scales down to the panel's ball
// radius, so a debris piece the size of a station module floats as a slab a
// few tens of metres across.
const PANEL_TYPES = Object.freeze({
  75781: Object.freeze({ kind: "common", graphicID: 3707, modelRadius: 658.9, model: "ud4_static (curved hull plate)" }),
  80246: Object.freeze({ kind: "common", graphicID: 3704, modelRadius: 313.7, model: "ud1_static (flat plate with fittings)" }),
  80247: Object.freeze({ kind: "rare", graphicID: 3706, modelRadius: 443.5, model: "ud3_static (machinery block)" }),
  90038: Object.freeze({ kind: "rare", graphicID: 3705, modelRadius: 410.6, model: "ud2_static (machinery block)" }),
});
const PANEL_TEXT = Object.freeze({
  common: Object.freeze({
    name: "Hull Plating",
    description:
      "A slab of hull plating cut from a wreck, which still contains the alloys it was made from. " +
      "The alloys can be recovered by processing the slab with a salvager.",
  }),
  rare: Object.freeze({
    name: "Core Section",
    description:
      "A section cut from the reinforced core of a wrecked ship, where the rarer alloys are found. " +
      "The alloys can be recovered by processing the section with a salvager.",
  }),
});
// Ball radius (m) of a panel from the volume of alloys in it (m3): a little
// under a cube of that volume, between 6 m and 40 m. A frigate is about 30 m
// across, so the biggest slab of a battleship is only a little larger.
const PANEL_RADIUS = Object.freeze({ perCubeRoot: 0.9, min: 6, max: 40 });

function panelRadius(volume) {
  const r = PANEL_RADIUS.perCubeRoot * Math.cbrt(Math.max(0, Number(volume) || 0));
  return Math.round(Math.min(PANEL_RADIUS.max, Math.max(PANEL_RADIUS.min, r)) * 10) / 10;
}

function panelTypesOfKind(kind) {
  return Object.entries(PANEL_TYPES).filter(([, panel]) => panel.kind === kind).map(([id]) => Number(id));
}

// Alloy volume: what one unit refines into, times this, so an alloy is bulkier
// than its minerals and a hull's alloys stay in proportion to its metal.
// Changing it needs the client patch run again (the client shows volumes from
// its own type data).
const ALLOY_VOLUME_FACTOR = 1.5;
const ALLOY_TYPE_IDS = Object.freeze([...COMMON_ALLOYS, ...RARE_ALLOYS]);

// Every cutter in the module family (meta, tech 2, faction, deadspace, officer
// and the new kinds), salvageModuleFamily.js; the three tech 1 cutters above
// are in it too. The type layer (defs/layer.js) gives the client the same ones.
function familyVariant(typeID) {
  const variant = require("./salvageModuleFamily").variantOf(typeID);
  return variant && variant.kind === "cutter" ? variant : null;
}

function profileForType(typeID) {
  const variant = familyVariant(typeID);
  if (variant) return variant.profile;
  const cutter = CUTTER_TYPES[Number(typeID)];
  return cutter ? PROFILES[cutter.profile] || null : null;
}

function isCutterType(typeID) {
  return Boolean(CUTTER_TYPES[Number(typeID)] || familyVariant(typeID));
}

function isRareAlloy(typeID) {
  return RARE_ALLOYS.includes(Number(typeID));
}

// 0 plating, 1 middle, 2 core.
function alloyBand(typeID) {
  const id = Number(typeID);
  if (MID_ALLOYS.includes(id)) return 1;
  return RARE_ALLOYS.includes(id) ? 2 : 0;
}

// A profile with a middle reach frees metal by mineral band (the pilot-goal
// cutters); one without keeps a share of each alloy class (older profiles).
function reachesByMineral(profile) {
  return Boolean(profile) && Number.isFinite(Number(profile.midReach));
}

function mineralReach(profile, mineralTypeID) {
  const band = MINERAL_BAND[Number(mineralTypeID)] ?? 0;
  return [profile.commonReach, profile.midReach, profile.rareReach][band] || 0;
}

// Panels a hull gives: at least 1, more for a bigger potential (units of alloy).
// The profile's count grows by perDoubling per doubling, then by the size
// ratio to the power EVEJS_CUT_PANEL_EXPONENT, so a battleship (300 times a
// Rifter's potential) breaks into far more fragments than a frigate.
function panelCount(profile, potentialUnits) {
  const ratio = Math.max(1, Math.max(1, Number(potentialUnits) || 0) / REFERENCE_POTENTIAL_UNITS);
  const count = (profile.panels + profile.perDoubling * Math.log2(ratio)) * ratio ** panelExponent();
  return Math.max(1, Math.round(count));
}

function panelExponent() {
  return Math.max(0, require("./game").number("EVEJS_CUT_PANEL_EXPONENT", 0.15));
}

// Volume (m3) of one alloy unit from its refined minerals: [{ quantity, volume }].
function alloyVolumeFromMinerals(minerals) {
  const refined = (minerals || []).reduce((sum, row) => sum + Number(row.quantity) * Number(row.volume), 0);
  return Math.max(0.01, Math.round(refined * ALLOY_VOLUME_FACTOR * 100) / 100);
}

module.exports = {
  COMMON_ALLOYS,
  RARE_ALLOYS,
  ALLOY_TYPE_IDS,
  ALLOY_VOLUME_FACTOR,
  PROFILES,
  CUTTER_TYPES,
  CUTTER_BLUEPRINTS,
  CUTTER_BLUEPRINT_MARKET_GROUP_ID,
  cutterBlueprintManufacturing,
  REFERENCE_POTENTIAL_UNITS,
  PANEL_TYPES,
  PANEL_TEXT,
  PANEL_RADIUS,
  panelRadius,
  panelTypesOfKind,
  profileForType,
  isCutterType,
  isRareAlloy,
  MINERAL_BAND,
  MID_ALLOYS,
  alloyBand,
  reachesByMineral,
  mineralReach,
  panelCount,
  alloyVolumeFromMinerals,
};
