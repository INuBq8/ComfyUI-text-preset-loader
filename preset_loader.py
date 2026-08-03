import json
import io
import hashlib
import asyncio
import os
import tempfile
import shutil
from datetime import datetime, timezone
from pathlib import Path
from aiohttp import web
from PIL import Image
import server

from . import id_resolver

# pre-define important paths
BASE_DIR     = Path(__file__).resolve().parent
DATA_DIR     = BASE_DIR / "data"
PREVIEWS_DIR = DATA_DIR / "previews"

# Two files, deliberately.
#
#   presets.json       shipped with the repo, tracked by git, never written to
#                      at runtime. It is only ever a seed.
#   user_presets.json  the live file everything reads and writes. Gitignored,
#                      so `git pull` and even `git reset --hard` cannot touch it.
#
# Keeping user data in a git-tracked file meant an update either refused to
# merge or silently wiped everyone's presets. This split removes that entirely.
DEFAULTS_PATH = DATA_DIR / "presets.json"
JSON_PATH     = DATA_DIR / "user_presets.json"
BROWSE_HTML  = BASE_DIR / "web" / "browse.html"  # standalone mobile editor page

_write_lock = asyncio.Lock()
_subscribers: set[asyncio.Queue] = set()
_revision = 0

# if for some reason the user deleted the folder and the JSON
DATA_DIR.mkdir(exist_ok=True)
PREVIEWS_DIR.mkdir(exist_ok=True)

# First run on this install: seed the live file.
# If presets.json is present — which it is for anyone who installed via git —
# we copy it across, so an existing user's presets carry over untouched.
if not JSON_PATH.exists() and DEFAULTS_PATH.exists():
    shutil.copy2(DEFAULTS_PATH, JSON_PATH)

# Only if there is no seed at all (someone deleted data/) do we fall back to
# writing the built-in starter set.
if not JSON_PATH.exists():
    starter = {
        "Flux/Styles/oil_painting_aivazovsky": {
            "text": "Oil on canvas painting in the style of Ivan Aivazovsky, characteristic thick brushstrokes and rich texture, deep navy and grey tones with golden highlights.",
            "preview": "Flux_Styles_oil_painting_aivazovsky.jpg", "preview_version": 1
        },
        "Flux/Styles/post_impressionism_vangogh": {
            "text": "Post-impressionism painting in the style of Vincent Van Gogh, swirling expressive brushstrokes, bold impasto texture, vivid contrasting colors.",
            "preview": "Flux_Styles_post_impressionism_vangogh.jpg", "preview_version": 1
        },
        "Flux/Styles/frank_frazetta": {
            "text": "Frank Frazetta fantasy illustration style, bold expressive brushstrokes, vivid dramatic colors.",
            "preview": "Flux_Styles_frank_frazetta.jpg", "preview_version": 1
        },
        "Flux/Styles/edvard_munch_scream": {
            "text": "Oil painting in the style of Edvard Munch's The Scream, expressionist style, muted warm and cold contrast, thick visible brushstrokes.",
            "preview": "Flux_Styles_edvard_munch_scream.jpg", "preview_version": 1
        },
        "Flux/Styles/jack_kirby_comics": {
            "text": "Comic art in the style of Jack Kirby, vibrant bold colors, iconic Kirby krackle energy effects, thick outlines, retro superhero aesthetic, dramatic perspective, flat cel-shaded coloring.",
            "preview": "Flux_Styles_jack_kirby_comics.jpg", "preview_version": 1
        },
        "Flux/Styles/ukiyo_e": {
            "text": "Ukiyo-e woodblock print style, bold black outlines, flat perspective, vibrant traditional colors, dynamic diagonal composition, asymmetrical arrangements, sense of movement and energy, decorative graphic elements, traditional Japanese aesthetic.",
            "preview": "Flux_Styles_ukiyo_e.jpg", "preview_version": 1
        },
        "Flux/Styles/alphonse_mucha_artnouveau": {
            "text": "Alphonse Mucha Art Nouveau style, flowing organic curvilinear lines, muted earthy pastel color palette, subtle watercolor-like textures, ornate decorative elements, intricate fine details, elegant poster composition, natural forms and curves, warm tactile feel.",
            "preview": "Flux_Styles_alphonse_mucha_artnouveau.jpg", "preview_version": 1
        },
    }
    JSON_PATH.write_text(json.dumps(starter, indent=2))


