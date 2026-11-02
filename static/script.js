// =============================================================================
// Multi-model comparison panel — frontend
// =============================================================================
// The model catalog and UI defaults come from the backend (/api/models and
// /api/config), which are driven by config/models.yaml. Nothing about which
// models exist or their reasoning options is hardcoded here.
// =============================================================================

// Model catalog: [{id, label, backend, reasoning_effort, available_efforts, configured, ...}]
let AVAILABLE_MODELS = [];
let MODELS_BY_ID = {};
let DEFAULT_PANEL_MODELS = [];
let REASONING_EFFORT_OPTIONS = ["default"];
let DEFAULT_PANEL_COUNT = 6;

// Application state
let panelStates = [];
let currentPanelCount = 6;
let globalRequestInProgress = false;
let globalSystemMessage = "";
let selectedPanelForSystemMessage = null;

// Last-used layout (panel count + each panel's model and reasoning effort), kept in
// localStorage so a refresh or relaunch restores it. Falls back to the config defaults.
const PREFS_KEY = "ai4ais.panelPrefs.v1";

function loadPrefs() {
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch (e) {
        return {};
    }
}

function savePrefs() {
    try {
        // Merge into the saved list so panels beyond the current count keep their
        // choices if the count is raised again.
        const prev = loadPrefs();
        const panels = Array.isArray(prev.panels) ? prev.panels.slice() : [];
        panelStates.forEach((s, i) => {
            panels[i] = { model: s.model, effort: s.reasoningEffort };
        });
        localStorage.setItem(PREFS_KEY, JSON.stringify({ count: currentPanelCount, panels }));
    } catch (e) {
        console.warn("Could not save panel preferences:", e);
    }
}

// ---- Saved chats -------------------------------------------------------------
// Every conversation is autosaved to the server (data/chats/<id>.json) after each
// message. The chat id lives in sessionStorage, so a refresh resumes this tab's
// chat while a new tab starts fresh; older chats come back via the Chats button.
const CURRENT_CHAT_KEY = "ai4ais.currentChatId";
const INCOGNITO_KEY = "ai4ais.incognito"; // sessionStorage: per tab, survives a refresh
let currentChat = null; // {id, title, created_at} once the first message is sent
let incognito = false; // while on, nothing is written to disk and nothing auto-resumes
let saveChain = Promise.resolve(); // serializes PUTs so an older snapshot can't land last

