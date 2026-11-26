"use strict";

// Bay extensions in NPC loot (README.md, "Where to find them"): a ship carries
// the hold its work needs. Miners carry a mining or mineral hold, haulers a
// mineral, planetary or fuel hold, warships an ammo or fuel hold, the odd
// scavenger a salvage hold and the odd roamer an expedition hold. Size follows
// the hull (barges and haulers take the medium one), quality the usual module
// roll, with meta spread over the four meta levels.
//
// Ported from the Scarlet build's npcLootOverhaul.js rollBayExtensions, with
// the same roles, chances and weights. EveJS's own loot tables have no
// overhaul context, so the NPC's role, size and rank come from its type's name
// and group here, the way reverie-salvage classifies its alloy drops.
//
// Only while the type layer is on (game.layerData), so a type the server does
// not know never drops. Setting extensionLoot (EVEJS_BAY_EXTENSION_LOOT)
// scales the chance; 0 turns it off.

const { number, layerData } = require("./game");
const family = require("./bayFamily");

const ROLES = Object.freeze({
  miner: { chance: 0.14, kinds: { mining: 6, mineral: 2, fuel: 1, expedition: 0.3 } },
  hauler: { chance: 0.16, kinds: { mineral: 3, planetary: 3, fuel: 2, ammo: 1, mining: 0.7, expedition: 0.5 } },
  salvager: { chance: 0.2, kinds: { salvage: 6, fuel: 1, ammo: 0.5 } },
  combat: { chance: 0.035, kinds: { ammo: 4, fuel: 3, expedition: 1, salvage: 0.6, planetary: 0.2 } },
});
const META_LEVELS = Object.freeze([["m1", 4], ["m2", 3], ["m3", 2], ["m4", 1]]);
const SCAVENGER = /\b(?:salvag\w*|scaveng\w*|reclaim\w*|scrapper|looter)\b/i;
const BARGE = /barge|exhumer|procurer|retriever|covetor|skiff|mackinaw|hulk|porpoise|orca/i;
const MINER = /\b(?:mining|miner|barge|exhumer|venture|prospect|endurance|procurer|retriever|covetor|skiff|mackinaw|hulk|porpoise|orca)\b/i;
const NOT_A_SHIP = /sentry|container|structure|billboard|cloud|cache|capture point|infrastructure hub|beacon|bunker|tower|stargate|station|wreck|cargo|asteroid$|deadspace overseer's belongings/i;

// The share of each quality when a module drops, by rank (npcLootOverhaul's
// MODULE_QUALITY).
const MODULE_QUALITY = Object.freeze({
  common: [["t1", 78.9], ["meta", 21], ["t2", 0.1], ["faction", 0]],
  elite: [["t1", 63.4], ["meta", 36], ["t2", 0.6], ["faction", 0]],
  faction: [["t1", 53.5], ["meta", 42], ["t2", 1.5], ["faction", 3]],
  burner: [["t1", 40], ["meta", 52], ["t2", 8], ["faction", 0]],
});
// How much a kill holds, by rank: [name, weight, count] (npcLootOverhaul's LUCK).
const LUCK = Object.freeze({
  common: [["lean", 18, 0.5], ["normal", 65, 1], ["rich", 15, 1.6], ["jackpot", 2, 2.2]],
  elite: [["lean", 12, 0.6], ["normal", 63, 1], ["rich", 21, 1.7], ["jackpot", 4, 2.4]],
  faction: [["lean", 8, 0.7], ["normal", 60, 1], ["rich", 25, 1.8], ["jackpot", 7, 2.6]],
  burner: [["lean", 5, 0.8], ["normal", 55, 1], ["rich", 30, 1.8], ["jackpot", 10, 2.6]],
});
const FACTION_NAMES = /\b(?:dread guristas|domination|dark blood|true sansha|shadow serpentis|dread|dark corp|true cent|shadow corel)|\b(?:navy|fleet|imperial navy|caldari navy|federation navy|republic fleet|ammatar navy|khanid navy|concord|ded)\b/i;
const ELITE_NAMES = /\b(?:commander|officer|overseer|elite|veteran|chief|captain|lieutenant|lord|general|admiral|boss|leader|warden|dire|elder|arch|sentient|true|high|grand|primus|overmind)\b/i;

