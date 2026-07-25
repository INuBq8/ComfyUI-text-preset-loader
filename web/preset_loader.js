// =============================================================================
// preset_loader.js
// =============================================================================

import { app } from "../../scripts/app.js";

// =============================================================================
// CONSTANTS
// =============================================================================

const API_BASE = "/preset_loader";
const presetChangeListeners = new Set();
let presetEventSource = null;

function subscribePresetChanges(listener) {
    presetChangeListeners.add(listener);
    if (!presetEventSource) {
        presetEventSource = new EventSource(`${API_BASE}/events`);
        presetEventSource.addEventListener("presets-changed", (event) => {
            let detail = {};
            try { detail = JSON.parse(event.data || "{}"); } catch (_) {}
            for (const notify of [...presetChangeListeners]) notify(detail);
        });
    }
    return () => {
        presetChangeListeners.delete(listener);
        if (!presetChangeListeners.size && presetEventSource) {
            presetEventSource.close();
            presetEventSource = null;
        }
    };
}

// ── TEXT AREA ────────────────────────────────────────────────────────────────
const TEXT_MIN_HEIGHT     = 160;    // minimum text area height in pixels

// ── PREVIEW ──────────────────────────────────────────────────────────────────
const PREVIEW_HEIGHT     = 200;     // default height of the preview image box (px)
const PREVIEW_MIN_HEIGHT = 80;      // smallest the drag handle allows (px)
const PREVIEW_MAX_HEIGHT = 640;     // largest the drag handle allows (px)

// ── NODE SIZE ────────────────────────────────────────────────────────────────
const NODE_MIN_WIDTH  = 300;       // minimum node width in pixels
const NODE_MIN_HEIGHT = 200;       // minimum node height in pixels

// ── COLOURS ──────────────────────────────────────────────────────────────────
const COLOR_ACCENT         = "#4a90d9";  // save button, dropdown border hover, popups
const COLOR_PRESET_NAME    = "#e8c547";  // last part of preset path in dropdown label
const COLOR_DELETE         = "#cc4444";  // delete button and delete popup
const COLOR_SURFACE        = "#1c1c24";  // background of popups and dropdown
const COLOR_SEARCH_BG      = "#13131a";  // search bar background in dropdown
const COLOR_IMG_BOX_BG     = "#13131a";  // image box background

// ── TOOLTIP ──────────────────────────────────────────────────────────────────
const TOOLTIP_WIDTH  = 120;        // hover tooltip width in pixels
const TOOLTIP_HEIGHT = 80;         // hover tooltip height in pixels

// ── DROPDOWN ─────────────────────────────────────────────────────────────────
const DROPDOWN_MAX_HEIGHT = 220;   // max height of the dropdown list in pixels

// =============================================================================
// API HELPERS
// =============================================================================

async function fetchPresets() {
    const res = await fetch(`${API_BASE}/list`);
    return await res.json();
}

async function savePreset(key, text) {
    const res = await fetch(`${API_BASE}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, text }),
    });
    return await res.json();
}

async function deletePreset(key) {
    const res = await fetch(`${API_BASE}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
    });
    return await res.json();
}

async function uploadPreview(key, file) {
    const formData = new FormData();
    formData.append("key", key);
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/set_preview`, {
        method: "POST",
        body: formData,
    });
    return await res.json();
}

async function clearPreview(key) {
    const res = await fetch(`${API_BASE}/clear_preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
    });
    return await res.json();
}

