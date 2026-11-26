# -*- coding: utf-8 -*-
# Reverie's Holds and Bays, the client's half (Python 2.7). The server sends this at login
# through Reverie's login scripts (reverie-core/lib/loginScripts.js), after a preamble that sets
# REVERIE_MOD and REVERIE_DATA (this mod's clientData from defs/layer.js):
#
#   REVERIE_DATA['extensionGroup']  the Bay Extension group
#   REVERIE_DATA['moduleBays']      {typeID: {bay, m3, mod}} other mods' modules that carry a bay
#   REVERIE_DATA['customBays']      bays other mods add on flags the client does not know
#   REVERIE_DATA['meters']          {show, perRow, most} the bay meter settings
#
# Ported from the Scarlet build's evejs_shipsystems.py (patch_holds, patch_tree_refresh,
# patch_data_storage, patch_icons) and evejs_bays.py (the meters). It runs before character
# selection, so the work waits in a tasklet until the client modules it patches have loaded.
# Each patch keeps the client's original on the function it replaces (evejs_original) and wraps
# that, so a second login never stacks them. Errors go to the client log under "reverie.holds"
# and never reach the player.
#
# What needs the client's help:
#   On CCP's ships a bay comes from the hull, so the inventory tree and the ship's menus read the
#   hull's attributes. Here a module can give a ship a bay, so for the active ship they read the
#   value client dogma computes (patch_holds), and the tree rebuilds itself when a bay module is
#   fitted or removed (patch_tree_refresh). A bay that has come down to nothing while it still
#   holds items stays listed so the pilot can empty it.
#   A bay another mod adds on a flag of its own gets a bay type the way CCP builds one
#   (patch_custom_bays): a controller, a container, its rules and name, and its size asked of
#   the server.
#   typeHelpers.GetIcon reads only the DUST icon table for a type ID above 350000, so the fitting
#   window drew no icon for the extensions (patch_icons).
#   Small ring meters above the ship HUD's buttons show how full each bay is (the meters).
import sys
import time
import logging

_log = logging.getLogger('reverie.holds')

try:
    _DATA = REVERIE_DATA
except NameError:
    _DATA = {}

STATE = getattr(sys, '_reverie_holds', None)
if STATE is None:
    STATE = {}
    sys._reverie_holds = STATE

EXTENSION_GROUP = int(_DATA.get('extensionGroup') or 0)
MODULE_BAY_TYPES = frozenset(int(_id) for _id in (_DATA.get('moduleBays') or {}).keys())
CUSTOM_BAYS = [dict(_bay) for _bay in (_DATA.get('customBays') or []) if _bay and _bay.get('flag') and _bay.get('invType')]
_METERS = _DATA.get('meters') or {}
METERS_SHOWN = _METERS.get('show', True) is not False
ROW_LENGTH = max(1, int(_METERS.get('perRow') or 6))
MAX_BAYS = max(1, int(_METERS.get('most') or 12))

TREE_REFRESH_DELAY_MS = 400
TREE_WATCH_SECONDS = 1.0
HELD_CACHE_SECONDS = 10.0
CAPACITY_CACHE_TICKS = 2000000  # blue wallclock is in 100 ns ticks
SHIP_CATEGORY_ID = 6
CAPSULE_GROUP_ID = 29
# Modules that hold CCP's ALL_HOLDS list (the same list, or copies of it).
ALL_HOLDS_MODULES = ('appConst', 'eve.common.lib.appConst', 'eve.common.script.sys.idCheckers',
                     'inventorycommon.const')

GAUGE_SIZE = 32          # CCP's meter size
GAUGE_STEP = 36          # from one meter to the next, across and up
ICON_SIZE = 14
ICON_OPACITY = 0.75
GAP_ABOVE_BUTTONS = 6    # pixels between the meters and the top of the HUD's buttons
POLL_SECONDS = 3         # remake check (ship, HUD, bays)
PLACE_SECONDS = 0.5      # position check

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


def builtin(name):
    import __builtin__
    return getattr(__builtin__, name, None)


def alive(element):
    return element is not None and not getattr(element, 'destroyed', False)


# ------------------------------------------------------------------ the bays a module can add

