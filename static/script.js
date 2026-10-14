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
    const savedCount = parseInt(loadPrefs().count);
    const count = savedCount >= 1 && savedCount <= 6 ? savedCount : DEFAULT_PANEL_COUNT;
    panelCountSelect.value = String(count);
    initializePanels(count);
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
            // The closed select shows the selected label, so spell out "reasoning: X".
            const label =
                e === "default"
                    ? `reasoning: ${(m && m.reasoning_effort) || "none"} (default)`
                    : `reasoning: ${e}`;
            return `<option value="${e}" ${e === sel ? "selected" : ""}>${label}</option>`;
        })
        .join("");
}

function initializePanels(count) {
    const panelsGrid = document.getElementById("panelsGrid");
    panelsGrid.innerHTML = "";
    panelStates = [];
    document.querySelector(".container").classList.remove("panel-focus");
    currentPanelCount = count;

    panelsGrid.className = `panels-grid grid-${count}`;

    const fallbackModel = AVAILABLE_MODELS.length ? AVAILABLE_MODELS[0].id : "";
    const savedPanels = loadPrefs().panels || [];

    for (let i = 0; i < count; i++) {
        // Prefer the last-used model/effort if it still exists in the config.
        const saved = savedPanels[i] || {};
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
            systemMessage: "",
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
            // The tokenizer depends on the model, so recount what's typed.
            panelStates[i].input.dispatchEvent(new Event("input"));
            refreshGlobalTokenCount();
        });
        panelStates[i].effortSelect.addEventListener("change", (e) => {
            panelStates[i].reasoningEffort = e.target.value;
            savePrefs();
        });
        panelStates[i].resetBtn.addEventListener("click", () => resetPanelChat(i));
        panel.querySelector(".panel-focus-btn").addEventListener("click", () => togglePanelFocus(i));
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
            <div class="input-wrap">
                <textarea
                    class="panel-input"
                    placeholder="Send to this model only…"
                    rows="2"
                ></textarea>
                <span class="token-count"></span>
            </div>
            <div class="panel-input-actions">
                <button class="btn btn-sm panel-reset-btn" title="Clear this panel's chat">Reset</button>
                <button class="btn btn-primary btn-sm panel-send-btn">Send</button>
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
        initializePanels(parseInt(e.target.value));
    });
    newTabBtn.addEventListener("click", () => {
        window.open(window.location.href, "_blank");
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
    });

    document.addEventListener("mouseup", () => {
        isResizing = false;
        document.body.style.cursor = "default";
        document.body.style.userSelect = "auto";
    });
}

function resetPanelChat(panelIndex) {
    panelStates[panelIndex].messages = [];
    panelStates[panelIndex].chatArea.innerHTML = "";
    clearInput(panelStates[panelIndex].input);
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

    for (let i = 0; i < panelStates.length; i++) {
        panelStates[i].messages.push({ role: "user", content: message });
        displayMessage(i, "user", message);
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

    state.messages.push({ role: "user", content: message });
    displayMessage(panelIndex, "user", message);
    clearInput(state.input);

    const panels = panelStates.map((s, idx) => ({
        model: s.model,
        messages: s.messages,
        enabled: idx === panelIndex,
        reasoning_effort: s.reasoningEffort,
    }));

    await sendRequestStreaming(panels, false, panelIndex);
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
                        displayMessage(idx, "assistant", "Error: Invalid response from server", 0, null);
                        return;
                    }

                    const content = result.content;
                    const duration = result.duration || 0;
                    const thinking = result.thinking || null;
                    const usage = result.usage || null;

                    if (content.startsWith("Error:")) {
                        displayMessage(idx, "assistant", content, duration, thinking, usage);
                    } else {
                        panelStates[idx].messages.push({ role: "assistant", content: content });
                        displayMessage(idx, "assistant", content, duration, thinking, usage);
                    }
                })
                .catch((error) => {
                    console.error(`Error for panel ${idx}:`, error);
                    displayMessage(idx, "assistant", `Error: ${error.message}`, 0, null);
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