async function presetAction(action, body) {
    const res = await fetch(`${API_BASE}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return await res.json();
}

// =============================================================================
// POPUP HELPERS
// =============================================================================

function createPopupBase() {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 9998;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    const popup = document.createElement("div");
    popup.style.cssText = `
        background: ${COLOR_SURFACE};
        border: 1px solid #4a4a64;
        border-radius: 8px;
        padding: 16px;
        min-width: 300px;
        max-width: 420px;
        z-index: 9999;
        font-family: monospace;
        box-shadow: 0 20px 50px rgba(0,0,0,0.7);
    `;
    overlay.appendChild(popup);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    return { overlay, popup };
}

function showSaveAsPopup(currentKey, currentText, onSaved) {
    const { overlay, popup } = createPopupBase();
    popup.innerHTML = `
        <div style="font-size:13px;font-weight:bold;color:${COLOR_ACCENT};margin-bottom:12px;letter-spacing:1px;display:flex;align-items:center;gap:8px;">
            <span style="display:block;width:3px;height:14px;background:${COLOR_ACCENT};border-radius:2px;"></span>
            SAVE PRESET
        </div>
        <input id="pl-save-input" type="text" value="${currentKey || ""}" placeholder="Group/Subgroup/Name" style="
            background:#13131a;border:1px solid ${COLOR_ACCENT}66;border-radius:5px;
            padding:7px 10px;font-family:monospace;font-size:12px;color:#d0cde8;
            width:100%;outline:none;box-sizing:border-box;margin-bottom:8px;
        "/>
        <div style="margin-bottom:14px;display:flex;flex-direction:column;gap:4px;">
            <div style="font-size:10px;color:#6a6880;display:flex;align-items:center;gap:6px;">
                <span style="background:${COLOR_ACCENT}18;border:1px solid ${COLOR_ACCENT}33;color:${COLOR_ACCENT};font-size:9px;padding:1px 5px;border-radius:3px;">same name</span>
                overwrites the existing preset
            </div>
            <div style="font-size:10px;color:#6a6880;display:flex;align-items:center;gap:6px;">
                <span style="background:${COLOR_ACCENT}18;border:1px solid ${COLOR_ACCENT}33;color:${COLOR_ACCENT};font-size:9px;padding:1px 5px;border-radius:3px;">new name</span>
                saves as a new preset entry
            </div>
            <div style="font-size:10px;color:#6a6880;display:flex;align-items:center;gap:6px;">
                <span style="background:${COLOR_ACCENT}18;border:1px solid ${COLOR_ACCENT}33;color:${COLOR_ACCENT};font-size:9px;padding:1px 5px;border-radius:3px;">use /</span>
                to create or nest into groups
            </div>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button id="pl-save-cancel" style="padding:5px 14px;border-radius:4px;border:1px solid #4a4a64;background:transparent;color:#6a6880;font-family:monospace;font-size:10px;cursor:pointer;text-transform:uppercase;letter-spacing:1px;">Cancel</button>
            <button id="pl-save-confirm" style="padding:5px 14px;border-radius:4px;border:1px solid ${COLOR_ACCENT};background:${COLOR_ACCENT};color:#111;font-family:monospace;font-size:10px;cursor:pointer;text-transform:uppercase;letter-spacing:1px;font-weight:bold;">Save</button>
        </div>
    `;
    document.getElementById("pl-save-cancel").onclick = () => overlay.remove();
    document.getElementById("pl-save-confirm").onclick = async () => {
        const key = document.getElementById("pl-save-input").value.trim();
        if (!key) { alert("Preset name cannot be empty."); return; }
        const result = await savePreset(key, currentText);
        if (result.status === "ok") { overlay.remove(); onSaved(key); }
        else alert("Error saving preset: " + result.message);
    };
    const input = document.getElementById("pl-save-input");
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") document.getElementById("pl-save-confirm").click();
        if (e.key === "Escape") overlay.remove();
    });
    setTimeout(() => input.focus(), 50);
}

function showDeletePopup(key, onDeleted) {
    const { overlay, popup } = createPopupBase();
    popup.style.borderColor = "#cc444444";
    popup.innerHTML = `
        <div style="font-size:13px;font-weight:bold;color:#cc4444;margin-bottom:12px;letter-spacing:1px;display:flex;align-items:center;gap:8px;">
            <span style="display:block;width:3px;height:14px;background:#cc4444;border-radius:2px;"></span>
            DELETE PRESET
        </div>
        <div style="font-size:11px;color:#9895b0;line-height:1.7;margin-bottom:6px;">
            Delete <strong style="color:#d0cde8;">"${key}"</strong> permanently?<br>
        </div>
        <div style="font-size:10px;color:#cc444488;margin-bottom:16px;">⚠ This cannot be undone.</div>
        <div style="display:flex;gap:6px;justify-content:flex-end;">
            <button id="pl-del-cancel" style="padding:5px 14px;border-radius:4px;border:1px solid #4a4a64;background:transparent;color:#6a6880;font-family:monospace;font-size:10px;cursor:pointer;text-transform:uppercase;letter-spacing:1px;">Cancel</button>
            <button id="pl-del-confirm" style="padding:5px 14px;border-radius:4px;border:1px solid #cc4444;background:#cc4444;color:#fff;font-family:monospace;font-size:10px;cursor:pointer;text-transform:uppercase;letter-spacing:1px;font-weight:bold;">Delete</button>
        </div>
    `;
    document.getElementById("pl-del-cancel").onclick = () => overlay.remove();
    document.getElementById("pl-del-confirm").onclick = async () => {
        const result = await deletePreset(key);
        if (result.status === "ok") { overlay.remove(); onDeleted(); }
        else alert("Error deleting preset: " + result.message);
    };
}

// =============================================================================
// DROPDOWN
// =============================================================================

function buildTree(presets) {
    const tree = {};
    for (const key of Object.keys(presets)) {
        const parts = key.split("/");
        let node = tree;
        for (let i = 0; i < parts.length - 1; i++) {
            if (!node[parts[i]]) node[parts[i]] = {};
            node = node[parts[i]];
        }
        node[parts[parts.length - 1]] = key;
    }
    return tree;
}

function showDropdown(anchor, presets, currentKey, onSelect, showPreviews = true) {
    document.getElementById("pl-dropdown")?.remove();
    document.getElementById("pl-active-tooltip")?.remove();

    const tree = buildTree(presets);
    const rect = anchor.getBoundingClientRect();

    const container = document.createElement("div");
    container.id = "pl-dropdown";
    container.style.cssText = `
        position: fixed;
        top: ${rect.bottom + 4}px;
        left: ${rect.left}px;
        width: ${rect.width}px;
        background: ${COLOR_SURFACE};
        border: 1px solid #4a4a64;
        border-radius: 8px;
        z-index: 9999;
        box-shadow: 0 16px 40px rgba(0,0,0,0.6);
        overflow: hidden;
        font-family: monospace;
    `;

    const searchWrap = document.createElement("div");
    searchWrap.style.cssText = `padding:8px 10px;border-bottom:1px solid #2e2e3c;background:${COLOR_SEARCH_BG};display:flex;align-items:center;gap:7px;`;
    searchWrap.innerHTML = `<span style="color:#6a6880;font-size:11px;">🔍</span>`;
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "search presets...";
    searchInput.style.cssText = "background:none;border:none;outline:none;font-family:monospace;font-size:11px;color:#d0cde8;flex:1;";
    searchWrap.appendChild(searchInput);
    container.appendChild(searchWrap);

    const body = document.createElement("div");
    body.style.cssText = `max-height:${DROPDOWN_MAX_HEIGHT}px;overflow-y:auto;padding:6px;`;
    container.appendChild(body);

    function renderTree(filter = "") {
        body.innerHTML = "";
        const lf = filter.toLowerCase();
        const matchingKeys = Object.keys(presets).filter(k => !filter || k.toLowerCase().includes(lf));
        if (matchingKeys.length === 0) {
            body.innerHTML = `<div style="font-size:10px;color:#6a6880;padding:8px 10px;">No results</div>`;
            return;
        }
        if (filter) {
            matchingKeys.forEach(key => body.appendChild(makeItem(key, presets[key])));
        } else {
            renderNode(tree, body, presets);
        }
    }

    function renderNode(node, parent, presets, depth = 0) {
        for (const [name, value] of Object.entries(node)) {
            if (typeof value === "string") {
                parent.appendChild(makeItem(value, presets[value], depth));
            } else {
                const groupEl = document.createElement("div");
                groupEl.style.cssText = `
                    font-size:${depth === 0 ? "9px" : "8px"};
                    color:${depth === 0 ? COLOR_ACCENT : "#6a6880"};
                    letter-spacing:${depth === 0 ? "2px" : "1px"};
                    text-transform:uppercase;
                    padding:4px 8px 2px ${8 + depth * 12}px;
                    display:flex;align-items:center;gap:5px;
                `;
                groupEl.innerHTML = `<span style="font-size:7px;">▸</span> ${name}`;
                parent.appendChild(groupEl);
                renderNode(value, parent, presets, depth + 1);
            }
        }
    }

    function makeItem(key, preset, depth = 0) {
        const name = key.split("/").pop();
        const item = document.createElement("div");
        item.style.cssText = `
            padding:5px 8px 5px ${20 + depth * 12}px;
            font-size:11px;
            color:${key === currentKey ? COLOR_ACCENT : "#9895b0"};
            background:${key === currentKey ? COLOR_ACCENT + "18" : "transparent"};
            border:1px solid ${key === currentKey ? COLOR_ACCENT + "30" : "transparent"};
            border-radius:4px;cursor:pointer;
            display:flex;align-items:center;gap:6px;
        `;
        item.innerHTML = `<span style="font-size:5px;color:${key === currentKey ? COLOR_ACCENT : "#4a4a64"};">◆</span> ${name}`;

        if (showPreviews && preset?.preview) {
            let tooltip = null;
            function removeTooltip() { tooltip?.remove(); tooltip = null; }

            item.addEventListener("mouseenter", () => {
                removeTooltip();
                tooltip = document.createElement("div");
                tooltip.id = "pl-active-tooltip";
                tooltip.style.cssText = `
                    position:fixed;width:${TOOLTIP_WIDTH}px;height:${TOOLTIP_HEIGHT}px;
                    background:#111118;border:1px solid ${COLOR_ACCENT}44;
                    border-radius:5px;overflow:hidden;
                    box-shadow:4px 0 16px rgba(0,0,0,0.5);
                    pointer-events:none;z-index:10000;
                `;
                const tImg = document.createElement("img");
                tImg.src = `${API_BASE}/preview/${preset.preview}?v=${preset.preview_version ?? 0}`;
                tImg.style.cssText = "width:100%;height:100%;object-fit:contain;opacity:0.85;";
                tooltip.appendChild(tImg);
                const r = item.getBoundingClientRect();
                tooltip.style.left = (r.right + 8) + "px";
                tooltip.style.top  = (r.top + r.height / 2 - 40) + "px";
                document.body.appendChild(tooltip);
            });
            item.addEventListener("mouseleave", removeTooltip);
            item.addEventListener("mousemove", (e) => {
                if (!tooltip) return;
                const r = item.getBoundingClientRect();
                if (e.clientX < r.left || e.clientX > r.right + 130 || e.clientY < r.top || e.clientY > r.bottom) removeTooltip();
            });
        }

        item.addEventListener("click", () => {
            document.getElementById("pl-dropdown")?.remove();
            document.getElementById("pl-active-tooltip")?.remove();
            onSelect(key, presets[key]);
        });
        item.addEventListener("mouseenter", () => { if (key !== currentKey) item.style.background = "#252530"; });
        item.addEventListener("mouseleave", () => { if (key !== currentKey) item.style.background = "transparent"; });
        return item;
    }

    renderTree();
    searchInput.addEventListener("input", () => renderTree(searchInput.value));
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape") container.remove(); });
    document.body.appendChild(container);

    setTimeout(() => {
        document.addEventListener("click", function handler(e) {
            if (!container.contains(e.target) && !anchor.contains(e.target)) {
                container.remove();
                document.getElementById("pl-active-tooltip")?.remove();
                document.removeEventListener("click", handler);
            }
        });
        searchInput.focus();
    }, 0);
}

function showNamePopup(title, initialValue, confirmLabel, onConfirm) {
    const { overlay, popup } = createPopupBase();
    const heading = document.createElement("div");
    heading.textContent = title;
    heading.style.cssText = `font-size:13px;font-weight:700;color:${COLOR_ACCENT};margin-bottom:12px;letter-spacing:.08em;`;
    const input = document.createElement("input");
    input.type = "text";
    input.value = initialValue || "";
    input.placeholder = "Category/Subcategory/Name";
    input.style.cssText = `background:#13131a;border:1px solid ${COLOR_ACCENT}66;border-radius:6px;padding:8px 10px;
        font-family:monospace;font-size:12px;color:#d0cde8;width:100%;outline:none;box-sizing:border-box;margin-bottom:14px;`;
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:7px;justify-content:flex-end;";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const confirm = document.createElement("button");
    confirm.textContent = confirmLabel;
    for (const button of [cancel, confirm]) button.style.cssText = "padding:6px 14px;border-radius:5px;border:1px solid #4a4a64;background:transparent;color:#c8cad2;font:10px monospace;cursor:pointer;";
    confirm.style.background = COLOR_ACCENT;
    confirm.style.borderColor = COLOR_ACCENT;
    confirm.style.color = "#11151d";
    confirm.style.fontWeight = "700";
    cancel.onclick = () => overlay.remove();
    confirm.onclick = async () => {
        const value = input.value.trim();
        if (!value) return;
        const ok = await onConfirm(value);
        if (ok !== false) overlay.remove();
    };
    input.onkeydown = event => {
        if (event.key === "Enter") confirm.click();
        if (event.key === "Escape") overlay.remove();
    };
    actions.append(cancel, confirm);
    popup.append(heading, input, actions);
    setTimeout(() => { input.focus(); input.select(); }, 30);
}

function showCategoryDropdown(anchor, presets, currentKey, onSelect, showPreviews = true) {
    document.getElementById("pl-dropdown")?.remove();
    document.getElementById("pl-active-tooltip")?.remove();

    const keys = Object.keys(presets);
    const categoryCounts = new Map();
    for (const key of keys) {
        const parts = key.split("/");
        parts.pop();
        for (let i = 1; i <= parts.length; i++) {
            const path = parts.slice(0, i).join("/");
            categoryCounts.set(path, (categoryCounts.get(path) || 0) + 1);
        }
    }
    const categories = [...categoryCounts.entries()].sort((a, b) =>
        a[0].localeCompare(b[0], undefined, { sensitivity: "base", numeric: true })
    );
    let activeCategory = currentKey?.includes("/")
        ? currentKey.split("/").slice(0, -1).join("/") : "";
    const pinnedCount = keys.filter(key => presets[key]?.pinned).length;
    const recentCount = keys.filter(key => presets[key]?.last_used_at).length;

    const container = document.createElement("div");
    container.id = "pl-dropdown";
    container.style.cssText = `
        position:fixed;width:min(540px,calc(100vw - 24px));height:min(390px,calc(100vh - 24px));
        background:#17191f;border:1px solid #343946;border-radius:12px;z-index:9999;
        box-shadow:0 22px 60px rgba(0,0,0,.68);overflow:hidden;
        font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
        display:flex;flex-direction:column;color:#eef0f4;
    `;

    const header = document.createElement("div");
    header.style.cssText = "padding:10px;border-bottom:1px solid #292d37;display:flex;gap:8px;align-items:center;";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search presets and prompt text…";
    searchInput.style.cssText = "min-width:0;flex:1;height:38px;background:#101216;border:1px solid #303541;border-radius:9px;padding:0 11px;outline:none;color:#eef0f4;font:12px inherit;";
    searchInput.addEventListener("focus", () => searchInput.style.borderColor = COLOR_ACCENT);
    searchInput.addEventListener("blur", () => searchInput.style.borderColor = "#303541");
    const libraryButton = document.createElement("button");
    libraryButton.textContent = "Library";
    libraryButton.title = "Open full prompt library";
    libraryButton.style.cssText = "height:38px;border:1px solid #303541;border-radius:9px;background:#20232b;color:#cbd0dc;padding:0 12px;cursor:pointer;font:11px inherit;";
    libraryButton.onclick = () => window.open(`${API_BASE}/browse`, "_blank", "noopener");
    header.append(searchInput, libraryButton);
    container.appendChild(header);

    const main = document.createElement("div");
    main.style.cssText = "display:grid;grid-template-columns:158px minmax(0,1fr);min-height:0;flex:1;";
    const nav = document.createElement("div");
    nav.style.cssText = "padding:7px;border-right:1px solid #292d37;overflow-y:auto;background:#14161b;";
    const content = document.createElement("div");
    content.style.cssText = "min-width:0;display:flex;flex-direction:column;overflow:hidden;";
    const crumbs = document.createElement("div");
    crumbs.style.cssText = "min-height:38px;padding:8px 11px;border-bottom:1px solid #292d37;display:flex;align-items:center;gap:5px;color:#858b99;font-size:10px;white-space:nowrap;overflow:hidden;";
    const results = document.createElement("div");
    results.style.cssText = "padding:7px;overflow-y:auto;min-height:0;flex:1;";
    content.append(crumbs, results);
    main.append(nav, content);
    container.appendChild(main);

    function navButton(label, count, path, depth = 0) {
        const button = document.createElement("button");
        button.type = "button";
        button.style.cssText = `width:100%;display:flex;align-items:center;gap:6px;border:0;border-radius:7px;
            background:${activeCategory === path ? COLOR_ACCENT + "1c" : "transparent"};
            color:${activeCategory === path ? "#a9beff" : "#a9aebb"};padding:7px 8px 7px ${8 + depth * 13}px;
            cursor:pointer;text-align:left;font:11px inherit;`;
        const text = document.createElement("span");
        text.textContent = label;
        text.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        const badge = document.createElement("span");
        badge.textContent = count;
        badge.style.cssText = "margin-left:auto;color:#6f7583;font-size:9px;font-variant-numeric:tabular-nums;";
        button.append(text, badge);
        button.onclick = () => { activeCategory = path; render(); };
        button.onmouseenter = () => { if (activeCategory !== path) button.style.background = "#20232b"; };
        button.onmouseleave = () => { if (activeCategory !== path) button.style.background = "transparent"; };
        return button;
    }

    function renderNav() {
        nav.replaceChildren();
        const title = document.createElement("div");
        title.textContent = "Categories";
        title.style.cssText = "padding:4px 8px 7px;color:#737a88;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;";
        nav.append(title, navButton("All presets", keys.length, ""));
        if (pinnedCount) nav.appendChild(navButton("Pinned", pinnedCount, "@pinned"));
        if (recentCount) nav.appendChild(navButton("Recent", recentCount, "@recent"));
        for (const [path, count] of categories) {
            const depth = Math.min(2, path.split("/").length - 1);
            nav.appendChild(navButton(path.split("/").pop(), count, path, depth));
        }
    }

    function renderCrumbs() {
        crumbs.replaceChildren();
        const makeCrumb = (label, path, current) => {
            const button = document.createElement("button");
            button.textContent = label;
            button.style.cssText = `border:0;background:transparent;padding:2px;color:${current ? "#e6e9ef" : "#858b99"};cursor:pointer;font:10px inherit;`;
            button.onclick = () => { activeCategory = path; render(); };
            return button;
        };
        crumbs.appendChild(makeCrumb("All", "", !activeCategory));
        if (!activeCategory) return;
        if (activeCategory === "@pinned" || activeCategory === "@recent") {
            const separator = document.createElement("span");
            separator.textContent = "/";
            crumbs.append(separator, makeCrumb(activeCategory === "@pinned" ? "Pinned" : "Recent", activeCategory, true));
            return;
        }
        let path = "";
        for (const part of activeCategory.split("/")) {
            const separator = document.createElement("span");
            separator.textContent = "/";
            crumbs.appendChild(separator);
            path = path ? `${path}/${part}` : part;
            crumbs.appendChild(makeCrumb(part, path, path === activeCategory));
        }
    }

    function removeTooltip() {
        document.getElementById("pl-active-tooltip")?.remove();
    }

    function makeResult(key) {
        const preset = presets[key] || {};
        const parts = key.split("/");
        const name = parts.pop();
        const item = document.createElement("button");
        item.type = "button";
        item.style.cssText = `width:100%;display:block;border:1px solid ${key === currentKey ? COLOR_ACCENT + "55" : "transparent"};
            border-radius:8px;background:${key === currentKey ? COLOR_ACCENT + "16" : "transparent"};padding:8px 9px;
            color:#d8dbe3;text-align:left;cursor:pointer;margin-bottom:3px;`;
        const title = document.createElement("div");
        title.textContent = name;
        title.style.cssText = "font-size:11px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        const meta = document.createElement("div");
        meta.textContent = parts.join(" / ") || "Uncategorised";
        meta.style.cssText = "font-size:9px;color:#747b89;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
        item.append(title, meta);
        item.onclick = () => {
            container.remove(); removeTooltip();
            presetAction("touch", { key }).catch(() => {});
            onSelect(key, preset);
        };
        item.onmouseenter = () => {
            if (key !== currentKey) item.style.background = "#22252d";
            if (!showPreviews || !preset.preview) return;
            removeTooltip();
            const tooltip = document.createElement("div");
            tooltip.id = "pl-active-tooltip";
            tooltip.style.cssText = `position:fixed;width:180px;height:120px;background:#0d0f13;border:1px solid #343946;
                border-radius:9px;overflow:hidden;box-shadow:0 14px 38px rgba(0,0,0,.6);pointer-events:none;z-index:10000;`;
            const image = document.createElement("img");
            image.src = `${API_BASE}/preview/${encodeURIComponent(preset.preview)}?v=${preset.preview_version ?? 0}`;
            image.style.cssText = "width:100%;height:100%;object-fit:contain;";
            tooltip.appendChild(image);
            document.body.appendChild(tooltip);
            const box = item.getBoundingClientRect();
            const left = Math.min(innerWidth - 190, box.right + 8);
            tooltip.style.left = Math.max(8, left) + "px";
            tooltip.style.top = Math.max(8, Math.min(innerHeight - 128, box.top - 35)) + "px";
        };
        item.onmouseleave = () => { if (key !== currentKey) item.style.background = "transparent"; removeTooltip(); };
        return item;
    }

    function renderResults() {
        results.replaceChildren();
        const query = searchInput.value.trim().toLocaleLowerCase();
        const matching = keys.filter(key =>
            (!activeCategory || activeCategory === "@pinned" && presets[key]?.pinned ||
                activeCategory === "@recent" && presets[key]?.last_used_at || key.startsWith(activeCategory + "/")) &&
            (!query || `${key} ${presets[key]?.text || ""}`.toLocaleLowerCase().includes(query))
        ).sort((a, b) => activeCategory === "@recent"
            ? String(presets[b]?.last_used_at || "").localeCompare(String(presets[a]?.last_used_at || ""))
            : a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
        if (!matching.length) {
            const empty = document.createElement("div");
            empty.textContent = "No matching presets";
            empty.style.cssText = "padding:18px 10px;color:#737a88;font-size:10px;text-align:center;";
            results.appendChild(empty);
            return;
        }
        for (const key of matching) results.appendChild(makeResult(key));
    }

    function render() { renderNav(); renderCrumbs(); renderResults(); }
    searchInput.addEventListener("input", renderResults);
    searchInput.addEventListener("keydown", event => {
        if (event.key === "Escape") { container.remove(); removeTooltip(); }
    });

    document.body.appendChild(container);
    const rect = anchor.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - box.width - 8, rect.left));
    const roomBelow = innerHeight - rect.bottom;
    const top = roomBelow >= box.height + 6
        ? rect.bottom + 5 : Math.max(8, rect.top - box.height - 5);
    container.style.left = left + "px";
    container.style.top = top + "px";
    render();

    setTimeout(() => {
        const outsideHandler = event => {
            if (!container.contains(event.target) && !anchor.contains(event.target)) {
                container.remove(); removeTooltip();
                document.removeEventListener("pointerdown", outsideHandler, true);
            }
        };
        document.addEventListener("pointerdown", outsideHandler, true);
        searchInput.focus();
    }, 0);
}

