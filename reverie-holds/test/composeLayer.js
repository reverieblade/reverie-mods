"use strict";

// Runs inside the test install (test/run.js) after a mod is added to it: composes the type layer
// again from every installed mod and saves it, as a client patch would, so the next server
// process starts with that mod's types and contributions in the layer.

const assert = require("assert");
const path = require("path");

const core = globalThis[Symbol.for("reverie.core")];
const compose = require(path.join(core.paths.modsDir, "reverie-core", "client", "compose"));

try {
  const { layer, errors } = compose.compose();
  assert.deepStrictEqual(errors, []);
  compose.save(layer);
  console.log(`ok    the type layer was composed again from ${layer.mods.map((mod) => mod.id).join(", ")}`);
  process.exit(0);
} catch (error) {
  console.log(`FAIL  the type layer was not composed\n      ${String(error && error.stack || error).split("\n").join("\n      ")}`);
  process.exit(1);
}
