"use strict";

// Reverie Salvage (README.md): brings back the old rogue drone alloys and
// compounds (group "Refinables") as loot and salvage. They refine into
// minerals at any reprocessing facility.
//
// Each kill rolls once for an alloy drop. The chance, the number of stacks
// and the stack sizes grow with the ship's size; rarer alloys come in smaller
// stacks. Rogue drones, the original source, keep their own alloy drops too.
// Structures, sentries, containers and similar non-ships drop none.

// Rarity follows each type's mineral value.
// [typeID, name, rarity weight, quantity factor]
const ALLOYS = Object.freeze([
  [11739, "Condensed Alloy", 10, 1], // Tritanium, Pyerite, Mexallon
  [11737, "Precious Alloy", 10, 1], // Pyerite, Isogen
  [11741, "Crystal Compound", 10, 1], // Mexallon, Isogen
  [11740, "Gleaming Alloy", 5, 0.7], // Tritanium, Nocxium
  [11732, "Sheen Compound", 5, 0.7], // Tritanium, Pyerite, Isogen, Nocxium
  [11735, "Dark Compound", 5, 0.6], // Isogen, Nocxium
  [11738, "Lucent Compound", 5, 0.6], // Pyerite, Mexallon, Isogen, Nocxium
  [11733, "Motley Compound", 4, 0.5], // Isogen, Nocxium
  [11736, "Lustering Alloy", 1.5, 0.35], // Mexallon, Isogen, Nocxium, Zydrine
  [11734, "Opulent Compound", 1.5, 0.35], // Morphite
  [11724, "Glossy Compound", 0.5, 0.25], // Mexallon, Nocxium, Megacyte
  [11725, "Plush Compound", 0.5, 0.25], // Tritanium, Pyerite, Isogen, Zydrine
]);

// size -> { chance, stacks [min, max], quantity [min, max] }
const SIZES = Object.freeze({
  frigate: { chance: 0.5, stacks: [1, 1], quantity: [1, 3] },
  destroyer: { chance: 0.55, stacks: [1, 1], quantity: [2, 5] },
  cruiser: { chance: 0.65, stacks: [1, 2], quantity: [3, 8] },
  hauler: { chance: 0.85, stacks: [1, 3], quantity: [6, 16] },
  battlecruiser: { chance: 0.7, stacks: [1, 2], quantity: [5, 12] },
  battleship: { chance: 0.8, stacks: [1, 3], quantity: [8, 20] },
  capital: { chance: 1, stacks: [2, 4], quantity: [30, 80] },
});
// Rogue drones already drop alloys from their own loot tables (about 45k ISK
// worth per kill); this roll comes on top, so they get no extra bonus here.
const ROGUE_DRONE_CHANCE_FACTOR = 1;
const ROGUE_DRONE_QUANTITY_FACTOR = 1;

// Same names as npcLootOverhaul's BAY_SCAVENGER.
const SCAVENGER = /\b(?:salvag\w*|scaveng\w*|reclaim\w*|scrapper|looter)\b/i;
const NOT_A_SHIP =/sentry|container|structure|billboard|cloud|cache|capture point|infrastructure hub|beacon|bunker|tower|stargate|station|wreck|cargo|asteroid$|deadspace overseer's belongings/i;
const NAME_SIZES = Object.freeze([
  [/(?:pacifier|skybreaker).*disparu/i, "frigate"],
  [/(?:enforcer|stormbringer).*disparu/i, "cruiser"],
  [/(?:marshal|thunderchild).*disparu/i, "battleship"],
  [/\bdamavik\b/i, "frigate"],
  [/\bkikimora\b/i, "destroyer"],
  [/\b(?:vedmak|rodiva|ikitursa)\b/i, "cruiser"],
  [/\bdrekavac\b/i, "battlecruiser"],
  [/\bleshak\b/i, "battleship"],
  [/\bemergent\b/i, "frigate"],
  [/\bawakened\b/i, "cruiser"],
  [/\bsleepless\b/i, "battleship"],
]);

