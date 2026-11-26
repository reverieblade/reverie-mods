# Holds and Bays: the modder's guide

This guide is for modders who want their Reverie mod to work with bays. It shows how to:

- give your module a bay, the way a salvager gets its own Salvage Hold;
- give ships a bay of a set size;
- add a bay of your own on a new inventory flag, the way the data mod adds Data Storage;
- put items into a ship and take them out from your scripts, so they always land in the right bay.

Holds and Bays version 0.1.1 needs Reverie Core 0.3.0 or later. Everything here is in the mod's own code, and the file each part lives in is named.

## The one rule

A ship has a bay exactly when the bay's fitted size is above zero. The size can come from the hull, a module, a rig or a skill. Nothing in Holds and Bays decides from the hull type alone, so your new ship, bay or module behaves like EVE's without any routing, capacity or client code of your own.

When a module that gives a bay comes off, the bay shrinks or goes. Its items are never lost or hidden:

- the pilot cannot unfit, strip, destroy or offline the module while the bay holds more than the ship would keep without it;
- a bay over its size takes nothing more, and the pilot cannot undock until it is back under (bots are never stopped);
- the client keeps the bay in the inventory tree while it holds anything, even at zero size.

These guards cover every bay in the bay table, a mod's own included (`server/lib/bayOverflow.js`).

## 1. Pick the bay

Use one of EVE's bays whenever one fits. Holds and Bays knows all of them: cargo, the Drone and Fighter Bays, the Fuel Bay, the Mining, Ice, Gas and Asteroid Holds, and every special hold EveJS's `specialShipHoldRegistry` defines (Mineral, Salvage, Ammo, Planetary Commodities, Expedition, the ship holds and the rest). They are sized and judged by EveJS's own rules.

Add a bay of your own only when none of EVE's fits. It needs an inventory flag of its own from 192 to 255. CCP's holds use flags below 192. Data Storage takes 199.

## 2. Reach the service

The server side is the `holds` service, version 1. Attach to it with `api.when`, so your mod works whether Holds is installed or not, and lets go cleanly when Holds is disabled:

```js
function init(api) {
  api.when("holds", "1", (holds) => {
    // holds is here: add your bay, keep the service for your scripts.
    return () => { /* Holds went away: forget it */ };
  });
}
```

List Holds in your `reverie.json` `worksWith`, so players see what it adds before they enable it:

```json
"worksWith": [
  { "mod": "reverie-holds", "service": "holds", "version": "1", "adds": "Your module carries a Mineral Hold." }
]
```

Call `addBay` from `init` or from the `api.when` callback. `addBay` itself loads nothing from the game, so it is safe even when `api.when` fires while mods are still declaring patches. The rest of the service (`route`, `capacity`, `grant` and the others) loads EveJS's hold registry on first use, so call those only once the game is running, never from `patches`, or other mods' patches on the registry would arrive late.

## 3. Give your module a bay

For one of EVE's bays, contribute a module bay from your type layer. Holds' `after` pass then puts the bay's attributes and its online effect on your module type, the same ones its own extensions use.

In your layer's `build`, return:

```js
contributes: { "reverie-holds": {
  moduleBays: [
    { typeID: 992040, bay: "salvage", m3: 500 },
    { typeID: 992041, bay: "mineral", m3: 1500 },
  ],
} }
```

| Field | What it is |
|---|---|
| `typeID` | your module's type. It must be a type your mod adds, or a CCP type your `reverie.json` lists in `edits.types`. |
| `bay` | `mining`, `fuel`, `expedition`, `salvage`, `ammo`, `mineral`, `planetary`, or `drone` |
| `m3` | the room the module adds. A ship without the bay gains one of this size. A ship that has it gains this much more. |
| `mbit` | `drone` only: the drone bandwidth the module adds |

The module must be fitted and online to give its bay. Players can turn module bays off with the "Bays on other mods' modules" setting.

You may put the contribution in `reverie.json` instead, as `"contributes": { "reverie-holds": { ... } }`, or point it at a JSON file in your mod: `"contributes": { "reverie-holds": "data/holds.json" }`. A layer's own `contributes` wins over `reverie.json`'s.

Reverie's Salvage and Reclamation does exactly this in `defs/layer.js` (`moduleBays`).

For a bay of your own (section 5), there is no contribution. Give your modules a dogma attribute of your own, and name it as the bay's `size.moduleAttribute`.

## 4. Give ships a bay

Contribute a ship bay to give a bay of a set size to the hulls you choose:

```js
contributes: { "reverie-holds": {
  shipBays: [
    { bay: "fuel", sizes: { 587: 120, 24690: 900 } },
    { bay: "fuel", groups: { 25: 100, 26: 400 } },
    { bay: "fuel", all: 50 },
  ],
} }
```

| Field | What it is |
|---|---|
| `bay` | one of the bay keys above, or the `key` of a bay your mod adds with `addBay` |
| `sizes` | `{ shipTypeID: m3 }` for single hulls |
| `groups` | `{ groupID: m3 }` for every published ship in those groups |
| `all` | m³ for every published ship |
| `mbit` | `drone` only: the drone bandwidth those hulls get |

`sizes` wins over `groups`, which wins over `all`. A ship bay never makes a hull's bay smaller than the hull already has.

For EVE's bays, Holds sets the hull's own capacity attribute, so every client window and fitting tool sees it. For a bay of your own, the sizes go to the server's bay table, and the client asks the server.

## 5. Add a bay of your own

A new bay needs two parts: the server's definition, through `addBay`, and the client's registration, through a contribution.

### The server

```js
api.when("holds", "1", (holds) => {
  holds.addBay({
    mod: api.id,
    key: "data",
    flag: 199,
    name: "Data Storage",
    size: {
      base: (shipTypeID) => 6,        // m3 on every hull, or a number
      moduleAttribute: 7913,          // plus this attribute summed over the online fitted modules
      slots: "low",                   // only modules in these slots ("low" or a list of flags)
    },
    accepts: { categories: [], groups: [990060], types: [991000] },
    refusal: "Only data can be placed in Data Storage.",
    exclusive: true,
    priority: 70,
  });
  return () => holds.removeBays(api.id);
});
```

| Field | What it is | Default |
|---|---|---|
| `mod` | your mod's ID, so the bay goes when your mod does (`removeBays`) | none |
| `key` | a short name, used by ship bays (section 4) | `bay<flag>` |
| `flag` | the inventory flag, 192 to 255. `addBay` refuses any flag outside that range, which keeps it off EVE's bays, and a flag another mod already uses. | required |
| `name` | the bay's name, used in refusals and the guards' messages | the key |
| `size.attribute` | a ship attribute that dogma grows (rigs, skills) | none |
| `size.base` | m³ per hull: a number, or a function of the ship's type ID | 0 |
| `size.moduleAttribute` | a module attribute summed over the online fitted modules | none |
| `size.slots` | which modules count for `moduleAttribute`: `"low"` or a list of flags | every fitted module |
| `accepts.categories`, `accepts.groups`, `accepts.types` | what the bay takes | nothing |
| `accepts.test(type)` | a function for any other rule (or pass a function as `accepts`) | none |
| `refusal` | the text a pilot sees when the bay refuses an item | "That item cannot be placed in the ..." |
| `exclusive` | the bay's items go nowhere else in the ship: `route` never falls back to cargo for them | false |
| `priority` | among bays that take the same item, the higher one is tried first. Specialised holds are 80, kind holds 70, the Mining Hold 60, cargo 0. | 70 |
| `routable` | false keeps the bay out of `route`, so items only arrive by hand | true |

The size is the sum of the three `size` parts plus any ship bay contributed for the bay's `key`. With the bay defined, the inventory window's move check and capacity both use it. The pilot is refused when the bay does not take an item or has no room, and the guards in "The one rule" apply.

### The client

The EVE client knows nothing of flag 199, so Holds' login script (`client/scripts/holds.py`) registers it from your contribution:

```js
contributes: { "reverie-holds": {
  clientBays: [{
    flag: 199,
    invType: "ShipDataStorage",
    name: "Data Storage",
    icon: "res:/ui/texture/icons/...png",
    openLabel: "Open Data Storage",
    everyShip: true,
    allowGroups: [990060],
    allowTypes: [991000],
  }],
} }
```

| Field | What it is |
|---|---|
| `flag` | the same flag as the server's bay, 192 to 255 |
| `invType` | the client class name for the bay. It must be a plain identifier (letters, digits and `_`, 3 to 49 characters), must not be one of CCP's (`ShipCargo`, `ShipFuelBay` and the rest), and must not be used by another bay. |
| `name` | the name in the inventory tree |
| `icon` | the tree icon (a `res:/` path). The cargo icon if left out. |
| `openLabel` | the ship menu entry. "Open <name>" if left out. |
| `everyShip` | true shows the bay on every ship. Otherwise it shows when the server gives the ship room in it, or while it still holds items. |
| `allowCategories`, `allowGroups`, `allowTypes` | what the client lets the pilot drag in. Match the server's `accepts`. |

