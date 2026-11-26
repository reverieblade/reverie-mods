"use strict";

// Reverie Salvage's type layer (reverie-core/client/compose.js): everything the
// mod changes in the game's type data, for the client patch and the server
// alike, built from the same tables the server code uses
// (server/lib/cuttingLaserCatalog.js and salvageModuleFamily.js).
//
//   group       Hull Cutter (990050), a copy of Mining Laser
//   attributes  the cutting numbers (7900-7904) shown on a cutter's Attributes tab
//   typeEdits   the three tech 1 cutters (CCP's unpublished mining lasers: name,
//               icon, group, market, cutting numbers in place of the mining ones),
//               Salvager I and II (their place on the meta ladder), the twelve
//               hull alloys (volume), the four hull panels (unused wreck types:
//               name and debris model) and the cutters' three blueprints (CCP's
//               unpublished mining laser blueprints)
//   types       the module family's new cutters and salvagers and their blueprints
//   blueprints  the family blueprints' recipes; blueprintEdits the cutters' own
//   icons       six cutter icons over CCP icon IDs no type uses
//   messages    names and descriptions in 9_710_000-9_710_999
//   clientData  what client/scripts/salvage.py needs: the panels' models, every
//               cutter type and the cutter group
//   marketStock the six tech 1 blueprints, sold wherever the market sells
//               Salvager I Blueprint (reverie-core/lib/marketStock.js)
//
// Message IDs (two per item, the description one after the name):
//   9_710_000            the Hull Cutter group
//   9_710_010 + i        attribute names, 9_710_020 + i their tooltips
//   9_710_040 + 2i       the three tech 1 cutters
//   9_710_060 + 2i       the four panels
//   9_710_080 + 2i       the three cutter blueprints
//   9_710_100 + 2n       family types, n = typeID - 992_000
//   9_710_400 + 2n       family blueprints, n = typeID - 992_500

const path = require("path");

const lib = (name) => require(path.join(__dirname, "..", "server", "lib", name));

const MESSAGE = Object.freeze({
  group: 9_710_000,
  attributeName: 9_710_010,
  attributeTooltip: 9_710_020,
  cutter: 9_710_040,
  panel: 9_710_060,
  cutterBlueprint: 9_710_080,
  familyType: 9_710_100,
  familyBlueprint: 9_710_400,
});

const CUTTER_MARKET_GROUP_ID = 1715; // Salvagers, Salvager I's market group
const SALVAGER_BLUEPRINT_TYPE_ID = 25862; // the family blueprints' template
const WRECK_GROUP_ID = 186;
const BLUEPRINT_CATEGORY_ID = 9;
const MODULE_CATEGORY_ID = 7;

// The cutters' icons take over icon IDs no CCP type, group, market group,
// attribute or effect uses, each with its own 64 px file in client/assets.
const ICONS = Object.freeze({
  careful: { iconID: 1063, resource: "res:/ui/texture/icons/5_64_16.png", file: "client/assets/cutter_careful.png" },
  precision: { iconID: 1665, resource: "res:/ui/texture/icons/5_64_6.png", file: "client/assets/cutter_precision.png" },
  breaker: { iconID: 1036, resource: "res:/ui/texture/icons/2_64_6.png", file: "client/assets/cutter_breaker.png" },
  torch: { iconID: 1459, resource: "res:/ui/texture/icons/25_64_5.png", file: "client/assets/cutter_torch.png" },
  reclaimer: { iconID: 1460, resource: "res:/ui/texture/icons/25_64_6.png", file: "client/assets/cutter_reclaimer.png" },
  breacher: { iconID: 1461, resource: "res:/ui/texture/icons/25_64_7.png", file: "client/assets/cutter_breacher.png" },
});

const clone = (value) => JSON.parse(JSON.stringify(value));

// A server dogma record with the variant's attributes on top (null removes one).
function dogmaWith(base, typeID, typeName, changes) {
  const attributes = { ...(base.attributes || {}) };
  for (const [id, value] of Object.entries(changes || {})) {
    if (value === null) delete attributes[id];
    else attributes[id] = value;
  }
  const effects = [...(base.effects || [])].map(Number);
  return { typeID, typeName, attributeCount: Object.keys(attributes).length, effectCount: effects.length, attributes, effects };
}

