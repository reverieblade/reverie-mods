"use strict";

// The test mod's server side: a Specimen Bay on flag 200 through the holds service, sized by the
// hull (the layer's shipBays) and by every online Specimen Locker in a low slot, taking minerals
// and Metal Scraps and nothing else, exclusive so what it takes never falls through to cargo.
// It listens on holds.changed and keeps what it heard where test/framework.js can read it.

const SPECIMEN_FLAG = 200;
const SPECIMEN_ATTRIBUTE = 7960;
const MINERAL_GROUP = 18;
const METAL_SCRAPS = 15331;
const HEARD = Symbol.for("reverie-specimen.heard");

function patches(api) {
  globalThis[HEARD] = globalThis[HEARD] || [];
  api.hooks.on("holds.changed", (detail) => { globalThis[HEARD].push(detail || null); });
  api.when("holds", "1.1", (holds) => {
    holds.addBay({
      mod: api.id,
      key: "specimen",
      flag: SPECIMEN_FLAG,
      name: "Specimen Bay",
      size: { moduleAttribute: SPECIMEN_ATTRIBUTE, slots: "low" },
      accepts: { groups: [MINERAL_GROUP], test: (type) => Number(type.typeID) === METAL_SCRAPS },
      refusal: "The Specimen Bay only takes minerals and scrap.",
      exclusive: true,
    });
    return () => holds.removeBays(api.id);
  });
}

module.exports = { patches };
