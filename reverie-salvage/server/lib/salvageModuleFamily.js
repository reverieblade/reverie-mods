"use strict";

// Reverie Salvage (README.md "The module family"): every cutter and salvager
// variant, built from one table so the server and the type layer
// (defs/layer.js) agree on each one.
//
// Families: the three original cutters (careful, precision, breaker), three
// new cutter kinds (torch, reclaimer, breacher) and the salvager. Tiers follow
// EVE's ladder: tech 1, meta 1-4 (Upgraded, Limited, Experimental, Prototype),
// tech 2, two factions (Thukker Tribe and the Angel Cartel's Domination), Angel
// deadspace C/B/A/X-Type (Gistum), one Angel officer each, and a civilian
// Hull Panel Cutter.
//
// Types that exist already (the three cutters, Salvager I and II) keep their
// IDs; every other variant is a new type at FIRST_TYPE_ID + family*20 + tier,
// cloned from its family's tech 1 type (CLONE_SOURCE). Only ever append
// families and tiers: the order is part of the ID scheme, and the IDs are
// inside this mod's claim in reverie.json.
//
// What a tier changes, against its family's tech 1:
//   speed   cut HP per cycle (cutters) or cycle time divided by it (salvagers)
//   close   share of the loss closed on the family's strong recoveries (a
//           recovery of 0.5 or more; weak ones stay as they are, so a Wreck
//           Breaker stays a breaker)
//   cpu, cap, range: fitting, capacitor use and optimal range
//   access  salvagers only: points added to the access difficulty bonus
//   common, rare: salvagers only: their own panel shares (absolute)
//
// The holds some of these modules bring in the repo's own build (a salvage
// hold on every salvager, a mineral hold on the Field Reclaimer) belong to a
// holds mod, not to this one. Without it a reclaimer's minerals go to the
// ship's mineral hold when it has one, then to the cargo hold.

const FIRST_TYPE_ID = 992_000;
const FIRST_BLUEPRINT_TYPE_ID = 992_500;

const MINING_SKILL = 3386;
const SALVAGING_SKILL = 25863;
const INDUSTRY_SKILL = 3380;

// Dogma attribute IDs a tier sets.
const ATTR = Object.freeze({
  capacitorNeed: 6,
  power: 30,
  cpu: 50,
  maxRange: 54,
  duration: 73,
  miningAmount: 77,
  requiredSkill1: 182,
  requiredSkill1Level: 277,
  requiredSkill2: 183,
  requiredSkill2Level: 278,
  techLevel: 422,
  metaLevel: 633,
  accessDifficultyBonus: 902,
  metaGroupID: 1692,
});

// Every cutter sits in its own group, a copy of Mining Laser (54, category
// Module): the info window is titled by group ("Hull Cutter: Information"),
// and nothing that looks for mining lasers by group picks a cutter.
const CUTTER_GROUP = Object.freeze({ groupID: 990_050, name: "Hull Cutter", templateGroupID: 54, categoryID: 7 });

// A cutter's Attributes tab shows what it does to a wreck instead of CCP's
// mining numbers. The profile does the cutting, but the activation and cycle
// still take range, duration and capacitor from the mining snapshot, which
// refuses a module with no mining amount (77) unless the mining.allowNoYield
// hook says it is a cutter (server/index.js). Each new attribute copies a CCP
// one for unit and icon (templateID) and has its own name and tooltip.
const CUTTER_ATTR = Object.freeze({ hullCut: 7900, commonKept: 7901, rareKept: 7902, partsFactor: 7903, midKept: 7904 });
const CUTTER_ATTRIBUTES = Object.freeze([
  { attributeID: CUTTER_ATTR.hullCut, name: "cutterHullCutPerCycle", templateID: 9, unitID: 113, highIsGood: true,
    displayText: "Hull Cut per Cycle",
    tooltip: "The hull hitpoints this beam cuts from a wreck each cycle. The wreck is consumed once its entire hull has been cut." },
  { attributeID: CUTTER_ATTR.commonKept, name: "cutterCommonKept", templateID: 5967, unitID: 127, highIsGood: true,
    displayText: "Plating Metal Kept",
    tooltip: "The share of the wreck's plating metal (Tritanium and Pyerite) recovered by the cut. A Field Reclaimer recovers this share as minerals." },
  { attributeID: CUTTER_ATTR.rareKept, name: "cutterRareKept", templateID: 5967, unitID: 127, highIsGood: true,
    displayText: "Core Metal Kept",
    tooltip: "The share of the wreck's core metal (Zydrine, Megacyte and Morphite) recovered by the cut. A Field Reclaimer recovers this share as minerals." },
  { attributeID: CUTTER_ATTR.partsFactor, name: "cutterSalvagePartsFactor", templateID: 64, unitID: 104, highIsGood: true,
    displayText: "Salvage Parts Found",
    tooltip: "The number of salvage parts this beam recovers from a wreck, relative to an ordinary cut. A careful beam preserves more of them, while a violent one destroys some." },
  { attributeID: CUTTER_ATTR.midKept, name: "cutterMidKept", templateID: 5967, unitID: 127, highIsGood: true,
    displayText: "Middle Metal Kept",
    tooltip: "The share of the wreck's middle metal (Mexallon, Isogen and Nocxium) recovered by the cut." },
]);
// CCP's mining numbers on the mining laser frames the cutters are built from.
const MINING_ATTRIBUTE_IDS = Object.freeze([77, 3153, 3154, 5967, 5969]);

