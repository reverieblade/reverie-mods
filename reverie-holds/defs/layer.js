"use strict";

// Reverie Holds and Bays' type layer (reverie-core/client/compose.js): the bay
// extensions and their blueprints, for the client patch and the server alike,
// built from server/lib/bayFamily.js.
//
//   group         Bay Extension (990051), a copy of Expanded Cargohold
//   attributes    Bay Capacity Added and Bonus, Drone Bandwidth Added (7910-7912)
//   effects       one online effect per bay (13900-13906) and the drone bay's (13907)
//   marketGroups  "Bay Extensions" under Hull Upgrades and under Hull & Armor
//                 blueprints, with a group per bay in each (990100-990117)
//   types         126 extensions copied from Expanded Cargohold I, 42 blueprints
//                 copied from its blueprint
//   blueprints    their recipes (tech 1 from minerals, tech 2 invented)
//   icons         a 64 px icon per bay over icon IDs only ancestries use
//   messages      names and descriptions in 9_711_000-9_711_999
//   marketStock   the 21 tech 1 blueprints, sold wherever Expanded Cargohold I
//                 Blueprint is sold
//   clientData    what client/scripts/holds.py needs: the bays, their flags and
//                 the effects that put each one on a ship
//
// after(ctx) answers the mods that contribute to this one (GUIDE.md, "Which
// modules carry it" and "Which ships get it"):
//
//   contributes: { "reverie-holds": {
//     moduleBays: [{ typeID, bay, m3, mbit? }],      bay: a kind key or "drone"
//     shipBays:   [{ bay, sizes: { typeID: m3 }, groups: { groupID: m3 }, all: m3 }],
//   } }
//
// A module bay puts the two bay attributes and the bay's effect on that module.
// A ship bay sets the hull's own capacity attribute, never lowering one it has.
// A ship bay for a bay that a mod adds with holds.addBay has no attribute in
// the game's data, so its sizes go to clientData.shipBays, which the server's
// bay table reads.
//
// Message IDs (two per item, the description one after the name):
//   9_711_000            the Bay Extension group
//   9_711_010 + i        attribute names, 9_711_020 + i their tooltips
//   9_711_040 + 2i       the market groups, in bayFamily.marketGroups() order
//   9_711_100 + 2n       extensions, n = typeID - 993_000
//   9_711_400 + 2n       blueprints, n = typeID - 993_500

const fs = require("fs");
const path = require("path");

const family = require(path.join(__dirname, "..", "server", "lib", "bayFamily"));

const MOD_ID = "reverie-holds";
const MESSAGE = Object.freeze({
  group: 9_711_000,
  attributeName: 9_711_010,
  attributeTooltip: 9_711_020,
  marketGroup: 9_711_040,
  type: 9_711_100,
  blueprint: 9_711_400,
});
const MODULE_CATEGORY_ID = 7;
const BLUEPRINT_CATEGORY_ID = 9;
const SHIP_CATEGORY_ID = 6;
const CAPSULE_GROUP_ID = 29;
const DRONE_BANDWIDTH = 1271;

const clone = (value) => JSON.parse(JSON.stringify(value));

// A server dogma record with the variant's attributes on top (null removes one)
// and its effects swapped.
function dogmaWith(base, typeID, typeName, changes, addEffects = [], removeEffects = []) {
  const attributes = { ...(base.attributes || {}) };
  for (const [id, value] of Object.entries(changes || {})) {
    if (value === null) delete attributes[id];
    else attributes[id] = value;
  }
  const removed = new Set(removeEffects.map(Number));
  const effects = (base.effects || []).map(Number).filter((id) => !removed.has(id));
  for (const id of addEffects.map(Number)) if (!effects.includes(id)) effects.push(id);
  return { typeID, typeName, attributeCount: Object.keys(attributes).length, effectCount: effects.length, attributes, effects };
}

const skillsOf = (pairs) => Object.fromEntries(pairs.map(([skillTypeID, level]) => [String(skillTypeID), level]));

// A tier's place on the meta ladder, as types.fsdbinary has it. A tech 1 has no
// parent, so the field is left out (null) rather than set to 0.
const ladderFields = (variant) => ({
  metaGroupID: variant.metaGroupID,
  metaLevel: variant.metaLevel,
  techLevel: variant.techLevel,
  variationParentTypeID: variant.variationParentTypeID || null,
});