# For the active ship the inventory tree and the item menus follow the live value client dogma
# computes instead of the hull's. (attribute ID, container type name, extra TreeDataInv kwargs
# needed, menu checker, inventory flag)
HOLD_ATTRIBUTES = (
    (283, 'SHIP_DRONE_BAY', True, 'IsDroneCapableShip', 87),
    (1556, 'SHIP_GENERAL_MINING_HOLD', False, 'IsGeneralMiningHoldShip', 134),
    (5325, 'SHIP_MOBILE_DEPOT_HOLD', False, 'IsMobileDepotHoldShip', 183),
    (1549, 'SHIP_FUEL_BAY', False, 'IsFuelBayShip', 133),
    (5944, 'SHIP_EXPEDITION_HOLD', False, 'IsExpeditionHoldShip', 188),
    (1559, 'SHIP_SALVAGE_HOLD', False, 'IsSalvageHoldShip', 137),
    (1573, 'SHIP_AMMO_HOLD', False, 'IsAmmoHoldShip', 143),
    (1558, 'SHIP_MINERAL_HOLD', False, 'IsMineralHoldShip', 136),
    (1653, 'SHIP_PLANETARY_COMMODITIES_HOLD', False, 'IsPlanetaryCommoditiesHoldShip', 149),
)
HOLD_FLAGS = dict((entry[0], entry[4]) for entry in HOLD_ATTRIBUTES)


def live_ship_attribute(item_id, attribute_id):
    """Live dogma value for the active ship, or None to keep the client's own answer."""
    try:
        if not item_id or item_id != builtin('session').shipid:
            return None
        location = builtin('sm').GetService('clientDogmaIM').GetDogmaLocation()
        if not location.IsItemLoaded(item_id):
            return None
        return float(location.GetAttributeValue(item_id, attribute_id) or 0.0)
    except Exception:
        log_once('live_ship_attribute', 'live_ship_attribute(%s, %s)' % (item_id, attribute_id))
        return None


_held_cache = {}


def flag_holds_items(item_id, flag):
    """True when the active ship's bay on this flag still holds items.

    A bay a module gives can come down to size 0 with cargo still in it, when the module burns
    out or is forced offline, and the pilot has to be able to open the bay to empty it (the
    server keeps the ship docked until then). The answer is asked of the server, so it is kept
    for a few seconds per bay.
    """
    if not flag or not item_id:
        return False
    key = (item_id, flag)
    now = time.time()
    hit = _held_cache.get(key)
    if hit is not None and now - hit[0] < HELD_CACHE_SECONDS:
        return hit[1]
    held = False
    try:
        held = bool(builtin('sm').GetService('invCache').GetInventoryFromId(item_id).List(flag))
    except Exception:
        log_once(('held', flag), 'flag_holds_items(%s)' % flag)
    _held_cache[key] = (now, held)
    if len(_held_cache) > 64:
        for old in [k for k, v in _held_cache.items() if now - v[0] >= HELD_CACHE_SECONDS]:
            _held_cache.pop(old, None)
    return held


def bay_holds_items(item_id, attribute_id):
    return flag_holds_items(item_id, HOLD_FLAGS.get(attribute_id))


def is_no_bays_placeholder(child):
    """True for the "No additional bays" entry TreeDataShip adds when the hull has no bay.

    CCP builds it as TreeData(label=..., id='none_<shipID>'), and TreeData keeps the id among its
    creation keywords (child._kw), not as an attribute.
    """
    node_id = (getattr(child, '_kw', None) or {}).get('id') or getattr(child, 'id', None) or ''
    return str(node_id).startswith('none_')


def no_bays_placeholder(treemod, parent, item_id):
    """CCP's "No additional bays" entry, made the way TreeDataShip.GetChildren makes it."""
    import localization
    return treemod.TreeData(parent=parent, label=localization.GetByLabel('UI/Inventory/NoAdditionalBays'),
                            id='none_%s' % item_id)


