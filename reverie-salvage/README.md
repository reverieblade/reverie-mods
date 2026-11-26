# Reverie's Salvage and Reclamation

The mod's ID stays `reverie-salvage`, since the launcher, the type layer's claims and other mods all refer to it by that ID.

Salvage turns a wreck into something worth working, the way an asteroid is. A wreck's hull holds a fixed amount of metal as alloys. Cutters take the hull apart into panels and containers, salvagers take the panels apart into the hold, and the pilot's choice of cutter, skills and time decide how much metal comes home. The mod also gives every salvage tool a full EVE-style ladder of variants with blueprints and invention, and decides what salvage gear and alloys NPC wrecks carry.

This is the first mod built for Reverie's Module Manager. It is written as a design of record: each section says what the mod does and whether it is built today in the main tree. Version 0.1, with its server side, type layer and client script, is in this folder and runs on a clean EveJS 261115.1 (see [Version 0.1](#version-01) below). The rest waits on the extraction steps at the end.

The full numbers, balance passes and history stay in [doc/SALVAGE.md](../../doc/SALVAGE.md). This document is the mod's boundary: what it owns, what it leaves to other mods, and how it attaches to them.

## Version 0.1

Version 0.1 carries salvage to a clean EveJS, server and client together. Its type layer adds the tool family, the blueprints, the Hull Cutter group and attributes, names, descriptions and icons, and the Reverie Client Data package (`mods/reverie-client`) writes that layer into the player's EVE client with no Python needed. The in-game script comes to the client at login.

**What it does:**