// metaGroupID: 1 Tech I, 2 Tech II, 4 Faction, 5 Officer, 6 Deadspace.
const TIERS = Object.freeze([
  { key: "t1", metaGroupID: 1, metaLevel: 0, techLevel: 1, speed: 1, close: 0, cpu: 1, cap: 1, range: 1 },
  { key: "m1", prefix: "Upgraded", metaGroupID: 1, metaLevel: 1, techLevel: 1, speed: 1.05, close: 0.04, cpu: 0.97, cap: 0.97, range: 1.03, access: 0.5, common: 0.86, rare: 0.72 },
  { key: "m2", prefix: "Limited", metaGroupID: 1, metaLevel: 2, techLevel: 1, speed: 1.1, close: 0.08, cpu: 0.94, cap: 0.94, range: 1.06, access: 1, common: 0.87, rare: 0.74 },
  { key: "m3", prefix: "Experimental", metaGroupID: 1, metaLevel: 3, techLevel: 1, speed: 1.15, close: 0.12, cpu: 0.91, cap: 0.91, range: 1.09, access: 1.5, common: 0.88, rare: 0.76 },
  { key: "m4", prefix: "Prototype", metaGroupID: 1, metaLevel: 4, techLevel: 1, speed: 1.2, close: 0.16, cpu: 0.88, cap: 0.88, range: 1.12, access: 2, common: 0.89, rare: 0.78 },
  { key: "t2", metaGroupID: 2, metaLevel: 5, techLevel: 2, speed: 1.25, close: 0.25, cpu: 1.15, cap: 1.2, range: 1.15 },
  { key: "thukker", prefix: "Thukker", metaGroupID: 4, metaLevel: 8, techLevel: 1, speed: 1.25, close: 0.2, cpu: 0.7, cap: 0.7, range: 1.1, access: 2.5, common: 0.97, rare: 0.72 },
  { key: "domination", prefix: "Domination", metaGroupID: 4, metaLevel: 9, techLevel: 1, speed: 1.35, close: 0.25, cpu: 1, cap: 1, range: 1.25, access: 3, common: 0.86, rare: 0.9 },
  { key: "c", prefix: "Gistum C-Type", metaGroupID: 6, metaLevel: 10, techLevel: 1, speed: 1.3, close: 0.25, cpu: 0.95, cap: 0.95, range: 1.15, access: 3, common: 0.92, rare: 0.8 },
  { key: "b", prefix: "Gistum B-Type", metaGroupID: 6, metaLevel: 11, techLevel: 1, speed: 1.4, close: 0.3, cpu: 0.92, cap: 0.92, range: 1.2, access: 3.5, common: 0.93, rare: 0.82 },
  { key: "a", prefix: "Gistum A-Type", metaGroupID: 6, metaLevel: 12, techLevel: 1, speed: 1.5, close: 0.35, cpu: 0.89, cap: 0.89, range: 1.25, access: 4, common: 0.94, rare: 0.84 },
  { key: "x", prefix: "Gistum X-Type", metaGroupID: 6, metaLevel: 13, techLevel: 1, speed: 1.6, close: 0.4, cpu: 0.86, cap: 0.86, range: 1.3, access: 4.5, common: 0.95, rare: 0.86 },
  { key: "officer", metaGroupID: 5, metaLevel: 14, techLevel: 1, speed: 1.8, close: 0.5, cpu: 0.8, cap: 0.8, range: 1.4, access: 6, common: 0.98, rare: 0.92 },
  { key: "civilian", prefix: "Civilian", metaGroupID: 1, metaLevel: 0, techLevel: 1, speed: 0.5, close: -0.15, cpu: 0.5, cap: 0.5, range: 0.9 },
]);
const TIER_INDEX = Object.freeze(Object.fromEntries(TIERS.map((tier, index) => [tier.key, index])));