def patch_holds():
    import eve.client.script.ui.shared.inventory.treeData as treemod
    from eve.client.script.ui.shared.inventory.invConst import ContainerType
    TreeDataShip = treemod.TreeDataShip
    TreeDataInv = treemod.TreeDataInv
    original_children = original_of(TreeDataShip.GetChildren)

    def GetChildren(self):
        children = original_children(self)
        try:
            item_id = self.invController.itemID
            changed = False
            for attribute_id, name, wants_cmd, _checker, _flag in HOLD_ATTRIBUTES:
                value = live_ship_attribute(item_id, attribute_id)
                if value is None:
                    break
                inv_type = getattr(ContainerType, name, None)
                if inv_type is None:
                    continue
                if value <= 0 and bay_holds_items(item_id, attribute_id):
                    value = 1.0
                present = [child for child in children if getattr(child, 'invType', None) == inv_type]
                if value > 0 and not present:
                    kwargs = {'cmdName': 'OpenDroneBayOfActiveShip'} if wants_cmd else {}
                    children.insert(0, TreeDataInv(parent=self, invType=inv_type, itemID=item_id, **kwargs))
                    changed = True
                elif value <= 0 and present:
                    for child in present:
                        children.remove(child)
                    changed = True
            # Bays other mods add (patch_custom_bays), listed last.
            for bay in CUSTOM_BAYS:
                if not custom_bay_registered(bay) or not custom_bay_on(bay, item_id, self.typeID):
                    continue
                if not [child for child in children if getattr(child, 'invType', None) == bay['invType']]:
                    children.append(TreeDataInv(parent=self, invType=bay['invType'], itemID=item_id))
                    changed = True
            if changed:
                kept = [child for child in children if not is_no_bays_placeholder(child)]
                if not kept:
                    # The last bay went away (a module put offline, say): the ship gets CCP's own
                    # "No additional bays" line back, as the hull would have. A ship entry with no
                    # children at all is a state the tree view never sees from CCP's code.
                    kept = [child for child in children if is_no_bays_placeholder(child)][:1] or \
                        [no_bays_placeholder(treemod, self, item_id)]
                children = kept
                # Every TreeData made with parent=self also adds itself to self._children, which
                # the tree view reads, so that list is set to the same children; otherwise the
                # placeholder and the entries of every earlier call stay listed.
                if isinstance(getattr(self, '_children', None), list):
                    self._children = list(children)
        except Exception:
            log_once('GetChildren', 'TreeDataShip.GetChildren')
        return children

    GetChildren.evejs_original = original_children
    TreeDataShip.GetChildren = GetChildren

    # The menus use menucheckers.itemCheckers.ItemChecker, which carries its own copy of each
    # method in its class dict, so every checker class that defines one is wrapped.
    import menucheckers.baseCheckers as checkmod
    import menucheckers.itemCheckers  # noqa: F401  (loads ItemChecker so it is a subclass below)
    Base = checkmod._BaseItemChecker
    classes, pending = [], [Base]
    while pending:
        klass = pending.pop()
        if klass not in classes:
            classes.append(klass)
            pending.extend(klass.__subclasses__())

    def wrap_checker(klass, method_name, attribute_id):
        current = klass.__dict__.get(method_name)
        if current is None:
            return
        original = original_of(current)

        def checker(self):
            try:
                item = self.item
                if self.IsShip():
                    value = live_ship_attribute(item.itemID, attribute_id)
                    if value is not None:
                        return value > 0 or bay_holds_items(item.itemID, attribute_id)
            except Exception:
                log_once(method_name, method_name)
            return original(self)

        checker.evejs_original = original
        checker.__name__ = method_name
        setattr(klass, method_name, checker)

    for klass in classes:
        for attribute_id, _name, _wants_cmd, checker_name, _flag in HOLD_ATTRIBUTES:
            wrap_checker(klass, checker_name, attribute_id)


# The inventory window rebuilds its tree when a ship or a container moves (invWindow.Inventory.
# OnInvChangeAny), never when a module does, because on CCP's ships a module cannot add a bay.
# Here one can, so a bay module fitted to or removed from the active ship asks the window to
# rebuild, a moment later so client dogma has applied the module's effect first.
def is_bay_module_type(type_id):
    try:
        if int(type_id) in MODULE_BAY_TYPES:
            return True
        import evetypes
        return EXTENSION_GROUP > 0 and evetypes.GetGroupID(type_id) == EXTENSION_GROUP
    except Exception:
        return False


def bay_module_moved(item, change):
    """True when a bay module went onto or came off the active ship."""
    try:
        ship_id = builtin('session').shipid
        if not item or not change or not ship_id:
            return False
        const = builtin('const')
        if const.ixFlag not in change and const.ixLocationID not in change:
            return False
        if item.locationID != ship_id and change.get(const.ixLocationID) != ship_id:
            return False
        return is_bay_module_type(item.typeID)
    except Exception:
        log_once('bay_module_moved', 'bay_module_moved')
        return False