// On while the mod is enabled; EVEJS_NPC_ALLOY_LOOT=0 turns the alloy drops
// and hull alloys off without disabling the cutters.
function isEnabled() {
  return require("./game").flag("EVEJS_NPC_ALLOY_LOOT", true);
}

// "frigate" ... "capital", or null for things that are not ships.
function classifySize(groupName, typeName) {
  const group = String(groupName || "");
  const text = `${group} ${typeName || ""}`;
  if (!group && !typeName) return null;
  if (NOT_A_SHIP.test(group)) return null;
  if (/titan|supercarrier|carrier|dreadnought|force auxiliary|capital|mothership/i.test(text)) return "capital";
  if (/industrial command ship|\b(?:orca|porpoise)\b/i.test(text)) return "battlecruiser";
  if (/mining barge|exhumer/i.test(group)) return "cruiser";
  for (const [pattern, size] of NAME_SIZES) if (pattern.test(text)) return size;
  if (/hauler|industrial|convoy|transport|freighter/i.test(text)) return "hauler";
  if (/battle\s*cruiser/i.test(text)) return "battlecruiser";
  if (/battleship/i.test(text)) return "battleship";
  if (/destroyer/i.test(text)) return "destroyer";
  if (/cruiser/i.test(text)) return "cruiser";
  return "frigate"; // frigates, corvettes, drones and anything else small
}