const splitChanges = (changes) => ({
  setAttributes: Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== null)),
  removeAttributes: Object.entries(changes).filter(([, v]) => v === null).map(([id]) => Number(id)),
});

const skillsOf = (pairs) => Object.fromEntries(pairs.map(([skillTypeID, level]) => [String(skillTypeID), level]));

// A tier's place on the meta ladder, as types.fsdbinary has it. A tech 1 has no
// parent, so the field is left out (null) rather than set to 0.
const ladderFields = (variant) => ({
  metaGroupID: variant.metaGroupID,
  metaLevel: variant.metaLevel,
  techLevel: variant.techLevel,
  variationParentTypeID: variant.variationParentTypeID || null,
});

function build(ctx) {
  const catalog = lib("cuttingLaserCatalog");
  const family = lib("salvageModuleFamily");
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

  // ---------------------------------------------------------------- group and attributes
  const cutterGroup = family.CUTTER_GROUP;
  messages[String(MESSAGE.group)] = cutterGroup.name;
  const groups = [{
    groupID: cutterGroup.groupID, cloneFrom: cutterGroup.templateGroupID, name: cutterGroup.name,
    nameMessageID: MESSAGE.group, categoryID: cutterGroup.categoryID,
  }];
  const attributes = family.CUTTER_ATTRIBUTES.map((def, index) => {
    const template = ctx.attributeType(def.templateID);
    if (!template) throw new Error(`cutter attribute ${def.attributeID} has no template attribute ${def.templateID}`);
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

  const typeEdits = [];
  const types = [];
  const blueprints = [];
  const blueprintEdits = [];
  const iconOfKind = (kind) => (kind ? ICONS[kind] : null);

  // ---------------------------------------------------------------- the family on the ladder
  // Existing types (the three cutters, Salvager I and II) are edited; every
  // other variant is a new type copied from its family's tech 1.
  const cutterIDs = Object.keys(catalog.CUTTER_TYPES).map(Number).sort((a, b) => a - b);
  const salvagerPrice = Number(rowOf(family.CLONE_SOURCE.salvager).basePrice) || 0;
  const t1Price = new Map();
  for (const variant of family.variants()) {
    // CCP's old mining lasers have no basePrice; a cutter then starts from Salvager I's.
    if (variant.tier === "t1") t1Price.set(variant.family, Number(rowOf(variant.cloneFrom).basePrice) || salvagerPrice);
  }
  const iconByType = new Map();
  for (const variant of family.variants()) {
    const icon = iconOfKind(variant.icon);
    if (variant.existing) {
      const edit = {
        typeID: variant.typeID,
        client: ladderFields(variant),
        row: {},
        dogma: splitChanges(variant.attributes),
      };
      const cutter = catalog.CUTTER_TYPES[variant.typeID];
      if (cutter) {
        // A tech 1 cutter: CCP's unpublished mining laser, renamed and put on the market.
        const index = cutterIDs.indexOf(variant.typeID);
        Object.assign(edit.client, named(MESSAGE.cutter + index * 2, cutter.name, cutter.description), {
          iconID: icon.iconID, marketGroupID: CUTTER_MARKET_GROUP_ID, published: true, groupID: cutterGroup.groupID,
          basePrice: t1Price.get(variant.family),
        });
        edit.row = {
          name: cutter.name, published: true, marketGroupID: CUTTER_MARKET_GROUP_ID, iconID: icon.iconID,
          groupID: cutterGroup.groupID, groupName: cutterGroup.name, basePrice: t1Price.get(variant.family),
        };
        iconByType.set(variant.typeID, icon.iconID);
      }
      typeEdits.push(edit);
      continue;
    }
    const source = rowOf(variant.cloneFrom);
    const iconID = icon ? icon.iconID : Number(source.iconID) || 0;
    iconByType.set(variant.typeID, iconID);
    const basePrice = Math.round(t1Price.get(variant.family) * variant.priceFactor);
    // Cutters move to the cutter group; salvagers stay in their source's.
    const groupID = variant.groupID || Number(source.groupID);
    const groupName = variant.groupID ? cutterGroup.name : source.groupName;
    types.push({
      typeID: variant.typeID,
      cloneFrom: variant.cloneFrom,
      client: {
        ...named(MESSAGE.familyType + (variant.typeID - family.FIRST_TYPE_ID) * 2, variant.name, variant.description),
        iconID, published: true, marketGroupID: CUTTER_MARKET_GROUP_ID, groupID, basePrice, ...ladderFields(variant),
      },
      row: {
        ...source, typeID: variant.typeID, name: variant.name, published: true, marketGroupID: CUTTER_MARKET_GROUP_ID,
        iconID, basePrice, groupID, groupName,
      },
      dogma: dogmaWith(dogmaOf(variant.cloneFrom), variant.typeID, variant.name, variant.attributes),
      skills: skillsOf(variant.skills),
    });
  }

  // ---------------------------------------------------------------- alloys and panels
  for (const typeID of [...catalog.ALLOY_TYPE_IDS].sort((a, b) => a - b)) {
    const row = rowOf(typeID);
    const minerals = ctx.materials(typeID).map((material) => {
      const mineral = rowOf(material.materialTypeID);
      return { quantity: Number(material.quantity), volume: Number(mineral.volume) };
    });
    if (!minerals.length) throw new Error(`alloy ${typeID} (${row.name}) refines into nothing`);
    const volume = catalog.alloyVolumeFromMinerals(minerals);
    typeEdits.push({ typeID, client: { volume }, row: { volume } });
  }
  const panelIDs = Object.keys(catalog.PANEL_TYPES).map(Number).sort((a, b) => a - b);
  const clientPanels = {};
  panelIDs.forEach((typeID, index) => {
    const row = rowOf(typeID);
    if (Number(row.groupID) !== WRECK_GROUP_ID) throw new Error(`panel type ${typeID} (${row.name}) is not a wreck`);
    const panel = catalog.PANEL_TYPES[typeID];
    const text = catalog.PANEL_TEXT[panel.kind];
    typeEdits.push({
      typeID,
      client: { ...named(MESSAGE.panel + index * 2, text.name, text.description), graphicID: panel.graphicID },
      row: { name: text.name, graphicID: panel.graphicID },
    });
    clientPanels[String(typeID)] = [panel.graphicID, panel.modelRadius];
  });

  // ---------------------------------------------------------------- the cutters' own blueprints
  const inventions = family.originalBlueprintInventions(catalog.CUTTER_BLUEPRINTS);
  const cutterBlueprintIDs = Object.keys(catalog.CUTTER_BLUEPRINTS).map(Number).sort((a, b) => a - b);
  const salvagerBlueprintPrice = Number(rowOf(SALVAGER_BLUEPRINT_TYPE_ID).basePrice) || 0;
  // Every tech 1 blueprint is sold where the market sells Salvager I Blueprint, so each cutter
  // can be built from the start; tech 2 ones come only from invention.
  const marketStock = [];
  cutterBlueprintIDs.forEach((typeID, index) => {
    const row = rowOf(typeID);
    if (Number(row.categoryID) !== BLUEPRINT_CATEGORY_ID) throw new Error(`type ${typeID} (${row.name}) is not a blueprint`);
    if (!ctx.blueprint(typeID)) throw new Error(`blueprint ${typeID} has no definition`);
    const blueprint = catalog.CUTTER_BLUEPRINTS[typeID];
    const product = catalog.CUTTER_TYPES[blueprint.productTypeID];
    const iconID = iconByType.get(blueprint.productTypeID);
    const description = `This blueprint is used to manufacture the ${product.name}. ${product.description.split("\n")[0]}`;
    const basePrice = Math.round(salvagerBlueprintPrice * (blueprint.priceFactor || 1));
    typeEdits.push({
      typeID,
      client: {
        ...named(MESSAGE.cutterBlueprint + index * 2, blueprint.name, description),
        iconID, marketGroupID: catalog.CUTTER_BLUEPRINT_MARKET_GROUP_ID, published: true, basePrice,
      },
      row: { name: blueprint.name, published: true, marketGroupID: catalog.CUTTER_BLUEPRINT_MARKET_GROUP_ID, iconID, basePrice },
    });
    marketStock.push({ typeID, like: SALVAGER_BLUEPRINT_TYPE_ID, basePrice });
    const invention = inventions[typeID];
    blueprintEdits.push({
      blueprintTypeID: typeID,
      activities: {
        manufacturing: catalog.cutterBlueprintManufacturing(typeID),
        invention: invention ? family.inventionActivity(invention) : null,
      },
      definition: {
        blueprintName: blueprint.name, productTypeID: blueprint.productTypeID, productName: product.name,
        productGroupID: cutterGroup.groupID, productGroupName: cutterGroup.name, productCategoryID: MODULE_CATEGORY_ID,
        published: true,
      },
    });
  });

  // ---------------------------------------------------------------- the family's blueprints
  const template = rowOf(SALVAGER_BLUEPRINT_TYPE_ID);
  const templateDefinition = ctx.blueprint(SALVAGER_BLUEPRINT_TYPE_ID);
  if (!templateDefinition) throw new Error(`blueprint ${SALVAGER_BLUEPRINT_TYPE_ID} has no definition`);
  const templateDogma = ctx.typeDogma(SALVAGER_BLUEPRINT_TYPE_ID);
  for (const blueprint of family.blueprints()) {
    const product = family.variantOf(blueprint.productTypeID);
    const iconID = iconByType.get(blueprint.productTypeID) || Number(template.iconID) || 0;
    const basePrice = Math.round((Number(template.basePrice) || 0) * (blueprint.techLevel === 2 ? 10 : 1.5));
    const description = `This blueprint is used to manufacture the ${product.name}. ${product.description.split("\n")[0]}`;
    const marketGroupID = catalog.CUTTER_BLUEPRINT_MARKET_GROUP_ID;
    types.push({
      typeID: blueprint.typeID,
      cloneFrom: SALVAGER_BLUEPRINT_TYPE_ID,
      client: {
        ...named(MESSAGE.familyBlueprint + (blueprint.typeID - family.FIRST_BLUEPRINT_TYPE_ID) * 2, blueprint.name, description),
        iconID, published: true, marketGroupID, basePrice, techLevel: blueprint.techLevel, metaGroupID: blueprint.metaGroupID,
      },
      row: { ...template, typeID: blueprint.typeID, name: blueprint.name, published: true, marketGroupID, iconID, basePrice },
      dogma: templateDogma ? dogmaWith(templateDogma, blueprint.typeID, blueprint.name, {}) : null,
      skills: {},
    });
    if (blueprint.techLevel === 1) marketStock.push({ typeID: blueprint.typeID, like: SALVAGER_BLUEPRINT_TYPE_ID, basePrice });
    const activities = clone(templateDefinition.activities || {});
    delete activities.invention;
    activities.manufacturing = family.manufacturingActivity(blueprint);
    if (blueprint.invention) activities.invention = family.inventionActivity(blueprint.invention);
    blueprints.push({
      blueprintTypeID: blueprint.typeID,
      cloneFrom: SALVAGER_BLUEPRINT_TYPE_ID,
      definition: {
        ...clone(templateDefinition),
        blueprintTypeID: blueprint.typeID, blueprintName: blueprint.name,
        productTypeID: blueprint.productTypeID, productName: product.name,
        productGroupID: cutterGroup.groupID, productGroupName: cutterGroup.name, productCategoryID: MODULE_CATEGORY_ID,
        published: true, activities,
      },
      client: { activities, maxProductionLimit: templateDefinition.maxProductionLimit },
    });
  }

  return {
    groups,
    attributes,
    types,
    typeEdits,
    blueprints,
    blueprintEdits,
    messages,
    icons: Object.values(ICONS).map((icon) => ({ ...icon })),
    marketStock,
    clientData: {
      panels: clientPanels,
      cutters: family.variants().filter((variant) => variant.kind === "cutter").map((variant) => variant.typeID),
      cutterGroup: cutterGroup.groupID,
    },
  };
}

module.exports = { build, MESSAGE, ICONS };