// The type's basePrice against its family's tech 1 (static data only: what a
// module trades for is the market's business).
const PRICE_FACTOR = Object.freeze({
  t1: 1, m1: 1.6, m2: 2.2, m3: 3, m4: 4, t2: 9, thukker: 25, domination: 35,
  c: 30, b: 45, a: 70, x: 110, officer: 400, civilian: 0.25,
});

const LADDER = Object.freeze(["t1", "m1", "m2", "m3", "m4", "t2", "thukker", "domination", "c", "b", "a", "x", "officer"]);

// The tech 1 stats each family starts from. Existing types keep CCP's dogma;
// new kinds set every stat here. A profile's mode: "panels" (the original
// cutters), "reclaim" (minerals straight into the hold, no panels) or "breach"
// (the hold and salvage parts out first, whole, in one container).
const FAMILIES = Object.freeze([
  {
    key: "careful", kind: "cutter", name: "Hull Panel Cutter", t1TypeID: 5241, t2Name: "Hull Panel Cutter II",
    officer: "Gotan's Modified Hull Panel Cutter", tiers: [...LADDER, "civilian"],
    stats: { cap: 10, power: 2, cpu: 54, range: 11200, duration: 60000 },
    profile: "careful",
    icon: "careful",
  },
  {
    key: "precision", kind: "cutter", name: "Precision Hull Cutter", t1TypeID: 5243, t2Name: "Precision Hull Cutter II",
    officer: "Hakim's Modified Precision Hull Cutter", tiers: LADDER,
    stats: { cap: 10, power: 2, cpu: 48, range: 11800, duration: 60000 },
    profile: "precision",
    icon: "precision",
  },
  {
    key: "breaker", kind: "cutter", name: "Wreck Breaker", t1TypeID: 5235, t2Name: "Wreck Breaker II",
    officer: "Tobias' Modified Wreck Breaker", tiers: LADDER,
    stats: { cap: 10, power: 2, cpu: 56, range: 11800, duration: 60000 },
    profile: "breaker",
    icon: "breaker",
  },
  {
    key: "torch", kind: "cutter", name: "Plasma Hull Torch", t1Name: "Plasma Hull Torch I", t2Name: "Plasma Hull Torch II",
    tiers: ["t1", "t2"],
    stats: { cap: 90, power: 4, cpu: 60, range: 8000, duration: 60000 },
    // The opportunist's tool: fastest by far, a thin mix, as few panels as a
    // Wreck Breaker so a salvager keeps up.
    profile: { mode: "panels", hpPerCycle: 3000, commonReach: 0.2, midReach: 0.1, rareReach: 0.08, panels: 1, perDoubling: 0.4 },
    icon: "torch",
  },
  {
    key: "reclaimer", kind: "cutter", name: "Field Reclaimer", t1Name: "Field Reclaimer I", t2Name: "Field Reclaimer II",
    tiers: ["t1", "t2"],
    stats: { cap: 15, power: 3, cpu: 65, range: 7000, duration: 60000 },
    // The tool for a ship with no salvage gear. Its reaches are shares of
    // what a Hull Panel Cutter I and a Salvager I bring home from the same
    // wreck as refined minerals (wreckCutting.mineralPotentialOf), 0.4 per
    // band. closeAll "relative": better tiers raise every share by the tier's
    // close (T2 +25%).
    profile: { mode: "reclaim", hpPerCycle: 75, commonReach: 0.4, midReach: 0.4, rareReach: 0.4, panels: 0, perDoubling: 0, closeAll: "relative" },
    icon: "reclaimer",
  },
  {
    key: "breacher", kind: "cutter", name: "Hold Breacher", t1Name: "Hold Breacher I", t2Name: "Hold Breacher II",
    tiers: ["t1", "t2"],
    stats: { cap: 20, power: 2, cpu: 50, range: 9000, duration: 60000 },
    // Clears mission sites: the parts first (partsFactor times the usual
    // roll), the whole middle band, quick. Better tiers close the loss on the
    // middle band only, so a T2 stays a middle-band tool.
    profile: { mode: "breach", hpPerCycle: 800, commonReach: 0.05, midReach: 0.8, rareReach: 0.08, panels: 2, perDoubling: 0.6, partsFactor: 1.3 },
    icon: "breacher",
  },
  {
    key: "salvager", kind: "salvager", name: "Salvager", t1TypeID: 25861, t2TypeID: 30836,
    officer: "Mizuro's Modified Salvager", tiers: LADDER,
    stats: { cap: 20, power: 1, cpu: 20, range: 5000, duration: 10000, access: 5 },
    shares: { t1: { common: 0.85, rare: 0.7 }, t2: { common: 0.95, rare: 0.85 } },
    icon: null,
  },
]);
const FAMILY_INDEX = Object.freeze(Object.fromEntries(FAMILIES.map((family, index) => [family.key, index])));