def refresh_tree_later(window):
    def refresh():
        try:
            import blue
            blue.pyos.synchro.SleepWallclock(TREE_REFRESH_DELAY_MS)
            if getattr(window, 'destroyed', False):
                return
            _held_cache.clear()
            window.RefreshTree()
        except Exception:
            log_once('refresh_tree_later', 'refresh_tree_later')

    import uthread
    uthread.new(refresh)


# A bay also comes and goes without any item moving: a module put offline or back online, burnt
# out, or a ship boarded. So while an inventory window is open, the bays the active ship has are
# checked every TREE_WATCH_SECONDS, and the window's tree is rebuilt when they change.
def bay_signature():
    ship_id = getattr(builtin('session'), 'shipid', None)
    if not ship_id:
        return None
    present = []
    for attribute_id, _name, _wants_cmd, _checker, _flag in HOLD_ATTRIBUTES:
        value = live_ship_attribute(ship_id, attribute_id)
        if value is None:
            return None
        if value > 0 or bay_holds_items(ship_id, attribute_id):
            present.append(attribute_id)
    return ship_id, tuple(present)


def inventory_windows():
    try:
        from carbonui.uicore import uicore
        return [window for window in uicore.registry.GetWindows()
                if getattr(window, 'treeData', None) is not None and not getattr(window, 'destroyed', False)]
    except Exception:
        log_once('inventory_windows', 'inventory_windows')
        return []


def start_tree_watch(generation):
    import blue
    import uthread

    def watch():
        last = None
        while STATE.get('generation') == generation:
            try:
                windows = inventory_windows()
                signature = bay_signature() if windows else None
                if signature is not None:
                    if last is not None and signature != last:
                        _held_cache.clear()
                        for window in windows:
                            window.RefreshTree()
                    last = signature
            except Exception:
                log_once('tree watch', 'tree watch')
            blue.pyos.synchro.SleepWallclock(int(TREE_WATCH_SECONDS * 1000))

    uthread.new(watch)


def patch_tree_refresh():
    import eve.client.script.ui.shared.inventory.invWindow as winmod
    Inventory = winmod.Inventory
    original_change = original_of(Inventory.OnInvChangeAny)

    def OnInvChangeAny(self, *args, **kwargs):
        result = original_change(self, *args, **kwargs)
        try:
            item = args[0] if args else kwargs.get('item')
            change = args[1] if len(args) > 1 else kwargs.get('change')
            if bay_module_moved(item, change):
                refresh_tree_later(self)
        except Exception:
            log_once('OnInvChangeAny', 'Inventory.OnInvChangeAny')
        return result

    OnInvChangeAny.evejs_original = original_change
    Inventory.OnInvChangeAny = OnInvChangeAny


# ------------------------------------------------------------------ bays other mods add

# A bay on a flag the client does not know (GUIDE.md, "The client"). It gets a bay type built
# the way CCP builds one:
#   - invControllers.<invType>, a BaseShipBay with its locationFlag, and invContainers.<invType>,
#     an _InvContBase whose __invControllerClass__ is that one. Both carry the invType name: a
#     controller's invID is (its class name, itemID), and the window finds the classes again by
#     that name in invConst's two maps;
#   - inventoryFlagData[flag], what the bay accepts (ShouldAllowAdd reads it) and its name
#     (GetNameForFlag, wrapped because CCP's reads a localization label);
#   - ALL_HOLDS, the ship's Open menu (GetOpenShipHoldMenus) and the inventory tree
#     (patch_holds);
#   - invCacheContainer.GetCapacity(flag), which asks the server, because the client would
#     otherwise size the bay from a dogma attribute it does not have.
# A reload gives existing classes their attributes again rather than making new ones, so open
# windows keep working.
def custom_bay_registered(bay):
    try:
        import eve.client.script.ui.shared.inventory.invConst as invConst
        return bay['invType'] in invConst._CONTROLLER_CLASS_BY_TYPE
    except Exception:
        return False


def is_ship_type(type_id):
    try:
        import evetypes
        type_id = int(type_id or 0)
        return type_id > 0 and evetypes.GetCategoryID(type_id) == SHIP_CATEGORY_ID and \
            evetypes.GetGroupID(type_id) != CAPSULE_GROUP_ID
    except Exception:
        return False