def _migrate_schema() -> None:
    """
    Backfill fields added after a user's presets.json was first created, so an
    update never leaves older entries without keys the UI now expects.
    Runs once at import time; only touches disk if something was missing.
    """
    try:
        data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    except Exception:
        return

    changed = False
    for entry in data.values():
        if isinstance(entry, dict) and "favorite" not in entry:
            entry["favorite"] = False
            changed = True

    if changed:
        save_presets(data)


# helper functions

def load_presets() -> dict:
    """
    Read presets.json from disk and return it as a Python dict.
    If the file is missing or corrupted, return an empty dict
    instead of crashing — the node should always be usable.
    """
    try:
        return json.loads(JSON_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_presets(data: dict) -> None:
    """
    Write the presets dict back to presets.json.
    indent=2 keeps it human-readable so users can hand-edit it if they want.
    ensure_ascii=False preserves non-latin characters (Japanese tags, etc.)
    """
    payload = json.dumps(data, indent=2, ensure_ascii=False)
    fd, temp_name = tempfile.mkstemp(
        prefix="presets-", suffix=".tmp", dir=str(DATA_DIR)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, JSON_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


_migrate_schema()


def publish_change(action: str, key: str | None = None) -> None:
    """Notify all open canvas/browser clients after a successful mutation."""
    global _revision
    _revision += 1
    event = {"revision": _revision, "action": action, "key": key}
    for queue in tuple(_subscribers):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # A refresh event is only an invalidation signal, so retaining the
            # newest event is enough for a slow/background browser tab.
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            queue.put_nowait(event)


def preset_key_to_filename(key: str) -> str:
    """
    Convert a preset path like "Styles/lighting/golden_hour"
    into a safe filename like "Styles_lighting_golden_hour.jpg"
    We replace "/" with "_" because slashes are not valid in filenames.
    """
    return key.replace("/", "_") + ".jpg"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# API endpoints
routes = server.PromptServer.instance.routes


@routes.get("/preset_loader/list")
async def list_presets(request):
    """
    GET /preset_loader/list
    Returns the full presets.json as JSON, plus each preset's derived ID path
    so the UI can show the numbers the preset_id input uses. IDs are computed
    from the keys on the fly and never written to disk.
    """
    presets = load_presets()
    paths   = id_resolver.id_paths(presets)
    for key, entry in presets.items():
        if isinstance(entry, dict):
            entry["id_path"] = paths.get(key, [])
    return web.json_response(presets)


@routes.get("/preset_loader/events")
async def preset_events(request):
    """Server-sent invalidation events shared by canvas and mobile clients."""
    response = web.StreamResponse(headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })
    await response.prepare(request)
    queue: asyncio.Queue = asyncio.Queue(maxsize=1)
    _subscribers.add(queue)
    try:
        await response.write(b"event: ready\ndata: {}\n\n")
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=20)
                payload = json.dumps(event, ensure_ascii=False)
                await response.write(f"event: presets-changed\ndata: {payload}\n\n".encode("utf-8"))
            except asyncio.TimeoutError:
                await response.write(b": keepalive\n\n")
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        _subscribers.discard(queue)
    return response


