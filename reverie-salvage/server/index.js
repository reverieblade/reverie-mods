"use strict";

// Reverie Salvage, server side (README.md). Everything the mod changes in the
// game is declared here:
//
//   patches       cutters through the mining runtime, alloys in NPC loot, gear in
//                 the loot tables' module pools (edits/npcLoot.selectorKind.js), guns
//                 destroying wrecks, the Salvage Hold's rules and loot routing
//   hooks         the hook points the mod's text edits put into
//                 salvagerRuntime.js (edits/*.js): access difficulty, chance,
//                 empty wrecks, rewards, the panel cycle and the salvage hold
//   service       "salvage" for other mods and for bots
//
// Hot reload: `node mods/reverie-core/cli.js reload reverie-salvage` drops the
// mod's files and declares all of this again; wrappers read their lists per
// call, so the next cycle runs the new code. Game modules are looked up where
// they are used (lib/game.js). The text edits are the one part that needs a
// server start, since they live in game files.

const fs = require("fs");
const path = require("path");

const lib = (name) => require(`./lib/${name}`);
const toInt = (value, fallback = 0) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

const SALVAGE_HOLD_FLAG = 137;
// Metal Scraps and Reinforced Metal Scraps: the Salvage Hold takes these too.
const SCRAP_TYPES = Object.freeze([15331, 30497]);
const SALVAGE_HOLD_REFUSAL = "Only salvage materials, alloys and scrap can be placed in the Salvage Hold.";
const HOOK_MARKER = "salvage.rewardEntries";

// This repository's own build already has all of this in its game files
// (services/salvage/). Hooking it twice would cut every wreck twice.
function hasLocalBuild(api) {
  return fs.existsSync(path.join(api.paths.srcRoot, "services", "salvage", "wreckCutting.js"));
}

function editsInPlace(api) {
  try {
    const file = path.join(api.paths.srcRoot, "space", "modules", "salvagerRuntime.js");
    return fs.readFileSync(file, "utf8").includes(HOOK_MARKER);
  } catch (_) {
    return false;
  }
}

function notifyPilotText(session, text) {
  if (!session || typeof session.sendNotification !== "function") return;
  session.sendNotification("OnRemoteMessage", "clientID", [
    "CustomNotify", { type: "dict", entries: [["notify", text]] },
  ]);
}

function cargoFullText(neededM3, freeM3) {
  const m3 = (value) => Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
  return `Salvaging has stopped because your cargo hold is too full. The salvaged materials require ${m3(neededM3)} m3 and only ${m3(freeM3)} m3 is available.`;
}

function salvageHoldFreeFor(ctx) {
  if (!ctx || ctx.rewardLocationID !== ctx.shipID) return 0;
  return lib("salvageHoldRouting").holdFree(ctx.characterID, ctx.shipItem);
}

// ---------------------------------------------------------------------------
// Patches on exported game functions.

function patchCutters(api) {
  const cutting = () => lib("wreckCutting");
  // A cutter is a mining laser by dogma, so its activation and cycles come
  // through the mining runtime first.
  api.patch("services/mining/miningRuntime", "resolveMiningActivation", {
    prefix(ctx, [scene, entity, moduleItem, effectRecord, options]) {
      if (!cutting().isCutterModule(moduleItem)) return undefined;
      const mining = api.require("services/mining/miningRuntime");
      if (typeof mining.isMiningEffectRecord === "function" && !mining.isMiningEffectRecord(effectRecord, moduleItem)) return undefined;
      return api.skip(cutting().resolveCutActivation(scene, entity, moduleItem, effectRecord, options || {}, lib("cutHelpers").cutHelpers()));
    },
  });
  // The type layer takes the mining numbers off every cutter, and the mining
  // snapshot refuses a module that mines nothing unless this hook (the
  // mod's edit to miningDogma.js) says it is a cutter.
  api.hooks.on("mining.allowNoYield", (allow, ctx) => (allow === true || cutting().isCutterModule(ctx && ctx.moduleItem) ? true : undefined));
  api.patch("services/mining/miningRuntime", "executeMiningCycle", {
    prefix(ctx, [scene, entity, effectState, cycleBoundaryMs, options]) {
      if (!scene || !entity || !effectState || !cutting().isCutterEffectState(effectState)) return undefined;
      const efficiency = Math.min(1, Math.max(0, Number.isFinite(Number(options && options.efficiency)) ? Number(options.efficiency) : 1));
      if (efficiency <= 0) return undefined; // the original stops the cycle
      return api.skip(cutting().executeCutCycle(scene, entity, effectState, cycleBoundaryMs,
        { ...(options || {}), efficiency }, lib("cutHelpers").cutHelpers()));
    },
  });
}

