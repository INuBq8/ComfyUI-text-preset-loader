# =============================================================================
# id_resolver.py
# =============================================================================
# Addresses a preset by number instead of by name.
#
# IDs are NOT stored in presets.json. A flat key like "Flux/Styles/vangogh"
# already describes the whole tree, so the tree — and the numbering — is
# rebuilt in memory on demand. That keeps the storage format untouched:
# no migration, no version field, nothing new to write to disk.
#
# Numbers restart at every level and follow the same order the UI lists
# things in, so you can read them straight off the dropdown:
#
#   1  Flux
#      1  Styles
#         1  oil_painting_aivazovsky
#         2  post_impressionism_vangogh
#      2  Characters
#         1  Goku            <- 1,2,1
#
# Spec syntax, one token per level:
#
#   1,1,1          literal   -> group 1, subgroup 1, preset 1
#   1,1,[3:8]      range     -> random ID between 3 and 8
#   1,1,[1:-1]     range     -> -1 means "last", so this is any valid ID
#   1,1,[1,4,6,8]  choice    -> random pick from that list
#   1              partial   -> unspecified levels take their first entry
#   1,,3           empty     -> that level takes its first entry
#
# Rules:
#   - Ranges and choices are filtered against what actually exists, so
#     [3:8] with only 5 presets picks from 3, 4, 5 rather than failing.
#   - A token matching nothing falls back to that level's first entry
#     instead of erroring out.
#   - Extra tokens past a preset are ignored.
# =============================================================================

import random
import re


# -----------------------------------------------------------------------------
# ORDERING
# -----------------------------------------------------------------------------

def _natural_key(name: str):
    """
    Sort key matching the frontend's localeCompare(..., {sensitivity: "base",
    numeric: true}) — case-insensitive, and digit runs compare as numbers so
    "item2" sorts before "item10". Keeping both sides in step means the
    numbers you see in the dropdown are the numbers you type.
    """
    return [
        int(part) if part.isdigit() else part
        for part in re.split(r"(\d+)", str(name).casefold())
    ]


def _ordered(node: dict) -> list:
    """
    This node's children as [(id, name, value)], numbered from 1 in display
    order. `value` is a dict for a group or the flat preset key for a leaf.
    """
    items = sorted(node.items(), key=lambda kv: _natural_key(kv[0]))
    return [(i, name, value) for i, (name, value) in enumerate(items, start=1)]


# -----------------------------------------------------------------------------
# TREE
# -----------------------------------------------------------------------------

def build_tree(presets: dict) -> dict:
    """
    Rebuild the nested tree from the flat "A/B/C" keys.
    Groups are dicts, leaves are the original flat key string.
    """
    tree = {}

    for key in presets:
        parts = [p for p in str(key).split("/") if p]
        if not parts:
            continue

        node = tree
        for part in parts[:-1]:
            child = node.get(part)
            if not isinstance(child, dict):
                # A preset already sits here under the same name — promote it
                # to a group and keep the old preset inside so nothing becomes
                # unaddressable. ("A/B" plus "A/B/C" is legal but unusual.)
                promoted = {}
                if isinstance(child, str):
                    promoted[part] = child
                node[part] = promoted
                child = promoted
            node = child

        leaf = parts[-1]
        if isinstance(node.get(leaf), dict):
            node[leaf][leaf] = key   # a group is already here — nest inside it
        else:
            node[leaf] = key

    return tree


def id_paths(presets: dict) -> dict:
    """
    { "Flux/Styles/vangogh": [1, 1, 2], ... }
    Sent along with the preset list so the UI can show the numbers.
    """
    out = {}

    def walk(node, prefix):
        for num, _name, value in _ordered(node):
            path = prefix + [num]
            if isinstance(value, dict):
                walk(value, path)
            else:
                out[value] = path

    walk(build_tree(presets), [])
    return out


# -----------------------------------------------------------------------------
# SPEC PARSING
# -----------------------------------------------------------------------------

def split_tokens(spec: str) -> list:
    """
    Split on commas, ignoring commas inside brackets so "[1,4,6]" stays whole.

    Empty tokens are kept, not dropped — "1,,3" means "level 2 takes its first
    entry, level 3 takes ID 3". Dropping them would silently shift every later
    token up a level.
    """
    tokens, depth, buf = [], 0, ""

    for ch in spec:
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1

        if ch == "," and depth <= 0:
            tokens.append(buf)
            buf = ""
        else:
            buf += ch

    tokens.append(buf)
    return [t.strip() for t in tokens]


def parse_token(token: str):
    """
    ("literal", n) | ("range", lo, hi) | ("choice", [ints]) | None
    None means "no constraint" — take this level's first entry.
    """
    token = token.strip()
    if not token:
        return None

    if token.startswith("[") and token.endswith("]"):
        inner = token[1:-1].strip()

        if ":" in inner:
            lo_raw, hi_raw = inner.split(":", 1)
            try:
                return ("range", int(lo_raw.strip()), int(hi_raw.strip()))
            except ValueError:
                return None

        try:
            values = [int(v.strip()) for v in inner.split(",") if v.strip()]
        except ValueError:
            return None
        return ("choice", values) if values else None

    try:
        return ("literal", int(token))
    except ValueError:
        return None


# -----------------------------------------------------------------------------
# RESOLUTION
# -----------------------------------------------------------------------------

def pick_child(token, kids: list, rng):
    """
    Choose one child from [(id, name, value)] based on a parsed token.
    Falls back to the first child whenever the token matches nothing.
    """
    if not kids:
        return None

    first     = kids[0]
    available = [k[0] for k in kids]
    by_id     = {k[0]: k for k in kids}

    if token is None:
        return first

    kind = token[0]

    if kind == "literal":
        return by_id.get(token[1], first)

    if kind == "range":
        lo, hi = token[1], token[2]
        last   = available[-1]
        # a negative bound means "the last one that exists"
        lo = last if lo < 0 else lo
        hi = last if hi < 0 else hi
        if lo > hi:
            lo, hi = hi, lo
        candidates = [i for i in available if lo <= i <= hi]
        return by_id[rng.choice(candidates)] if candidates else first

    if kind == "choice":
        candidates = [i for i in token[1] if i in by_id]
        return by_id[rng.choice(candidates)] if candidates else first

    return first


def resolve(presets: dict, spec: str, seed: int = 0):
    """
    Resolve a spec against the preset list.

    `seed` drives every random pick, so the same seed always lands on the same
    preset. A private Random instance is used rather than the global random
    module so nothing else in ComfyUI can disturb it.

    Returns the flat preset key, or None if there is nothing to resolve to.
    """
    tree = build_tree(presets)
    if not tree:
        return None

    rng  = random.Random(seed)
    node = tree

    # One level per token
    for token in [parse_token(t) for t in split_tokens(spec or "")]:
        if not isinstance(node, dict):
            break  # already at a preset — ignore leftover tokens
        chosen = pick_child(token, _ordered(node), rng)
        if chosen is None:
            break
        node = chosen[2]

    # Levels the spec didn't mention take their first entry
    while isinstance(node, dict):
        kids = _ordered(node)
        if not kids:
            return None
        node = kids[0][2]

    return node if isinstance(node, str) else None