function newChatId() {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function chatTitleFrom(text) {
    const line = (text || "").trim().split("\n")[0].trim();
    if (!line) return "Untitled chat";
    return line.length > 60 ? line.slice(0, 57) + "…" : line;
}

function rememberCurrentChatId(id) {
    try {
        if (id) sessionStorage.setItem(CURRENT_CHAT_KEY, id);
        else sessionStorage.removeItem(CURRENT_CHAT_KEY);
    } catch (e) {
        /* sessionStorage unavailable: the chat still saves, it just won't auto-resume */
    }
}

// Create the chat record the first time a message is sent. In incognito it exists
// only in memory (so turning incognito off later can save it from that point).
function ensureChat(firstMessage) {
    if (currentChat) return currentChat;
    currentChat = {
        id: newChatId(),
        title: chatTitleFrom(firstMessage),
        created_at: new Date().toISOString(),
    };
    if (!incognito) rememberCurrentChatId(currentChat.id);
    return currentChat;
}

// Turning incognito on stops all saving and forgets the tab's chat id, so a refresh
// starts empty. Turning it off saves the chat as it stands now and resumes autosave.
function setIncognito(on) {
    incognito = on;
    try {
        if (on) sessionStorage.setItem(INCOGNITO_KEY, "1");
        else sessionStorage.removeItem(INCOGNITO_KEY);
    } catch (e) {
        /* fine: the flag just won't survive a refresh */
    }
    document.querySelector(".container").classList.toggle("incognito", on);
    const btn = document.getElementById("incognitoBtn");
    btn.classList.toggle("active", on);
    btn.textContent = on ? "Incognito: on" : "Incognito";
    btn.title = on
        ? "Nothing is being saved. Click to turn saving back on (the chat as it stands now gets saved)."
        : "Incognito: nothing is saved to disk while this is on";
    if (on) {
        rememberCurrentChatId(null);
    } else if (currentChat) {
        rememberCurrentChatId(currentChat.id);
        persistChat();
    }
}

// Everything needed to rebuild this screen later: layout, models, system
// messages, and each panel's transcript (what was shown, including errors).
function snapshotChat() {
    return {
        id: currentChat ? currentChat.id : null,
        title: currentChat ? currentChat.title : null,
        created_at: currentChat ? currentChat.created_at : null,
        updated_at: new Date().toISOString(),
        panel_count: currentPanelCount,
        global_system_message: globalSystemMessage,
        panels: panelStates.map((s) => ({
            model: s.model,
            effort: s.reasoningEffort,
            system_message: s.systemMessage || "",
            transcript: s.transcript,
        })),
    };
}

function persistChat() {
    if (!currentChat || incognito) return;
    saveChain = saveChain
        .then(async () => {
            const res = await fetch(`/api/chats/${currentChat.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(snapshotChat()),
            });
            if (!res.ok) console.warn("Could not save chat:", res.status, await res.text());
        })
        .catch((e) => console.warn("Could not save chat:", e));
}

// The API-facing message list is derived from the transcript: the active system
// message first, then every non-error user/assistant turn.
function rebuildMessages(state) {
    const sys = state.systemMessage || globalSystemMessage;
    state.messages = [
        ...(sys ? [{ role: "system", content: sys }] : []),
        ...state.transcript
            .filter((e) => !e.error)
            .map((e) => ({ role: e.role, content: e.content })),
    ];
}

// Append one turn to a panel: transcript (for saving/restoring), the API message
// list (unless it's an error), the screen, and the autosave.
function recordMessage(panelIndex, entry) {
    const state = panelStates[panelIndex];
    state.transcript.push(entry);
    if (!entry.error) state.messages.push({ role: entry.role, content: entry.content });
    displayMessage(
        panelIndex, entry.role, entry.content,
        entry.duration ?? null, entry.thinking ?? null, entry.usage ?? null,
    );
    persistChat();
}

// Rebuild the whole screen from a chat object (saved or freshly snapshotted).
function restoreChat(chat) {
    currentChat = chat.id ? { id: chat.id, title: chat.title, created_at: chat.created_at } : null;
    rememberCurrentChatId(!incognito && currentChat ? currentChat.id : null);
    globalSystemMessage = chat.global_system_message || "";
    document.getElementById("globalSystemMessage").value = globalSystemMessage;
    const count = Math.min(6, Math.max(1, parseInt(chat.panel_count) || currentPanelCount || 1));
    document.getElementById("panelCount").value = String(count);
    initializePanels(count, chat.panels || []);
}

function anyRequestInFlight() {
    return globalRequestInProgress || panelStates.some((s) => s.isRequesting);
}

// Clear every transcript but keep the layout, models, and system messages.
function startNewChat() {
    if (anyRequestInFlight()) {
        alert("Wait for the current responses to finish first.");
        return;
    }
    const snap = snapshotChat();
    snap.id = null;
    snap.panels.forEach((p) => (p.transcript = []));
    restoreChat(snap);
}

// ---- Edit & resample -------------------------------------------------------------
// Each .message div in a chat area corresponds 1:1 to a transcript entry, so a
// message's position in the DOM is its transcript index.

function transcriptIndexOf(panelIndex, messageDiv) {
    return Array.from(panelStates[panelIndex].chatArea.children).indexOf(messageDiv);
}

// Redraw a panel's chat area from its transcript (after truncating it).
function renderTranscript(panelIndex) {
    const state = panelStates[panelIndex];
    state.chatArea.innerHTML = "";
    for (const entry of state.transcript) {
        displayMessage(
            panelIndex, entry.role, entry.content,
            entry.duration ?? null, entry.thinking ?? null, entry.usage ?? null,
        );
    }
}

// Drop transcript entries from `index` on and redraw. The API message list follows.
function truncateTranscript(panelIndex, index) {
    const state = panelStates[panelIndex];
    state.transcript.length = Math.max(0, index);
    renderTranscript(panelIndex);
    rebuildMessages(state);
}

function panelRequestSpec(enabledIndexes) {
    return panelStates.map((s, idx) => ({
        model: s.model,
        messages: s.messages,
        enabled: enabledIndexes.includes(idx),
        reasoning_effort: s.reasoningEffort,
    }));
}

// Replace the user message at `index` in one panel and ask the model again from there.
async function resendEditedMessage(panelIndex, index, newContent) {
    if (anyRequestInFlight()) {
        alert("Wait for the current responses to finish first.");
        return;
    }
    truncateTranscript(panelIndex, index);
    ensureChat(newContent);
    recordMessage(panelIndex, { role: "user", content: newContent });
    await sendRequestStreaming(panelRequestSpec([panelIndex]), false, panelIndex);
}

// Same, but in every panel that has that user message: each panel is cut at its
// own last copy of `original` (side conversations can put it at different depths).
async function resendEditedMessageToAll(original, newContent) {
    if (anyRequestInFlight()) {
        alert("Wait for the current responses to finish first.");
        return;
    }
    const targets = [];
    panelStates.forEach((s, i) => {
        const idx = s.transcript.map((e) => e.role === "user" && e.content === original).lastIndexOf(true);
        if (idx !== -1) targets.push([i, idx]);
    });
    if (!targets.length) return;
    ensureChat(newContent);
    for (const [i, idx] of targets) {
        truncateTranscript(i, idx);
        recordMessage(i, { role: "user", content: newContent });
    }
    await sendRequestStreaming(panelRequestSpec(targets.map(([i]) => i)), true);
}

// Throw away the assistant reply at `index` (and anything after) and sample again.
async function retryFrom(panelIndex, index) {
    if (anyRequestInFlight()) {
        alert("Wait for the current responses to finish first.");
        return;
    }
    truncateTranscript(panelIndex, index);
    persistChat();
    await sendRequestStreaming(panelRequestSpec([panelIndex]), false, panelIndex);
}

// Swap a user bubble for an inline editor with resend buttons.
function startEditMessage(panelIndex, messageDiv, original) {
    if (messageDiv.classList.contains("editing")) return;
    messageDiv.classList.add("editing");

    const editor = document.createElement("div");
    editor.className = "message-editor";
    const ta = document.createElement("textarea");
    ta.className = "message-edit-input";
    ta.value = original;
    ta.rows = Math.min(14, Math.max(3, original.split("\n").length + 1));
    const actions = document.createElement("div");
    actions.className = "message-editor-actions";

    const close = () => {
        editor.remove();
        messageDiv.classList.remove("editing");
    };
    const hereBtn = document.createElement("button");
    hereBtn.className = "btn btn-primary btn-sm";
    hereBtn.textContent = "Resend here";
    hereBtn.title = "Replace this message in this panel and ask the model again (⌘/Ctrl+Enter)";
    hereBtn.addEventListener("click", () => {
        const text = ta.value.trim();
        if (!text) return;
        const index = transcriptIndexOf(panelIndex, messageDiv);
        close();
        resendEditedMessage(panelIndex, index, text);
    });
    actions.appendChild(hereBtn);

    if (panelStates.length > 1) {
        const allBtn = document.createElement("button");
        allBtn.className = "btn btn-sm";
        allBtn.textContent = "Resend to all panels";
        allBtn.title = "Replace this message in every panel that has it and ask all those models again";
        allBtn.addEventListener("click", () => {
            const text = ta.value.trim();
            if (!text) return;
            close();
            resendEditedMessageToAll(original, text);
        });
        actions.appendChild(allBtn);
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);
    actions.appendChild(cancelBtn);

    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            hereBtn.click();
        } else if (e.key === "Escape") {
            e.stopPropagation();
            close();
        }
    });

    editor.appendChild(ta);
    editor.appendChild(actions);
    messageDiv.appendChild(editor);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
}

async function fetchChat(id) {
    try {
        const res = await fetch(`/api/chats/${encodeURIComponent(id)}`);
        return res.ok ? await res.json() : null;
    } catch (e) {
        return null;
    }
}

// Real token counts from the server (/api/count_tokens → Anthropic's count_tokens API).
// Exact for Claude models; for any other model it's counted with Claude's tokenizer and
// flagged `exact: false`, so we show it with a "≈". Returns null if the count failed.
async function fetchTokenCount(text, modelId) {
    if (!text) return { tokens: 0, exact: true };
    try {
        const res = await fetch("/api/count_tokens", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, model: modelId }),
        });
        const data = await res.json();
        return data.error ? null : data;
    } catch (e) {
        return null;
    }
}

function formatTokenCount(result) {
    if (!result) return "";
    return `${result.exact ? "" : "≈"}${result.tokens.toLocaleString()} tokens`;
}

function tokenCountTitle(result) {
    if (!result) return "";
    return result.exact
        ? `Counted with ${result.counted_with}'s tokenizer`
        : `Approximate: counted with ${result.counted_with}'s tokenizer, not this model's`;
}

// Keep `badge` showing the token count of `textarea`'s text (debounced, race-safe).
// `getModelId` says which model's tokenizer to use.
function bindTokenCounter(textarea, badge, getModelId) {
    let timer = null;
    let seq = 0;
    const update = () => {
        clearTimeout(timer);
        const text = textarea.value;
        const mySeq = ++seq;
        if (!text) {
            badge.textContent = "";
            return;
        }
        timer = setTimeout(async () => {
            const result = await fetchTokenCount(text, getModelId());
            if (mySeq !== seq) return; // a newer keystroke superseded this request
            badge.textContent = formatTokenCount(result);
            badge.title = tokenCountTitle(result);
        }, 350);
    };
    textarea.addEventListener("input", update);
}

// Refresh the badge on the shared input, e.g. after a panel's model changes.
function refreshGlobalTokenCount() {
    const el = document.getElementById("globalInput");
    if (el) el.dispatchEvent(new Event("input"));
}

// Clear a textarea and refresh its token badge (setting .value doesn't fire "input").
function clearInput(textarea) {
    textarea.value = "";
    textarea.dispatchEvent(new Event("input"));
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", async () => {
    await loadConfig();
    const panelCountSelect = document.getElementById("panelCount");
    let resumed = null;
    try {
        if (sessionStorage.getItem(INCOGNITO_KEY)) setIncognito(true);
        const id = sessionStorage.getItem(CURRENT_CHAT_KEY);
        if (id && !incognito) resumed = await fetchChat(id);
    } catch (e) {
        resumed = null;
    }
    if (resumed) {
        restoreChat(resumed);
    } else {
        rememberCurrentChatId(null);
        const savedCount = parseInt(loadPrefs().count);
        const count = savedCount >= 1 && savedCount <= 6 ? savedCount : DEFAULT_PANEL_COUNT;
        panelCountSelect.value = String(count);
        initializePanels(count);
    }
    setupEventListeners();
});

async function loadConfig() {
    try {
        const [modelsRes, configRes] = await Promise.all([
            fetch("/api/models"),
            fetch("/api/config"),
        ]);
        const modelsData = await modelsRes.json();
        const configData = await configRes.json();

        AVAILABLE_MODELS = modelsData.models || [];
        MODELS_BY_ID = {};
        AVAILABLE_MODELS.forEach((m) => (MODELS_BY_ID[m.id] = m));

        DEFAULT_PANEL_MODELS = configData.default_panel_models || AVAILABLE_MODELS.map((m) => m.id);
        REASONING_EFFORT_OPTIONS = configData.reasoning_effort_options || ["default"];
        DEFAULT_PANEL_COUNT = configData.panel_count || 6;
    } catch (e) {
        console.error("Failed to load config:", e);
        alert("Failed to load model configuration from server. Check the server logs.");
    }
}

function modelLabel(modelId) {
    const m = MODELS_BY_ID[modelId];
    return m ? m.label : modelId;
}

// Build the <option> list for a model dropdown, marking the unconfigured ones.
function modelOptionsHtml(selectedId) {
    return AVAILABLE_MODELS.map((m) => {
        const warn = m.configured ? "" : " — no API key";
        const selected = m.id === selectedId ? "selected" : "";
        return `<option value="${m.id}" ${selected}>${m.label}${warn}</option>`;
    }).join("");
}

// Build the reasoning-effort dropdown for a given model.
function effortOptionsHtml(modelId, selectedEffort) {
    const m = MODELS_BY_ID[modelId];
    let options = m && m.available_efforts ? m.available_efforts.slice() : REASONING_EFFORT_OPTIONS.slice();
    const sel = selectedEffort || "default";
    return options
        .map((e) => {
            // The closed select shows the selected label, so spell out "effort: X".
            const label =
                e === "default"
                    ? `effort: ${(m && m.reasoning_effort) || "none"} (default)`
                    : `effort: ${e}`;
            return `<option value="${e}" ${e === sel ? "selected" : ""}>${label}</option>`;
        })
        .join("");
}

// `chatPanels` (optional) are saved panel specs {model, effort, system_message,
// transcript}; panels without one fall back to the last-used prefs / config defaults.
function initializePanels(count, chatPanels = []) {
    const panelsGrid = document.getElementById("panelsGrid");
    panelsGrid.innerHTML = "";
    panelStates = [];
    document.querySelector(".container").classList.remove("panel-focus");
    currentPanelCount = count;

    panelsGrid.className = `panels-grid grid-${count}`;

    const fallbackModel = AVAILABLE_MODELS.length ? AVAILABLE_MODELS[0].id : "";
    const savedPanels = loadPrefs().panels || [];

    for (let i = 0; i < count; i++) {
        // Prefer the chat's model/effort, then the last-used one, if it still exists.
        const spec = chatPanels[i] || null;
        const saved = (spec && MODELS_BY_ID[spec.model]) ? spec : (savedPanels[i] || {});
        const model = MODELS_BY_ID[saved.model]
            ? saved.model
            : DEFAULT_PANEL_MODELS[i] || DEFAULT_PANEL_MODELS[0] || fallbackModel;
        const efforts = (MODELS_BY_ID[model] && MODELS_BY_ID[model].available_efforts) || REASONING_EFFORT_OPTIONS;
        const effort = MODELS_BY_ID[saved.model] && efforts.includes(saved.effort) ? saved.effort : "default";
        const panel = createPanel(i, model, effort);
        panelsGrid.appendChild(panel);

        panelStates[i] = {
            model: model,
            reasoningEffort: effort,
            messages: [],
            element: panel,
            chatArea: panel.querySelector(".chat-area"),
            input: panel.querySelector(".panel-input"),
            sendBtn: panel.querySelector(".panel-send-btn"),
            resetBtn: panel.querySelector(".panel-reset-btn"),
            modelSelect: panel.querySelector(".panel-model-select"),
            effortSelect: panel.querySelector(".panel-effort-select"),
            isRequesting: false,
            systemMessage: (spec && spec.system_message) || "",
            transcript: [],
        };

        bindTokenCounter(panelStates[i].input, panel.querySelector(".token-count"), () => panelStates[i].model);
        panelStates[i].sendBtn.addEventListener("click", () => sendToPanelMessage(i));
        panelStates[i].input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendToPanelMessage(i);
            }
        });
        panelStates[i].modelSelect.addEventListener("change", (e) => {
            panelStates[i].model = e.target.value;
            // Refresh the effort dropdown for the newly selected model.
            panelStates[i].reasoningEffort = "default";
            panelStates[i].effortSelect.innerHTML = effortOptionsHtml(e.target.value, "default");
            savePrefs();
            persistChat();
            // The tokenizer depends on the model, so recount what's typed.
            panelStates[i].input.dispatchEvent(new Event("input"));
            refreshGlobalTokenCount();
        });
        panelStates[i].effortSelect.addEventListener("change", (e) => {
            panelStates[i].reasoningEffort = e.target.value;
            savePrefs();
            persistChat();
        });
        panelStates[i].resetBtn.addEventListener("click", () => resetPanelChat(i));
        panel.querySelector(".panel-reply-toggle").addEventListener("click", () => {
            setPanelReplyOpen(i, !panel.classList.contains("reply-open"));
        });
        panel.querySelector(".panel-focus-btn").addEventListener("click", () => togglePanelFocus(i));

        // Replay a saved transcript, then derive the API message list from it.
        if (spec && Array.isArray(spec.transcript)) {
            for (const entry of spec.transcript) {
                panelStates[i].transcript.push(entry);
                displayMessage(
                    i, entry.role, entry.content,
                    entry.duration ?? null, entry.thinking ?? null, entry.usage ?? null,
                );
            }
        }
        rebuildMessages(panelStates[i]);
    }

    savePrefs();
    refreshGlobalTokenCount();
}