@routes.post("/preset_loader/save")
async def save_preset(request):
    """
    POST /preset_loader/save
    Saves a preset (new or overwrite).
    The JS sends this when the user confirms in the Save As popup.

    Expected request body (JSON):
    { "key": "Styles/lighting/golden_hour", "text": "warm tones, ..." }
    """
    try:
        body = await request.json()
        key  = body.get("key", "").strip()
        text = body.get("text", "").strip()

        if not key:
            return web.json_response({"status": "error", "message": "Preset name cannot be empty"})

        async with _write_lock:
            presets  = load_presets()
            existing = presets.get(key, {})
            presets[key] = {
                "text":            text,
                "preview":         existing.get("preview", None),
                "preview_version": existing.get("preview_version", 0),
                "pinned":          existing.get("pinned", False),
                "favorite":        existing.get("favorite", False),
                "created_at":      existing.get("created_at", utc_now()),
                "updated_at":      utc_now(),
                "last_used_at":    existing.get("last_used_at", None),
            }
            save_presets(presets)
        publish_change("save", key)
        return web.json_response({"status": "ok"})

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/rename")
async def rename_preset(request):
    try:
        body = await request.json()
        old_key = body.get("old_key", "").strip()
        new_key = body.get("new_key", "").strip()
        if not old_key or not new_key:
            return web.json_response({"status": "error", "message": "Both names are required"})
        async with _write_lock:
            presets = load_presets()
            if old_key not in presets:
                return web.json_response({"status": "error", "message": "Preset not found"})
            if new_key != old_key and new_key in presets:
                return web.json_response({"status": "error", "message": "A preset with that name already exists"})
            entry = presets.pop(old_key)
            if entry.get("preview"):
                old_path = PREVIEWS_DIR / entry["preview"]
                new_filename = preset_key_to_filename(new_key)
                new_path = PREVIEWS_DIR / new_filename
                if old_path.exists() and old_path != new_path:
                    old_path.replace(new_path)
                entry["preview"] = new_filename
                entry["preview_version"] = entry.get("preview_version", 0) + 1
            entry["updated_at"] = utc_now()
            presets[new_key] = entry
            save_presets(presets)
        publish_change("rename", new_key)
        return web.json_response({"status": "ok", "key": new_key})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/duplicate")
async def duplicate_preset(request):
    try:
        body = await request.json()
        source_key = body.get("source_key", "").strip()
        new_key = body.get("new_key", "").strip()
        if not source_key or not new_key:
            return web.json_response({"status": "error", "message": "Source and new name are required"})
        async with _write_lock:
            presets = load_presets()
            if source_key not in presets:
                return web.json_response({"status": "error", "message": "Source preset not found"})
            if new_key in presets:
                return web.json_response({"status": "error", "message": "A preset with that name already exists"})
            source = presets[source_key]
            entry = dict(source)
            if source.get("preview"):
                old_path = PREVIEWS_DIR / source["preview"]
                new_filename = preset_key_to_filename(new_key)
                if old_path.exists():
                    shutil.copy2(old_path, PREVIEWS_DIR / new_filename)
                    entry["preview"] = new_filename
            entry["pinned"] = False
            entry["favorite"] = False
            entry["created_at"] = utc_now()
            entry["updated_at"] = entry["created_at"]
            entry["last_used_at"] = None
            entry["preview_version"] = entry.get("preview_version", 0) + 1
            presets[new_key] = entry
            save_presets(presets)
        publish_change("duplicate", new_key)
        return web.json_response({"status": "ok", "key": new_key})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/pin")
async def pin_preset(request):
    try:
        body = await request.json()
        key = body.get("key", "").strip()
        pinned = bool(body.get("pinned", True))
        async with _write_lock:
            presets = load_presets()
            if key not in presets:
                return web.json_response({"status": "error", "message": "Preset not found"})
            presets[key]["pinned"] = pinned
            save_presets(presets)
        publish_change("pin", key)
        return web.json_response({"status": "ok", "pinned": pinned})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/favorite")