// The player's saved settings (the launcher's Configure form). The layer is
// composed when the client is brought up to date, so a change here applies at
// the next game launch.
function preferences() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "preferences.json"), "utf8").replace(/^﻿/, ""));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function build(ctx) {
  const rowOf = (typeID) => {
    const row = ctx.itemType(typeID);
    if (!row) throw new Error(`type ${typeID} is not in itemTypes`);
    return row;
  };
  const dogmaOf = (typeID) => {
    const record = ctx.typeDogma(typeID);
    if (!record) throw new Error(`type ${typeID} has no typeDogma record`);
    return record;
  };
  const messages = {};
  const named = (id, name, description) => {
    messages[String(id)] = name;
    if (description) messages[String(id + 1)] = description;
    return { typeNameID: id, ...(description ? { descriptionID: id + 1 } : {}) };
  };

  // ---------------------------------------------------------------- group, attributes, effects
  messages[String(MESSAGE.group)] = family.GROUP.name;
  const groups = [{
    groupID: family.GROUP.groupID, cloneFrom: family.GROUP.templateGroupID, name: family.GROUP.name,
    nameMessageID: MESSAGE.group, categoryID: family.GROUP.categoryID,
  }];
  const attributes = family.ATTRIBUTES.map((def, index) => {
    const template = ctx.attributeType(def.templateID);
    if (!template) throw new Error(`bay attribute ${def.attributeID} has no template attribute ${def.templateID}`);
    const nameMessageID = MESSAGE.attributeName + index;
    const tooltipMessageID = MESSAGE.attributeTooltip + index;
    messages[String(nameMessageID)] = def.displayText;
    messages[String(tooltipMessageID)] = def.tooltip;
    return {
      attributeID: def.attributeID, cloneFrom: def.templateID, nameMessageID, tooltipMessageID,
      server: {
        attributeID: def.attributeID, attributeName: def.name, name: def.name, description: def.tooltip,
        iconID: template.iconID == null ? null : template.iconID, defaultValue: 0, published: true,
        displayName: def.displayText, unitID: def.unitID, stackable: true, highIsGood: def.highIsGood,
        categoryID: template.categoryID || 0, dataType: 4, displayWhenZero: false,
        maxAttributeID: null, minAttributeID: null, chargeRechargeTimeID: null,
      },
    };
  });
  const effects = Object.values(family.effects()).map((server) => ({ effectID: server.effectID, server }));

  // ---------------------------------------------------------------- market groups
  const marketGroups = family.marketGroups().map((mg, index) => {
    const nameMessageID = MESSAGE.marketGroup + index * 2;
    messages[String(nameMessageID)] = mg.name;
    messages[String(nameMessageID + 1)] = mg.description;
    return {
      marketGroupID: mg.marketGroupID, cloneFrom: mg.templateMarketGroupID, parentGroupID: mg.parentGroupID,
      nameMessageID, descriptionMessageID: nameMessageID + 1, iconID: mg.iconID, hasTypes: mg.hasTypes,
    };
  });

  // ---------------------------------------------------------------- the extensions
  const source = rowOf(family.CLONE_SOURCE);
  const sourceDogma = dogmaOf(family.CLONE_SOURCE);
  const types = [];
  for (const variant of family.variants()) {
    const iconID = variant.icon.iconID;
    types.push({
      typeID: variant.typeID,
      cloneFrom: variant.cloneFrom,
      client: {
        ...named(MESSAGE.type + (variant.typeID - family.FIRST_TYPE_ID) * 2, variant.name, variant.description),
        iconID, published: true, marketGroupID: variant.marketGroupID, groupID: variant.groupID,
        basePrice: variant.basePrice, ...ladderFields(variant),
      },
      row: {
        ...source, typeID: variant.typeID, name: variant.name, published: true, marketGroupID: variant.marketGroupID,
        iconID, basePrice: variant.basePrice, groupID: variant.groupID, groupName: family.GROUP.name,
      },
      dogma: dogmaWith(sourceDogma, variant.typeID, variant.name, variant.attributes, variant.addEffects, variant.removeEffects),
      skills: skillsOf(variant.skills),
    });
  }

  // ---------------------------------------------------------------- the blueprints
  const template = rowOf(family.CLONE_BLUEPRINT);
  if (Number(template.categoryID) !== BLUEPRINT_CATEGORY_ID) throw new Error(`type ${family.CLONE_BLUEPRINT} is not a blueprint`);
  const templateDefinition = ctx.blueprint(family.CLONE_BLUEPRINT);
  if (!templateDefinition) throw new Error(`blueprint ${family.CLONE_BLUEPRINT} has no definition`);
  const templateDogma = ctx.typeDogma(family.CLONE_BLUEPRINT);
  const blueprints = [];
  const marketStock = [];
  for (const blueprint of family.blueprints()) {
    const product = family.variantOf(blueprint.productTypeID);
    const size = family.SIZES.find((candidate) => candidate.key === product.size);
    const basePrice = Math.round((Number(template.basePrice) || 0) * size.buildScale * (blueprint.techLevel === 2 ? 10 : 1));
    const iconID = blueprint.icon.iconID;
    const description = `This blueprint is used to manufacture the ${product.name}. ${product.description.split("\n")[0]}`;
    types.push({
      typeID: blueprint.typeID,
      cloneFrom: family.CLONE_BLUEPRINT,
      client: {
        ...named(MESSAGE.blueprint + (blueprint.typeID - family.FIRST_BLUEPRINT_TYPE_ID) * 2, blueprint.name, description),
        iconID, published: true, marketGroupID: blueprint.marketGroupID, basePrice,
        techLevel: blueprint.techLevel, metaGroupID: blueprint.metaGroupID,
      },
      row: { ...template, typeID: blueprint.typeID, name: blueprint.name, published: true, marketGroupID: blueprint.marketGroupID, iconID, basePrice },
      dogma: templateDogma ? dogmaWith(templateDogma, blueprint.typeID, blueprint.name, {}) : null,
      skills: {},
    });
    if (blueprint.techLevel === 1) marketStock.push({ typeID: blueprint.typeID, like: family.CLONE_BLUEPRINT, basePrice });
    const activities = clone(templateDefinition.activities || {});
    delete activities.invention;
    activities.manufacturing = family.manufacturingActivity(blueprint);
    if (blueprint.invention) activities.invention = family.inventionActivity(blueprint.invention);
    blueprints.push({
      blueprintTypeID: blueprint.typeID,
      cloneFrom: family.CLONE_BLUEPRINT,
      definition: {
        ...clone(templateDefinition),
        blueprintTypeID: blueprint.typeID, blueprintName: blueprint.name,
        productTypeID: blueprint.productTypeID, productName: product.name,
        productGroupID: family.GROUP.groupID, productGroupName: family.GROUP.name, productCategoryID: MODULE_CATEGORY_ID,
        published: true, activities,
      },
      client: { activities, maxProductionLimit: templateDefinition.maxProductionLimit },
    });
  }

  return {
    groups,
    attributes,
    effects,
    marketGroups,
    types,
    blueprints,
    messages,
    icons: Object.values(family.ICONS).map((icon) => ({ ...icon })),
    marketStock: preferences().blueprintsOnMarket === false ? [] : marketStock,
    clientData: {
      bays: family.KINDS.map((kind) => ({ key: kind.key, name: kind.name, flag: kind.flag, attributeID: kind.attributeID, effectID: family.effectIDOf(kind) }))
        .concat([{ key: "drone", name: "Drone Bay", flag: family.DRONE_BAY_FLAG, attributeID: 283, effectID: family.DRONE_BAY_EFFECT_ID }]),
      bayAttribute: family.ATTR.bayAdded,
      extensionGroup: family.GROUP.groupID,
      moduleBays: {},
      shipBays: {},
      // The bay meters' settings (evejs-launcher.mod.json, restart "client").
      meters: meterSettings(preferences()),
    },
  };
}