def custom_bay_on(bay, item_id, type_id):
    """True when this ship has the bay: every ship when the bay says so, otherwise when the
    server gives it room or the bay still holds items."""
    if not is_ship_type(type_id):
        return False
    if bay.get('everyShip'):
        return True
    try:
        capacity = server_capacity(item_id, int(bay['flag']))
        if capacity is not None and float(getattr(capacity, 'capacity', 0) or 0) > 0:
            return True
    except Exception:
        log_once(('custom capacity', bay['flag']), 'custom bay capacity %s' % bay['flag'])
    return flag_holds_items(item_id, int(bay['flag']))


_capacity_cache = {}


def server_capacity(item_id, flag, moniker=None):
    """The server's GetCapacity for a mod's bay, kept a fifth of a second per container."""
    import blue
    key = (item_id, flag)
    now = blue.os.GetWallclockTime()
    hit = _capacity_cache.get(key)
    if hit is not None and now - hit[0] < CAPACITY_CACHE_TICKS:
        return hit[1]
    if moniker is None:
        moniker = builtin('sm').GetService('invCache').GetInventoryFromId(item_id).moniker
    answer = moniker.GetCapacity(flag)
    _capacity_cache[key] = (now, answer)
    if len(_capacity_cache) > 64:
        for old in [k for k, v in _capacity_cache.items() if now - v[0] >= CAPACITY_CACHE_TICKS]:
            _capacity_cache.pop(old, None)
    return answer


def bay_class(module, name, base, attributes):
    """module.<name>, made once as a subclass of base, given these attributes on every load.
    None when the module already has a class of that name that this script did not make."""
    klass = module.__dict__.get(name)
    if klass is not None and not getattr(klass, 'reverieBay', False):
        return None
    if not isinstance(klass, type) or base not in klass.__mro__:
        body = dict(attributes)
        body['__module__'] = module.__name__
        body['reverieBay'] = True
        klass = type(base)(str(name), (base,), body)
        setattr(module, name, klass)
    else:
        for key, value in attributes.items():
            setattr(klass, key, value)
    return klass


def rebind(name, original, replacement):
    """Points every module that imported `name` by name (and still holds the original or an
    earlier wrapper of it) at the replacement."""
    for module in list(sys.modules.values()):
        try:
            current = module.__dict__.get(name) if module is not None else None
            if current is not None and current is not replacement and original_of(current) is original:
                setattr(module, name, replacement)
        except Exception:
            continue


