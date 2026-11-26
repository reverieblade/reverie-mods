
  const groupName = normalizeLowerText(itemType.groupName);
  const categoryID = toPositiveInt(itemType.categoryID, 0);

  // Reverie hook point (reverie-salvage): a mod may place an item type of its
  // own in a selector kind ("module", "utility", "ammo" and so on) that the
  // group lists below do not name, such as the hull cutters and salvagers in
  // the module pools. true or false decides; anything else leaves it to the
  // rules below.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const hookedKind = reverieHooks ? reverieHooks.run("loot.selectorKind", null, itemType, kind, selector) : null;
  if (hookedKind === true || hookedKind === false) {
    return hookedKind;
  }