// =============================================================================
// EXTENSION
// =============================================================================

app.registerExtension({
    name: "presetloader.PresetLoader",

    async nodeCreated(node) {
        if (node.comfyClass !== "PresetLoader") return;

        // ── STATE ────────────────────────────────────────────────────────────
        let presets     = {};
        let selectedKey = null;
        let lastLoadedText = null;

        presets = await fetchPresets();

        // ── MINIMUM NODE SIZE ────────────────────────────────────────────────
        node.minSize = [NODE_MIN_WIDTH, NODE_MIN_HEIGHT];
        const origResize = node.onResize;
        node.onResize = function(size) {
            size[0] = Math.max(size[0], NODE_MIN_WIDTH);
            size[1] = Math.max(size[1], NODE_MIN_HEIGHT);
            origResize?.call(this, size);
        };

        // ── NATIVE PRESET WIDGET (mobile / non-canvas frontends) ─────────────
        // Python declares a real `preset` COMBO so frontends that don't run this
        // JS (e.g. the experimental mobile frontend) can render and use the
        // selector. On the desktop canvas we hide it — the rich DOM dropdown
        // below replaces it — and keep it at "(none)" so the backend uses this
        // node's editable text box instead of the preset.
        const NONE_CHOICE = "(none)";
        const presetWidget = node.widgets.find(w => w.name === "preset");
        if (presetWidget) {
            presetWidget.value = NONE_CHOICE;
            presetWidget.hidden = true;                 // legacy canvas rendering
            presetWidget.options = presetWidget.options || {};
            presetWidget.options.hidden = true;         // Vue "nodes v2" rendering
            presetWidget.computeSize = () => [0, -4];   // collapse its reserved row
        }

        // ── NATIVE TEXT WIDGET ───────────────────────────────────────────────
        const textWidget = node.widgets.find(w => w.name === "text");
        // element is the correct property (inputEl is deprecated)
        const textWidgetEl = textWidget?.element ?? null;

        // Helper — reads current text widget colours from the live theme
        function getThemeColors() {
            if (!textWidgetEl) return { bg: "#1e1e2a", color: "#d0cde8" };
            const cs = getComputedStyle(textWidgetEl);
            return { bg: cs.backgroundColor, color: cs.color };
        }

        // ── SINGLE CONTAINER WIDGET ──────────────────────────────────────────
        const uiWidget = node.addDOMWidget("preset_ui", "div", (() => {
            const root = document.createElement("div");
            root.style.cssText = `
                display: flex;
                flex-direction: column;
                gap: 6px;
                width: 100%;
                min-width: 0;
                max-width: 100%;
                overflow: hidden;
                box-sizing: border-box;
            `;

            // ── DROPDOWN ────────────────────────────────────────────────────
            const dropdownEl = document.createElement("div");

            function syncDropdownColor() {
                const { bg } = getThemeColors();
                dropdownEl.style.background = bg;
            }

            dropdownEl.style.cssText = `
                background: #1e1e2a;
                border: 1px solid #2e2e3c;
                border-radius: 5px;
                padding: 6px 10px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                cursor: pointer;
                font-family: monospace;
                font-size: 11px;
                color: #6a6880;
                user-select: none;
                box-sizing: border-box;
                flex-shrink: 0;
                min-width: 0;
                overflow: hidden;
            `;

            // Initial sync
            syncDropdownColor();

            // Observers are registered after updateLabel is defined — see below

            dropdownEl.innerHTML = `<span id="pl-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">— select preset —</span><span style="color:#6a6880;font-size:9px;flex-shrink:0;margin-left:6px;">▾</span>`;
            dropdownEl.addEventListener("click", async () => {
                // Re-read presets.json every time the dropdown opens so edits made
                // elsewhere (e.g. the /preset_loader/browse page) show up without
                // reloading the workflow.
                presets = await fetchPresets();
                showCategoryDropdown(dropdownEl, presets, selectedKey, (key) => {
                    selectedKey = key;
                    persistKey();
                    textWidget.value = presets[key].text;
                    lastLoadedText = presets[key].text;
                    updateLabel();
                    updatePreview();
                    node.setDirtyCanvas(true);
                }, previewEnabled());
            });
            dropdownEl.addEventListener("mouseenter", () => dropdownEl.style.borderColor = COLOR_ACCENT);
            dropdownEl.addEventListener("mouseleave", () => dropdownEl.style.borderColor = "#2e2e3c");
            root.appendChild(dropdownEl);

            // ── PREVIEW AREA ─────────────────────────────────────────────────
            // Hidden by default; updatePreview() shows it when a preset with a
            // preview image is selected AND the per-node "Show preset preview"
            // toggle (right-click menu) is on. A fixed-height image box keeps the
            // widget's computeSize deterministic.
            const previewArea = document.createElement("div");
            previewArea.id = "pl-preview-area";
            previewArea.style.cssText = `
                display: none;
                flex-direction: column;
                gap: 4px;
                box-sizing: border-box;
                flex-shrink: 0;
            `;

            const imgBox = document.createElement("div");
            imgBox.id = "pl-img-box";
            imgBox.style.cssText = `
                background: ${COLOR_IMG_BOX_BG};
                border: 1px solid #2e2e3c;
                border-radius: 5px;
                height: ${PREVIEW_HEIGHT}px;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
                box-sizing: border-box;
                position: relative;
            `;

            const img = document.createElement("img");
            img.id = "pl-img";
            img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;display:none;border-radius:4px;";
            imgBox.appendChild(img);

            const noPreview = document.createElement("div");
            noPreview.id = "pl-no-preview";
            noPreview.style.cssText = "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:24px 0;";
            noPreview.innerHTML = `
                <span style="font-size:18px;opacity:0.2;">🖼</span>
                <span style="font-size:8px;color:#6a6880;letter-spacing:1px;">NO PREVIEW</span>
            `;
            imgBox.appendChild(noPreview);

            const fileInput = document.createElement("input");
            fileInput.type = "file";
            fileInput.accept = "image/*";
            fileInput.style.display = "none";
            imgBox.appendChild(fileInput);

            const setImgBtn = document.createElement("button");
            setImgBtn.textContent = "📁 set image";
            setImgBtn.style.cssText = `
                position:absolute;bottom:8px;right:8px;
                background:rgba(0,0,0,0.65);border:1px solid #4a4a64;border-radius:4px;
                padding:3px 7px;font-family:monospace;font-size:9px;color:#9895b0;
                cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;
                backdrop-filter:blur(4px);z-index:1;
            `;
            setImgBtn.addEventListener("mouseenter", () => { setImgBtn.style.borderColor = COLOR_ACCENT; setImgBtn.style.color = COLOR_ACCENT; });
            setImgBtn.addEventListener("mouseleave", () => { setImgBtn.style.borderColor = "#4a4a64"; setImgBtn.style.color = "#9895b0"; });
            setImgBtn.addEventListener("click", () => {
                if (!selectedKey) { alert("Please select a preset first."); return; }
                fileInput.click();
            });
            fileInput.addEventListener("change", async () => {
                const file = fileInput.files[0];
                if (!file) return;
                const result = await uploadPreview(selectedKey, file);
                if (result.status === "ok") { presets = await fetchPresets(); updatePreview(); }
                else alert("Error setting preview: " + result.message);
                fileInput.value = "";
            });
            imgBox.appendChild(setImgBtn);

            // Clear button — removes the current preset's preview image. Only shown
            // when the selected preset actually has one (toggled in updatePreview).
            const clearImgBtn = document.createElement("button");
            clearImgBtn.id = "pl-clear-img";
            clearImgBtn.textContent = "🗑 clear";
            clearImgBtn.style.cssText = `
                position:absolute;bottom:8px;left:8px;
                background:rgba(0,0,0,0.65);border:1px solid ${COLOR_DELETE}66;border-radius:4px;
                padding:3px 7px;font-family:monospace;font-size:9px;color:#c98a8a;
                cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;
                backdrop-filter:blur(4px);z-index:1;display:none;
            `;
            clearImgBtn.addEventListener("mouseenter", () => { clearImgBtn.style.borderColor = COLOR_DELETE; clearImgBtn.style.color = "#ffffff"; });
            clearImgBtn.addEventListener("mouseleave", () => { clearImgBtn.style.borderColor = `${COLOR_DELETE}66`; clearImgBtn.style.color = "#c98a8a"; });
            clearImgBtn.addEventListener("click", async () => {
                if (!selectedKey) return;
                const result = await clearPreview(selectedKey);
                if (result.status === "ok") { presets = await fetchPresets(); updatePreview(); }
                else alert("Error clearing preview: " + result.message);
            });
            imgBox.appendChild(clearImgBtn);

            // Drag handle — lets the user set the preview box height. The height is
            // persisted in node.properties.previewHeight and reapplied on reload.
            const resizeHandle = document.createElement("div");
            resizeHandle.title = "Drag to resize preview";
            resizeHandle.innerHTML = `<span style="font-size:9px;color:#6a6880;letter-spacing:2px;line-height:1;">⠿</span>`;
            resizeHandle.style.cssText = `
                position:absolute;bottom:0;left:50%;transform:translateX(-50%);
                width:48px;height:14px;display:flex;align-items:center;justify-content:center;
                cursor:ns-resize;z-index:2;border-top-left-radius:4px;border-top-right-radius:4px;
                background:rgba(0,0,0,0.35);backdrop-filter:blur(2px);
            `;
            resizeHandle.addEventListener("mouseenter", () => resizeHandle.firstElementChild.style.color = COLOR_ACCENT);
            resizeHandle.addEventListener("mouseleave", () => resizeHandle.firstElementChild.style.color = "#6a6880");
            resizeHandle.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();           // don't let LiteGraph start dragging the node
                resizeHandle.setPointerCapture?.(e.pointerId);
                const scale     = app.canvas?.ds?.scale || 1;  // overlay is CSS-scaled by zoom
                const startY    = e.clientY;
                const startBoxH = imgBox.offsetHeight;
                const startNodeH = node.size[1];

                const onMove = (ev) => {
                    const delta = (ev.clientY - startY) / scale;
                    const boxH  = Math.max(PREVIEW_MIN_HEIGHT, Math.min(PREVIEW_MAX_HEIGHT, startBoxH + delta));
                    imgBox.style.height = boxH + "px";
                    // Grow/shrink the node by the same amount so the text area above
                    // keeps its size instead of being squeezed.
                    node.setSize([node.size[0], startNodeH + (boxH - startBoxH)]);
                    node.setDirtyCanvas(true, true);
                };
                const onUp = (ev) => {
                    resizeHandle.releasePointerCapture?.(ev.pointerId);
                    resizeHandle.removeEventListener("pointermove", onMove);
                    resizeHandle.removeEventListener("pointerup", onUp);
                    node.properties["previewHeight"] = imgBox.offsetHeight;
                    node.setDirtyCanvas(true, true);
                };
                resizeHandle.addEventListener("pointermove", onMove);
                resizeHandle.addEventListener("pointerup", onUp);
            });
            imgBox.appendChild(resizeHandle);

            previewArea.appendChild(imgBox);
            root.appendChild(previewArea);

            // ── BUTTONS ROW ──────────────────────────────────────────────────
            const btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;gap:6px;width:100%;box-sizing:border-box;flex-shrink:0;";

            function makeBtn(label, bg, border, color, hBorder, hColor, hBg) {
                const btn = document.createElement("button");
                btn.textContent = label;
                btn.style.cssText = `
                    flex:1 1 0;
                    min-width:0;
                    padding:6px 8px;
                    border-radius:5px;border:1px solid ${border};
                    background:${bg};color:${color};
                    font-family:monospace;font-size:9px;font-weight:600;
                    cursor:pointer;text-transform:uppercase;letter-spacing:1px;
                    box-sizing:border-box;white-space:nowrap;
                    overflow:hidden;text-overflow:ellipsis;
                `;
                btn.addEventListener("mouseenter", () => { btn.style.borderColor = hBorder; btn.style.color = hColor; btn.style.background = hBg; });
                btn.addEventListener("mouseleave", () => { btn.style.borderColor = border; btn.style.color = color; btn.style.background = bg; });
                return btn;
            }

            const updateBtn = makeBtn("Update", `${COLOR_ACCENT}24`, COLOR_ACCENT, COLOR_ACCENT, COLOR_ACCENT, "#ffffff", `${COLOR_ACCENT}55`);
            updateBtn.dataset.action = "update";
            updateBtn.onclick = async () => {
                if (!selectedKey || textWidget.value === lastLoadedText) return;
                const result = await savePreset(selectedKey, textWidget.value);
                if (result.status !== "ok") return alert("Update failed: " + result.message);
                presets = await fetchPresets();
                textWidget.value = presets[selectedKey].text || "";
                lastLoadedText = textWidget.value;
                updateLabel(); node.setDirtyCanvas(true);
            };

            const copyBtn = makeBtn("Save copy", "transparent", "#4a4a64", "#b7bac5", COLOR_ACCENT, "#ffffff", "#252a34");
            copyBtn.onclick = () => {
                const suggested = selectedKey ? selectedKey + " copy" : "New preset";
                showNamePopup("SAVE AS NEW PRESET", suggested, "Save copy", async newKey => {
                    presets = await fetchPresets();
                    if (presets[newKey]) { alert("A preset with that name already exists."); return false; }
                    const result = selectedKey
                        ? await presetAction("duplicate", { source_key: selectedKey, new_key: newKey })
                        : await savePreset(newKey, textWidget.value);
                    if (result.status !== "ok") { alert("Save failed: " + result.message); return false; }
                    if (selectedKey) {
                        const textResult = await savePreset(newKey, textWidget.value);
                        if (textResult.status !== "ok") { alert("Save failed: " + textResult.message); return false; }
                    }
                    presets = await fetchPresets(); selectedKey = newKey;
                    textWidget.value = presets[newKey].text || ""; lastLoadedText = textWidget.value;
                    persistKey(); updateLabel(); updatePreview(); return true;
                });
            };

            const moreBtn = makeBtn("•••", "transparent", "#4a4a64", "#a7abb7", COLOR_ACCENT, "#ffffff", "#252a34");
            moreBtn.style.flex = "0 0 44px";
            moreBtn.title = "Preset actions";
            moreBtn.onclick = () => {
                document.getElementById("pl-actions-menu")?.remove();
                if (!selectedKey) return alert("Please select a preset first.");
                const menu = document.createElement("div");
                menu.id = "pl-actions-menu";
                menu.style.cssText = "position:fixed;z-index:10001;width:180px;padding:5px;background:#181a20;border:1px solid #363b47;border-radius:9px;box-shadow:0 16px 40px #0009;";
                const addAction = (label, handler, danger = false) => {
                    const action = document.createElement("button");
                    action.textContent = label;
                    action.style.cssText = `display:block;width:100%;border:0;border-radius:6px;background:transparent;color:${danger ? "#e78186" : "#c9ccd5"};padding:8px 9px;text-align:left;cursor:pointer;font:11px monospace;`;
                    action.onmouseenter = () => action.style.background = "#252832";
                    action.onmouseleave = () => action.style.background = "transparent";
                    action.onclick = () => { menu.remove(); handler(); };
                    menu.appendChild(action);
                };
                addAction(presets[selectedKey]?.pinned ? "Unpin preset" : "Pin preset", async () => {
                    await presetAction("pin", { key: selectedKey, pinned: !presets[selectedKey]?.pinned });
                    presets = await fetchPresets(); updateLabel();
                });
                addAction("Rename / move…", () => showNamePopup("RENAME OR MOVE PRESET", selectedKey, "Move", async newKey => {
                    const result = await presetAction("rename", { old_key: selectedKey, new_key: newKey });
                    if (result.status !== "ok") { alert(result.message); return false; }
                    selectedKey = result.key; presets = await fetchPresets();
                    lastLoadedText = presets[selectedKey]?.text || textWidget.value;
                    persistKey(); updateLabel(); updatePreview(); return true;
                }));
                addAction("Delete preset…", () => showDeletePopup(selectedKey, async () => {
                    presets = await fetchPresets(); selectedKey = null; lastLoadedText = null;
                    persistKey(); textWidget.value = ""; updateLabel(); updatePreview(); node.setDirtyCanvas(true);
                }), true);
                document.body.appendChild(menu);
                const rect = moreBtn.getBoundingClientRect(), box = menu.getBoundingClientRect();
                menu.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, rect.right - box.width)) + "px";
                menu.style.top = Math.max(8, rect.top - box.height - 6) + "px";
                setTimeout(() => document.addEventListener("pointerdown", function close(event) {
                    if (!menu.contains(event.target) && event.target !== moreBtn) { menu.remove(); document.removeEventListener("pointerdown", close, true); }
                }, true), 0);
            };

            btnRow.append(updateBtn, copyBtn, moreBtn);
            root.appendChild(btnRow);

            return root;
        })());

        // ── SIZE THE UI WIDGET TO ITS CONTENT ────────────────────────────────
        // By default a DOM widget is a "fill" widget: ComfyUI gives it all the
        // node's leftover height, which shows up as an empty gap. Report only the
        // natural height of the visible rows (dropdown + optional preview +
        // buttons) so the native multiline `text` widget fills the rest. The
        // preview row collapses to 0 when hidden, so toggling it re-flows cleanly.
        uiWidget.computeSize = function (width) {
            // Keep the DOM overlay pinned to the node's width. A DOM widget stores
            // its own numeric `width`; if that ever drifts from the node (ComfyUI
            // seeds it from the element's natural content width at creation) the
            // overlay renders at that stale width and overflows the node — and the
            // node looks un-resizable. Native widgets avoid this by leaving `width`
            // undefined; we re-sync it here on every layout pass instead.
            uiWidget.width = node.size[0];

            const root = uiWidget.element;
            let h = 0;
            let visibleRows = 0;
            for (const child of root.children) {
                const ch = child.offsetHeight;
                if (ch > 0) { h += ch; visibleRows++; }
            }
            h += 6 * Math.max(0, visibleRows - 1); // column gap between visible rows
            h += 18;                                // trim slack under the buttons
            return [width, h > 0 ? h : 60];
        };

        // ── WORKFLOW PERSISTENCE ─────────────────────────────────────────────
        node.properties = node.properties || {};

        // Reapply a persisted preview height (set via the drag handle).
        if (node.properties["previewHeight"]) {
            const box = uiWidget.element.querySelector("#pl-img-box");
            if (box) {
                box.style.height = Math.max(PREVIEW_MIN_HEIGHT,
                    Math.min(PREVIEW_MAX_HEIGHT, node.properties["previewHeight"])) + "px";
            }
        }

        const savedKey = node.properties["selectedKey"];
        if (savedKey) {
            fetchPresets().then(p => {
                presets = p;
                if (presets[savedKey]) {
                    selectedKey = savedKey;
                    lastLoadedText = presets[savedKey].text;
                    updateLabel();
                    updatePreview();
                    node.setDirtyCanvas(true);
                } else {
                    delete node.properties["selectedKey"];
                }
            });
        }

        // ── UPDATE HELPERS ───────────────────────────────────────────────────

        function persistKey() {
            node.properties["selectedKey"] = selectedKey;
        }

        // Per-node preview toggle. Defaults to ON; persisted in the workflow via
        // node.properties so it survives save/reload. Only an explicit `false`
        // (set from the "Show preset preview" right-click menu) hides it.
        function previewEnabled() {
            return node.properties?.["showPreview"] !== false;
        }

        // Show / hide + populate the in-node preview image. Called whenever the
        // selection, the presets data, or the toggle changes. Kept in sync with
        // `previewEnabled()` so the "Show preset preview" menu item fully controls it.
        function updatePreview() {
            const el        = uiWidget.element;
            const area      = el.querySelector("#pl-preview-area");
            const img       = el.querySelector("#pl-img");
            const noPreview = el.querySelector("#pl-no-preview");
            const clearBtn  = el.querySelector("#pl-clear-img");
            if (!area) return;

            const preset = selectedKey ? presets[selectedKey] : null;

            // The "clear" button only makes sense when the preset has an image.
            if (clearBtn) clearBtn.style.display = preset?.preview ? "block" : "none";

            // Hidden only when the toggle is off. When on, the box stays visible
            // even with no preset selected — it shows the NO PREVIEW placeholder.
            if (!previewEnabled()) {
                area.style.display = "none";
                node.setDirtyCanvas(true, true);
                return;
            }

            area.style.display = "flex";

            if (preset?.preview) {
                img.style.display       = "block";
                noPreview.style.display = "none";
                // preview_version busts the cache on updates; the extra cb param
                // forces a recheck so a deleted file falls back to NO PREVIEW.
                img.src = `${API_BASE}/preview/${encodeURIComponent(preset.preview)}?v=${preset.preview_version ?? 0}`;
                img.onerror = () => {
                    img.style.display       = "none";
                    img.src                 = "";
                    noPreview.style.display = "flex";
                    img.onerror             = null;
                    node.setDirtyCanvas(true, true);
                };
            } else {
                img.style.display       = "none";
                noPreview.style.display = "flex";
            }

            node.setDirtyCanvas(true, true);
        }

        // ── RIGHT-CLICK MENU: TOGGLE PREVIEW ─────────────────────────────────
        // Adds a "Show preset preview" entry to the node's context menu. Enabling
        // grows the node so the preview isn't cramped; disabling reclaims that
        // space. Both paths recompute the DOM widget height via updatePreview().
        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function (canvas, options) {
            origGetExtraMenuOptions?.apply(this, arguments);
            options.push({
                content: (previewEnabled() ? "✔ " : "") + "Show preset preview",
                callback: () => {
                    const turningOn = !previewEnabled();
                    node.properties["showPreview"] = turningOn;
                    // Grow/shrink the node by the preview's footprint.
                    const delta = (PREVIEW_HEIGHT + 6) * (turningOn ? 1 : -1);
                    node.setSize([node.size[0], Math.max(NODE_MIN_HEIGHT, node.size[1] + delta)]);
                    updatePreview();
                },
            });
        };

        function updateLabel() {
            const label = uiWidget.element.querySelector("#pl-label");
            const updateButton = uiWidget.element.querySelector('[data-action="update"]');
            const { color } = getThemeColors();
            const dirty = Boolean(selectedKey && lastLoadedText !== null && textWidget.value !== lastLoadedText);
            if (updateButton) {
                updateButton.disabled = !dirty;
                updateButton.style.opacity = dirty ? "1" : ".42";
                updateButton.style.cursor = dirty ? "pointer" : "default";
            }

            if (!selectedKey) {
                label.style.color = color;
                label.innerHTML = "— select preset —";
                return;
            }
            const parts = selectedKey.split("/");
            label.style.color = color;
            const pathHtml = parts.map((p, i) =>
                i === parts.length - 1
                    ? `<span style="color:${COLOR_PRESET_NAME};">${p}</span>`
                    : `<span style="color:${color};">${p}</span>`
            ).join(`<span style="color:${color};opacity:0.4;margin:0 2px;">/</span>`);
            const pin = presets[selectedKey]?.pinned ? `<span style="color:#ef88a7;margin-right:5px;">♥</span>` : "";
            const changed = dirty ? `<span title="Unsaved changes" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${COLOR_ACCENT};margin-left:7px;vertical-align:middle;"></span>` : "";
            label.innerHTML = pin + pathHtml + changed;
        }

        // ── THEME CHANGE OBSERVERS ──────────────────────────────────────────
        // Registered here so updateLabel is already defined when they fire.
        // ────────────────────────────────────────────────────────────────────
        function syncTheme() {
            const { bg } = getThemeColors();
            const dropdownEl = uiWidget.element.querySelector("#pl-label")?.parentElement;
            if (dropdownEl) dropdownEl.style.background = bg;
            updateLabel();
        }

        const themeObservers = [];
        const onTextEdited = () => { updateLabel(); node.setDirtyCanvas(true); };
        textWidgetEl?.addEventListener("input", onTextEdited);
        if (textWidgetEl) {
            const textObserver = new MutationObserver(syncTheme);
            textObserver.observe(textWidgetEl, {
                attributes: true, attributeFilter: ["style", "class"]
            });
            themeObservers.push(textObserver);
        }
        const bodyObserver = new MutationObserver(syncTheme);
        bodyObserver.observe(document.body, {
            attributes: true, attributeFilter: ["class", "style"]
        });
        themeObservers.push(bodyObserver);

        const unsubscribeChanges = subscribePresetChanges(async (change) => {
            const previousText = lastLoadedText;
            presets = await fetchPresets();
            if (selectedKey && !presets[selectedKey]) {
                selectedKey = null;
                lastLoadedText = null;
                persistKey();
            } else if (selectedKey && change.key === selectedKey) {
                const nextText = presets[selectedKey].text || "";
                // Preserve an in-progress manual edit; otherwise follow the
                // externally saved preset immediately.
                if (textWidget.value === previousText) textWidget.value = nextText;
                lastLoadedText = nextText;
            }
            updateLabel();
            updatePreview();
            node.setDirtyCanvas(true, true);
        });

        const originalRemoved = node.onRemoved;
        node.onRemoved = function () {
            unsubscribeChanges();
            for (const observer of themeObservers) observer.disconnect();
            textWidgetEl?.removeEventListener("input", onTextEdited);
            document.getElementById("pl-dropdown")?.remove();
            document.getElementById("pl-active-tooltip")?.remove();
            document.getElementById("pl-actions-menu")?.remove();
            originalRemoved?.apply(this, arguments);
        };

        // Render the initial preview state so a fresh node (with no selection)
        // shows the box by default instead of appearing only after a pick.
        updatePreview();

    },
});