// New kinds are cloned from this cutter (a mining laser frame with a 60 s
// cycle); salvager variants from Salvager I.
const CLONE_SOURCE = Object.freeze({ cutter: 5241, salvager: 25861 });

const TEXT = Object.freeze({
  careful: "A low-power cutting beam built on a mining laser frame. It dismantles a wreck slowly, lifting the hull away one plate at a time, which preserves more of the salvageable parts and recovers more metal from each wreck than any other cutter. It yields a large number of panels, most of them hull plating and mid-hull sections.",
  precision: "A narrow, focused cutting beam designed to reach the reinforced core of a ship, where the Zydrine, Megacyte and Morphite are found. It cuts through a wreck at a steady pace and leaves few panels, although most of them are core sections, and much of the ordinary plating is burned away in the process.",
  breaker: "A wide, powerful beam that shears a wreck into a few large slabs of hull plating nearly three times faster than a panel cutter. Everything beneath the plating is lost, and the violence of the cut destroys half of the salvageable parts.",
  torch: "A plasma cutting torch that tears through a hull far faster than any beam, at a heavy cost in capacitor. Although it wastes most of the metal, it produces a few panels of mixed plating and core from the very first minute, which makes it well suited to pilots who cannot afford to stay for long.",
  reclaimer: "A field reclamation beam that breaks a hull down into raw minerals on the spot and draws them directly into the ship's hold. It leaves no panels and requires no salvager, and the minerals take up less room than alloys, although much of the metal is lost in the process.",
  breacher: "A breaching beam that opens the wreck's hold and fittings before it cuts anything else. Its first cycle releases everything the ship was carrying in a single container, together with more salvageable parts than an ordinary cut would find. It then works quickly through the middle of the hull, where the Mexallon, Isogen and Nocxium are found, and leaves the plating and most of the core behind.",
  salvager: "A salvager breaks down wrecks, and the panels left behind by a cutter, into usable materials.",
});
const TIER_TEXT = Object.freeze({
  t1: "",
  m1: "This upgraded production model is slightly faster, easier to fit and wastes less metal.",
  m2: "This limited production run features a better beam controller than the standard model.",
  m3: "This experimental design drives the beam harder than the production models.",
  m4: "This prototype design never entered full production.",
  t2: "This Tech II model features a reworked beam that is faster and far less wasteful, at a higher fitting cost. It is intended for pilots who have mastered the trade.",
  thukker: "Thukker Tribe caravans make their living from what others leave behind. Their version is rugged, requires little power and capacitor, and preserves the ordinary plating that other cutters burn away.",
  domination: "The Angel Cartel built its fortune on salvaged ancient technology, and Domination engineers have tuned this model for range and speed.",
  c: "Recovered from Angel Cartel deadspace complexes, these cutting rigs were built for the Cartel's own salvage crews.",
  b: "An improved Angel deadspace model, used by the crews that strip the Cartel's richest finds.",
  a: "One of the best Angel deadspace models, reserved for the Cartel's veteran salvage teams.",
  x: "The finest deadspace model fielded by the Angel Cartel, which is seldom seen outside its inner complexes.",
  officer: "The personal equipment of an Angel Cartel officer, built to that officer's own specifications.",
  civilian: "A civilian model issued to new pilots. It requires no training to use, but it is slow and wasteful.",
});