def patch_custom_bays():
    if not CUSTOM_BAYS:
        return
    from eve.common.script.util import inventoryFlagsCommon as flagmod
    import eve.client.script.environment.invControllers as controllers
    import eve.client.script.ui.shared.inventory.invContainers as containers
    import eve.client.script.ui.shared.inventory.invConst as invConst
    import eve.client.script.ui.services.menuSvcExtras.openFunctions as openmod
    import eve.client.script.environment.invCache as cachemod

    # A flag the client already has an entry for is CCP's (or was filled by a
    # version of this script that set 'reverieBay'), and CCP's are never replaced.
    by_flag = {}
    for bay in CUSTOM_BAYS:
        flag = int(bay['flag'])
        known = flagmod.inventoryFlagData.get(flag)
        if known is not None and not known.get('reverieBay'):
            if ('flag taken', flag) not in _warned:
                _warned.add(('flag taken', flag))
                log('custom bay %s left out: flag %d is the client\'s own' % (bay['invType'], flag))
            continue
        by_flag[flag] = bay
    if not by_flag:
        return

    # GetCapacity for these flags is the server's.
    InvCacheContainer = cachemod.invCacheContainer
    # getattr, not __dict__: the method may be inherited from a base class.
    original_capacity = original_of(getattr(InvCacheContainer, 'GetCapacity'))

    def GetCapacity(self, *args, **kwargs):
        flag = args[0] if args else kwargs.get('flag')
        if flag in by_flag:
            try:
                return server_capacity(getattr(self, 'itemID', None) or id(self), flag, self.moniker)
            except Exception:
                log_once(('GetCapacity', flag), 'invCacheContainer.GetCapacity(%s)' % flag)
        return original_capacity(self, *args, **kwargs)

    GetCapacity.evejs_original = original_capacity
    InvCacheContainer.GetCapacity = GetCapacity

    for flag, bay in by_flag.items():
        name = unicode(bay.get('name') or u'Hold')
        flagmod.inventoryFlagData[flag] = {
            'name': name,
            'attribute': None,
            'allowTypes': tuple(int(x) for x in bay.get('allowTypes') or ()) or None,
            'allowGroups': tuple(int(x) for x in bay.get('allowGroups') or ()) or None,
            'allowCategories': tuple(int(x) for x in bay.get('allowCategories') or ()) or None,
            'blockTypes': None,
            'blockGroups': None,
            'blockCategories': None,
            'reverieBay': True,
        }
        controller = bay_class(controllers, bay['invType'], controllers.BaseShipBay, {
            '__guid__': 'invCtrl.%s' % bay['invType'],
            'locationFlag': flag,
            'iconName': bay.get('icon') or 'res:/UI/Texture/WindowIcons/cargo.png',
            'GetName': (lambda _name: (lambda self, *args, **kwargs: _name))(name),
        })
        container = bay_class(containers, bay['invType'], containers._InvContBase, {
            '__guid__': 'invCont.%s' % bay['invType'],
            '__invControllerClass__': controller,
        }) if controller is not None else None
        if controller is None or container is None:
            log('custom bay %s left out: the client already has a class of that name' % bay['invType'])
            flagmod.inventoryFlagData.pop(flag, None)
            del by_flag[flag]  # by_flag.items() is a list in Python 2
            continue
        # Registered only once the capacity answer is in place, so the tree never offers a bay
        # whose gauge cannot be read.
        invConst._CONTROLLER_CLASS_BY_TYPE[bay['invType']] = controller
        invConst._CONTAINERS_CLASS_BY_TYPE[bay['invType']] = container

    seen = []
    for holder in [builtin('const')] + [sys.modules.get(module_name) for module_name in ALL_HOLDS_MODULES]:
        holds = getattr(holder, 'ALL_HOLDS', None)
        if not isinstance(holds, list) or [other for other in seen if other is holds]:
            continue
        seen.append(holds)
        for bay in by_flag.values():
            if bay['invType'] not in holds:
                holds.append(bay['invType'])

    # CCP's GetNameForFlag reads inventoryFlagData[flag]['name'] as a localization label.
    original_name = original_of(controllers.GetNameForFlag)

    def GetNameForFlag(flagID, *args, **kwargs):
        bay = by_flag.get(flagID)
        if bay is not None:
            return unicode(bay.get('name') or u'Hold')
        return original_name(flagID, *args, **kwargs)

    GetNameForFlag.evejs_original = original_name
    controllers.GetNameForFlag = GetNameForFlag
    rebind('GetNameForFlag', original_name, GetNameForFlag)

    # The ship's Open menu offers the bay wherever it offers the cargo hold, just after it.
    original_menus = original_of(openmod.GetOpenShipHoldMenus)

    def GetOpenShipHoldMenus(checker, *args, **kwargs):
        entries = original_menus(checker, *args, **kwargs)
        try:
            item = checker.item
            if checker.OfferOpenCargoHold():
                at = 1
                for bay in CUSTOM_BAYS:
                    if not custom_bay_registered(bay) or not custom_bay_on(bay, item.itemID, item.typeID):
                        continue
                    label = unicode(bay.get('openLabel') or (u'Open %s' % (bay.get('name') or u'Hold')))
                    entry = [label, openmod.OpenShipBay, [(bay['invType'], item.itemID)]]
                    if len(entries) >= at:
                        entries.insert(at, entry)
                    else:
                        entries.append(entry)
                    at += 1
        except Exception:
            log_once('GetOpenShipHoldMenus', 'GetOpenShipHoldMenus')
        return entries

    GetOpenShipHoldMenus.evejs_original = original_menus
    openmod.GetOpenShipHoldMenus = GetOpenShipHoldMenus
    rebind('GetOpenShipHoldMenus', original_menus, GetOpenShipHoldMenus)


# ------------------------------------------------------------------ icons

# typeHelpers.GetIcon takes every type ID at or above const.minDustTypeID (350000) for a DUST 514
# item and looks it up in the DUST icon table only. The extensions are numbered from 993000, so
# the fitting window (photo.GetIconByType) drew None.dds while the market and inventory showed the
# icon. When the DUST table has nothing, fall back to the type's own icon ID.
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
    rebind('GetIcon', original_get_icon, GetIcon)


# ------------------------------------------------------------------ the bay meters

