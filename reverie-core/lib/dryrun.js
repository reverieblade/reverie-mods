"use strict";

// Reads what each mod would patch, without the game. Each mod's patches(api) runs against a host
// that only records, so `reverie check` can say before a start that two mods replace the same
// export, or that a target file or export name does not exist. A mod's server/index.js must do
// nothing at load beyond defining its functions for this to be safe, which is the rule anyway.

const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const { createModApi } = require("./api");

function exportNameInText(text, exportPath) {
  if (exportPath === "*") return true;
  const last = exportPath.split(".").pop();
  return new RegExp(`\\b${last.replace(/[$]/g, "\\$")}\\b`).test(text);
}

// mods: catalog records in load order. Returns { errors, notes, declarations }.
function readDeclarations(mods) {
  const errors = [];
  const notes = [];
  const declarations = [];
  const replacements = new Map(); // "file#export" -> mod id
  const provided = new Map(); // service name -> mod id
  const textCache = new Map();
  mods.forEach((mod, index) => {
    const entry = path.join(mod.dir, "server", "index.js");
    if (!fs.existsSync(entry)) return;
    const record = { id: mod.id, version: mod.version, dir: mod.dir, index };
    const host = {
      role: "check",
      version: "check",
      log: { info() {}, warn() {}, error() {} },
      hooks: { on: (modID, modIndex, name) => { declarations.push({ mod: mod.id, hook: name }); return () => {}; }, off() {}, run: (n, v) => v, emit() {} },
      isModActive: (id) => mods.some((other) => other.id.toLowerCase() === String(id).toLowerCase()),
      listMods: () => mods.map((other) => ({ id: other.id, version: other.version, state: "check" })),
      // Services are usually provided in init(), which a check never runs; those given in
      // patches() are recorded so that two providers of one name show up here.
      services: {
        provide(modID, name, version) {
          declarations.push({ mod: mod.id, provides: `${name} ${version}` });
          if (provided.has(name) && provided.get(name) !== mod.id) errors.push(`service ${name} is provided by both ${provided.get(name)} and ${mod.id}`);
          else provided.set(name, mod.id);
          return () => {};
        },
        use: () => null,
        when: (modID, name) => { declarations.push({ mod: mod.id, uses: name }); return () => {}; },
      },
      addPatch(rec, target, exportPath, spec) {
        let file;
        try { file = paths.resolveTarget(target); } catch (error) { errors.push(`${mod.id}: ${error.message}`); return false; }
        const label = `${path.relative(paths.srcRoot, file).split(path.sep).join("/").replace(/\.js$/, "")}#${exportPath}`;
        const kind = typeof spec.replace === "function" ? "replace" : "patch";
        declarations.push({ mod: mod.id, target: label, kind });
        if (!fs.existsSync(file)) { errors.push(`${mod.id}: ${kind} target ${label}: the file does not exist`); return false; }
        if (!textCache.has(file)) textCache.set(file, fs.readFileSync(file, "utf8"));
        if (!exportNameInText(textCache.get(file), String(exportPath))) notes.push(`${mod.id}: ${label}: that name does not appear in the file`);
        if (kind === "replace") {
          const key = paths.normalize(file) + "#" + exportPath;
          if (replacements.has(key) && replacements.get(key) !== mod.id) {
            errors.push(`${label} is replaced by both ${replacements.get(key)} and ${mod.id}; only one mod may replace an export (use prefix or postfix)`);
          } else replacements.set(key, mod.id);
        }
        return true;
      },
    };
    try {
      const loaded = require(entry);
      if (typeof loaded.patches === "function") loaded.patches(createModApi(host, record));
    } catch (error) {
      errors.push(`${mod.id}: patches() failed: ${error.message}`);
    }
  });
  return { errors, notes, declarations };
}

module.exports = { readDeclarations };