// Inline SVG icons for the panel focus button.
const ICON_EXPAND =
    '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8.5 1.5h4v4M5.5 12.5h-4v-4M12.5 1.5L8 6M1.5 12.5L6 8"/></svg>';
const ICON_COLLAPSE =
    '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12.5 5.5h-4v-4M1.5 8.5h4v4M8.5 5.5L13 1M5.5 8.5L1 13"/></svg>';

// Focus mode: one panel fills the whole window (header, shared input and the other
// panels are hidden). Click the button again or press Esc to return.
function focusedPanelIndex() {
    return panelStates.findIndex((s) => s.element.classList.contains("maximized"));
}

function setPanelFocus(index) {
    const container = document.querySelector(".container");
    panelStates.forEach((s, i) => {
        const on = i === index;
        s.element.classList.toggle("maximized", on);
        const btn = s.element.querySelector(".panel-focus-btn");
        btn.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
        btn.title = on ? "Back to all panels (Esc)" : "Fill the whole window (Esc to go back)";
    });
    container.classList.toggle("panel-focus", index !== null);
    // Panels that were hidden may have received messages; show their latest.
    requestAnimationFrame(() => {
        panelStates.forEach((s) => (s.chatArea.scrollTop = s.chatArea.scrollHeight));
    });
}

