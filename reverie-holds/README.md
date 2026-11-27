# Reverie's Holds and Bays

Holds and Bays adds bay extension modules to EveJS. A bay extension grows one of your ship's special holds, or gives your ship that hold if its hull was built without one. Every bay a module adds works like a bay the hull came with: it shows in the inventory window and the ship's right-click menu, items you loot or mine go into it, and nothing in it can be lost by taking the module off.

The mod is also a framework for other Reverie mods. Their modules can carry a bay (a salvager with its own Salvage Hold), their ships can get a bay, and a mod can add a bay of its own on a new inventory flag. [GUIDE.md](GUIDE.md) shows modders how.

Version 0.2.0. It ports the bay extensions from the Scarlet build into a standalone install, and it passes its offline tests against a clean EveJS 261115.1. Version 0.1.1 was installed through the EveJS Launcher on 2026-11-26 with Reverie Core 0.3.0, Reverie Client Data 0.1.1 and Reverie's Salvage and Reclamation 0.3.0, and passed an 80-step automated test in a running EVE client with no client errors. After every fit, unfit, offline, online, undock, dock and change of ship, that test checks that the inventory window lists exactly the bays the ship's menu offers.

Version 0.2.0 makes the mod a sturdier base for other mods to build on:

- Gas and salvage go to the Mining Hold and the Salvage Hold before the Expedition Hold, which takes almost anything and now comes last of the special holds.
- When a mod makes its bay the only place for an item, ships without that bay still put the item in cargo. Before, the item had nowhere to go on those ships.
- A mod's own bay that one of its modules gives now shows up and disappears in the inventory window when you fit, unfit, offline or online that module, with no relog.
- Modders get version 1.1 of the holds service. It adds the route order numbers, an event when a mod's bay goes away, and a way to take a whole list of materials from every bay on the ship at once, so a module that builds from a blueprint can use the minerals in your Mineral Hold or any other bay. A new test mod, covered in [GUIDE.md](GUIDE.md), shows every step of adding a bay of your own.

Version 0.1.1 fixed three things in the inventory window. A bay shows again when you fit its extension a second time, the list of bays updates when you put an extension offline or online, and taking the last bay away from a ship no longer freezes the client.

## What you get

### Bay extension modules

126 low-slot modules, one family for each of these seven bays:

| Bay | What it holds |
|---|---|
| Mining Hold | ore, ice and gas (the extension also grows the Ice, Gas and Asteroid Holds) |
| Fuel Bay | fuel blocks and isotopes |
| Expedition Hold | probes, deployables, boosters, blueprints and other exploration supplies |
| Salvage Hold | salvaged parts and hull alloys |
| Ammo Hold | ammunition and charges |
| Mineral Hold | minerals and other raw materials |
| Planetary Commodities Hold | planetary commodities |

Each family comes in Small, Medium and Large, and in T1, four meta levels (Upgraded, Reinforced, Experimental, Prototype) and T2. A module adds a fixed size to its bay and then grows the whole bay by a percentage, so a hull that already has the bay gains more from it. Like a Cargo Expander, it costs some velocity and hull strength.

All seven bays are ones EVE already has. The mod adds no new kinds of bay.

### Blueprints

There are 42 blueprints, a T1 and a T2 for every size of every bay. The T1 blueprints are sold wherever the market sells the Expanded Cargohold I Blueprint. You invent the T2 blueprints from them. The meta modules come from NPC loot.

### Items go to the right bay

- **Loot All** from a wreck or can in space into your cargo hold sends each item that one of your bays takes to that bay, as long as the bay has room. The rest goes to cargo.
- **Mining lasers** fill the hold made for what they mine first (the Ice Hold for ice, say), then the Mining Hold, including a Mining Hold an extension gives. When every hold that takes the ore is full, the laser stops, as in EVE. You can let it spill into cargo instead (a setting).
- **Charges** load from the Ammo Hold when your cargo has none of that charge.
- **Agent and mission deliveries** count ore in your Mining Hold and items in your other bays, not only your cargo hold.

### Safeguards

You can never end up with cargo in a bay your ship no longer has.

