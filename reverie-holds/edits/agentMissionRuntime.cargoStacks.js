
  const items = listContainerItems(characterID, locationID, flagID)
    .filter((item) => normalizePositiveInteger(item && item.typeID, 0) === normalizePositiveInteger(typeID, 0));
  // Reverie hook point (reverie-holds): a delivery or courier check that looks
  // in a ship's cargo hold also counts the bays the item could have been put in
  // (ore in the Mining Hold, minerals in the Mineral Hold), in the order the
  // holds service pulls from them. A handler returns the whole list of stacks;
  // each keeps its own flagID, so the delivery takes it from where it lies.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const hooked = reverieHooks
    ? reverieHooks.run("holds.deliveryStacks", null, characterID, locationID, flagID, typeID, items)
    : null;
  return Array.isArray(hooked) ? hooked : items;
}