function togglePanelFocus(index) {
    setPanelFocus(focusedPanelIndex() === index ? null : index);
}

// Show or hide a panel's "message this model only" box. It starts collapsed so the
// chat area gets the space; opening it focuses the textarea.
function setPanelReplyOpen(index, open) {
    const state = panelStates[index];
    state.element.classList.toggle("reply-open", open);
    if (open) state.input.focus();
}

function createPanel(index, model, effort = "default") {
    const panel = document.createElement("div");
    panel.className = "panel";

    panel.innerHTML = `
        <div class="panel-header">
            <div class="panel-title-wrapper">
                <div class="panel-model-group">
                    <span class="panel-num" title="Panel ${index + 1}">(${index + 1})</span>
                    <select class="panel-model-select" title="Model">
                        ${modelOptionsHtml(model)}
                    </select>
                </div>
                <select class="panel-effort-select" title="Reasoning effort">
                    ${effortOptionsHtml(model, effort)}
                </select>
                <button type="button" class="panel-focus-btn" title="Fill the whole window (Esc to go back)">${ICON_EXPAND}</button>
            </div>
        </div>
        <div class="chat-area"></div>
        <div class="panel-footer">
            <div class="panel-footer-bar">
                <button type="button" class="panel-reply-toggle" title="Message this model only">
                    <span class="panel-reply-toggle-icon">▶</span>Message this model only
                </button>
                <button class="btn btn-sm panel-reset-btn" title="Clear this panel's chat">Reset</button>
            </div>
            <div class="panel-reply">
                <div class="input-wrap">
                    <textarea
                        class="panel-input"
                        placeholder="Send to this model only…"
                        rows="2"
                    ></textarea>
                    <span class="token-count"></span>
                </div>
                <div class="panel-input-actions">
                    <button class="btn btn-primary btn-sm panel-send-btn">Send</button>
                </div>
            </div>
        </div>
    `;

    return panel;
}