- You cannot unfit an extension, strip your fitting, or destroy a fitted extension while its bay holds more than the ship would keep without it. The message names the bay, what it holds and the room that would be left.
- You cannot put an extension offline while doing so would leave its bay overfull. An offline extension gives no bay.
- If a module goes offline by itself and leaves a bay overfull, the bay takes nothing more until it is back under its size, and you cannot undock until it is. Bots are never stopped from undocking.
- A bay stays in the inventory window for as long as it holds anything, even at zero size, so you can always empty it.

### Bay meters

Small meters above the ship display show how full each of your ship's bays is. You can turn them off, and set how many show and how many fit in a row.

### NPC loot

NPCs drop bay extensions that fit what they do. Miners drop mostly Mining Hold extensions, haulers drop Mineral, Planetary, Fuel and Ammo Hold extensions, salvagers drop Salvage Hold extensions, and warships now and then drop Ammo, Fuel or Expedition Hold extensions. Bigger and higher-ranked NPCs drop bigger and better ones.

## Settings

Open the mod's **Configure** form in the EveJS Launcher.

| Setting | Default | When it applies |
|---|---|---|
| Loot All sends items to their bay | on | right away |
| Mining lasers spill into cargo | off (EVE's rule: the laser stops) | right away |
| Module output that does not fit goes into a can | on | right away |
| Bay extensions in NPC loot (multiplier, 0 turns it off) | 1 | right away |
| T1 extension blueprints on the market | on | next client launch |
| Bays on other mods' modules | on | next client launch |
| Show bay meters | on | next client launch |
| Meters per row | 6 | next client launch |
| Most meters shown | 12 | next client launch |

"Next client launch" settings change the client's game data. Reverie Client Data brings your client up to date the next time you start the game from the launcher.

## Installing

You need:

- **Reverie Core 0.3.0 or later.** An older core loads the extensions but leaves out the bays from other mods and the hull edits, and Holds warns about it in the server log.
- **Reverie Client Data** (`reverie-client`), which writes the new modules, blueprints and icons into your EVE client.

In the EveJS Launcher, enable Reverie Core, then Reverie Client Data, then Reverie's Holds and Bays. Close the EVE client before you enable or disable the mod, because the client's files are changed.

The mod changes one game file on the server: it adds a hook point to `server/src/services/agent/agentMissionRuntime.js` so deliveries can count your bays. Disabling the mod puts that file back exactly as it was.

Before you remove the mod for good, take everything out of the bays its modules give, and take the extensions off your ships. A removed mod's modules are no longer known to the game.

## Works with

| Mod | What it adds |
|---|---|
| Reverie's Salvage and Reclamation 0.3.0 or later | Every salvager carries a Salvage Hold of its own (500 m³ on T1 and meta, 750 m³ from T2 up), each Field Reclaimer a Mineral Hold (1,000 m³ T1, 1,500 m³ T2), and Loot All sends salvage to the Salvage Hold. |
| Field modules (not released yet) | Field Assemblers take their materials from any of your bays as well as cargo, the Ice Centrifuge carries a Fuel Bay and the Field Reprocessor a Mineral Hold. |
| Data (not released yet) | Data Storage, a bay of its own on every ship, with its drives, chips and extensions. |
| Ship fuel (not released yet) | A Fuel Bay on every ship, sized by hull. |

The drone bay extension, a high-slot hangar that gives drone bays to ships without them, will be its own mod.

## What the mod claims

| Kind | IDs |
|---|---|
| Types (modules and blueprints) | 993000 to 993999 |
| Group (Bay Extension) | 990051 |
| Attributes | 7910 to 7912 |
| Effects | 13900 to 13907 |
| Market groups | 990100 to 990117 |
| Messages (names and descriptions) | 9711000 to 9711999 |
| Icons | 1642, 1643, 1644, 1647, 1648, 1650, 1651 |

It also edits ships (category 6), but only to give hulls the bays other mods ask for.

## Testing

`node mods/reverie-holds/test/run.js "<clean EveJS root>"` builds a throwaway install from a clean EveJS, enables the core and the mod with the core's own CLI, runs a probe and a pilot's whole way through the bays, and checks that disabling puts the game file back byte for byte. When Reverie's Salvage and Reclamation sits beside this mod in `mods/`, it joins for a partner test. Last, it enables the test mod in `test/fixtures/reverie-specimen`, which adds a Specimen Bay of its own, and checks that every part of Holds treats that bay like one of EVE's, including through a live reload of Holds and a live disable of the test mod.