function meterSettings(prefs) {
  const whole = (value, low, high, fallback) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
  };
  return {
    show: prefs.meters !== false,
    perRow: whole(prefs.metersPerRow, 1, 12, 6),
    most: whole(prefs.metersMost, 1, 24, 12),
  };
}

// ---------------------------------------------------------------- what partner mods contribute

function bayOf(key) {
  if (key === "drone") return { key: "drone", attributeID: 283, effectID: family.DRONE_BAY_EFFECT_ID };
  const kind = family.kindOf(key);
  return kind ? { key: kind.key, attributeID: kind.attributeID, effectID: family.effectIDOf(kind) } : null;
}

const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

function after(ctx) {
  const prefs = preferences();
  const typeEdits = [];
  const moduleBays = {};
  const shipBays = {};
  const errors = [];
  const knownType = (typeID) => Boolean(ctx.itemType(typeID)) ||
    ctx.layers.types.some((type) => Number(type.typeID) === Number(typeID));
  const rowOf = (typeID) => {
    const own = ctx.layers.types.find((type) => Number(type.typeID) === Number(typeID));
    return (own && own.row) || ctx.itemType(typeID);
  };
  const dogmaOf = (typeID) => {
    const own = ctx.layers.types.find((type) => Number(type.typeID) === Number(typeID));
    return (own && own.dogma) || ctx.typeDogma(typeID) || { attributes: {} };
  };

  for (const contribution of ctx.contributions()) {
    const data = contribution.data || {};
    // Module bays: the bay's attributes and effect on the partner's module.
    if (prefs.partnerModuleBays !== false) {
      for (const entry of Array.isArray(data.moduleBays) ? data.moduleBays : []) {
        const typeID = Number(entry && entry.typeID);
        const bay = bayOf(entry && entry.bay);
        if (!bay || !positive(entry.m3) || !knownType(typeID)) {
          errors.push(`${contribution.mod}: module bay ${JSON.stringify(entry)} names no known type, bay kind or size`);
          continue;
        }
        const setAttributes = { [family.ATTR.bayAdded]: Number(entry.m3), [family.ATTR.bayBonus]: 0 };
        if (bay.key === "drone") setAttributes[family.ATTR.bandwidthAdded] = positive(entry.mbit) ? Number(entry.mbit) : 0;
        typeEdits.push({ typeID, dogma: { setAttributes, addEffects: [bay.effectID] } });
        moduleBays[String(typeID)] = { bay: bay.key, m3: Number(entry.m3), mod: contribution.mod };
      }
    }
    // Ship bays: a bay of a set size on the hulls the partner chooses.
    for (const entry of Array.isArray(data.shipBays) ? data.shipBays : []) {
      const key = String(entry && entry.bay || "");
      if (!key) continue;
      const bay = bayOf(key);
      const sizes = new Map();
      const all = positive(entry.all) ? Number(entry.all) : 0;
      const groups = entry.groups && typeof entry.groups === "object" ? entry.groups : {};
      const hulls = entry.sizes && typeof entry.sizes === "object" ? entry.sizes : {};
      if (all || Object.keys(groups).length) {
        for (const row of ctx.itemTypes()) {
          if (Number(row.categoryID) !== SHIP_CATEGORY_ID || !row.published) continue;
          // `all` leaves capsules out, as the client's bay list does (holds.py
          // CAPSULE_GROUP_ID); a mod that wants them names group 29.
          const named = positive(groups[String(row.groupID)]);
          if (!named && Number(row.groupID) === CAPSULE_GROUP_ID) continue;
          const size = named ? Number(groups[String(row.groupID)]) : all;
          if (size) sizes.set(Number(row.typeID), size);
        }
      }
      for (const [typeID, size] of Object.entries(hulls)) if (positive(size)) sizes.set(Number(typeID), Number(size));
      if (!bay) {
        // A bay a mod adds itself: the server's bay table reads the sizes.
        shipBays[key] = { ...(shipBays[key] || {}), ...Object.fromEntries([...sizes].map(([id, size]) => [String(id), size])) };
        continue;
      }
      for (const [typeID, size] of sizes) {
        const row = rowOf(typeID);
        if (!row || Number(row.categoryID) !== SHIP_CATEGORY_ID) {
          errors.push(`${contribution.mod}: ship bay ${key} names ${typeID}, which is not a ship`);
          continue;
        }
        const have = Number((dogmaOf(typeID).attributes || {})[String(bay.attributeID)]) || 0;
        if (have >= size) continue;
        const setAttributes = { [bay.attributeID]: size };
        if (bay.key === "drone" && positive(entry.mbit)) {
          const bandwidth = Number((dogmaOf(typeID).attributes || {})[String(DRONE_BANDWIDTH)]) || 0;
          if (bandwidth < Number(entry.mbit)) setAttributes[DRONE_BANDWIDTH] = Number(entry.mbit);
        }
        typeEdits.push({ typeID, dogma: { setAttributes } });
      }
    }
  }
  // A bad entry is skipped, not fatal, so one partner's mistake never costs the
  // other partners their bays. The server logs these at start (server/index.js).
  return { typeEdits, clientData: { moduleBays, shipBays, customBays: clientBays(ctx, errors), problems: errors } };
}