function between(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function pickAlloy(random, exclude, list = ALLOYS) {
  const pool = list.filter((entry) => !exclude.has(entry[0]));
  const total = pool.reduce((sum, entry) => sum + entry[2], 0);
  let roll = random() * total;
  for (const entry of pool) {
    roll -= entry[2];
    if (roll < 0) return entry;
  }
  return pool[pool.length - 1];
}

// source: the loot roll's source (npcTypeName, npcGroupName, factionName,
// profileID, random). Returns [{ typeID, quantity }].
function rollAlloyDrops(source = {}) {
  if (!isEnabled()) return [];
  const random = typeof source.random === "function" ? source.random : Math.random;
  const size = classifySize(source.npcGroupName, source.npcTypeName);
  if (!size) return [];
  // Alloys come from cutting and salvaging a hull, not from its cargo
  // (2026-11-17, user). Only a ship that carries them as its work has some:
  // a scavenger (by name) usually, a hauler sometimes.
  const scavenger = SCAVENGER.test(String(source.npcTypeName || ""));
  if (!scavenger && size !== "hauler") return [];
  const rules = scavenger ? { ...SIZES[size], chance: 0.8 } : { ...SIZES[size], chance: 0.3 };
  const rogueDrone = /rogue drone/i.test(`${source.npcGroupName || ""} ${source.factionName || ""}`) ||
    /^rogue_drones|rogue_drone/i.test(String(source.profileID || ""));
  const chance = Math.min(1, rules.chance * (rogueDrone ? ROGUE_DRONE_CHANCE_FACTOR : 1));
  if (random() >= chance) return [];

  const drops = [];
  const used = new Set();
  const stacks = Math.min(ALLOYS.length, between(random, rules.stacks[0], rules.stacks[1]));
  for (let index = 0; index < stacks; index += 1) {
    const [typeID, , , quantityFactor] = pickAlloy(random, used);
    used.add(typeID);
    const base = between(random, rules.quantity[0], rules.quantity[1]) * (rogueDrone ? ROGUE_DRONE_QUANTITY_FACTOR : 1);
    drops.push({ typeID, quantity: Math.max(1, Math.round(base * quantityFactor)) });
  }
  return drops;
}

// ---------------------------------------------------------------------------
// Salvage (space/modules/salvagerRuntime.js): alloys recovered from a wreck's
// hull. Bigger wrecks salvage more often, in bigger stacks, and give up the
// rarer alloys: a frigate yields the common and uncommon ones, a cruiser can
// yield a rare one, only battleship-sized and capital wrecks the rarest.
// Rogue drone wrecks, being alloy, salvage more of it.

// rarity of an alloy from its weight in ALLOYS.
function rarityOf(weight) {
  return weight >= 10 ? "common" : weight >= 4 ? "uncommon" : weight >= 1 ? "rare" : "veryRare";
}

// salvage size (small, medium, large, capital) -> chance, stacks, quantity,
// and the weight multiplier of each rarity (0 = cannot salvage it).
const SALVAGE_SIZES = Object.freeze({
  small: { chance: 0.3, stacks: [1, 1], quantity: [1, 3], rarity: { common: 1, uncommon: 0.6, rare: 0, veryRare: 0 } },
  medium: { chance: 0.45, stacks: [1, 2], quantity: [2, 5], rarity: { common: 1, uncommon: 1, rare: 0.7, veryRare: 0 } },
  large: { chance: 0.6, stacks: [1, 2], quantity: [4, 10], rarity: { common: 1, uncommon: 1.2, rare: 1.3, veryRare: 1 } },
  capital: { chance: 0.9, stacks: [2, 4], quantity: [10, 25], rarity: { common: 1, uncommon: 1.4, rare: 2, veryRare: 2.5 } },
});
const SALVAGE_DRONE_FACTOR = 1.5;

function salvageMultiplier() {
  // Off by default, as on the Scarlet server since 2026-11-17: the metal comes
  // from cutting, and a player can turn this roll on in the Configure form.
  return Math.max(0, require("./game").number("EVEJS_SALVAGE_ALLOYS", 0));
}

// size: "small" | "medium" | "large" | "capital"; options.faction is the
// salvager's wreck faction ("drone" for rogue drones). Returns
// [{ itemType, quantity }] in the salvager's grant shape.
function salvageAlloys(size, random = Math.random, options = {}) {
  if (!isEnabled()) return [];
  const rules = SALVAGE_SIZES[size] || SALVAGE_SIZES.small;
  const drone = options.faction === "drone";
  const odds = rules.chance * salvageMultiplier() * (drone ? SALVAGE_DRONE_FACTOR : 1);
  if (!(odds > 0) || random() >= Math.min(1, odds)) return [];
  const weighted = ALLOYS
    .map(([typeID, name, weight, quantityFactor]) => [typeID, name, weight * (rules.rarity[rarityOf(weight)] || 0), quantityFactor])
    .filter((entry) => entry[2] > 0);
  const used = new Set();
  const grants = [];
  const stacks = Math.min(weighted.length, between(random, rules.stacks[0], rules.stacks[1]));
  for (let index = 0; index < stacks; index += 1) {
    const [typeID, , , quantityFactor] = pickAlloy(random, used, weighted);
    used.add(typeID);
    const base = between(random, rules.quantity[0], rules.quantity[1]) * (drone ? SALVAGE_DRONE_FACTOR : 1);
    grants.push({ itemType: typeID, quantity: Math.max(1, Math.round(base * quantityFactor)) });
  }
  return grants;
}

// ---------------------------------------------------------------------------
// Hull alloys: part of the minerals in the ship's own hull comes back as
// alloys, sized to the hull, to whoever salvages the wreck
// (EVEJS_SALVAGE_HULL_RECOVERY, 0 by default so the metal waits for a cutter;
// at 0.25 a bare salvage would beat the Hull Panel Cutter on the middle
// metals), varied by +-30%. They are not loot: a
// wreck's cargo is what the ship carried (rollAlloyDrops above), and the
// hull's metal comes only from salvage. What does not fit the salvager's
// hold is lost, so a bigger salvage ship gets more. The hull is the ship's own blueprint, else the
// player hull it is built on ("Detainer Caracal" -> Caracal), else a T1 hull
// of its size. A barge or hauler with a blueprint gives back its own hull.

const MINERAL_IDS = new Set([34, 35, 36, 37, 38, 39, 40, 11399]);
const HULL_JITTER = 0.3;
// size -> [stand-in hull typeID, multiple of its minerals]
const STAND_INS = Object.freeze({
  frigate: [587, 1], // Rifter
  destroyer: [16242, 1], // Thrasher
  cruiser: [622, 1], // Stabber
  hauler: [652, 1], // Mammoth
  battlecruiser: [24702, 1], // Hurricane
  battleship: [639, 1], // Tempest
  capital: [639, 15],
});
// Greedy fill: each alloy in turn takes as many units as the minerals in its
// list still allow. Plush carries the Tritanium and Pyerite bulk, the rare
// minerals go next, and Gleaming takes the Tritanium left at the end. No
// alloy may push any other mineral more than OVERSHOOT of the hull's own
// amount past it, so a Megacyte-bearing alloy cannot flood the Mexallon;
// whatever no alloy fits is lost. Trace contents (under TRACE of the alloy's
// key units, such as the Zydrine in Plush) come along free.
const OVERSHOOT = 0.1;
const TRACE = 0.05;
const FILL_ORDER = Object.freeze([
  [11725, [34, 35]], // Plush
  [11724, [40]], // Glossy: Megacyte
  [11736, [39]], // Lustering: Zydrine
  [11734, [11399]], // Opulent: Morphite
  [11735, [38]], // Dark: Nocxium
  [11737, [35, 37]], // Precious: Pyerite, Isogen
  [11739, [35]], // Condensed: Pyerite
  [11741, [36]], // Crystal: Mexallon
  [11740, [34]], // Gleaming: Tritanium
]);

function services(relative) {
  return require("./game").game(`services/${relative}`);
}

function share(name, fallback) {
  return Math.max(0, require("./game").number(name, fallback));
}

// minerals in a type's manufacturing recipe, { mineralTypeID: quantity }, or null
function recipeMinerals(typeID) {
  let job = null;
  try {
    const blueprint = services("industry/industryStaticData").getBlueprintDefinitionByProductTypeID(Number(typeID));
    job = blueprint && blueprint.activities && blueprint.activities.manufacturing;
  } catch (_) {
    return null;
  }
  const minerals = {};
  let any = false;
  for (const row of (job && Array.isArray(job.materials) ? job.materials : [])) {
    const id = Number(row.typeID);
    if (!MINERAL_IDS.has(id) || !(Number(row.quantity) > 0)) continue;
    minerals[id] = Number(row.quantity);
    any = true;
  }
  return any ? minerals : null;
}

const hullCache = new Map();
// { mineralTypeID: quantity } in the hull of a ship type, or null for things
// that are not ships. Cached per type.
function hullMinerals(typeID, groupName, typeName) {
  const numericTypeID = Number(typeID) || 0;
  const key = numericTypeID || `${groupName || ""}|${typeName || ""}`;
  if (hullCache.has(key)) return hullCache.get(key);
  const registry = services("inventory/itemTypeRegistry");
  const type = numericTypeID ? registry.resolveItemByTypeID(numericTypeID) || {} : {};
  const name = String(typeName || type.name || "");
  const group = String(groupName || type.groupName || "");
  let minerals = null;
  const size = classifySize(group, name);
  if (size) {
    minerals = numericTypeID ? recipeMinerals(numericTypeID) : null;
    // "Detainer Caracal" -> "Caracal": the first exact ship match with a recipe.
    const words = name.split(/\s+/);
    for (let index = 1; index < words.length && !minerals; index += 1) {
      for (const match of registry.listExactItemMatchesByName(words.slice(index).join(" ")) || []) {
        if (Number(match.categoryID) !== 6) continue;
        minerals = recipeMinerals(match.typeID);
        if (minerals) break;
      }
    }
    if (!minerals && STAND_INS[size]) {
      const [standTypeID, multiple] = STAND_INS[size];
      const base = recipeMinerals(standTypeID);
      if (base) {
        minerals = {};
        for (const [id, quantity] of Object.entries(base)) minerals[id] = quantity * multiple;
      }
    }
  }
  hullCache.set(key, minerals);
  return minerals;
}

const contentCache = new Map();
function alloyContents(typeID) {
  if (contentCache.has(typeID)) return contentCache.get(typeID);
  const contents = {};
  for (const row of services("reprocessing/reprocessingStaticData").getTypeMaterials(typeID)) {
    contents[Number(row.materialTypeID)] = Number(row.quantity) || 0;
  }
  contentCache.set(typeID, contents);
  return contents;
}

// The alloys that hold a share of a hull's minerals: [{ typeID, quantity }].
// Fractional units round up or down at random, so the share holds on average.
//
// scale (optional, mineralTypeID -> 0..1): the share of each mineral a cutter
// frees (its reach on that mineral's band, wreckCutting.js). An alloy forms on
// its key minerals only as far as they were freed; its other contents come
// along from the whole hull share, so a core cut still forms Glossy, which
// carries Mexallon and Nocxium with its Megacyte. With no scale this is the
// plain fill (freed = the whole share).
function hullAlloys(minerals, fraction, random = Math.random, scale = null) {
  if (!minerals || !(fraction > 0)) return [];
  const jitter = 1 + HULL_JITTER * (2 * random() - 1);
  const avail = {}; // the hull share of each mineral not yet in an alloy
  const left = {}; // what of it the cutter freed (= avail with no scale)
  const floor = {}; // how far below zero each mineral may go (the overshoot allowed)
  for (const [id, quantity] of Object.entries(minerals)) {
    avail[id] = quantity * fraction * jitter;
    const share = typeof scale === "function" ? Math.max(0, Math.min(1, Number(scale(Number(id))) || 0)) : 1;
    left[id] = avail[id] * share;
    floor[id] = -OVERSHOOT * avail[id];
  }
  const drops = [];
  for (const [typeID, keys] of FILL_ORDER) {
    const contents = alloyContents(typeID);
    let count = Infinity;
    for (const id of keys) count = Math.min(count, contents[id] > 0 ? Math.max(0, left[id] || 0) / contents[id] : 0);
    const keyUnits = keys.reduce((sum, id) => sum + (contents[id] || 0), 0);
    for (const [id, quantity] of Object.entries(contents)) {
      if (!(quantity > 0) || keys.includes(Number(id)) || quantity < TRACE * keyUnits) continue;
      count = Math.min(count, Math.max(0, (avail[id] || 0) - (floor[id] || 0)) / quantity);
    }
    if (!(count > 0) || !Number.isFinite(count)) continue;
    for (const [id, quantity] of Object.entries(contents)) {
      left[id] = (left[id] || 0) - count * quantity;
      avail[id] = (avail[id] || 0) - count * quantity;
    }
    const quantity = Math.floor(count) + (random() < count % 1 ? 1 : 0);
    if (quantity > 0) drops.push({ typeID, quantity });
  }
  return drops;
}

// Salvage: the large hull share, trimmed to options.room m3 (the salvager's
// free cargo). Returns [{ itemType, quantity }] in the salvager's grant shape.
function salvageHullAlloys(sourceTypeID, random = Math.random, options = {}) {
  if (!isEnabled()) return [];
  // options.share: the part of the hull still on the wreck (1 = untouched).
  const left = Number.isFinite(Number(options.share)) ? Math.max(0, Math.min(1, Number(options.share))) : 1;
  const drops = hullAlloys(hullMinerals(sourceTypeID, options.groupName, options.typeName),
    share("EVEJS_SALVAGE_HULL_RECOVERY", 0) * left, random);
  const room = Number.isFinite(Number(options.room)) ? Math.max(0, Number(options.room)) : Infinity;
  const volumeOf = (typeID) => Number((services("inventory/itemTypeRegistry").resolveItemByTypeID(typeID) || {}).volume) || 1;
  const volume = drops.reduce((sum, drop) => sum + drop.quantity * volumeOf(drop.typeID), 0);
  const scale = volume > room ? room / volume : 1;
  return drops
    .map((drop) => ({ itemType: drop.typeID, quantity: Math.floor(drop.quantity * scale) }))
    .filter((grant) => grant.quantity > 0);
}

module.exports = {
  ALLOYS,
  SALVAGE_SIZES,
  classifySize,
  rollAlloyDrops,
  salvageAlloys,
  hullMinerals,
  hullAlloys,
  salvageHullAlloys,
};
