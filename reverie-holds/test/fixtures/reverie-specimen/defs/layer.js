"use strict";

// The test mod's type layer: one attribute and two modules of its own, and what it hands
// Reverie's Holds and Bays (GUIDE.md). It does everything a modder would do for a bay of their
// own, and a few things wrong on purpose so the test can see Holds skip them.

const SPECIMEN_ATTRIBUTE = 7960;
const LOCKER = 994700;   // sizes the Specimen Bay through SPECIMEN_ATTRIBUTE
const SCANNER = 994701;  // carries an Ammo Hold, one of EVE's bays, through moduleBays
const RIFTER = 587;
const CLONE_SOURCE = 1317; // Expanded Cargohold I
const CARGO_EFFECT_ID = 59;
const MESSAGE = 9796000;

function dogmaOf(ctx, typeID, typeName, changes) {
  const base = ctx.typeDogma(CLONE_SOURCE);
  if (!base) throw new Error(`type ${CLONE_SOURCE} has no typeDogma record`);
  const attributes = { ...(base.attributes || {}), ...changes };
  const effects = (base.effects || []).map(Number).filter((id) => id !== CARGO_EFFECT_ID);
  return { typeID, typeName, attributeCount: Object.keys(attributes).length, effectCount: effects.length, attributes, effects };
}

function build(ctx) {
  const source = ctx.itemType(CLONE_SOURCE);
  if (!source) throw new Error(`type ${CLONE_SOURCE} is not in itemTypes`);
  const template = ctx.attributeType(38);
  const messages = {
    [MESSAGE]: "Specimen Bay Capacity",
    [MESSAGE + 1]: "The room this module adds to the Specimen Bay.",
    [MESSAGE + 10]: "Specimen Locker I",
    [MESSAGE + 11]: "Adds a Specimen Bay to the ship, or enlarges the one it has.",
    [MESSAGE + 12]: "Sample Scanner I",
    [MESSAGE + 13]: "Carries a small Ammo Hold for its sample charges.",
  };
  const moduleType = (typeID, name, nameID, changes) => ({
    typeID,
    cloneFrom: CLONE_SOURCE,
    client: { typeNameID: nameID, descriptionID: nameID + 1, published: true },
    row: { ...source, typeID, name, published: true },
    dogma: dogmaOf(ctx, typeID, name, changes),
  });
  return {
    attributes: [{
      attributeID: SPECIMEN_ATTRIBUTE, cloneFrom: 38, nameMessageID: MESSAGE, tooltipMessageID: MESSAGE + 1,
      server: {
        attributeID: SPECIMEN_ATTRIBUTE, attributeName: "specimenBayCapacityAdded", name: "specimenBayCapacityAdded",
        description: messages[MESSAGE + 1], iconID: template && template.iconID != null ? template.iconID : null, defaultValue: 0,
        published: true, displayName: messages[MESSAGE], unitID: 9, stackable: true, highIsGood: true,
        categoryID: (template && template.categoryID) || 0, dataType: 4, displayWhenZero: false,
        maxAttributeID: null, minAttributeID: null, chargeRechargeTimeID: null,
      },
    }],
    types: [
      moduleType(LOCKER, messages[MESSAGE + 10], MESSAGE + 10, { [SPECIMEN_ATTRIBUTE]: 300 }),
      moduleType(SCANNER, messages[MESSAGE + 12], MESSAGE + 12, {}),
    ],
    messages,
    contributes: {
      "reverie-holds": {
        clientBays: [
          { flag: 200, invType: "ShipSpecimenBay", name: "Specimen Bay", openLabel: "Open Specimen Bay", allowGroups: [18] },
          // Wrong on purpose: one of CCP's flags, and one of CCP's bay types.
          { flag: 150, invType: "ShipWrongFlagBay", name: "Wrong Flag Bay" },
          { flag: 201, invType: "ShipCargo", name: "Wrong Type Bay" },
        ],
        shipBays: [{ bay: "specimen", sizes: { [RIFTER]: 100 } }],
        moduleBays: [
          { typeID: SCANNER, bay: "ammo", m3: 250 },
          // Wrong on purpose: no such bay kind.
          { typeID: SCANNER, bay: "nonsense", m3: 5 },
        ],
      },
    },
  };
}

module.exports = { build, SPECIMEN_ATTRIBUTE, LOCKER, SCANNER };