// Bays a partner adds on a flag the client does not know (GUIDE.md, "The
// client"): client/scripts/holds.py gives each one a bay type of its own.
//   contributes: { "reverie-holds": { clientBays: [{ flag, invType, name,
//     icon?, openLabel?, everyShip?, allowCategories?, allowGroups?, allowTypes? }] } }
// The flags CCP uses for holds run below 192, so a mod's bay takes one above.
const CLIENT_BAY_FLAGS = Object.freeze([192, 255]);
// invType names the client classes, so it must be a plain identifier and must
// not be one of CCP's. The common ones are refused here; holds.py also leaves
// alone any class it did not make itself.
const CCP_INV_TYPES = new Set(["ShipCargo", "ShipDroneBay", "ShipFighterBay", "ShipFuelBay", "ShipGeneralMiningHold", "ShipGasHold",
  "ShipIceHold", "ShipAsteroidHold", "ShipMineralHold", "ShipSalvageHold", "ShipAmmoHold", "ShipPlanetaryCommoditiesHold",
  "ShipExpeditionHold", "ShipMaintenanceBay", "ShipFleetHangar", "ShipMobileDepotHold", "ShipCorpseHold", "ShipBoosterHold",
  "ShipSubsystemHold", "ShipFrigateEscapeBay", "ShipInfrastructureHold", "ShipQuafeHold", "ShipCommandCenterHold",
  "ShipShipHold", "ShipSmallShipHold", "ShipMediumShipHold", "ShipLargeShipHold", "ShipIndustrialShipHold", "ShipMaterialBay",
  "StationItems", "StationShips", "StationCorpHangar", "StationCorpDeliveries", "StationContainer", "ItemFloatingCargo"]);