const round = (value, digits = 2) => Math.round(Number(value) * 10 ** digits) / 10 ** digits;
// all = true: close the loss on weak recoveries too. all = "relative": raise
// every recovery by the same share instead (T2 +25%), for a family whose low
// recovery is its price: closing a quarter of an 85% loss would more than
// double it.
const closeLoss = (reach, close, all = false) => {
  if (close < 0) return round(Math.max(0, reach * (1 + close)), 3);
  if (all === "relative") return round(Math.min(0.99, reach * (1 + close)), 3);
  return reach >= 0.5 || all ? round(Math.min(0.99, reach + (1 - reach) * close), 3) : reach;
};

// A family's tech 1 profile: the original cutters' from cuttingLaserCatalog.
// Looked up when a variant is built: the catalog requires this file.
function baseProfile(family) {
  if (typeof family.profile !== "string") return family.profile;
  const catalog = require("./cuttingLaserCatalog");
  return { mode: "panels", ...catalog.PROFILES[family.profile] };
}

function variantName(family, tier) {
  if (tier.key === "t1") return family.t1Name || `${family.name} I`;
  if (tier.key === "t2") return family.t2Name || `${family.name} II`;
  if (tier.key === "officer") return family.officer;
  return `${tier.prefix} ${family.name}`;
}

function typeIDOf(family, tier) {
  if (tier.key === "t1" && family.t1TypeID) return family.t1TypeID;
  if (tier.key === "t2" && family.t2TypeID) return family.t2TypeID;
  return FIRST_TYPE_ID + FAMILY_INDEX[family.key] * 20 + TIER_INDEX[tier.key];
}

function skillsFor(family, tier) {
  if (tier.key === "civilian") return [];
  if (family.kind === "salvager") return [[SALVAGING_SKILL, tier.key === "t2" ? 5 : 1]];
  const mining = [MINING_SKILL, tier.key === "t2" ? 4 : 1];
  const newKind = !family.t1TypeID;
  if (tier.key === "t2") return [mining, [SALVAGING_SKILL, 3]];
  return newKind ? [mining, [SALVAGING_SKILL, 1]] : [mining];
}

