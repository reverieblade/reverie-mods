"use strict";

// What a salvager gets from a wreck, beyond CCP's salvage roll: more
// successful attempts, fewer wrecks that salvage empty, and metal scrap from
// nearly every salvaged wreck, with now and then an extra salvaged part. These
// lived in the repo's loot overhaul (space/npc/npcLootOverhaul.js) and moved
// here, since they are salvaging and not loot.
//
// Tunables (lib/game.js): EVEJS_SALVAGE_CHANCE_BONUS (percentage points on
// every attempt, 15), EVEJS_SALVAGE_EMPTY_FACTOR (times CCP's chance of an
// empty wreck, 0.35), EVEJS_SALVAGE_SCRAP (times the scrap chances, 1).
//
// Hot reload: the type pools are cached by the item type table they came
// from, so a reload of the mod or of the static data rebuilds them.

const { game, number } = require("./game");

// size -> chance of scrap, its units, chance of reinforced scrap, chance of an extra salvaged part
const SCRAP = Object.freeze({
  small: Object.freeze({ chance: 0.75, units: [3, 12], reinforced: 0.04, extra: 0.35 }),
  medium: Object.freeze({ chance: 0.85, units: [6, 25], reinforced: 0.1, extra: 0.45 }),
  large: Object.freeze({ chance: 0.92, units: [12, 50], reinforced: 0.2, extra: 0.55 }),
  capital: Object.freeze({ chance: 1, units: [40, 150], reinforced: 0.5, extra: 0.8 }),
});
// Salvaged parts whose names say they came off damaged (the common ones).
const DAMAGED = /^(?:burned|charred|fried|tripped|scorched|malfunctioning|contaminated|defective|smashed|tangled|damaged|broken|melted|alloyed|armor plates|conductive|ward console|thruster console)/i;

function between(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function chance(random, probability) {
  return random() < probability;
}

function pick(random, list) {
  return list.length ? list[Math.min(list.length - 1, Math.floor(random() * list.length))] : null;
}

// Lumpy quantities: most rolls land near the middle, some far off it.
function spread(random) {
  const gaussian = (random() + random() + random() - 1.5) / 0.5;
  return Math.exp(gaussian * 0.45);
}

let poolCache = { rows: null, pools: null };
function pools() {
  const { TABLE, readStaticRows } = game("services/_shared/referenceData");
  const rows = readStaticRows(TABLE.ITEM_TYPES) || [];
  if (poolCache.rows === rows && poolCache.pools) return poolCache.pools;
  const published = rows.filter((row) => row && row.published !== false);
  const named = (name) => published.find((row) => row.name === name) || null;
  const salvage = published.filter((row) => row.groupName === "Salvaged Materials");
  poolCache = {
    rows,
    pools: {
      metalScraps: named("Metal Scraps"),
      reinforcedScraps: named("Reinforced Metal Scraps"),
      salvageCommon: salvage.filter((row) => DAMAGED.test(row.name)),
      salvageRare: salvage.filter((row) => !DAMAGED.test(row.name)),
    },
  };
  return poolCache.pools;
}

function chanceBonus() {
  return number("EVEJS_SALVAGE_CHANCE_BONUS", 15);
}

function emptyFactor() {
  return Math.max(0, number("EVEJS_SALVAGE_EMPTY_FACTOR", 0.35));
}

// size: "small", "medium", "large" or "capital". Returns [{ itemType, quantity }].
function scrapFor(size, random = Math.random) {
  const rules = SCRAP[size] || SCRAP.small;
  const scale = Math.max(0, number("EVEJS_SALVAGE_SCRAP", 1));
  if (!(scale > 0)) return [];
  const state = pools();
  const out = [];
  const add = (row, quantity) => {
    if (row && quantity > 0) out.push({ itemType: Number(row.typeID), quantity: Math.max(1, Math.round(quantity)) });
  };
  if (chance(random, Math.min(1, rules.chance * scale))) {
    add(state.metalScraps, between(random, rules.units[0], rules.units[1]) * spread(random));
  }
  if (chance(random, Math.min(1, rules.reinforced * scale))) {
    add(state.reinforcedScraps, between(random, 1, Math.max(2, Math.round(rules.units[0] / 2))));
  }
  if (chance(random, Math.min(1, rules.extra * scale))) {
    add(pick(random, chance(random, 0.85) ? state.salvageCommon : state.salvageRare), between(random, 1, 3));
  }
  return out;
}

module.exports = { SCRAP, chanceBonus, emptyFactor, scrapFor, _testing: { pools } };