function setupEventListeners() {
    const sendAllBtn = document.getElementById("sendAllBtn");
    const globalInput = document.getElementById("globalInput");
    const panelCountSelect = document.getElementById("panelCount");
    const newTabBtn = document.getElementById("newTabBtn");
    const resizeHandle = document.querySelector(".main-resize-handle");
    const panelsGrid = document.getElementById("panelsGrid");

    // The shared input goes to every panel, so count with the first Claude panel's
    // tokenizer if there is one (the server falls back to a Claude model otherwise).
    bindTokenCounter(globalInput, document.getElementById("globalTokenCount"), () => {
        const claudePanel = panelStates.find((s) => MODELS_BY_ID[s.model] && MODELS_BY_ID[s.model].backend === "anthropic");
        return (claudePanel || panelStates[0] || {}).model;
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && focusedPanelIndex() !== -1) setPanelFocus(null);
    });
    sendAllBtn.addEventListener("click", sendToAllModels);
    globalInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendToAllModels();
        }
    });
    panelCountSelect.addEventListener("change", (e) => {
        // Rebuild from a snapshot so existing panels keep their conversations.
        const snap = snapshotChat();
        snap.panel_count = parseInt(e.target.value);
        restoreChat(snap);
        persistChat();
    });
    newTabBtn.addEventListener("click", () => {
        window.open(window.location.href, "_blank");
    });
    document.getElementById("newChatBtn").addEventListener("click", startNewChat);
    document.getElementById("incognitoBtn").addEventListener("click", () => setIncognito(!incognito));

    // Saved chats modal
    const chatsModal = document.getElementById("chatsModal");
    const closeChats = () => (chatsModal.style.display = "none");
    document.getElementById("chatsBtn").addEventListener("click", openChatsModal);
    document.getElementById("closeChatsBtn").addEventListener("click", closeChats);
    document.getElementById("closeChatsBtnFooter").addEventListener("click", closeChats);
    chatsModal.addEventListener("click", (e) => {
        if (e.target === chatsModal) closeChats();
    });

    // System Message modal
    const systemMessageBtn = document.getElementById("systemMessageBtn");
    const systemMessageModal = document.getElementById("systemMessageModal");
    const closeSystemMessageBtn = document.getElementById("closeSystemMessageBtn");
    const closeSystemMessageBtnFooter = document.getElementById("closeSystemMessageBtnFooter");
    const globalSystemMessageInput = document.getElementById("globalSystemMessage");
    const panelSystemSelect = document.getElementById("panelSystemSelect");
    const panelSystemMessageInput = document.getElementById("panelSystemMessage");
    const clearPanelSystemBtn = document.getElementById("clearPanelSystemBtn");

    systemMessageBtn.addEventListener("click", () => {
        globalSystemMessageInput.value = globalSystemMessage;
        updatePanelSystemSelectDropdown();
        systemMessageModal.style.display = "flex";
    });

    const closeModal = () => {
        saveSystemMessages();
        persistChat();
        systemMessageModal.style.display = "none";
    };
    closeSystemMessageBtn.addEventListener("click", closeModal);
    closeSystemMessageBtnFooter.addEventListener("click", closeModal);

    systemMessageModal.addEventListener("click", (e) => {
        if (e.target === systemMessageModal) {
            closeModal();
        }
    });

    panelSystemSelect.addEventListener("change", (e) => {
        selectedPanelForSystemMessage = parseInt(e.target.value);
        if (!isNaN(selectedPanelForSystemMessage)) {
            panelSystemMessageInput.value = panelStates[selectedPanelForSystemMessage].systemMessage;
        } else {
            panelSystemMessageInput.value = "";
        }
    });

    clearPanelSystemBtn.addEventListener("click", () => {
        if (!isNaN(selectedPanelForSystemMessage)) {
            panelStates[selectedPanelForSystemMessage].systemMessage = "";
            panelSystemMessageInput.value = "";
        }
    });

    // Main resize handle
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    resizeHandle.addEventListener("mousedown", (e) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = panelsGrid.offsetHeight;
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const deltaY = e.clientY - startY;
        const newHeight = Math.max(200, startHeight + deltaY);
        panelsGrid.style.height = newHeight + "px";
        panelsGrid.style.flex = "0 0 auto";
        // The grid is now fixed-height, so let the shared input absorb the rest.
        document.querySelector(".container").classList.add("input-resized");
    });

    document.addEventListener("mouseup", () => {
        isResizing = false;
        document.body.style.cursor = "default";
        document.body.style.userSelect = "auto";
    });
}