# CCP's meter, from the client's bytecode: mining.client.ui.circular_inventory_gauge.
# CircularInventoryGauge(inv_controller=...) is a 32 x 32 ring of segment sprites that lights
# from inv_controller.get_capacity_ratio(), listens to OnItemChange, and on hover shows
# "<hold name> NN%" from inv_controller.GetName(). It asks nothing else but IsItemHere.
#
# The meters sit in a row just above the ship HUD's left-hand button cluster (uicore.layer.
# shipui.hudButtons), right edges lined up, wrapping upwards after ROW_LENGTH meters. A fast loop
# keeps the row in place when the HUD moves; the slow poll remakes it when the ship, the HUD or
# the set of bays changes, and it goes when the HUD does (docking). CCP's own ore hold meter by
# the ship is not opened while ours is up, since the ore hold is one of ours.
class BayController(object):
    """What CircularInventoryGauge asks of an inventory controller, answered so that a bay with
    no capacity, or one the server has not answered for yet, reads as empty."""

    def __init__(self, controller):
        self.controller = controller

    def get_capacity_ratio(self):
        try:
            capacity = self.controller.GetCapacity()
            total = float(capacity.capacity or 0.0)
            if total <= 0.0:
                return 0.0
            return max(0.0, round(float(capacity.used or 0.0) / total, 2))
        except Exception:
            log_once(('ratio', id(self.controller)), 'GetCapacity')
            return 0.0

    def IsItemHere(self, item):
        try:
            return self.controller.IsItemHere(item)
        except Exception:
            return False

    def GetName(self):
        try:
            return self.controller.GetName()
        except Exception:
            return u''


def collect_bays():
    """[(key, tree node, controller)] for the active ship: the cargo hold, then every other bay
    that belongs to the ship itself (containers in the hold are left out)."""
    ship_id = getattr(builtin('session'), 'shipid', None)
    if not ship_id:
        return []
    tree = builtin('sm').GetService('inv').get_active_ship_tree_data()
    nodes = [tree]
    try:
        nodes.extend(tree.GetChildren() or [])
    except Exception:
        log_once('children', 'TreeDataShip.GetChildren')
    bays = []
    seen = set()
    for node in nodes:
        controller = getattr(node, 'invController', None)
        if controller is None or getattr(controller, 'itemID', None) != ship_id:
            continue
        if not hasattr(controller, 'GetCapacity'):
            continue
        try:
            key = node.GetID()
        except Exception:
            key = id(node)
        key = repr(key)
        if key in seen:
            continue
        seen.add(key)
        bays.append((key, node, controller))
        if len(bays) >= MAX_BAYS:
            break
    return bays


def hud_parts():
    """(ShipUI layer, its left-hand button cluster) while the ship HUD is up in space."""
    current = builtin('session')
    if not getattr(current, 'shipid', None) or not getattr(current, 'solarsystemid', None):
        return None, None
    from carbonui.uicore import uicore
    shipui = getattr(uicore.layer, 'shipui', None)
    if not alive(shipui):
        return None, None
    buttons = getattr(shipui, 'hudButtons', None)
    if not alive(buttons):
        return shipui, None
    return shipui, buttons


STATE.setdefault('row', None)
STATE.setdefault('signature', None)
STATE.setdefault('buttons', None)


def make_row(shipui, bays):
    from mining.client.ui.circular_inventory_gauge import CircularInventoryGauge
    from carbonui import Align, uiconst
    from carbonui.primitives.container import Container
    from carbonui.primitives.sprite import Sprite

    count = max(1, len(bays))
    columns = min(count, ROW_LENGTH)
    rows = (count + ROW_LENGTH - 1) // ROW_LENGTH
    row = Container(name='reverieBayMeters', parent=shipui, align=Align.TOPLEFT,
                    width=columns * GAUGE_STEP - (GAUGE_STEP - GAUGE_SIZE),
                    height=rows * GAUGE_STEP - (GAUGE_STEP - GAUGE_SIZE),
                    state=uiconst.UI_PICKCHILDREN, idx=0)
    for index, (key, node, controller) in enumerate(bays):
        # The first row sits lowest, by the buttons; the cargo hold is its first meter.
        column = index % ROW_LENGTH
        line = index // ROW_LENGTH
        try:
            gauge = CircularInventoryGauge(parent=row, inv_controller=BayController(controller),
                                           align=Align.TOPLEFT, left=column * GAUGE_STEP,
                                           top=(rows - 1 - line) * GAUGE_STEP)
            icon = None
            try:
                icon = node.GetIcon()
            except Exception:
                pass
            if icon:
                Sprite(name='reverieBayIcon', parent=gauge, align=Align.CENTER, width=ICON_SIZE,
                       height=ICON_SIZE, texturePath=icon, state=uiconst.UI_DISABLED,
                       opacity=ICON_OPACITY)
        except Exception:
            log_once(('gauge', key), 'bay meter %s' % key)
    return row