- Wreck cutting with every cutter in the family, on native NPC wrecks and on inventory wrecks with their stand-in hulls. CCP's three unpublished cutting lasers, 5241, 5243 and 5235, become the T1 Hull Panel Cutter, Precision Hull Cutter and Wreck Breaker.
- The tool family: 46 cutters and the salvager ladder (see [The tool family](#the-tool-family)), with nine new blueprints, CCP's three unused mining laser blueprints taken over for the T1 cutters, and invention.
- The type layer in `defs/layer.js`: the new types, the edits to CCP's types, the blueprints and recipes, 157 names and descriptions, and six icons (see [In the client](#in-the-client)).
- The client script `client/scripts/salvage.py`, sent at login.
- Panels on four CCP debris types under the names Hull Plating and Core Section, sized by the metal they hold.
- Panel salvaging, chunk by chunk, at the salvager shares above.
- The salvaging extras: the chance bonus, the empty factor, and the scrap and extra part rolls by hull size (moved here from the main tree's `npcLootOverhaul.js` into `server/lib/salvageTables.js`).
- Alloys from the hull on every salvage, scaled by the hull left on the wreck, and the alloy rolls on scavenger and hauler cargo.
- Guns destroy NPC wrecks and panels.
- The Salvage Hold rules: it takes Metal Scraps and Reinforced Metal Scraps, salvage fills it before cargo, and Loot All in space sends what it takes there. These rules do nothing yet with this mod alone. The only type in CCP's data with a Salvage Hold (`specialSalvageHoldCapacity`) is the unpublished Cockroach, so no ship a player can fly has one until the holds mod gives the hold to the salvagers and to hulls (checked 2026-11-25). In the main tree the holds come from the Salvage Hold Extensions and the salvagers' own bays.
- The `salvage` service for other mods and bots (under [Provides](#provides)).
- Salvage gear in NPC loot (version 0.2). Cutters and salvagers join the module pools of EveJS's own loot tables and drop like any other module, from plain T1 and meta models off ordinary NPCs up to the Angel officer pieces (see [Loot tables](#loot-tables)).
- A Configure form in the EveJS Launcher (version 0.2) for twelve settings, which apply without a restart (see [Settings](#settings)).
- The six T1 cutter blueprints on sale wherever Salvager I Blueprint is sold, and every one of them researches, copies and invents its T2 blueprint (see [Blueprints and invention](#blueprints-and-invention)).

**What waits for later versions:**

- bot salvagers, which need the bot-jobs service;
- the salvagers' own holds and the Field Reclaimer's mineral hold, which belong to the holds mod.

**The client and the server stay in step.** The server turns the layer on only while the client was patched with exactly that layer: the core compares the layer's sha-256 with the one in the client patch ledger. Until then the server has none of the new types, the three cutters are CCP's unpublished lasers under CCP's names (they still cut, because they keep their mining amount), and panels are the plain small, medium and large wrecks. A server whose players patch their own clients from the same mods can turn the layer on with `REVERIE_TYPE_LAYER=server`.

**Putting it into a client.** The mod needs Reverie Client Data (`reverie-client`), so under the EveJS Launcher enable Reverie Core, then Reverie Client Data, then this mod. The manifest cannot say so in `requires`: when the launcher plans a game server start it counts only server mods, so a requirement on a client package is never met there and the server refuses to start. Without the client package the new items stay off on the server as well, because the type layer only turns on when the client's ledger matches. The client package's helper composes the layer and writes it into the client on install, writes it again when the set of mods changes, and puts the client's own files back on disable or removal. Without the launcher:

```
node mods/reverie-core/cli.js client apply      (or client status, client restore; --client <tq folder>, --dry-run)
```

Both need every EVE client closed. A running game server takes the new and changed types within a few seconds, because the apply writes `_local/reverie/reload.json` and the core's hook point in `itemTypeRegistry.js` rebuilds the type index when the layer changes.

**Files:**

| File | What it is |
|---|---|
| `server/index.js` | every patch, hook handler and the service, declared in one place |
| `server/lib/wreckCutting.js` | cutting, panels, panel salvaging, the GM actions |
| `server/lib/inventoryWreckCutting.js` | stand-in hulls for wrecks that are plain items |
| `server/lib/cuttingLaserCatalog.js` | cutter profiles, alloys, panel types |
| `server/lib/salvageModuleFamily.js` | the tool family: every variant's tier, stats, price, name and description, the blueprints and invention |
| `server/lib/npcAlloyLoot.js` | hull minerals, hull alloys, cargo alloy rolls |
| `server/lib/salvageTables.js` | the salvaging extras |
| `server/lib/salvageHoldRouting.js`, `salvageHoldLootRouting.js` | the Salvage Hold rules and the Loot All routing |
| `server/lib/cutHelpers.js` | what a cutter needs from the mining runtime |
| `server/lib/game.js` | game modules through the core, the tunables and the player's settings |
| `edits/*.js` | the text regions put into four game files (see [Game files it changes](#game-files-it-changes)) |
| `defs/layer.js` | the type layer, built from the family and the catalog |
| `client/scripts/salvage.py` | the in-game script |
| `client/assets/*.png` | the six cutter icons |
| `test/run.js`, `probe.js`, `seedStore.js` | the offline test |

**Tunables:** the mod reads each tunable from the game's live tunables when the game knows the name, then from the environment, then from the player's settings (`preferences.json` in the mod folder, see [Settings](#settings)), then from `_local/reverie-salvage/tunables.json`. Both files are read again when they change. The names are the ones in the table under GM tools and tunables, plus `EVEJS_SALVAGE_CHANCE_BONUS` (15), `EVEJS_SALVAGE_EMPTY_FACTOR` (0.35), `EVEJS_SALVAGE_SCRAP` (1) and `EVEJS_SALVAGE_HOLD_AUTO` (on).

### Settings

The manifest's `settings` block gives the mod a Configure button in the EveJS Launcher. The launcher writes what the player saves into `preferences.json` in the mod folder, and keeps that file through mod updates. `server/lib/game.js` maps each key to its tunable (`PREFERENCES`) and reads the file by mtime, so a saved setting applies at the next roll or cycle with no restart. Every field is marked `restart: none`.

| Group | Setting | Key | Tunable | Default |
|---|---|---|---|---|
| Loot | Cutters and salvagers in NPC loot | `gearInLoot` | `EVEJS_SALVAGE_GEAR_LOOT` | on |
| Loot | Alloys from wrecks | `alloysEnabled` | `EVEJS_NPC_ALLOY_LOOT` | on |
| Salvaging | Salvage success bonus (percentage points) | `salvageChanceBonus` | `EVEJS_SALVAGE_CHANCE_BONUS` | 15 |
| Salvaging | Empty wreck chance (% of base game) | `emptyWreckPct` | `EVEJS_SALVAGE_EMPTY_FACTOR` (÷ 100) | 35 |
| Salvaging | Metal scrap (multiplier) | `scrapAmount` | `EVEJS_SALVAGE_SCRAP` | 1 |
| Salvaging | Salvaged alloys (multiplier) | `salvageAlloyAmount` | `EVEJS_SALVAGE_ALLOYS` | 0 |
| Salvaging | Hull metal recovered by a salvager (%) | `hullRecoveryPct` | `EVEJS_SALVAGE_HULL_RECOVERY` (÷ 100) | 0 |
| Salvaging | Salvage Hold first | `salvageHoldFirst` | `EVEJS_SALVAGE_HOLD_AUTO` | on |
| Cutting | Hull metal a cutter can free (%) | `cutRecoveryPct` | `EVEJS_CUT_RECOVERY` (÷ 100) | 20 |
| Cutting | Cutting speed (multiplier) | `cutSpeed` | `EVEJS_CUT_SPEED` | 1 |
| Cutting, advanced | Salvage containers per cut wreck | `cutContainers` | `EVEJS_CUT_CONTAINERS` | 2 |
| Cutting, advanced | Cut wreck lifetime (minutes) | `cutWreckMinutes` | `EVEJS_CUT_WRECK_HOLD_MINUTES` | 30 |

The probe checks that every field has a tunable and that every default is the code's own.

**In this repository:** the main tree already has all of this in its own files (`services/salvage/`). The mod checks for those files when it loads, and if they are there it logs one line and stays idle, so it never cuts a wreck twice.

**Testing:** `node mods/reverie-salvage/test/run.js "<a clean EveJS root>"` builds a throwaway install in the temp folder. It copies that EveJS's `server/src` and a few static tables and links its `node_modules`, without changing the source install. It then:

- enables the core and the mod with the core's CLI;
- loads the patched game modules and checks each way in;
- composes the type layer and checks that the server's item types, dogma and blueprints take it, and that panels take the debris types only while the layer is on;
- follows one pilot from the blueprint market through research, invention, building, fitting, cutting, salvaging and refining (`workflow.js`);
- disables the mod and checks that the game files are back byte for byte.

On 2026-11-25 every check passed against a clean EveJS 261115.1 exported from the `upstream-261115.1` tag, including version 0.2.0's research and invention step, the gear in the loot pools (workflow step 8) and the settings. The demo install cannot serve as the clean tree once the launcher has put the core's regions into its files.

The client half was tested on a copy of the demo client's index and patched files, marked `EVEJS_TEST_CLIENT`, through the reverie-client helper the way the launcher calls it. Install wrote the layer, and reading the files back showed:
- the cutter names, group 990050, icons and market groups;
- dogma with the cutter attributes and no mining amount;
- recipes and invention in `blueprints.static`.

Verify found nothing to do, and a second install changed nothing. Restore put all three index files back byte for byte and removed the ledger, which turns the layer off on the server. A re-install gave the same bytes as the first.

None of it has been seen in a running client yet: the market tree, the info windows, the icons, a cutter's beam and a panel's model wait for a play test.

## What the mod does

### Wreck cutting

- **Every wreck can be cut.** NPC kills leave native wrecks that know their ship. Plain wreck items with no ship behind them (salvage contract fields, derelict fleets, mission wrecks, ship kills) get a stand-in hull, a T1 ship of the wreck's race and size read from the wreck type and the item's name. The stand-in and the cutting state live on the item (`customInfo.evejsWreckCut`), so they survive reloads and restarts.
- **Cutting HP grows with the hull.** A wreck's cutting HP is its hull's mineral volume against a destroyer's (1,010 m³ is 1,000 HP), raised to `EVEJS_CUT_HP_EXPONENT` (0.73 by default, so a Tempest is about 25,000 HP), and never below the wreck's own structure or the frigate and destroyer floors. It is fixed when the first cut lands.
- **Potential.** What a perfect cutter would keep is `EVEJS_CUT_RECOVERY` (0.2 by default) of the hull's minerals, as alloys, less any share already shot away. Each cutter reach gets its own potential on the wreck, rolled at the first cut.
- **Three bands.** Each cutter has a reach for plating minerals (Tritanium, Pyerite), middle minerals (Mexallon, Isogen, Nocxium) and core minerals (Zydrine, Megacyte, Morphite). Alloys form on the key minerals it freed.
- **What comes off.** As the HP falls, the wreck sheds panels (Hull Plating, or Core Section when rare-rich, named after the ship) and `EVEJS_CUT_CONTAINERS` cargo containers holding the wreck's other salvage. At 0 HP the wreck goes, and any cargo still in it goes into a loot container.
- **A wreck being cut stays** at least `EVEJS_CUT_WRECK_HOLD_MINUTES` after each cut.
- **Several cutters on one wreck** add their HP, and the alloys each cycle frees are kept at the rates of the cutter that made that cut.
- **Guns destroy wrecks as before**, and the hull lost to gunfire is metal lost.

Status: built and live, played in game 2026-11-15.

### Panels

- Panels are small wrecks that hold alloys. They use four CCP debris wreck types that nothing in CCP's data spawns: 75781 and 80246 for Hull Plating, 80247 and 90038 for Core Section.
- A panel's size follows its volume: small under 400 m³, medium under 4,000 m³, large above that, needing one, two or three salvager successes.
- The server gives each panel a ball radius of 0.9 × ∛volume, clamped to 6–40 m. The in-game script (`evejs_salvage.py` in the main tree, `client/scripts/salvage.py` in the mod) scales the debris model to that radius.
- Access difficulty follows the panel's size, not the reused type.

Status: built and seen in game. The panel types' info window still shows the old types' figures (see Open work).

### Salvaging

- A salvager on a panel takes it apart chunk by chunk. It keeps its share (Salvager II 95% common and 85% rare, Salvager I 85% and 70%, any other 75% and 50%, plus 2% for each Salvaging level) and fills the hold in whole units, rarest alloy first. What does not fit stays on the panel.
- A salvager straight on a wreck still gets the old roll, `EVEJS_SALVAGE_HULL_RECOVERY` of the hull, which is 0 by default (the development server plays at 0 too), so bare salvage gives parts, scrap and the size-based alloy roll, and the hull's metal waits for a cutter. At 0.25 a bare salvage would keep more of the middle metals than the Hull Panel Cutter and Salvager I together (0.6 × 0.45 × 0.85 ≈ 0.23). On a part-cut wreck it gets only the hull share and parts still on the wreck.
- The salvaging extras on every salvage success: the chance bonus, the empty factor and the extra scrap and salvage rolls by hull size (`SALVAGE_SCRAPS`, `salvageExtras`).

Status: built and live.

### The tool family

Every cutter and the salvager has a full ladder, with a Minmatar flavour: T1, four meta tiers, T2, a Thukker make, a Domination make, Gistum C to X deadspace models, named Angel officer pieces and a civilian model. Types are `992000 + family × 20 + tier`; CCP's own types (5241, 5243, 5235, 25861, 30836) keep their IDs and only get their place on the ladder.

| Family | Kind | T1 | T2 |
|---|---|---|---|
| Hull Panel Cutter | the careful cutter, most metal from each wreck | 5241 | 992005 |
| Precision Hull Cutter | keeps the core | 5243 | 992025 |
| Wreck Breaker | fast, keeps the plating, ruins half the parts | 5235 | 992045 |
| Plasma Hull Torch | the fastest, with heavy capacitor use | 992060 | 992065 |
| Field Reclaimer | no panels, minerals straight into the hold | 992080 | 992085 |
| Hold Breacher | the cargo whole in one container on the first cycle | 992100 | 992105 |
| Salvager | the panel salvager, with a salvage hold of its own on every tier when holds is installed | 25861 | 30836 |

The cutters sit in their own group, Hull Cutter (990050), with five attributes of their own in place of the mining ones: Hull Cut per Cycle (7900), Plating Metal Kept (7901), Core Metal Kept (7902), Salvage Parts Found (7903) and Middle Metal Kept (7904).

Status: built and installed in the client 2026-11-16, 59 of 59 variants live. The market tree, info windows and a cycle of the new variants have not been seen in game. In the mod since 2026-11-25 (`server/lib/salvageModuleFamily.js`, without the holds, which go to the holds mod).

### Blueprints and invention

- Three unused CCP mining laser blueprints are taken over for the T1 cutters: 28751, 22922 and 28749.
- Nine new blueprints from 992500: T1 for the three new kinds, and T2 for all six cutter families. The T2 recipes use the alloys salvage gives, so salvage feeds better salvage gear.
- Every T1 cutter blueprint, the three taken over and the three new, researches material and time efficiency, copies, and invents its T2 blueprint. Invention follows Miner I's: 34%, 10 runs, two Mechanical Engineering and two Laser Physics datacores, with Laser Physics, Mechanical Engineering and Minmatar Encryption Methods. The new blueprints take their research and copying times from Salvager I Blueprint.
- Meta, faction, deadspace and officer variants have no blueprint and come from loot.

Status: built and live; recipes written into the client 2026-11-16. The T1 blueprints are seeded at the Scarlet hub.

**On the market (v0.1, 2026-11-25).** The six T1 blueprints are sold wherever the server's market sells Salvager I Blueprint, in the same quantity, at that station's Salvager I Blueprint price times the ratio of base prices. Hull Panel Cutter I and Wreck Breaker I Blueprints cost what Salvager I Blueprint does (332,640 ISK base), Precision Hull Cutter I Blueprint 1.25 times that, and the three new kinds' blueprints 1.5 times. The base prices CCP left on the three taken-over blueprints belong to the mining lasers they were, so the layer replaces them. The layer lists the six as `marketStock`, and the core writes the stock (doc/REVERIE.md "Market stock"). The stock appears while this mod runs and the client has the layer, and it goes again when the mod is disabled. T2 blueprints come only from invention, and the cutters themselves come from building and loot.

### Loot tables

The mod owns every salvage-related roll on NPC wrecks:

- **Salvage gear** (hook `loot.selectorKind`, `EVEJS_SALVAGE_GEAR_LOOT`, in the mod since 0.2.0). There is no roll of the mod's own. EveJS's loot tables draw modules from pools that its selectors build (weapons, launchers, tank, capacitor and propulsion groups), and the mod's text region in `npcLoot.js` lets every family variant count as a module there, in every size band, since a cutter fits any hull. The tables' own rules then decide which models a table can give:
  - the low-tier pools of belt and mission NPCs take the T1 and meta models (23 types: the six T1 cutters, Salvager I and the four meta tiers of the four laddered families);
  - T2 never drops, as nothing T2 does from these tables;
  - Angel deadspace tables take the Domination makes (selector `Domination`) and the Gistum C to X models (selector `Gist`);
  - Angel officer tables take the officer pieces through their officers' names (Gotan, Hakim, Tobias and Mizuro);
  - belt commanders' faction pools and overseers' special pools take every special make, Thukker and Civilian included.

  Each model is one more entry in its pool, so it is exactly as likely as any other module there. With clean EveJS 261115.1's tables (workflow step 8 prints the pools), the gear is 23 of 132 types in the small module pool, 23 of 131 medium and 23 of 114 large, 4 of 68 Domination modules, 16 of 81 Gist modules and 4 of 54 Angel officer modules. Worked through the tables' empty chances, entry counts and selector weights, one given model drops from about 0.2% of belt frigate kills, and some piece of salvage gear from about 5% of belt frigates, 7% of belt cruisers and 12% of belt battleships, 2% of mission frigates, 4% of belt commanders, 8% of Angel deadspace NPCs and 15% of Angel officers (an officer piece). Only types the server knows can be in a pool, so with the type layer off the hook leaves every type to the tables' own rules and CCP's three mining lasers stay out. The setting clears npcLoot's pool cache when it changes, so turning it off or on takes effect at the next roll. In the main tree the loot overhaul's `rollSalvageGear` gives the gear instead, and the mod stays idle there.
- **Alloys in wreck cargo** (`npcAlloyLoot.rollAlloyDrops`, `EVEJS_NPC_ALLOY_LOOT`). Only scavenger-named ships and some haulers carry alloys, salvaged parts and scrap as cargo. A warship's wreck has none until it is cut or salvaged.
- **Hull alloys** (`npcAlloyLoot.hullMinerals`, `hullAlloys`, `salvageHullAlloys`). The metal a hull holds, which cutting and salvaging draw on.
- **Scrap** (`carriesSalvage`, `rollScrap`). Metal Scraps on the wrecks of ships that would carry them.
- **Salvaging extras** (`salvageChanceBonus`, `salvageEmptyFactor`, `salvageExtras`), described under Salvaging.

Status: built and live in the main tree since 2026-11-15, where these rolls are written into npc-loot's file, `npcLootOverhaul.js`. On a clean EveJS the gear joins the game's own loot pools (the `npcLoot.js` text region) and the cargo alloy roll is added to the game's own loot table (a postfix on `npcLoot.rollNpcLootEntries`). Once npc-loot provides a way to add rolls, the mod gives them to npc-loot instead (see Partners).

### Alloy volumes

Each alloy is 1.5 times the volume of the minerals it refines into, from 77.82 m³ for Plush Compound down to 0.03 m³ for Opulent Compound. This is a type edit on CCP's alloys (group 355).

Status: installed and seen in game.

### Bot salvagers

A share of non-combat pilots (`EVEJS_BOT_SALVAGER_SHARE`, picked by a personality trait so the same pilots salvage every time) buy a cutter and a salvager that fit their ship, cut the wrecks in their system, salvage the panels and bring the metal home for the sell job.

- A run starts when the pilot's system holds at least `EVEJS_BOT_SALVAGE_MIN_WRECKS` wrecks with no pirate within 100 km, no station mission and no other bot's claim, and the pilot can get gear it can fit and use, spending at most `EVEJS_BOT_SALVAGE_GEAR_SHARE` of its wallet.
- The run's stages are gear, fit, fly, return and restore. It stops at 45 minutes, a full hold or no wrecks left, and leaves the rest of a big wreck for whoever comes next.
- A salvage pilot keeps one cutter and one salvager in its hangar, and bot mining fits never take a cutter.

Status: built and live 2026-11-16. Today the bot code calls the salvage run by name in four places; in the mod it registers through the bot-jobs service (see [Bots](#bots)).

### In the client

- **Type layer** (`defs/layer.js`, built 2026-11-25). It holds:
  - the Hull Cutter group, cloned from Strip Miner;
  - the five cutter attributes, cloned from mining ones, with names and tooltips;
  - the three CCP cutters under their family names, published in the Salvage Tools market group, with the cutter attributes in place of the mining amount;
  - the ladder fields on Salvager I and II;
  - the 54 new variants and 9 new blueprints, each cloned from its CCP source;
  - the three taken-over blueprints with their new recipes and invention;
  - the alloy volumes;
  - the four panel types with their names and debris models.

  The core composes it with the other enabled mods' layers into `_local/reverie/typeLayer.json`. The core's type layer then applies it on the server, and the reverie-client package writes it into the client. Messages use the mod's block from 9,710,000.
- **Icons.** The six cutter icons, 64 by 64, on icon IDs 1063, 1665, 1036, 1459, 1460 and 1461, written over those icons' own files in the client by re-pointing their index lines.
- **Script** (`client/scripts/salvage.py`, delivered at login through the core). It does three things:
  - it scales each panel's debris model to the panel's ball radius;
  - it draws a cutter's beam without the mining rock effect;
  - it adds the cutter group to the client's turret groups, so cutters get a turret at all.

  It reads the panel models and the cutter types from `REVERIE_DATA`, which the layer fills, and does nothing to anything else.

### GM tools and tunables

GM (`gm_salvage`, `gm.js salvage action=...`): `wrecks`, `cut`, `salvage`, `debris`, `respawn`, `types`, `applyTypes`, and for bots `bots`, `botPlan`, `botRun`.

Live tunables:

| Tunable | What it sets |
|---|---|
| `EVEJS_CUT_RECOVERY` | the share of a hull's minerals a perfect cutter keeps |
| `EVEJS_CUT_SPEED` | multiplies every cutter's HP per cycle |
| `EVEJS_CUT_HP_EXPONENT` | how cutting HP grows with the hull |
| `EVEJS_CUT_PANEL_EXPONENT` | how the panel count grows with the hull |
| `EVEJS_CUT_CONTAINERS` | how many cargo containers come off a wreck |
| `EVEJS_CUT_WRECK_HOLD_MINUTES` | how long a cut keeps a wreck in space |
| `EVEJS_SALVAGE_HULL_RECOVERY` | the hull share a salvager gets straight off a wreck |
| `EVEJS_SALVAGE_ALLOYS` | whether direct salvage gives alloys |
| `EVEJS_SALVAGE_GEAR_LOOT` | whether salvage gear is in the NPC loot pools |
| `EVEJS_NPC_ALLOY_LOOT` | alloys in wreck cargo |
| `EVEJS_BOT_SALVAGER_SHARE` | the share of pilots who salvage |
| `EVEJS_BOT_SALVAGE_MIN_WRECKS` | wrecks needed before a bot starts a run |
| `EVEJS_BOT_SALVAGE_GEAR_SHARE` | the share of its wallet a bot spends on gear |

## What it leaves to other mods

| Feature | Where it lives |
|---|---|
| Refining alloys in space (the Field Reprocessor) | field-modules, which uses this mod's alloys |
| What stations bid for alloys (`EVEJS_STATION_ALLOY_BID_SHARE`) and station refining | station-economy |
| The Salvage Hold and its routing, the Salvage Hold Extensions, the bays that come with modules | holds and bay-extensions |
| The loot engine itself: luck, NPC tiers, hull fit filters, the order of rolls | npc-loot |
| Running bots: the director, operations, travel, market and fitting | the bot mod that provides bot-jobs |
| Agents in space selling salvage gear | space-agents |

## Partners

### Requires

| Mod | Why |
|---|---|
| reverie-core | the patch layer, hook points, services, and the type layer composer |

That is the only requirement. With nothing else installed, salvage still works: cutting, panels, salvaging, the tool family, blueprints, the alloy volumes and its own loot rolls, which it then adds to the game's own NPC loot table itself.

### Works with

Each partner adds features when it is installed and enabled, and the features go away cleanly when it is disabled, live. The mod attaches through `api.when(service, version, fn)`, so load order does not matter.

| Mod | Service | What it adds |
|---|---|---|
| holds | `holds` 1 | What a salvager takes and what is looted in space goes to the Salvage Hold first. Each salvager carries a salvage hold of its own, and each Field Reclaimer a mineral hold that its minerals fill first. Without holds, everything goes to the cargo hold. |
| npc-loot | `npc-loot` 1 | The salvage gear, alloy, scrap and salvaging rolls become rolls in npc-loot's table, so they follow its luck and NPC tiers and come after its own rolls in a fixed order. Without npc-loot, salvage adds its rolls to the game's own loot table. |
| bot economy | `bot-jobs` 1 | Bot salvagers. Without a bot mod, no bot salvages. |
| bay-extensions | `bays` 1 | Salvage Hold Extensions grow the hold the salvagers fill. Its loot roll for them is its own. |
| field-modules | `field-modules` 1 | The Field Reprocessor refines this mod's alloys in space. Salvage provides the alloy classes it reads. |
| space-agents | `space-agents` 1 | Space agents stock salvage gear by variant (`variantOf`). |

### Provides

Salvage provides the `salvage` 1 service for mods that read its data, and for a bot mod's salvage job. Another mod gets it with `api.when("salvage", "1", (salvage) => ...)`. These are the calls in v0.1.0:

| Call | Returns |
|---|---|
| `isCutterType(typeID)`, `cutterTypes()`, `isCutterModule(moduleItem)` | whether a type or a fitted module is a cutter, and the cutter types |
| `cuttableRecordOf(entity)` | the wreck record a cutter can work, for a wreck in space, or null |
| `hullCutHP(record)`, `hullLeftShare(record)` | a wreck's cutting HP, and the share of its hull still on it |
| `isPanelEntity(entity)`, `panelVolume(entity)` | whether a ball is a hull panel, and the m³ of alloys it holds |
| `alloyTypeIDs()` | the alloys salvage gives |
| `hullMinerals(typeID)` | the minerals in a ship type's hull, or null for a type that is not a ship |
| `hullAlloys(minerals, share, random, scale)` | the alloys a share of those minerals forms |
| `salvageHoldAccepts(typeID)`, `salvageHoldFree(characterID, shipItem)` | the Salvage Hold's rules and its free room |
| `salvagerTypes()` | the salvager types in the family |
| `moduleVariant(typeID)` | a family variant's place on the ladder (family, kind, tier, meta, shares and stats), or null |
| `gm(body, context)` | the GM actions `wrecks`, `cut`, `salvage`, `debris` and `respawn` |

`cutterTypes()` lists all 46 cutters in the family. The new types among them exist on the server only while the type layer is on.

Planned for later versions: `alloyBand(typeID)`, and `cuttableWrecks(systemID)` for the bot job.

## Game files it changes

The patch layer reaches most of what salvage needs by wrapping exports. Where one function calls another inside the same file, the mod puts a hook point into the file as a text region when it is enabled, and takes it out when it is disabled. These are the places in v0.1, with the way in for each:

| File | What salvage does there | Way in |
|---|---|---|
| `services/mining/miningRuntime.js` | hands a cutter's activation and cycles to wreck cutting | patches on `resolveMiningActivation` and `executeMiningCycle` |
| `services/mining/miningRuntime.js` | hands over the internals a cutter needs (snapshot, targets, range, hold, grants) | text region `edits/miningRuntime.exports.js`, a `reverieInternals` export |
| `space/modules/salvagerRuntime.js` | access difficulty by panel size, the chance bonus | text region `edits/salvagerRuntime.chance.js`: hooks `salvage.accessDifficultyBase`, `salvage.chanceBonus` |
| `space/modules/salvagerRuntime.js` | the empty factor, scrap, alloys, the cut share of a direct salvage | text region `edits/salvagerRuntime.rewards.js`: hooks `salvage.emptyFactor`, `salvage.rewardEntries` |
| `space/modules/salvagerRuntime.js` | panel cycles, the Salvage Hold's room and split, the cargo-full message | text regions `edits/salvagerRuntime.cycle.js` and `.grant.js`: hooks `salvage.cycle`, `salvage.extraRoom`, `salvage.rewardSplit`, `salvage.cargoFull` |
| `space/modules/salvagerRuntime.js` | hands over the loot container and scene helpers a finished wreck needs | text region `edits/salvagerRuntime.exports.js`, a `reverieInternals` export |
| `services/mining/miningDogma.js` | lets a cutter with no mining amount through the mining snapshot, since the layer swaps that amount for the cutter attributes | text region `edits/miningDogma.noYield.js`: hook `mining.allowNoYield` |
| `space/runtime/combatDestruction.js` | guns finishing a wreck | patch on `destroyCombatEntity` |
| `space/npc/npcLoot.js` | alloys in scavenger and hauler cargo, and the pool cache cleared when the gear setting changes | patch on `rollNpcLootEntries` |
| `space/npc/npcLoot.js` | cutters and salvagers counted as modules in the loot tables' pools | text region `edits/npcLoot.selectorKind.js`: hook `loot.selectorKind` |
| `services/inventory/specialShipHoldRegistry.js` | the Salvage Hold takes scrap | patches on `isSpecialShipHoldItemAllowed` and `getSpecialShipHoldRestrictionMessage` |
| `services/inventory/invBrokerService.js` | Loot All into cargo sends salvage to the Salvage Hold | replaces `Handle_Add` and `Handle_MultiAdd` (one mod only) |

Each text region is pinned to EveJS 261115.1 by `originalSha256` in `reverie.json`. On another build that changed those lines, enabling refuses with a message rather than edit the wrong text.

The type layer reaches the server through two hook points that belong to the core, not to this mod: `data.staticTable` in `_shared/referenceData.js` and `data.blueprintDefinitions` in `industry/industryStaticData.js`. The core puts them in when it is enabled.

Later versions add these:

| File | What salvage does there | Way in |
|---|---|---|
| `space/npc/nativeNpcWreckService.js` | custom info on loot entries | patch |
| `playerbots/*` | bot salvagers | none: the bot mod calls the registered job |

## IDs it claims

| Kind | IDs |
|---|---|
| Types | 992000–992139 (seven families of 20) |
| Blueprints | 992500–992639 |
| Group | 990050 Hull Cutter |
| Attributes | 7900–7904 |
| Icons | 1063, 1665, 1036, 1459, 1460, 1461 |
| Messages | 9710000–9710999 (names, descriptions and tooltips) |

`reverie.json` reserves the whole block 992000–992999, group 990050, attributes 7900–7904, the six icons and the message block, so no other mod can take them. The composer refuses a layer whose new IDs fall outside these claims.

It also edits CCP types, each listed under `edits.types` in `reverie.json`. Those are the three cutters 5241, 5243 and 5235, the salvagers 25861 and 30836, the blueprints 28751, 22922 and 28749, the panel wreck types 75781, 80246, 80247 and 90038, and the twelve alloys 11724, 11725 and 11732–11741.

## State and reload

- No module state. A wreck's cutting state is on the wreck and panel records (`cutting`, `wreckPanel`), or on the item's `customInfo.evejsWreckCut`.
- A bot run's state is on its operation, so a reload mid-run carries on.
- Server code reloads live with `reverie reload reverie-salvage`.
- A change to the type layer needs the client patch again, with the client closed. The server reads the layer and the ledger by mtime and drops its cached tables, so edits to existing types' names, groups and blueprints go live at once. New types go live too: each layer change raises a generation counter, and the core's region in `itemTypeRegistry.js` drops the type index when it sees a new one. Dogma edits to a type the server had already looked up are the exception: the fitting code caches each type's attributes and effects and nothing clears that cache, so the three CCP mining lasers that become cutters keep their mining laser dogma in fitting until the server restarts. Install the mod with the server stopped, as the trial does, or restart once after a live install. `test/workflow.js` checks a server started with the layer on.
- A change to the client script needs a server start, because login delivery fixes its scripts at the first login, and then a fresh login.
- The blueprints' market stock follows the mod live: the core syncs it at start, after a layer change and after a reload of this mod, so enabling or disabling the mod adds or removes the stock with no restart of the market server.

## Bots

The bot API is described in [doc/REVERIE.md](../../doc/REVERIE.md#bots). Salvage registers one job:

```js
api.when("bot-jobs", 1, (jobs) => jobs.register({
  id: "salvage",
  findRun: (bot, tools) => runs.findRun(bot, tools),
  describe: (run) => runs.describe(run),
  advance: (run, bot, tools) => runs.advance(run, bot, tools),
  keepTypes: (bot, stationID) => runs.keepTypes(bot, stationID),
  excludeFromFits: (typeID) => catalog.isCutter(typeID),
  gm: { bots: runs.gmBots, botPlan: runs.gmPlan, botRun: runs.gmRun },
}));
```

`register` returns the function that takes the job away, so the job leaves when either mod is disabled.

## Open work

**For the extraction:**

1. Done 2026-11-25: the core composes type layers (`client/compose.js`), writes them into the client (`client/patch.js`), applies them on the server (`lib/typeLayer.js`) and sends client scripts at login (`lib/loginScripts.js`). The mod carries its own copy of the ladder (`salvageModuleFamily.js`); the other mods that use the ladder in the main tree will want it as shared machinery in the core.
2. The bot mod has to provide `bot-jobs`, and the four places that call the salvage run by name have to ask the registry instead.
3. npc-loot has to provide `npc-loot` with a way to add rolls, and the salvage rolls move out of `npcLootOverhaul.js`.
4. The holds mod has to provide `holds`, which `salvageHoldRouting.js` and the salvager holds use.
5. The files move into `server/`, `defs/` and `client/` here, and `mods/reverie-salvage/evejs-launcher.mod.json` and `reverie.json` are written. All of it, `defs/` and `client/` included, was done for v0.1 on 2026-11-25.

**In the game:**

- Play-test v0.1 on a clean EveJS with a patched client:
  - the market tree and info windows;
  - the icons;
  - a cutter's turret and beam;
  - a panel's model and size;
  - building and inventing the blueprints.

  Then check the bug registry.
- The server's dogma record for a cutter keeps CCP's type name (Dual Diode Mining Laser I) in its `typeName` field, which only logs show.
- The panel types' info window shows the old types' figures until the layer gives them the same attributes.
- Optionally, let the best cutter on a wreck set recovery, instead of the cutter that made each cut.
- Bot salvagers could pick a cutter by its profile, not only its price.
- The Plasma Hull Torch pays about eight times the other cutters at scaled HP, and has not been changed.