function resetPanelChat(panelIndex) {
    panelStates[panelIndex].transcript = [];
    rebuildMessages(panelStates[panelIndex]); // keeps the system message, drops the turns
    panelStates[panelIndex].chatArea.innerHTML = "";
    clearInput(panelStates[panelIndex].input);
    persistChat();
}

// ---- Chats modal ---------------------------------------------------------------

function fmtChatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function openChatsModal() {
    const modal = document.getElementById("chatsModal");
    const list = document.getElementById("chatsList");
    modal.style.display = "flex";
    list.innerHTML = '<div class="chats-empty">Loading…</div>';
    let chats = [];
    try {
        const res = await fetch("/api/chats");
        chats = (await res.json()).chats || [];
    } catch (e) {
        list.innerHTML = '<div class="chats-empty">Could not load saved chats.</div>';
        return;
    }
    renderChatsList(chats);
}

function renderChatsList(chats) {
    const list = document.getElementById("chatsList");
    list.innerHTML = "";
    if (!chats.length) {
        list.innerHTML = '<div class="chats-empty">No saved chats yet.</div>';
        return;
    }
    for (const chat of chats) {
        const item = document.createElement("div");
        item.className = "chat-item" + (currentChat && chat.id === currentChat.id ? " current" : "");

        const main = document.createElement("div");
        main.className = "chat-item-main";
        const title = document.createElement("div");
        title.className = "chat-item-title";
        title.textContent = chat.title || "Untitled chat";
        const meta = document.createElement("div");
        meta.className = "chat-item-meta";
        const models = (chat.models || []).map((m) => modelLabel(m)).join(", ");
        meta.textContent = `${fmtChatDate(chat.updated_at)} · ${chat.message_count} messages · ${models}`;
        meta.title = models;
        main.appendChild(title);
        main.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "chat-item-actions";
        const openBtn = document.createElement("button");
        openBtn.className = "btn btn-primary";
        openBtn.textContent = "Open";
        openBtn.addEventListener("click", () => openSavedChat(chat.id));
        const renameBtn = document.createElement("button");
        renameBtn.className = "btn";
        renameBtn.textContent = "Rename";
        renameBtn.addEventListener("click", () => renameSavedChat(chat));
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => deleteSavedChat(chat));
        actions.appendChild(openBtn);
        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);

        item.appendChild(main);
        item.appendChild(actions);
        list.appendChild(item);
    }
}

async function openSavedChat(id) {
    if (anyRequestInFlight()) {
        alert("Wait for the current responses to finish first.");
        return;
    }
    const chat = await fetchChat(id);
    if (!chat) {
        alert("That chat could not be loaded.");
        return;
    }
    restoreChat(chat);
    document.getElementById("chatsModal").style.display = "none";
}

