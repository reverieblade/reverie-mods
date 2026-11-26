# Reverie mods for EveJS

These are the Reverie mods for the EveJS server emulator. You install them with the EveJS Launcher, which also offers you their updates. Each mod is its own folder here and its own download on the releases page.

| Mod | Version | What it does |
| --- | --- | --- |
| [Reverie Core](reverie-core) | 0.3.0 | The framework every Reverie mod runs on. It gives every mod one shared patch layer applied in load order, combines the new item types and client data from all installed mods, catches mods that claim the same IDs or edit the same thing, and reloads code and settings without a restart. |
| [Reverie Client Data](reverie-client) | 0.1.1 | Writes the new items, names, icons and blueprints of your installed Reverie mods into your EVE client, and puts the client's own files back when you disable or remove it. |
| [Reverie's Holds and Bays](reverie-holds) | 0.1.1 | Adds new modules which let you add and expand special cargo holds on any ship, and create fits that wouldn't be practical in normal EVE. It has 126 bay extensions for seven of EVE's own bays in T1, meta and T2, with blueprints on the market, and a bay a module gives works like one the hull came with. See its [README](reverie-holds/README.md). |
| [Reverie's Salvage and Reclamation](reverie-salvage) | 0.3.0 | Lets you cut wrecks apart with hull cutters into panels of alloys, which a salvager takes apart into your hold. It adds a full set of T1, meta and T2 cutters and salvagers, puts salvage gear in the NPC loot pools, stocks the T1 blueprints on the market, and has its own settings in the launcher's Configure form. With Holds and Bays installed, every salvager carries a Salvage Hold of its own. See its [README](reverie-salvage/README.md). |

## Installing

You need EveJS 261115.1 and EveJS Launcher 1.0.74 or later.

1. Download the ZIPs from the [releases page](../../releases). Each mod has its own release, tagged with the mod's name and version, for example `reverie-salvage-v0.2.1`.
2. Close the EVE client. In the launcher, open **Mods**, choose **Add ZIP** and add them in this order: Reverie Core, then Reverie Client Data, then Reverie's Holds and Bays, then Reverie's Salvage and Reclamation. You can leave out either of the last two.
3. Enable them and choose **Apply & Restart**.

The launcher will not warn you if Reverie Client Data is missing, but the new modules stay switched off without it. Once the mods are installed, **Check mod updates** in the launcher finds newer releases here.

### If you downloaded before 26 November 2026

This repository moved from the GitHub account KevinBomer to reverieblade. The launcher only takes updates from the place a mod says it came from, so Reverie Core 0.2.3 or older, Reverie Client Data 0.1.0 and Reverie's Salvage and Reclamation 0.2.0 or older will never be offered an update. Add the current ZIP of each mod once with **Add ZIP**, the same way you installed it, and the launcher finds every later update by itself.

## For mod authors

Each folder is the mod exactly as it ships, except that the release ZIPs leave out Reverie Core's `test` folder. Reverie Core's loader ships as `loader.js.disabled`, because the launcher turns a loader mod on by renaming it.

The tests run offline against a clean EveJS tree:

```
node reverie-core/test/run.js
node reverie-salvage/test/run.js "<a clean EveJS 261115.1 folder>"
node reverie-holds/test/run.js "<a clean EveJS 261115.1 folder>"
```

The Holds test also runs a partner test with Salvage when both folders sit side by side.

Set `REVERIE_LOCAL_DIR` to a scratch folder when you run them, so they don't write into a real install's `_local/reverie`.

## Reviews

If you've played with the mods, good or bad, please leave a review in [Discussions](../../discussions). Reviews tell me what to fix and what to build next.

## License

The mods are released under the GNU Affero General Public License version 3, the same license as EveJS, whose code they patch. `reverie-core/vendor/login_delivery.cjs` is an unmodified copy from the EveJS Launcher and stays under the launcher's GNU General Public License version 3.

EVE Online and its assets belong to CCP Games. These are fan-made mods and are not made or endorsed by CCP Games.
