# Vendored files

`login_delivery.cjs` is an unmodified copy of the EveJS Launcher's shared login delivery runtime, taken from `src/core/client/login_delivery.cjs` in EveJS Launcher v1.0.94 (sha-256 `82b7bbe8b43121c8f407aeb3eb576dd730fb40d1720028ac26717ad0cf3a21c5`).

The launcher's documentation asks mods that deliver Python at login to carry this file byte for byte rather than write their own. Every copy shares one runtime through `globalThis[Symbol.for("evejs.loginDelivery.v1")]`, so Reverie and the launcher's own shared menu deliver through the same runtime. `lib/loginScripts.js` loads this file, and a test checks its hash.

The EveJS Launcher is released under the GNU General Public License version 3, and this file is covered by that license.