function patchLoot(api) {
  // Hull cutters and salvagers sit in the module pools of EveJS's own loot
  // tables (the mod's edit to npcLoot.js), so they drop the way any other
  // module does: the plain models from ordinary NPCs, Domination, Gistum and
  // officer models from the tables that name them. The server knows the
  // mod's types only while the type layer is on, so nothing drops without it.
  // Without the layer the three cutter types are still CCP's mining lasers,
  // and the loot tables keep their own rules for them.
  const gearState = () => (lib("game").layerModelTypes().size === 0 ? "off"
    : lib("game").flag("EVEJS_SALVAGE_GEAR_LOOT", true) ? "on" : "none");
  let gearSeen = null;
  api.hooks.on("loot.selectorKind", (value, itemType, kind) => {
    if (value === true || value === false) return undefined;
    if (!lib("salvageModuleFamily").variantOf(toInt(itemType && itemType.typeID))) return undefined;
    gearSeen = gearState();
    if (gearSeen === "off") return undefined;
    if (gearSeen === "none") return false;
    return kind === "module" ? true : undefined;
  });
  // npcLoot caches each selector's pool, so a change to the setting or the
  // layer clears them; they fill again as the tables are next rolled.
  const clearPoolsOnChange = () => {
    const now = gearState();
    if (gearSeen === null || now === gearSeen) return;
    gearSeen = now;
    const loot = api.require("space/npc/npcLoot");
    if (loot && loot._testing && typeof loot._testing.clearRuleCandidateCache === "function") loot._testing.clearRuleCandidateCache();
  };

  // Alloys in the cargo of the NPC ships that carry them as their work
  // (scavengers, now and then a hauler).
  api.patch("space/npc/npcLoot", "rollNpcLootEntries", {
    prefix() {
      clearPoolsOnChange();
      return undefined;
    },
    postfix(ctx, entries, [lootTable, options]) {
      if (!Array.isArray(entries)) return undefined;
      const opts = options || {};
      const source = { ...(opts.source || {}) };
      source.random = opts.random || source.random || Math.random;
      const registry = api.require("services/inventory/itemTypeRegistry");
      if (toInt(source.npcTypeID) > 0 && (!source.npcTypeName || !source.npcGroupName)) {
        const npcType = registry.resolveItemByTypeID(toInt(source.npcTypeID));
        if (npcType) {
          source.npcTypeName = source.npcTypeName || npcType.name;
          source.npcGroupName = source.npcGroupName || npcType.groupName;
        }
      }
      const drops = lib("npcAlloyLoot").rollAlloyDrops(source);
      if (!drops.length) return undefined;
      const out = [...entries];
      for (const drop of drops) {
        const itemType = registry.resolveItemByTypeID(toInt(drop.typeID));
        if (!itemType) continue;
        out.push({ itemType, typeID: itemType.typeID, name: itemType.name, quantity: Math.max(1, toInt(drop.quantity, 1)), singleton: 0 });
      }
      return out;
    },
  });
}

function patchWrecks(api) {
  // Guns destroy an NPC wreck, or a hull panel cut from one, and everything
  // still in it, as in EVE.
  api.patch("space/runtime/combatDestruction", "destroyCombatEntity", {
    prefix(ctx, [scene, entity, options]) {
      if (!scene || !entity || entity.nativeNpcWreck !== true) return undefined;
      const opts = options || {};
      const nowMs = Number.isFinite(Number(opts.destructionNowMs)) ? Number(opts.destructionNowMs) : scene.getCurrentSimTimeMs();
      return api.skip(api.require("space/npc/nativeNpcWreckService").destroyNativeWreck(entity.itemID, { scene, broadcast: true, nowMs }));
    },
  });
}

