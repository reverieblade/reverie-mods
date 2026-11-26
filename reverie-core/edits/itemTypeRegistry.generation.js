
  // Reverie hook point (reverie-core): the composed type layer can change the
  // item types while the server runs, and a new generation drops this index so
  // the next lookup builds it again from the reshaped table.
  const reverieGeneration = globalThis[Symbol.for("reverie.typeLayer.generation")] || 0;
  if (cachedRegistry && loadRegistry.reverieGeneration !== reverieGeneration) {
    cachedRegistry = null;
    cachedShipTypeIDs = null;
  }
  loadRegistry.reverieGeneration = reverieGeneration;
  if (cachedRegistry) {
    return cachedRegistry;
  }

  const dbRegistry = loadDbRegistry();
  if (dbRegistry) {
    cachedRegistry = dbRegistry;
    return cachedRegistry;
  }

  cachedRegistry = buildFallbackRegistry();
  return cachedRegistry;
}