function buildVariant(family, tier) {
  const s = family.stats;
  const typeID = typeIDOf(family, tier);
  const t1TypeID = typeIDOf(family, TIERS[TIER_INDEX.t1]);
  const skills = skillsFor(family, tier);
  const attributes = {
    [ATTR.capacitorNeed]: round(s.cap * tier.cap, 1),
    [ATTR.power]: Math.max(1, Math.round(s.power * (tier.key === "t2" ? 1.5 : 1))),
    [ATTR.cpu]: Math.max(1, Math.round(s.cpu * tier.cpu)),
    [ATTR.maxRange]: Math.round(s.range * tier.range),
    [ATTR.techLevel]: tier.techLevel,
    [ATTR.metaLevel]: tier.metaLevel,
    [ATTR.metaGroupID]: tier.metaGroupID,
  };
  // Skill slots. CCP's Salvager I keeps Salvaging in the second slot (183/278),
  // the cutters keep Mining in the first; a variant uses its source's slots so
  // the cloned dogma has no stale or doubled skill. null removes an attribute
  // from the cloned dogma (the civilian cutter needs no skill at all).
  const slots = family.kind === "salvager"
    ? [[ATTR.requiredSkill2, ATTR.requiredSkill2Level]]
    : [[ATTR.requiredSkill1, ATTR.requiredSkill1Level], [ATTR.requiredSkill2, ATTR.requiredSkill2Level]];
  slots.forEach(([skillAttr, levelAttr], index) => {
    const skill = skills[index];
    attributes[skillAttr] = skill ? skill[0] : null;
    attributes[levelAttr] = skill ? skill[1] : null;
  });
  // Tech II types use CCP's tech II colour scheme (Salvager II's 1768).
  if (tier.key === "t2") attributes[1768] = 11347;
  const existing = typeID < FIRST_TYPE_ID;
  const variant = {
    typeID,
    family: family.key,
    kind: family.kind,
    tier: tier.key,
    name: variantName(family, tier),
    description: [TEXT[family.key], TIER_TEXT[tier.key]].filter(Boolean).join("\n\n") +
      (family.kind === "cutter" ? "\n\nUse it on wrecks only." : ""),
    existing,
    cloneFrom: existing ? typeID : (family.t1TypeID || CLONE_SOURCE[family.kind]),
    variationParentTypeID: typeID === t1TypeID ? 0 : t1TypeID,
    metaGroupID: tier.metaGroupID,
    metaLevel: tier.metaLevel,
    techLevel: tier.techLevel,
    priceFactor: PRICE_FACTOR[tier.key],
    skills,
    icon: family.icon,
    attributes,
  };
  if (family.kind === "cutter") {
    const p = baseProfile(family);
    attributes[ATTR.duration] = s.duration;
    variant.profile = {
      key: family.key,
      mode: p.mode,
      hpPerCycle: round(p.hpPerCycle * tier.speed, 1),
      commonReach: closeLoss(p.commonReach, tier.close, p.closeAll),
      ...(Number.isFinite(Number(p.midReach)) ? { midReach: closeLoss(p.midReach, tier.close, p.closeAll) } : {}),
      rareReach: closeLoss(p.rareReach, tier.close, p.closeAll),
      panels: p.panels,
      perDoubling: p.perDoubling,
      ...(p.partsFactor ? { partsFactor: p.partsFactor } : {}),
    };
  } else {
    // Salvagers: faster cycles, a better access bonus and their own shares.
    attributes[ATTR.duration] = Math.round(s.duration / tier.speed);
    attributes[ATTR.accessDifficultyBonus] = tier.key === "t2" ? 7 : round(s.access + (tier.access || 0), 1);
    const own = family.shares[tier.key];
    variant.shares = own ? { ...own } : { common: tier.common, rare: tier.rare };
  }
  // Existing types keep CCP's dogma and text; only their place on the ladder is set.
  if (existing) {
    variant.attributes = {
      [ATTR.techLevel]: tier.techLevel,
      [ATTR.metaLevel]: tier.metaLevel,
      [ATTR.metaGroupID]: tier.metaGroupID,
    };
    variant.description = null;
  }
  // Every cutter, existing or new: its own group, its cutting numbers in
  // place of the mining ones.
  if (family.kind === "cutter") {
    variant.groupID = CUTTER_GROUP.groupID;
    for (const id of MINING_ATTRIBUTE_IDS) variant.attributes[id] = null;
    variant.attributes[CUTTER_ATTR.hullCut] = variant.profile.hpPerCycle;
    variant.attributes[CUTTER_ATTR.commonKept] = variant.profile.commonReach;
    variant.attributes[CUTTER_ATTR.rareKept] = variant.profile.rareReach;
    if (variant.profile.midReach !== undefined) variant.attributes[CUTTER_ATTR.midKept] = variant.profile.midReach;
    if (variant.profile.partsFactor) variant.attributes[CUTTER_ATTR.partsFactor] = variant.profile.partsFactor;
  }
  return variant;
}