async def favorite_preset(request):
    """
    POST /preset_loader/favorite
    Toggles a preset's favorite flag. Favorites keep their place in their
    category (unlike pinning, which groups everything into one list) — they
    just sort first within it and get a heart badge.

    Expected request body (JSON):
    { "key": "Styles/lighting/golden_hour", "favorite": true }
    """
    try:
        body = await request.json()
        key = body.get("key", "").strip()
        favorite = bool(body.get("favorite", True))
        async with _write_lock:
            presets = load_presets()
            if key not in presets:
                return web.json_response({"status": "error", "message": "Preset not found"})
            presets[key]["favorite"] = favorite
            save_presets(presets)
        publish_change("favorite", key)
        return web.json_response({"status": "ok", "favorite": favorite})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/touch")
async def touch_preset(request):
    try:
        body = await request.json()
        key = body.get("key", "").strip()
        async with _write_lock:
            presets = load_presets()
            if key not in presets:
                return web.json_response({"status": "error", "message": "Preset not found"})
            presets[key]["last_used_at"] = utc_now()
            save_presets(presets)
        publish_change("touch", key)
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/delete")
async def delete_preset(request):
    """
    POST /preset_loader/delete
    Deletes a preset and its preview image (if one exists).

    Expected request body (JSON):
    { "key": "Styles/lighting/golden_hour" }
    """
    try:
        body = await request.json()
        key  = body.get("key", "").strip()

        if not key:
            return web.json_response({"status": "error", "message": "No preset key provided"})

        async with _write_lock:
            presets = load_presets()
            if key not in presets:
                return web.json_response({"status": "error", "message": "Preset not found"})
            preview_filename = presets[key].get("preview")
            if preview_filename:
                preview_path = PREVIEWS_DIR / preview_filename
                if preview_path.exists():
                    preview_path.unlink()
            del presets[key]
            save_presets(presets)
        publish_change("delete", key)

        return web.json_response({"status": "ok"})

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/set_preview")
async def set_preview(request):
    """
    POST /preset_loader/set_preview
    Saves an image file as the preview for a preset.
    The JS sends this when the user picks an image via the file picker.

    The request is multipart/form-data:
    - "key"  → the preset path string
    - "file" → the image file bytes
    """
    try:
        reader   = await request.multipart()
        key      = None
        img_data = None

        async for part in reader:
            if part.name == "key":
                key = (await part.read()).decode("utf-8").strip()
            elif part.name == "file":
                img_data = await part.read()

        if not key or not img_data:
            return web.json_response({"status": "error", "message": "Missing key or file"})

        # Validate and resize with Pillow.
        # verify() does a deep integrity check — raises if not a valid image.
        # We reopen after verify() because verify() closes the file handle.
        try:
            image = Image.open(io.BytesIO(img_data))
            image.verify()
            image = Image.open(io.BytesIO(img_data))
        except Exception:
            return web.json_response({"status": "error", "message": "File is not a valid image"})

        # Normalize to RGB (handles RGBA, palette, greyscale, etc.)
        # thumbnail() resizes down preserving aspect ratio, never upscales.
        # LANCZOS = best quality downscaling algorithm.
        # We target 1 megapixel (1,000,000 pixels) max.
        # thumbnail() takes a bounding box — we use 1000x1000 which gives
        # exactly 1MP for square images and proportionally less for others.
        image = image.convert("RGB")
        image.thumbnail((1000, 1000), Image.LANCZOS)

        # Save as JPEG — much smaller than PNG for photos
        async with _write_lock:
            presets = load_presets()
            if key not in presets:
                return web.json_response({"status": "error", "message": "Preset not found"})
            filename = preset_key_to_filename(key)
            preview_path = PREVIEWS_DIR / filename
            image.save(preview_path, format="JPEG", quality=85, optimize=True)
            current_version = presets[key].get("preview_version", 0)
            presets[key]["preview"] = filename
            presets[key]["preview_version"] = current_version + 1
            save_presets(presets)

        publish_change("preview", key)

        return web.json_response({
            "status":          "ok",
            "filename":        filename,
            "preview_version": presets[key]["preview_version"]
        })

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.post("/preset_loader/clear_preview")
async def clear_preview(request):
    """
    POST /preset_loader/clear_preview
    Removes a preset's preview image: deletes the file from disk and clears the
    `preview`/`preview_version` fields. The JS calls this from the "clear" button.

    Expected request body (JSON):
    { "key": "Styles/lighting/golden_hour" }
    """
    try:
        body = await request.json()
        key  = body.get("key", "").strip()

        if not key:
            return web.json_response({"status": "error", "message": "No preset key provided"})

        async with _write_lock:
            presets = load_presets()
            if key not in presets:
                return web.json_response({"status": "error", "message": "Preset not found"})
            preview_filename = presets[key].get("preview")
            if preview_filename:
                preview_path = PREVIEWS_DIR / preview_filename
                if preview_path.exists():
                    preview_path.unlink()
            current_version = presets[key].get("preview_version", 0)
            presets[key]["preview"] = None
            presets[key]["preview_version"] = current_version + 1
            save_presets(presets)

        publish_change("preview", key)

        return web.json_response({"status": "ok"})

    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)})


