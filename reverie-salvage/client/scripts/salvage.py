# -*- coding: utf-8 -*-
# Reverie Salvage, the client's half (Python 2.7). The server sends this at login through
# Reverie's login scripts (reverie-core/lib/loginScripts.js), after a preamble that sets
# REVERIE_MOD and REVERIE_DATA (this mod's clientData from defs/layer.js):
#
#   REVERIE_DATA['panels']       {typeID: [graphicID, model radius in m]}
#   REVERIE_DATA['cutters']      [typeID, ...] every cutter type
#   REVERIE_DATA['cutterGroup']  the Hull Cutter group
#
# It runs before character selection, so the work waits in a tasklet until the client modules
# it patches have loaded. Each patch keeps the client's original on the function it replaces
# (evejs_original) and wraps that, so a second login never stacks them. Errors go to the client
# log under "reverie.salvage" and never reach the player.
#
# Three things need the client's help:
#   Hull panels are wrecks whose type has a model from CCP's ship debris set, which is hundreds
#   of metres across. The client never scales a wreck, so this scales a panel's model to its
#   ball radius (the server sizes the ball from the alloys in the panel).
#   The client fits a turret only for modules in const.turretModuleGroups. The cutters have their
#   own group, which this adds, or a cutter would fire no beam.
#   A cutter fires CCP's mining beam, which throws rocks off the target. A cutter's turret gets
#   its own copy of the effect without them.
import sys
import logging

_log = logging.getLogger('reverie.salvage')

try:
    _DATA = REVERIE_DATA
except NameError:
    _DATA = {}

STATE = getattr(sys, '_reverie_salvage', None)
if STATE is None:
    STATE = {}
    sys._reverie_salvage = STATE

PANELS = {}
for _key, _value in (_DATA.get('panels') or {}).items():
    PANELS[int(_key)] = (int(_value[0]), float(_value[1]))
CUTTERS = frozenset(int(_id) for _id in (_DATA.get('cutters') or []))
CUTTER_GROUP = int(_DATA.get('cutterGroup') or 0)
MIN_RADIUS = 2.0
ROCK_PARTS = ('dest_ps_rocks',)
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


# ------------------------------------------------------------------ hull panels

def client_graphic(type_id):
    try:
        import evetypes
        return evetypes.GetGraphicID(type_id)
    except Exception:
        log_once('graphic', 'evetypes.GetGraphicID')
        return None


def panel_scale(space_object):
    """Uniform scale for a panel's model, or None when the ball is not a panel."""
    try:
        type_id = space_object.GetTypeID()
    except Exception:
        return None
    entry = PANELS.get(type_id)
    if entry is None:
        return None
    graphic_id, model_radius = entry
    # A client whose type data was put back has CCP's graphic again; leave it alone.
    if client_graphic(type_id) != graphic_id or model_radius <= 0:
        return None
    radius = float(getattr(space_object, 'radius', 0) or 0)
    if radius <= 0:
        return None
    return max(MIN_RADIUS, radius) / model_radius


def scale_panel(space_object):
    """Sizes a panel's model to its ball. The debris models are SOF objects, sized by
    modelScale as the client's ScalableSpaceObject does. Returns the scale set, or None."""
    scale = panel_scale(space_object)
    model = getattr(space_object, 'model', None)
    if scale is None or model is None:
        return None
    model.modelScale = scale
    return scale


def patch_wreck():
    from eve.client.script.environment.spaceObject import wreck as wreck_module
    klass = wreck_module.Wreck
    original = original_of(klass.Assemble)

    def Assemble(self):
        result = original(self)
        try:
            scale_panel(self)
        except Exception:
            log_once('assemble', 'scale panel model')
        return result

    Assemble.evejs_original = original
    klass.Assemble = Assemble


def ballpark():
    try:
        return sm.GetService('michelle').GetBallpark()
    except Exception:
        return None


def rescale_present():
    bp = ballpark()
    if bp is None:
        return 0
    count = 0
    for ball in list(bp.balls.values()):
        try:
            if scale_panel(ball) is not None:
                count += 1
        except Exception:
            log_once('rescale', 'rescale present panel')
    return count


