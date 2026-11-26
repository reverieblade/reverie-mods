"use strict";

// Makes an empty game store for the test install (test/run.js): the game's own sqliteStore opens
// the file as an owner, which creates its schema, and closes it. The probe then opens it as a
// reader, as any process that does not own persistence would.
//
//   node seedStore.js <server/src> <gamestore.sqlite>

const path = require("path");

const [srcRoot, dbPath] = process.argv.slice(2);
const store = require(path.join(srcRoot, "gameStore", "sqliteStore.js"));
store.init(dbPath, { readOnly: false });
store.close();