async function renameSavedChat(summary) {
    const title = prompt("Chat title:", summary.title || "");
    if (title === null) return;
    const chat = await fetchChat(summary.id);
    if (!chat) return;
    chat.title = title.trim() || "Untitled chat";
    if (currentChat && currentChat.id === chat.id) currentChat.title = chat.title;
    await fetch(`/api/chats/${encodeURIComponent(chat.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chat),
    });
    openChatsModal();
}

async function deleteSavedChat(summary) {
    if (!confirm(`Delete "${summary.title}"? This cannot be undone.`)) return;
    await fetch(`/api/chats/${encodeURIComponent(summary.id)}`, { method: "DELETE" });
    if (currentChat && currentChat.id === summary.id) {
        // What's on screen stays; the next message starts a fresh record.
        currentChat = null;
        rememberCurrentChatId(null);
    }
    openChatsModal();
}

function updatePanelSystemSelectDropdown() {
    const panelSystemSelect = document.getElementById("panelSystemSelect");
    const currentValue = panelSystemSelect.value;
    panelSystemSelect.innerHTML = '<option value="">Select a panel...</option>';

    for (let i = 0; i < panelStates.length; i++) {
        const option = document.createElement("option");
        option.value = i;
        option.textContent = `Panel ${i + 1} (${modelLabel(panelStates[i].model)})`;
        panelSystemSelect.appendChild(option);
    }

    panelSystemSelect.value = currentValue;
}

function saveSystemMessages() {
    const newGlobalSystemMessage = document.getElementById("globalSystemMessage").value;

    if (newGlobalSystemMessage !== globalSystemMessage) {
        globalSystemMessage = newGlobalSystemMessage;

        for (let i = 0; i < panelStates.length; i++) {
            if (
                panelStates[i].messages.length > 0 &&
                panelStates[i].messages[0].role === "system" &&
                !panelStates[i].systemMessage
            ) {
                panelStates[i].messages.shift();
            }

            if (globalSystemMessage && !panelStates[i].systemMessage) {
                panelStates[i].messages.unshift({ role: "system", content: globalSystemMessage });
            }
        }
    }

    if (!isNaN(selectedPanelForSystemMessage) && selectedPanelForSystemMessage !== null) {
        const newPanelSystemMessage = document.getElementById("panelSystemMessage").value;
        const panelIndex = selectedPanelForSystemMessage;

        if (newPanelSystemMessage !== panelStates[panelIndex].systemMessage) {
            panelStates[panelIndex].systemMessage = newPanelSystemMessage;

            while (
                panelStates[panelIndex].messages.length > 0 &&
                panelStates[panelIndex].messages[0].role === "system"
            ) {
                panelStates[panelIndex].messages.shift();
            }

            if (newPanelSystemMessage) {
                panelStates[panelIndex].messages.unshift({ role: "system", content: newPanelSystemMessage });
            } else if (globalSystemMessage) {
                panelStates[panelIndex].messages.unshift({ role: "system", content: globalSystemMessage });
            }
        }
    }
}

async function sendToAllModels() {
    if (globalRequestInProgress) return;

    const globalInput = document.getElementById("globalInput");
    const message = globalInput.value.trim();

    if (!message) {
        alert("Please enter a message");
        return;
    }

    ensureChat(message);
    for (let i = 0; i < panelStates.length; i++) {
        recordMessage(i, { role: "user", content: message });
    }

    clearInput(globalInput);
    globalInput.focus();

    const panels = panelStates.map((state) => ({
        model: state.model,
        messages: state.messages,
        enabled: true,
        reasoning_effort: state.reasoningEffort,
    }));

    await sendRequestStreaming(panels, true);
}

async function sendToPanelMessage(panelIndex) {
    if (panelStates[panelIndex].isRequesting) return;

    const state = panelStates[panelIndex];
    const message = state.input.value.trim();
    if (!message) return;

    ensureChat(message);
    recordMessage(panelIndex, { role: "user", content: message });
    clearInput(state.input);
    setPanelReplyOpen(panelIndex, false); // give the reply room back to the chat

    await sendRequestStreaming(panelRequestSpec([panelIndex]), false, panelIndex);
}

async function sendRequestStreaming(panels, isGlobal = false, panelIndex = null) {
    const sendAllBtn = document.getElementById("sendAllBtn");
    const status = document.getElementById("status");

    if (isGlobal) {
        globalRequestInProgress = true;
        sendAllBtn.disabled = true;
        status.textContent = "Sending requests to models...";
        status.classList.add("loading");
    } else if (panelIndex !== null) {
        panelStates[panelIndex].isRequesting = true;
        panelStates[panelIndex].sendBtn.disabled = true;
    }

    try {
        const requests = panels.map((panel, idx) => {
            if (!panel.enabled || idx >= panelStates.length) {
                return Promise.resolve();
            }

            return fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ panels: [panel] }),
            })
                .then((response) => {
                    if (!response.ok) {
                        throw new Error(`Server error: ${response.status}`);
                    }
                    return response.json();
                })
                .then((data) => {
                    if (!data.results || data.results.length === 0) {
                        throw new Error("Invalid response from server");
                    }

                    const result = data.results[0];
                    if (result === null) return;

                    if (typeof result !== "object" || !("content" in result)) {
                        console.error(`Invalid result format for panel ${idx}:`, result);
                        recordMessage(idx, {
                            role: "assistant", content: "Error: Invalid response from server", duration: 0, error: true,
                        });
                        return;
                    }

                    const content = String(result.content);
                    recordMessage(idx, {
                        role: "assistant",
                        content: content,
                        duration: result.duration || 0,
                        thinking: result.thinking || null,
                        usage: result.usage || null,
                        error: content.startsWith("Error:"), // errors show but aren't sent back to the model
                    });
                })
                .catch((error) => {
                    console.error(`Error for panel ${idx}:`, error);
                    recordMessage(idx, { role: "assistant", content: `Error: ${error.message}`, duration: 0, error: true });
                });
        });

        await Promise.all(requests);

        if (isGlobal) {
            status.textContent = "Done!";
            status.classList.remove("loading");
            setTimeout(() => {
                status.textContent = "";
            }, 2000);
        }
    } catch (error) {
        if (isGlobal) {
            status.textContent = `Error: ${error.message}`;
            status.classList.remove("loading");
        }
        console.error("Error:", error);
    } finally {
        if (isGlobal) {
            globalRequestInProgress = false;
            sendAllBtn.disabled = false;
        } else if (panelIndex !== null) {
            panelStates[panelIndex].isRequesting = false;
            panelStates[panelIndex].sendBtn.disabled = false;
        }
    }
}

// Copy text to the clipboard; falls back to execCommand where the async API is unavailable.
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch (err) {
            console.error("Copy failed:", err);
        }
        document.body.removeChild(ta);
        return ok;
    }
}

// Small "Copy" button that copies the raw message text (markdown source, not rendered HTML).
// Long messages get a Collapse/Expand button so a pasted transcript or a long answer
// doesn't push everything else out of view. Short ones don't need it.
const COLLAPSIBLE_MIN_CHARS = 600;
const COLLAPSIBLE_MIN_LINES = 8;

function isLongMessage(text) {
    return text.length > COLLAPSIBLE_MIN_CHARS || text.split("\n").length > COLLAPSIBLE_MIN_LINES;
}

function createCollapseButton(bubble) {
    const btn = document.createElement("button");
    btn.className = "message-collapse-btn";
    btn.type = "button";
    const render = () => {
        const collapsed = bubble.classList.contains("collapsed");
        btn.textContent = collapsed ? "Expand" : "Collapse";
        btn.title = collapsed ? "Show the whole message" : "Show only the first few lines";
    };
    btn.addEventListener("click", () => {
        bubble.classList.toggle("collapsed");
        render();
    });
    render();
    return btn;
}

function createCopyButton(text) {
    const btn = document.createElement("button");
    btn.className = "message-copy-btn";
    btn.type = "button";
    btn.title = "Copy message";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
        const ok = await copyText(text);
        btn.textContent = ok ? "Copied!" : "Failed";
        btn.classList.toggle("copied", ok);
        setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
        }, 1200);
    });
    return btn;
}

// "1.2k" style token counts for the usage line.
function fmtTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// e.g. "in 1.2k (cached 1.1k) · out 340"; empty string if the provider reported nothing.
function formatUsage(usage) {
    if (!usage) return "";
    const parts = [];
    if (usage.input != null) {
        let s = `in ${fmtTokens(usage.input)}`;
        const extra = [];
        if (usage.cached) extra.push(`cached ${fmtTokens(usage.cached)}`);
        if (usage.cache_write) extra.push(`cache write ${fmtTokens(usage.cache_write)}`);
        if (extra.length) s += ` (${extra.join(", ")})`;
        parts.push(s);
    }
    if (usage.output != null) parts.push(`out ${fmtTokens(usage.output)}`);
    return parts.join(" · ");
}

function displayMessage(panelIndex, role, content, duration = null, thinking = null, usage = null) {
    if (!panelStates[panelIndex]) {
        console.error(`Panel ${panelIndex} not found`);
        return;
    }

    const state = panelStates[panelIndex];
    if (!state.chatArea) {
        console.error(`Chat area not found for panel ${panelIndex}`);
        return;
    }

    if (content === null || content === undefined) {
        console.error(`Invalid content for panel ${panelIndex}:`, content);
        content = "Error: Empty response from model";
    }
    if (typeof content !== "string") {
        content = String(content);
    }

    try {
        const messageDiv = document.createElement("div");
        messageDiv.className = `message ${role}`;

        if (thinking && role === "assistant") {
            const thinkingContainer = document.createElement("div");
            thinkingContainer.className = "thinking-container";

            const thinkingToggle = document.createElement("div");
            thinkingToggle.className = "thinking-toggle";

            const toggleIcon = document.createElement("span");
            toggleIcon.className = "thinking-toggle-icon";
            toggleIcon.textContent = "▶";

            const toggleLabel = document.createElement("span");
            toggleLabel.textContent = "Thinking (click to expand)";

            thinkingToggle.appendChild(toggleIcon);
            thinkingToggle.appendChild(toggleLabel);

            const thinkingContent = document.createElement("div");
            thinkingContent.className = "thinking-content";

            try {
                thinkingContent.innerHTML = marked.parse(thinking);
            } catch (e) {
                console.error("Error parsing thinking markdown:", e);
                thinkingContent.textContent = thinking;
            }

            thinkingContainer.appendChild(thinkingToggle);
            thinkingContainer.appendChild(thinkingContent);
            messageDiv.appendChild(thinkingContainer);

            thinkingToggle.addEventListener("click", () => {
                thinkingContent.classList.toggle("open");
                toggleIcon.classList.toggle("open");
            });
        }

        const bubble = document.createElement("div");
        bubble.className = "message-bubble";

        if (role === "user") {
            // Show what the user typed verbatim (CSS keeps their line breaks).
            bubble.textContent = content;
        } else {
            try {
                bubble.innerHTML = marked.parse(content);
            } catch (e) {
                console.error("Error parsing markdown:", e);
                bubble.textContent = content;
            }
        }

        messageDiv.appendChild(bubble);

        // Action row under the bubble: copy button, plus token estimate on user
        // messages and timing/usage on assistant messages.
        const actionsDiv = document.createElement("div");
        actionsDiv.className = "message-actions";
        actionsDiv.appendChild(createCopyButton(content));
        if (isLongMessage(content)) actionsDiv.appendChild(createCollapseButton(bubble));
        if (role === "user") {
            const editBtn = document.createElement("button");
            editBtn.className = "message-edit-btn";
            editBtn.type = "button";
            editBtn.textContent = "Edit";
            editBtn.title = "Edit this message and ask again from here (later turns are discarded)";
            editBtn.addEventListener("click", () => startEditMessage(panelIndex, messageDiv, content));
            actionsDiv.appendChild(editBtn);
        } else {
            const retryBtn = document.createElement("button");
            retryBtn.className = "message-retry-btn";
            retryBtn.type = "button";
            retryBtn.textContent = "Retry";
            retryBtn.title = "Discard this reply (and anything after it) and sample again";
            retryBtn.addEventListener("click", () => retryFrom(panelIndex, transcriptIndexOf(panelIndex, messageDiv)));
            actionsDiv.appendChild(retryBtn);
        }

        if (role === "user") {
            const tokensDiv = document.createElement("div");
            tokensDiv.className = "message-timing";
            actionsDiv.appendChild(tokensDiv);
            // Filled in once the real count comes back; stays blank if it fails.
            fetchTokenCount(content, state.model).then((result) => {
                tokensDiv.textContent = formatTokenCount(result);
                tokensDiv.title = tokenCountTitle(result);
            });
        }

        if (duration !== null && role === "assistant") {
            const timingDiv = document.createElement("div");
            timingDiv.className = "message-timing";
            const usageText = formatUsage(usage);
            timingDiv.textContent =
                `${parseFloat(duration).toFixed(2)}s` + (usageText ? ` · ${usageText}` : "");
            actionsDiv.appendChild(timingDiv);
        }
        messageDiv.appendChild(actionsDiv);

        state.chatArea.appendChild(messageDiv);
        state.chatArea.offsetHeight;

        requestAnimationFrame(() => {
            state.chatArea.scrollTop = state.chatArea.scrollHeight;
            state.chatArea.offsetHeight;
        });
    } catch (e) {
        console.error(`Error creating message element for panel ${panelIndex}:`, e);
    }
}