The client asks the server for the bay's capacity, so the window shows the size the server's bay table gives.

A bad entry is skipped and named in the server log at start ("skipped a bay from another mod: ..."). It never costs the other partners their bays.

## 6. Placing and pulling from your scripts

Never write items straight into a flag. Ask the service, so your items go where the pilot expects and come back from wherever the pilot put them.

| Call | What it does |
|---|---|
| `route(ship, typeID, options)` | the ordered places an item of that type goes: `[{ flag, key, name, priority, capacity, used, free }]`. The bays that take it and that the ship has, highest priority first, then cargo (unless a bay that takes it is exclusive, or `options.cargo` is false). `options.only` limits it to a list of flags. |
| `grant(ship, entries, options)` | places `[{ typeID, quantity, options? }]` along each route, checking the room at every step and telling the pilot's client. Returns `{ placed: [{ flag, typeID, quantity }], left: [{ typeID, quantity }] }`. |
| `sources(ship, typeID, options)` | the flags to take an item from, in route order: every bay that takes it and holds some (even a bay at zero size), then cargo |
| `holdings(ship, typeID, options)` | what the ship holds of a type in each source: `[{ flag, quantity }]` |
| `take(ship, { typeID, quantity, characterID? })` | takes across the sources in order. All or nothing. Returns `{ success, receipt, available }`. |
| `giveBack(receipt, quantity, options)` | returns items you took and could not use to the bays they came from. Returns how many went back. |
| `capacity(ship, flag)`, `used(ship, flag)`, `free(ship, flag)` | a bay's size with the fit applied, the m³ in it, and the room left |
| `accepts(flag, itemOrTypeID)` | whether a bay takes an item, by its own rules |
| `bays()`, `bay(flag)`, `bayName(flag)` | the bay table |
| `overfullBays(characterID, ship)` | every bay of the ship that holds more than its size |
| `moduleOutputCan()` | the player's "Module output that does not fit goes into a can" setting |

`ship` is a ship item or its item ID. Pass `characterID` (or `session`) in `options` when the pilot is not the ship's owner.

`grant` never drops anything. Whatever does not fit comes back in `left`, and your mod decides what happens to it. A module that makes things should check `moduleOutputCan()`: when it is on, leave `left` in a can in space beside the ship, and when it is off, stop the module.

A module that turns one item into another:

```js
const holds = api.use("holds", "1");     // or the one api.when handed you
const taken = holds.take(ship, { typeID: ICE, quantity: 1, characterID });
if (!taken.success) return stop("no ice");
const out = holds.grant(ship, [{ typeID: FUEL, quantity: 30 }], { characterID, purpose: "module-output" });
if (out.left.length) {
  if (holds.moduleOutputCan()) dropInCan(out.left);
  else { holds.giveBack(taken.receipt, 1, { characterID }); return stop("no room"); }
}
```

## 7. Hooks

| Hook | Kind | When |
|---|---|---|
| `holds.changed` | emit | a ship's bays change: `{ reason: "addBay", flag }`, or `{ reason: "grant" \| "take" \| "giveBack", shipID, purpose? }` |
| `holds.deliveryStacks` | run | an agent counts a delivery. Holds answers with the stacks in every bay that takes the type, so ore in the Mining Hold counts. The hook point is the text edit in `agentMissionRuntime.js`. |

Listen with `api.hooks.on(name, fn)`.

## 8. Settings

Holds' own settings are in its launcher manifest (`evejs-launcher.mod.json`). Settings that change the type layer, like "Bays on other mods' modules", apply at the next client launch. The rest apply live.

Give your own bay its own settings in your mod's manifest, in the same way. A setting that changes your contribution changes the type layer, so mark it `"restart": "client"`.

## 9. Testing

Holds' offline harness (`test/run.js`) shows how to test a mod against a clean EveJS: it builds a throwaway install, enables the core and the mod with the core's CLI, runs scripts inside the game's own code with the type layer on, and checks that disabling restores the game files.

`test/partners.js` is the worked example of a partner. It runs with Reverie's Salvage and Reclamation enabled beside Holds and checks that a Salvager I gives a Rifter a 500 m³ Salvage Hold, that the hold takes salvage and refuses ore, and that Loot All sends salvage there. `test/workflow.js` adds a bay of its own on flag 199 and checks its size, the window's capacity, the refusal and the route.

Things to check for your own bay:

- a ship without the bay has no room in it, and gains it when your module is fitted;
- the inventory window shows the same size as `capacity`;
- the bay refuses what it should, with your refusal text;
- the module cannot come off or go offline while the bay is full;
- your items route to your bay first and come back from it.
