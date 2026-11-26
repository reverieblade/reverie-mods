
  const baseDefinitions = Array.isArray(payload.blueprintDefinitions)
    ? payload.blueprintDefinitions.map((entry) => cloneValue(entry))
    : [];
  // Reverie hook point (reverie-core): mods' composed type layer adds its
  // blueprints and edits the recipes it changes.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const hookedDefinitions = reverieHooks
    ? reverieHooks.run("data.blueprintDefinitions", baseDefinitions, { payload })
    : baseDefinitions;
  const definitions = Array.isArray(hookedDefinitions) ? hookedDefinitions : baseDefinitions;
