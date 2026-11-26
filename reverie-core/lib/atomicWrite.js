"use strict";

// Writes a file through a temporary beside it and a rename, so a reader never sees half a file.
// On Windows a rename over a file that was written a moment ago can fail with EPERM, EBUSY or
// EACCES while an antivirus scanner or the search indexer still holds it open, so the rename is
// tried again for up to about two seconds before the error is passed on.

const fs = require("fs");
const path = require("path");

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function pause(ms) { Atomics.wait(sleeper, 0, 0, ms); }

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(from, to); return; } catch (error) {
      if (!RETRY_CODES.has(error.code) || attempt >= 20) {
        try { fs.rmSync(from, { force: true }); } catch (_) { /* the temporary is left for the next run */ }
        throw error;
      }
      pause(25 + attempt * 5);
    }
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.reverie-tmp`;
  fs.writeFileSync(temp, data);
  renameWithRetry(temp, file);
}

module.exports = { writeAtomic, renameWithRetry };