@routes.get("/preset_loader/preview/{filename}")
async def serve_preview(request):
    """
    GET /preset_loader/preview/{filename}
    Serves a preview image file to the JS.
    Returns 404 if the file doesn't exist.
    """
    filename     = request.match_info["filename"]
    preview_path = PREVIEWS_DIR / filename

    # Security check — prevent path traversal attacks
    if not str(preview_path.resolve()).startswith(str(PREVIEWS_DIR.resolve())):
        return web.Response(status=403)

    if not preview_path.exists():
        return web.Response(status=404)

    return web.FileResponse(preview_path)


@routes.get("/preset_loader/browse")
async def browse_presets(request):
    """
    GET /preset_loader/browse
    Serves the standalone, mobile-friendly editor page (web/browse.html). Open
    this in a phone browser to edit a preset's text and save it, create new
    presets, delete presets, or copy text to paste into the node's text box in
    the mobile frontend. The page reuses the /preset_loader/list, /save, and
    /delete endpoints. Served from disk each request, so edits to browse.html
    take effect on reload without restarting ComfyUI.
    """
    if not BROWSE_HTML.exists():
        return web.Response(status=404, text="browse.html not found")
    return web.FileResponse(BROWSE_HTML)


# NODE CLASS

class PresetLoaderNode:

    # Sentinel for "no preset selected" — kept as a constant so the JS and the
    # backend agree on the exact string.
    NONE_CHOICE = "(none)"

    @classmethod
    def INPUT_TYPES(cls):
        # Build the dropdown choices from presets.json at object_info time.
        # Declaring `preset` as a real widget (instead of a JS-only DOM widget)
        # is what lets ANY frontend render the selector natively — including the
        # experimental mobile frontend, which never runs our JS. Frontends re-fetch
        # /object_info on reload, so newly saved presets appear after a refresh.
        preset_choices = [cls.NONE_CHOICE] + list(load_presets().keys())
        # NOTE: widget order matters. ComfyUI serializes widget values as a
        # POSITIONAL array (widgets_values) with no keys, and restores them by
        # position on load. `text` MUST stay first so workflows saved before the
        # `preset` widget existed keep mapping their text to position 0. New
        # widgets always go at the END to preserve backward compatibility.
        return {
            "required": {
                "text": ("STRING", {
                    "multiline":   True,
                    "default":     "",
                    "placeholder": "Load a preset or type freely...",
                }),
                "preset": (preset_choices, {
                    "default": cls.NONE_CHOICE,
                    "tooltip": "Pick a preset. Used only when the text box is empty — anything typed in the text box overrides it.",
                }),
            },
            "optional": {
                # forceInput makes these connection sockets rather than widgets,
                # which matters: ComfyUI puts every *widget* value into the node's
                # cache signature, so a seed widget set to randomize would re-run
                # this node — and everything downstream — on every queue even when
                # preset_id is unused. As sockets they only exist once wired.
                "preset_id": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Pick a preset by number, e.g. 1,2,1 — see the README for the range and choice syntax.",
                }),
                "seed": ("INT", {
                    "forceInput": True,
                    "tooltip": "Drives random picks in preset_id. The same seed always gives the same preset.",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION     = "execute"
    CATEGORY     = "utils/presets"

    @classmethod
    def _resolve_key(cls, preset_id, seed):
        # Turn a preset_id spec ("1,2,1", "1,1,[3:8]", ...) into a preset key.
        # None when nothing is wired or the spec resolves to nothing.
        if not preset_id or not str(preset_id).strip():
            return None
        return id_resolver.resolve(load_presets(), str(preset_id), seed or 0)

    @classmethod
    def _resolve_output(cls, preset, text, preset_id=None, seed=0):
        # The exact string this node outputs for the given inputs. Shared by
        # execute() and IS_CHANGED() so the cache fingerprint tracks precisely
        # the current prompt and nothing else.
        #
        # Priority: the text box wins. If you typed anything, that overrides the
        # preset. Only when the text box is empty do we fall back to the selected
        # preset's text. This makes the node usable on frontends that never run
        # our JS (e.g. the mobile frontend): pick a preset and leave the box empty
        # to use it as-is, or type in the box to override it.
        #
        # On desktop the DOM UI copies the chosen preset into the (editable) text
        # box, so `text` is non-empty there and is used unchanged.
        #
        # A wired preset_id outranks both. Connecting a socket is deliberate in a
        # way that leftover text in a box is not, so it wins when present.
        key = cls._resolve_key(preset_id, seed)
        if key:
            entry = load_presets().get(key)
            if entry and entry.get("text"):
                return entry["text"]

        if text and text.strip():
            return text
        if preset and preset != cls.NONE_CHOICE:
            entry = load_presets().get(preset)
            if entry and entry.get("text"):
                return entry["text"]
        return text

    @classmethod
    def IS_CHANGED(cls, preset=None, text="", preset_id=None, seed=0, **kwargs):
        # ComfyUI caches a node's output keyed on its input widget values. When a
        # preset is used as-is (empty text box, e.g. from the mobile frontend),
        # the selected key stays the same even after the preset is edited on disk,
        # so ComfyUI would serve a stale cached result. Return a fingerprint of
        # the resolved current prompt — the very string execute() produces — so
        # the cache is invalidated only when that output actually changes.
        #
        # **kwargs is load-bearing: ComfyUI passes hidden inputs here, and if this
        # signature rejects them the call raises and the node silently falls back
        # to being cached.
        #
        # preset_id and seed arrive as None/0 even when wired — ComfyUI resolves
        # IS_CHANGED without upstream outputs, so linked inputs are invisible here.
        # That is fine: a linked input reaches the cache key through its upstream
        # node's own signature, so changing the seed upstream still invalidates us.
        output = cls._resolve_output(preset, text, preset_id, seed)
        return hashlib.sha256(output.encode("utf-8")).hexdigest()

    def execute(self, preset=None, text="", preset_id=None, seed=0, unique_id=None):
        # Tell the frontend which preset a wired preset_id landed on so the node
        # can show it. Execution cannot write into widgets, so this goes over
        # ComfyUI's websocket and the JS applies it.
        key = self._resolve_key(preset_id, seed)
        if key:
            try:
                server.PromptServer.instance.send_sync("preset_loader.resolved", {
                    "node_id": unique_id,
                    "key":     key,
                })
            except Exception:
                pass  # a UI update must never break execution

        return (self._resolve_output(preset, text, preset_id, seed),)