def place_row():
    """Keep the row over the HUD's button cluster, right edges lined up."""
    row = STATE.get('row')
    buttons = STATE.get('buttons')
    if not alive(row) or not alive(buttons):
        return
    parent = getattr(row, 'parent', None)
    if not alive(parent):
        return
    bx, by, bw, _bh = buttons.GetAbsolute()
    px, py, _pw, _ph = parent.GetAbsolute()
    left = max(0, int(bx - px + bw - row.width))
    top = max(0, int(by - py - row.height - GAP_ABOVE_BUTTONS))
    if row.left != left:
        row.left = left
    if row.top != top:
        row.top = top


def close_row():
    row = STATE.get('row')
    STATE['row'] = None
    STATE['signature'] = None
    STATE['buttons'] = None
    if alive(row):
        try:
            row.Close()
        except Exception:
            log_once('close', 'close meters')


def refresh_meters():
    shipui, buttons = hud_parts()
    if buttons is None:
        if STATE.get('row') is not None:
            close_row()
        return
    bays = collect_bays()
    if not bays:
        if STATE.get('row') is not None:
            close_row()
        return
    signature = (getattr(builtin('session'), 'shipid', None), tuple(key for key, _node, _controller in bays))
    if alive(STATE.get('row')) and STATE.get('signature') == signature and STATE.get('buttons') is buttons:
        return
    close_row()
    STATE['row'] = make_row(shipui, bays)
    STATE['signature'] = signature
    STATE['buttons'] = buttons
    place_row()


def patch_ore_hold_bracket():
    """MyShipBracket.show_ore_hold_bracket: nothing to show while our meters are up."""
    import eve.client.script.ui.inflight.bracketsAndTargets.my_ship_bracket as bracket_module
    klass = bracket_module.MyShipBracket
    # getattr, not __dict__: the method may be inherited, or missing in this client build.
    original = original_of(getattr(klass, 'show_ore_hold_bracket', None))

    def show_ore_hold_bracket(self, *args, **kwargs):
        if alive(STATE.get('row')):
            return
        if original is not None:
            return original(self, *args, **kwargs)

    show_ore_hold_bracket.evejs_original = original
    klass.show_ore_hold_bracket = show_ore_hold_bracket


def start_meters(generation):
    import blue
    import uthread

    def poll():
        while STATE.get('generation') == generation:
            try:
                refresh_meters()
            except Exception:
                log_once('poll', 'meter poll')
            blue.pyos.synchro.SleepWallclock(POLL_SECONDS * 1000)
        close_row()

    def keep_in_place():
        while STATE.get('generation') == generation:
            try:
                place_row()
            except Exception:
                log_once('place', 'meter place')
            blue.pyos.synchro.SleepWallclock(int(PLACE_SECONDS * 1000))

    uthread.new(poll)
    uthread.new(keep_in_place)


# ------------------------------------------------------------------ install

PATCHES = [('holds', patch_holds), ('tree refresh', patch_tree_refresh), ('custom bays', patch_custom_bays),
           ('icons', patch_icons)]
if METERS_SHOWN:
    PATCHES.append(('ore hold bracket', patch_ore_hold_bracket))


def install():
    generation = STATE.get('generation', 0) + 1
    STATE['generation'] = generation
    close_row()

    def attempt():
        import blue
        done = set()
        meters_started = False
        watch_started = False
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
            if not watch_started and 'holds' in done:
                start_tree_watch(generation)
                watch_started = True
            # The meters need only their own patch, so one failing patch
            # elsewhere never keeps them off.
            if METERS_SHOWN and not meters_started and 'ore hold bracket' in done:
                start_meters(generation)
                meters_started = True
            if len(done) == len(PATCHES):
                log('installed: %d module bay types, %d mod bays, meters %s' %
                    (len(MODULE_BAY_TYPES), len(CUSTOM_BAYS), 'on' if METERS_SHOWN else 'off'))
                return
            blue.pyos.synchro.SleepWallclock(2000)
        log('installed in part after 90 tries; not installed: %s' %
            ', '.join(name for name, _ in PATCHES if name not in done))

    import uthread
    uthread.new(attempt)


try:
    install()
except Exception:
    log_once('install', 'install')
