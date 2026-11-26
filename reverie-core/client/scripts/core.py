# -*- coding: utf-8 -*-
# Reverie Core, the client's half (Python 2.7). The server sends this at login through
# lib/loginScripts.js whenever the type layer adds types, ahead of every mod's own script.
# It fixes what the client gets wrong for any mod's new types, so no feature mod has to.
#
# It runs before character selection, so the work waits in a tasklet until the client modules
# it patches have loaded. Each patch keeps the client's original on the function it replaces
# (evejs_original) and wraps that, so a second login never stacks them. Errors go to the client
# log under "reverie.core" and never reach the player.
#
# Icons: inventorycommon.typeHelpers.GetIcon takes every type ID at or above
# const.minDustTypeID (350000) for a DUST 514 item and looks it up in the DUST icon table only.
# Reverie's types are numbered far above that, so the market, Show Info and the fitting window
# (photo.GetIconByType) found no icon and drew nothing, while blueprints, which go through
# another path, showed theirs. When the DUST table has nothing, this falls back to the type's
# own icon ID. EveJS's own tools/ClientMods/ingame/evejs_shipsystems.py does the same.
import sys
import logging

_log = logging.getLogger('reverie.core')

STATE = getattr(sys, '_reverie_core', None)
if STATE is None:
    STATE = {}
    sys._reverie_core = STATE

_warned = set()


def log(message):
    try:
        _log.info(message)
    except Exception:
        pass


def log_once(key, where):
    if key in _warned:
        return
    _warned.add(key)
    try:
        _log.exception('%s failed', where)
    except Exception:
        pass


def original_of(current):
    return getattr(current, 'evejs_original', None) or current


# ------------------------------------------------------------------ icons

def patch_icons():
    import inventorycommon.typeHelpers as typemod
    original_get_icon = original_of(typemod.GetIcon)

    def GetIcon(typeID):
        icon = original_get_icon(typeID)
        if icon is not None:
            return icon
        try:
            import evetypes
            import fsdBuiltData.common.iconIDs as iconIDs
            icon_id = evetypes.GetIconID(typeID)
            return iconIDs.GetIcon(icon_id) if icon_id else None
        except Exception:
            log_once('GetIcon', 'GetIcon(%s)' % typeID)
            return None

    GetIcon.evejs_original = original_get_icon
    typemod.GetIcon = GetIcon


# ------------------------------------------------------------------ install

PATCHES = (('icons', patch_icons),)


def install():
    generation = STATE.get('generation', 0) + 1
    STATE['generation'] = generation

    def attempt():
        import blue
        done = set()
        for tries in range(90):
            if STATE.get('generation') != generation:
                return
            for name, patch in PATCHES:
                if name in done:
                    continue
                try:
                    patch()
                    done.add(name)
                except Exception:
                    if tries in (0, 89):
                        log_once('%s %d' % (name, tries), '%s patch (try %d)' % (name, tries + 1))
            if len(done) == len(PATCHES):
                log('installed: %s' % ', '.join(name for name, _ in PATCHES))
                break
            blue.pyos.synchro.SleepWallclock(2000)

    import uthread
    uthread.new(attempt)


try:
    install()
except Exception:
    log_once('install', 'install')