function pickWeighted(random, entries) {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry[1]), 0);
  if (!(total > 0)) return null;
  let roll = random() * total;
  for (const entry of entries) {
    roll -= Math.max(0, entry[1]);
    if (roll < 0) return entry[0];
  }
  return entries[entries.length - 1][0];
}

const chance = (random, p) => random() < p;

// frigate, destroyer, cruiser, battlecruiser, battleship, capital or hauler;
// null for something that is not a ship.
function classifySize(groupName, typeName) {
  const group = String(groupName || "");
  const text = `${group} ${typeName || ""}`;
  if (!group && !typeName) return null;
  if (NOT_A_SHIP.test(group)) return null;
  if (/titan|supercarrier|carrier|dreadnought|force auxiliary|capital|mothership/i.test(text)) return "capital";
  if (/industrial command ship|\b(?:orca|porpoise)\b/i.test(text)) return "battlecruiser";
  if (/mining barge|exhumer/i.test(group)) return "cruiser";
  if (/hauler|industrial|convoy|transport|freighter/i.test(text)) return "hauler";
  if (/battle\s*cruiser/i.test(text)) return "battlecruiser";
  if (/battleship/i.test(text)) return "battleship";
  if (/destroyer/i.test(text)) return "destroyer";
  if (/cruiser/i.test(text)) return "cruiser";
  return "frigate";
}

const BAND_BY_SIZE = Object.freeze({
  frigate: "small", destroyer: "small", cruiser: "medium", battlecruiser: "medium",
  hauler: "small", battleship: "large", capital: "large",
});

function rankOf(text) {
  if (/\bburner\b/i.test(text)) return "burner";
  if (FACTION_NAMES.test(text)) return "faction";
  if (ELITE_NAMES.test(text)) return "elite";
  return "common";
}

function roleOf(ctx) {
  if (ctx.miner) return "miner";
  if (SCAVENGER.test(ctx.name)) return "salvager";
  if (ctx.size === "hauler") return "hauler";
  return "combat";
}

function sizeFor(random, ctx, role) {
  if (role === "miner") return BARGE.test(ctx.name) ? "medium" : "small";
  if (role === "hauler") return chance(random, 0.7) ? "medium" : chance(random, 0.6) ? "small" : "large";
  return BAND_BY_SIZE[ctx.size] || "small";
}

// The bay extension an NPC of this kind drops, or null: { typeID, quantity }.
// source: { npcTypeName, npcGroupName, random }.
function rollBayExtension(source = {}) {
  if (!layerData()) return null;
  const tune = number("EVEJS_BAY_EXTENSION_LOOT", 1);
  if (!(tune > 0)) return null;
  const random = typeof source.random === "function" ? source.random : Math.random;
  const name = String(source.npcTypeName || "");
  const group = String(source.npcGroupName || "");
  const size = classifySize(group, name);
  if (!size) return null;
  const text = `${group} ${name}`;
  const ctx = { name, size, miner: MINER.test(text) };
  const rank = rankOf(name);
  const luck = pickWeighted(random, LUCK[rank].map((row) => [row, row[1]]));
  const role = roleOf(ctx);
  const plan = ROLES[role];
  if (!chance(random, Math.min(0.9, plan.chance * tune * Math.sqrt(luck[2])))) return null;
  const kind = pickWeighted(random, Object.entries(plan.kinds));
  const bandSize = sizeFor(random, ctx, role);
  const quality = pickWeighted(random, MODULE_QUALITY[rank]);
  const tier = quality === "t2" ? "t2" : quality === "faction" ? "m4"
    : quality === "meta" ? pickWeighted(random, META_LEVELS) : "t1";
  const chosen = family.variants().find((variant) => variant.bay === kind && variant.size === bandSize && variant.tier === tier);
  return chosen ? { typeID: chosen.typeID, quantity: 1 } : null;
}

module.exports = { rollBayExtension, classifySize, rankOf, ROLES };
