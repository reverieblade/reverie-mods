
  const emptyChance =
    size === "small"
      ? 0.22
      : size === "medium"
        ? 0.14
        : size === "large"
          ? 0.08
          : 0.02;
  // Reverie hook points (reverie-salvage): a mod may change how often a wreck
  // salvages empty and add to what a salvager recovers. An empty wreck still
  // passes through salvage.rewardEntries, with no rolls, since its hull is
  // still there.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const rewardContext = {
    targetEntity,
    itemRecord,
    nativeWreckRecord,
    size,
    faction,
    options,
    empty: false,
    random: () => getRandom(randomCallbacks),
    computeGrantVolume,
  };
  const hookedEntries = (entries) => {
    const out = reverieHooks ? reverieHooks.run("salvage.rewardEntries", entries, rewardContext) : entries;
    return Array.isArray(out) ? out : entries;
  };
  const emptyFactor = reverieHooks
    ? Math.max(0, toFiniteNumber(reverieHooks.run("salvage.emptyFactor", 1, rewardContext), 1))
    : 1;
  if (getRandom(randomCallbacks) < emptyChance * emptyFactor) {
    rewardContext.empty = true;
    return mergeGrantEntries(hookedEntries([]));
  }

  const rollCount =
    size === "capital"
      ? 4 + Math.floor(getRandom(randomCallbacks) * 5)
      : size === "large"
        ? 1 + Math.floor(getRandom(randomCallbacks) * 3)
        : size === "medium"
          ? 1 + Math.floor(getRandom(randomCallbacks) * 2)
          : 1;
  const grantEntries = [];
  for (let index = 0; index < rollCount; index += 1) {
    const selected = chooseWeighted(pool, randomCallbacks);
    if (!selected) {
      continue;
    }
    const quantity =
      size === "capital"
        ? 2 + Math.floor(getRandom(randomCallbacks) * 4)
        : size === "large"
          ? 1 + Math.floor(getRandom(randomCallbacks) * 3)
          : size === "medium"
            ? 1 + Math.floor(getRandom(randomCallbacks) * 2)
            : 1;
    grantEntries.push({
      itemType: selected.typeID,
      quantity,
    });
  }
  return mergeGrantEntries(hookedEntries(grantEntries));
}

