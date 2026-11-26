
  // Reverie hook point (reverie-salvage): a mod may set a wreck's access
  // difficulty itself, as for a hull panel, whose type is a reused CCP wreck
  // type with an accessDifficulty that is not the panel's own.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const hookedBase = reverieHooks
    ? reverieHooks.run("salvage.accessDifficultyBase", null, targetEntity, itemRecord, nativeWreckRecord, {
      small: DEFAULT_SMALL_WRECK_ACCESS_CHANCE,
      medium: DEFAULT_MEDIUM_WRECK_ACCESS_CHANCE,
      large: DEFAULT_LARGE_WRECK_ACCESS_CHANCE,
    })
    : null;
  if (Number.isFinite(Number(hookedBase)) && hookedBase !== null) {
    return Number(hookedBase);
  }
  const typeID = toPositiveInt(
    (itemRecord && itemRecord.typeID) ||
      (nativeWreckRecord && nativeWreckRecord.typeID) ||
      (targetEntity && targetEntity.typeID),
    0,
  );
  if (typeID > 0) {
    const typeAttrs = getTypeAttributeMap(typeID);
    const directAccessDifficulty = toFiniteNumber(typeAttrs[ATTRIBUTE_ACCESS_DIFFICULTY], NaN);
    if (Number.isFinite(directAccessDifficulty)) {
      return directAccessDifficulty;
    }
  }

  const source = getWreckSourceText(targetEntity, itemRecord, nativeWreckRecord);
  if (/\b(sleeper|drifter)\b/.test(source)) {
    return DEFAULT_SLEEPER_WRECK_ACCESS_CHANCE;
  }
  if (/\b(advanced|officer|commander|elite|tech ii|t2|abyssal|triglavian)\b/.test(source)) {
    return DEFAULT_ADVANCED_WRECK_ACCESS_CHANCE;
  }
  switch (resolveEntitySize(targetEntity, itemRecord, nativeWreckRecord)) {
    case "capital":
    case "large":
      return DEFAULT_LARGE_WRECK_ACCESS_CHANCE;
    case "medium":
      return DEFAULT_MEDIUM_WRECK_ACCESS_CHANCE;
    case "small":
    default:
      return DEFAULT_SMALL_WRECK_ACCESS_CHANCE;
  }
}

function calculateSalvageChancePercent(accessBasePercent, accessBonusPercent) {
  // Reverie hook point (reverie-salvage): percentage points a mod adds to
  // every salvage attempt.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const hookedBonus = reverieHooks
    ? toFiniteNumber(reverieHooks.run("salvage.chanceBonus", 0, accessBasePercent, accessBonusPercent), 0)
    : 0;
  return Math.max(
    0,
    Math.min(
      100,
      roundNumber(
        toFiniteNumber(accessBasePercent, 0) + toFiniteNumber(accessBonusPercent, 0) + hookedBonus,
        6,
      ),
    ),
  );
}

