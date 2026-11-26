# Reverie Client Data

Reverie Client Data writes the new items of the installed Reverie mods into the EVE client, so the client knows every type, name, icon and blueprint the server adds. It is an EveJS Launcher client package (`kind: client-package`) and needs Reverie Core beside it in `mods/`. A player enables it once, after the mods, and from then on the launcher keeps the client in step with whatever Reverie mods are enabled.

## What it does

The helper (`helper.js`) does no patching of its own. It calls the core's `client/run.js`, which is the same code as `node mods/reverie-core/cli.js client apply`. That code composes every enabled mod's type layer into `_local/reverie/typeLayer.json` and writes the composition into the client.

The client patch changes these resources:

- `res:/staticdata/` types, groups, dogma attributes and effects, type dogma, market groups and required skills (`.fsdbinary`);
- the localization pickle for each language patched (`en-us` unless told otherwise);
- `blueprints.static` and `blueprintsbymaterialtypeids.pickle`;
- the icons the mods draw.

Every changed resource is a new file in `ResFiles` beside CCP's, and only its line in the `resfileindex` files is pointed at the new file. CCP's files are never touched. The ledger, `_local/reverie/clientPatch.json`, keeps every line Reverie changed and the line it replaced, so a restore is exact for any set of mods. The patch is written in JavaScript, so a player needs no Python.

The ledger also holds the layer's sha-256. The game server turns the layer on only when that hash matches the layer on disk, so the server never has a type the client cannot show.

## Launcher actions

The launcher runs these while every client is closed:

| Action | What happens |
|---|---|
| `install`, `recover` | compose and write the layer, and ask a running game server to take it (`_local/reverie/reload.json`); no restart is asked for |
| `verify` (before each launch) | nothing when the client already has the layer the enabled mods compose to; when a Reverie mod was enabled, disabled or updated since, write the new layer now |
| `prepare_disable`, `prepare_remove` | put every client file Reverie changed back to the client's own, remove the ledger and ask a running server to turn the layer off |

Each reply carries a receipt at `<client tq>/_local/mod-receipts/reverie-client.json`, with the state `active`, `restored` or `recoverable`. When another tool changed one of the same index lines after Reverie did, the restore leaves that line alone and says so, and the receipt is `recoverable`.

A client folder that holds an `EVEJS_TEST_CLIENT` file is treated as a test copy, and the check for a running client is skipped.

## Without the launcher

```
node mods/reverie-core/cli.js client status
node mods/reverie-core/cli.js client apply     [--client <tq folder>] [--languages en-us,de] [--dry-run]
node mods/reverie-core/cli.js client restore   [--client <tq folder>] [--dry-run]
```

## Tested

On 2026-11-25 the helper was driven the way the launcher drives it, against a copy of the demo client's index and patched files, with the Reverie Salvage layer. It ran install, verify, verify, prepare_disable, install, install and verify. All three index files came back byte for byte on restore, and a re-install gave the same bytes as the first. It has not yet run under the real launcher or been followed by a game in a patched client.
