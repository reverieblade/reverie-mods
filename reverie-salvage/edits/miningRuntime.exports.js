
  // Reverie hook point (reverie-salvage): what mods whose modules run on
  // mining laser frames (hull cutters) need from this file.
  reverieInternals: () => ({
    buildEntityMiningSnapshot,
    getTargetsForEntity,
    getMiningCommandSurfaceDistance,
    resolveDestinationFlagForPlayer,
    resolveEntityCharacterID,
    syncMinedOreChangesToSession,
    getPlayerShipStorageSnapshot,
  }),