function clientBays(ctx, errors) {
  const out = [];
  const taken = new Map();
  const ids = (list) => (Array.isArray(list) ? list.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);
  for (const contribution of ctx.contributions()) {
    const data = contribution.data || {};
    for (const entry of Array.isArray(data.clientBays) ? data.clientBays : []) {
      const flag = Number(entry && entry.flag);
      const invType = String(entry && entry.invType || "");
      const name = String(entry && entry.name || "").trim();
      const problem = !Number.isInteger(flag) || flag < CLIENT_BAY_FLAGS[0] || flag > CLIENT_BAY_FLAGS[1]
        ? `a flag from ${CLIENT_BAY_FLAGS[0]} to ${CLIENT_BAY_FLAGS[1]}`
        : !/^[A-Za-z][A-Za-z0-9_]{2,48}$/.test(invType) || CCP_INV_TYPES.has(invType) ? "an invType of its own"
          : !name ? "a name"
            : taken.has(flag) ? `a flag ${taken.get(flag)} has not taken`
              : out.some((bay) => bay.invType === invType) ? "an invType no other bay uses" : null;
      if (problem) {
        errors.push(`${contribution.mod}: client bay ${JSON.stringify(entry)} needs ${problem}`);
        continue;
      }
      taken.set(flag, contribution.mod);
      out.push({
        flag, invType, name, mod: contribution.mod,
        icon: typeof entry.icon === "string" && entry.icon ? entry.icon : null,
        openLabel: typeof entry.openLabel === "string" && entry.openLabel ? entry.openLabel : null,
        everyShip: entry.everyShip === true,
        allowCategories: ids(entry.allowCategories),
        allowGroups: ids(entry.allowGroups),
        allowTypes: ids(entry.allowTypes),
      });
    }
  }
  return out;
}

module.exports = { build, after, MESSAGE, MOD_ID };
