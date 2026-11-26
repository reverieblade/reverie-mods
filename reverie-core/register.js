"use strict";

// Every Reverie mod's loader.js is one line:
//   require("../reverie-core/register")(__dirname);
// Registration order is load order, which the launcher (or the core, without it) has resolved.

const { getCore } = require("./lib/core");

module.exports = function register(dir) {
  const core = getCore();
  return core ? core.register(dir) : null;
};