let built = null;
function variants() {
  if (built) return built;
  const list = [];
  for (const family of FAMILIES) {
    for (const tierKey of family.tiers) list.push(buildVariant(family, TIERS[TIER_INDEX[tierKey]]));
  }
  const ids = new Set();
  for (const variant of list) {
    if (ids.has(variant.typeID)) throw new Error(`salvage module family: type ID ${variant.typeID} used twice`);
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
// Blueprints. Tech 1 blueprints for the new kinds (the three original cutters
// have theirs in cuttingLaserCatalog.CUTTER_BLUEPRINTS) and tech 2 blueprints
// for every cutter family. Meta, faction, deadspace and officer variants have
// none: they come from loot, as in EVE.
//
// Tech 2 is built from a tech 1 cutter, minerals and the rare alloys salvage
// gives, so salvage feeds better salvage gear. It is invented from the tech 1
// blueprint the way Miner II is from Miner I.

const T1_BLUEPRINT_RECIPES = Object.freeze({
  torch: { time: 1200, materials: [[34, 2600], [35, 900], [36, 240], [37, 80], [38, 10]] },
  reclaimer: { time: 1200, materials: [[34, 1800], [35, 700], [36, 200], [37, 120], [39, 8]] },
  breacher: { time: 900, materials: [[34, 1500], [35, 520], [36, 140], [37, 70]] },
});
// Rare alloys: 11724 Glossy, 11736 Lustering, 11734 Opulent, 11735 Dark, 11733 Motley.
const T2_EXTRA = Object.freeze([[11724, 6], [11736, 6], [11735, 4], [11733, 3], [11734, 1], [38, 40], [39, 12]]);
const INVENTION = Object.freeze({
  time: 13800,
  materials: [[20424, 2], [20413, 2]], // Datacore - Mechanical Engineering, Datacore - Laser Physics
  skills: [[11447, 1], [11452, 1], [21791, 1]], // Laser Physics, Mechanical Engineering, Minmatar Encryption Methods
  probability: 0.34,
  runs: 10,
});

function blueprintTypeIDOf(familyKey, tierKey) {
  return FIRST_BLUEPRINT_TYPE_ID + FAMILY_INDEX[familyKey] * 20 + TIER_INDEX[tierKey];
}

let blueprintList = null;
function blueprints() {
  if (blueprintList) return blueprintList;
  const list = [];
  for (const family of FAMILIES) {
    if (family.kind !== "cutter") continue;
    const t1 = variantOf(typeIDOf(family, TIERS[TIER_INDEX.t1]));
    const t2 = variantOf(typeIDOf(family, TIERS[TIER_INDEX.t2]));
    const t2BlueprintTypeID = blueprintTypeIDOf(family.key, "t2");
    // The tech 1 blueprint: ours for the new kinds, the existing one otherwise.
    let t1BlueprintTypeID = null;
    if (!family.t1TypeID) {
      t1BlueprintTypeID = blueprintTypeIDOf(family.key, "t1");
      const recipe = T1_BLUEPRINT_RECIPES[family.key];
      list.push({
        typeID: t1BlueprintTypeID, productTypeID: t1.typeID, family: family.key, tier: "t1",
        name: `${t1.name} Blueprint`, techLevel: 1, metaGroupID: 1, icon: family.icon,
        manufacturing: { time: recipe.time, materials: recipe.materials, skills: [[INDUSTRY_SKILL, 1]] },
        invention: { ...INVENTION, productTypeID: t2BlueprintTypeID },
      });
    }
    list.push({
      typeID: t2BlueprintTypeID, productTypeID: t2.typeID, family: family.key, tier: "t2",
      name: `${t2.name} Blueprint`, techLevel: 2, metaGroupID: 2, icon: family.icon,
      inventedFrom: t1BlueprintTypeID,
      manufacturing: {
        time: 2400,
        materials: [[t1.typeID, 1], ...T2_EXTRA],
        skills: [[INDUSTRY_SKILL, 5], [11447, 1], [11452, 1]],
      },
    });
  }
  blueprintList = Object.freeze(list);
  return blueprintList;
}

// Invention onto the original cutters' tech 1 blueprints (cuttingLaserCatalog):
// t1 blueprint typeID -> the tech 2 blueprint it invents.
function originalBlueprintInventions(cutterBlueprints) {
  const out = {};
  for (const [blueprintTypeID, blueprint] of Object.entries(cutterBlueprints || {})) {
    const variant = variantOf(blueprint.productTypeID);
    if (!variant) continue;
    out[blueprintTypeID] = { ...INVENTION, productTypeID: blueprintTypeIDOf(variant.family, "t2") };
  }
  return out;
}

// The activities in blueprints.static's shape (the server's definitions use
// the same one): [[typeID, n]] lists become [{ quantity, typeID }] and so on.
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
  ATTR,
  CUTTER_GROUP,
  CUTTER_ATTR,
  CUTTER_ATTRIBUTES,
  MINING_ATTRIBUTE_IDS,
  TIERS,
  PRICE_FACTOR,
  FAMILIES,
  CLONE_SOURCE,
  INVENTION,
  variants,
  variantOf,
  blueprints,
  blueprintTypeIDOf,
  originalBlueprintInventions,
  manufacturingActivity,
  inventionActivity,
};