# ------------------------------------------------------------------ cutter turrets and beams

def patch_turret_groups():
    from eve.client.script.environment.model import turretSet as turret_module
    const = turret_module.const
    original = STATE.get('turret_groups_original')
    if original is None:
        original = const.turretModuleGroups
        STATE['turret_groups_original'] = original
    if not CUTTER_GROUP or CUTTER_GROUP in original:
        return
    if isinstance(original, (set, frozenset)):
        widened = type(original)(set(original) | set([CUTTER_GROUP]))
    elif isinstance(original, list):
        widened = list(original) + [CUTTER_GROUP]
    else:
        widened = tuple(original) + (CUTTER_GROUP,)
    const.turretModuleGroups = widened
    log('turret groups: added the cutter group %s' % CUTTER_GROUP)


def strip_rocks(container, removed):
    objects = getattr(container, 'objects', None)
    if objects is None:
        return
    for child in list(objects):
        name = (getattr(child, 'name', '') or '').lower()
        if name in ROCK_PARTS:
            try:
                objects.remove(child)
                removed.append(name)
            except Exception:
                child.display = False
                removed.append(name + ' (hidden)')
            continue
        strip_rocks(child, removed)


def strip_turret(turret):
    """Gives each turret set of a cutter its own rock-free firing effect. Idempotent."""
    if getattr(turret, 'evejs_no_rocks', False):
        return False
    if int(getattr(turret, 'turretTypeID', 0) or 0) not in CUTTERS:
        return False
    import trinity
    removed = []
    for turret_set in list(getattr(turret, 'turretSets', None) or []):
        path = getattr(turret_set, 'firingEffectResPath', None)
        if not path:
            continue
        effect = trinity.Load(path)
        if effect is None:
            continue
        for stretch in list(getattr(effect, 'stretch', None) or []):
            strip_rocks(getattr(stretch, 'destObject', None), removed)
        turret_set.firingEffect = effect
    turret.evejs_no_rocks = True
    return True


def patch_turrets():
    from eve.client.script.environment.model import turretSet as turret_module
    klass = turret_module.TurretSet
    # A staticmethod read through the class is the plain function (Python 2).
    original = original_of(klass.FitTurret)

    def FitTurret(*args, **kwargs):
        turret = original(*args, **kwargs)
        try:
            if turret is not None:
                strip_turret(turret)
        except Exception:
            log_once('fit', 'strip cutter beam rocks')
        return turret

    FitTurret.evejs_original = original
    klass.FitTurret = staticmethod(FitTurret)


def refit_present():
    bp = ballpark()
    if bp is None:
        return 0
    count = 0
    for ball_id, ball in list(bp.balls.items()):
        slim = bp.GetInvItem(ball_id)
        modules = getattr(slim, 'modules', None) if slim is not None else None
        if not modules or not hasattr(ball, 'FitHardpoints'):
            continue
        if not any(int(entry[1]) in CUTTERS for entry in modules):
            continue
        try:
            ball.FitHardpoints()
            count += 1
        except Exception:
            log_once('refit', 'refit hardpoints')
    return count


def strip_present():
    bp = ballpark()
    if bp is None:
        return 0
    count = 0
    for ball in list(bp.balls.values()):
        for turret in list((getattr(ball, 'modules', None) or {}).values()):
            try:
                if not getattr(turret, 'isShooting', False) and strip_turret(turret):
                    count += 1
            except Exception:
                log_once('present-turret', 'strip present cutter')
    return count


# ------------------------------------------------------------------ install

PATCHES = (('wreck panels', patch_wreck), ('cutter turret group', patch_turret_groups), ('cutter beams', patch_turrets))


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
                for name, present in (('rescale present panels', rescale_present),
                                      ('refit present cutters', refit_present),
                                      ('strip present cutters', strip_present)):
                    try:
                        present()
                    except Exception:
                        log_once(name, name)
                log('installed for %d panel types and %d cutter types' % (len(PANELS), len(CUTTERS)))
                break
            blue.pyos.synchro.SleepWallclock(2000)

    import uthread
    uthread.new(attempt)


try:
    install()
except Exception:
    log_once('install', 'install')