function patchHolds(api) {
  api.patch("services/inventory/specialShipHoldRegistry", "isSpecialShipHoldItemAllowed", {
    postfix(ctx, allowed, [itemOrTypeID, flagID]) {
      if (allowed === true || toInt(flagID) !== SALVAGE_HOLD_FLAG) return undefined;
      const typeID = toInt(itemOrTypeID && typeof itemOrTypeID === "object" ? itemOrTypeID.typeID : itemOrTypeID);
      return SCRAP_TYPES.includes(typeID) ? true : undefined;
    },
  });
  api.patch("services/inventory/specialShipHoldRegistry", "getSpecialShipHoldRestrictionMessage", {
    postfix(ctx, message, [flagID]) {
      return toInt(flagID) === SALVAGE_HOLD_FLAG ? SALVAGE_HOLD_REFUSAL : undefined;
    },
  });
  // Loot All into cargo in space sends what the Salvage Hold takes there.
  api.replace("services/inventory/invBrokerService", "prototype.Handle_Add", function handleAdd(original, ...args) {
    return lib("salvageHoldLootRouting").handleAdd.call(this, original, ...args);
  });
  api.replace("services/inventory/invBrokerService", "prototype.Handle_MultiAdd", function handleMultiAdd(original, ...args) {
    return lib("salvageHoldLootRouting").handleMultiAdd.call(this, original, ...args);
  });
}

// ---------------------------------------------------------------------------
// Handlers on the hook points the text edits add to salvagerRuntime.js.

function hookSalvager(api) {
  const cutting = () => lib("wreckCutting");
  const tables = () => lib("salvageTables");

  // A hull panel's difficulty follows its own size. Its type is a reused CCP
  // wreck type whose accessDifficulty is not the panel's.
  api.hooks.on("salvage.accessDifficultyBase", (value, targetEntity, itemRecord, nativeWreckRecord, defaults) => {
    const panel = nativeWreckRecord && nativeWreckRecord.wreckPanel;
    if (!panel || !defaults) return undefined;
    if (panel.size === "large") return defaults.large;
    if (panel.size === "medium") return defaults.medium;
    return defaults.small;
  });

  api.hooks.on("salvage.chanceBonus", (value) => Number(value || 0) + tables().chanceBonus());
  api.hooks.on("salvage.emptyFactor", (value) => Number(value) * tables().emptyFactor());

  // What a salvager recovers from a plain wreck: CCP's roll, then scrap and
  // alloys (not from an empty wreck), then the cut-off parts and the hull.
  api.hooks.on("salvage.rewardEntries", (entries, ctx) => {
    const out = Array.isArray(entries) ? [...entries] : [];
    const options = (ctx && ctx.options) || {};
    const random = ctx && typeof ctx.random === "function" ? ctx.random : Math.random;
    if (!ctx.empty) {
      out.push(...tables().scrapFor(ctx.size, random));
      out.push(...lib("npcAlloyLoot").salvageAlloys(ctx.size, random, { faction: ctx.faction }));
    }
    // A wreck someone has been cutting gave part of its salvage to
    // containers; only the rest is left on it.
    const cutRecord = ctx.nativeWreckRecord || cutting().inventoryRecordOf(ctx.targetEntity);
    const cutLeft = options.skipHullAlloys === true ? null : cutting().remainingSalvageEntries(cutRecord);
    if (cutLeft) {
      out.length = 0;
      out.push(...cutLeft);
    }
    const sourceTypeID = toInt(cutRecord && cutRecord.sourceTypeID);
    if (sourceTypeID > 0 && options.skipHullAlloys !== true) {
      const volume = typeof ctx.computeGrantVolume === "function" ? ctx.computeGrantVolume(out) : 0;
      const room = Number.isFinite(Number(options.availableVolume)) ? Number(options.availableVolume) - volume : Infinity;
      out.push(...lib("npcAlloyLoot").salvageHullAlloys(sourceTypeID, random, { room, share: cutting().hullLeftShare(cutRecord) }));
    }
    return out;
  });

  // A hull panel comes apart a chunk per successful cycle.
  api.hooks.on("salvage.cycle", (value, ctx) => {
    if (value || !ctx || !cutting().isPanelEntity(ctx.targetEntity)) return undefined;
    return cutting().salvagePanelCycle({
      scene: ctx.scene,
      entity: ctx.entity,
      targetEntity: ctx.targetEntity,
      effectState: ctx.effectState,
      characterID: ctx.characterID,
      rewardLocationID: ctx.rewardLocationID,
      shipID: ctx.shipID,
      cargoSnapshot: ctx.cargoSnapshot,
      salvageHoldFree: salvageHoldFreeFor(ctx),
      skillMap: ctx.skillMap,
      nowMs: ctx.nowMs,
      helpers: {
        syncRewards: (changes) => ctx.syncRewards(changes),
        notify: (rewards) => ctx.notify(rewards),
        say: (text) => notifyPilotText(ctx.messageSession, text),
        cargoFull: (neededM3, freeM3) => notifyPilotText(ctx.messageSession, cargoFullText(neededM3, freeM3)),
      },
    });
  });

  // Salvage fills the Salvage Hold first, the way ore fills an ore hold.
  api.hooks.on("salvage.extraRoom", (value, ctx) => Number(value || 0) + salvageHoldFreeFor(ctx));
  api.hooks.on("salvage.rewardSplit", (value, entries, cargoFree, extraRoom, ctx) => {
    if (value || !(extraRoom > 0)) return undefined;
    const routing = lib("salvageHoldRouting");
    const split = routing.plan(entries, cargoFree, salvageHoldFreeFor(ctx));
    return { ...split, grant: () => routing.grantPlan(ctx.characterID, ctx.shipID, split) };
  });
  api.hooks.on("salvage.cargoFull", (ctx, neededM3, freeM3) => {
    notifyPilotText(ctx && ctx.messageSession, cargoFullText(neededM3, freeM3));
  });
}

