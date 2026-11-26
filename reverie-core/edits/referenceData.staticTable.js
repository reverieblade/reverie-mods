
    payload = normalizeTypeDogmaPayload(payload);
  }

  // Reverie hook point (reverie-core): mods' composed type layer adds its
  // types, dogma and attributes to the static tables as they load.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  return reverieHooks ? reverieHooks.run("data.staticTable", payload, { tableName }) : payload;
}