// ---------------------------------------------------------------------------
// The service other mods and bots use (README.md, "For other mods and bots").

function provideService(api) {
  const cutting = () => lib("wreckCutting");
  api.provide("salvage", "1.0.0", {
    // Cutters and what they work on.
    isCutterType: (typeID) => lib("cuttingLaserCatalog").isCutterType(typeID),
    // Every cutter type: the three tech 1 cutters and the module family's.
    cutterTypes: () => lib("salvageModuleFamily").variants().filter((v) => v.kind === "cutter").map((v) => v.typeID),
    salvagerTypes: () => lib("salvageModuleFamily").variants().filter((v) => v.kind === "salvager").map((v) => v.typeID),
    // { typeID, family, kind, tier, name, profile | shares } of a family module, or null.
    moduleVariant: (typeID) => lib("salvageModuleFamily").variantOf(typeID),
    isCutterModule: (moduleItem) => cutting().isCutterModule(moduleItem),
    cuttableRecordOf: (entity) => cutting().cuttableRecordOf(entity),
    hullCutHP: (record) => cutting().hullCutHP(record),
    hullLeftShare: (record) => cutting().hullLeftShare(record),
    // Hull panels and how much room they take.
    isPanelEntity: (entity) => cutting().isPanelEntity(entity),
    panelVolume: (entity) => cutting().panelVolume(entity),
    // Alloys.
    alloyTypeIDs: () => [...lib("cuttingLaserCatalog").ALLOY_TYPE_IDS],
    // { mineralTypeID: units } a ship's hull holds, or null for a type that is not a ship.
    hullMinerals: (sourceTypeID) => {
      const type = api.require("services/inventory/itemTypeRegistry").resolveItemByTypeID(toInt(sourceTypeID));
      return type && Number(type.categoryID) === 6 ? lib("npcAlloyLoot").hullMinerals(toInt(sourceTypeID)) : null;
    },
    // The alloys a share of those minerals forms: [{ typeID, quantity }]. scale(mineralTypeID)
    // is the share of each mineral kept (a cutter's reach), 1 when left out.
    hullAlloys: (minerals, share, random, scale) => lib("npcAlloyLoot").hullAlloys(minerals, share, random, scale),
    // The Salvage Hold.
    salvageHoldAccepts: (typeID) => lib("salvageHoldRouting").holdAccepts(typeID),
    salvageHoldFree: (characterID, shipItem) => lib("salvageHoldRouting").holdFree(characterID, shipItem),
    // The GM surface: wrecks, cut, salvage, debris, respawn.
    gm: (body, context) => cutting().gm(body, context),
  });
}

// ---------------------------------------------------------------------------

function patches(api) {
  if (hasLocalBuild(api)) {
    api.log.warn("this build already has wreck cutting in its own files (services/salvage); the mod stays idle");
    return;
  }
  if (!editsInPlace(api)) {
    api.log.warn("salvagerRuntime.js has no Reverie hook points; enable the mod through the launcher or `cli.js enable reverie-salvage` so its file edits go in. Cutters and loot still work, plain wreck salvage stays CCP's");
  }
  patchCutters(api);
  patchLoot(api);
  patchWrecks(api);
  patchHolds(api);
  hookSalvager(api);
  provideService(api);
}

function init(api) {
  if (hasLocalBuild(api)) return;
  if (!lib("cutHelpers").available()) {
    api.log.warn("miningRuntime.js has no reverieInternals; cutters cannot run until the mod's file edits are in");
  }
}

function dispose() {
  // Nothing held: patches, hooks and the service are let go by the core.
}

module.exports = { patches, init, dispose, _testing: { cargoFullText, hasLocalBuild } };
