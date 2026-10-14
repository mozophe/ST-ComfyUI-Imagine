import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { splitDataUrl, isOwnImaginePath, isOwnDebugPath, separateReasoning, selectChatWindow, toMarkdownImagePath } from './image-helpers.js';

const MODULE_NAME = 'comfy_imagine';
// Capture everything after scripts/extensions/ up to index.js — this preserves
// the third-party/ prefix that ST uses for externally installed extensions.
const EXTENSION_FOLDER = (() => {
    const m = new URL(import.meta.url).pathname.match(/scripts\/extensions\/(.+)\/index\.js$/);
    return m ? m[1] : new URL(import.meta.url).pathname.split('/').slice(-2, -1)[0];
})();
const POLL_INTERVAL_MS = 1500;
const GENERATION_TIMEOUT_MS = 120_000;

// Cached LoRA filename list from ComfyUI /object_info/LoraLoader. Populated on
// first settings-panel render; reload button clears it to force a refetch.
let loraListCache = null;

// Baseline of image paths referenced by comfy-imagine messages in the current
// chat. Diffed on MESSAGE_DELETED to find files whose messages were removed.
let knownImaginePaths = new Set();

// Re-entrancy guard: one generation at a time, shared by the slash command
// and the per-message camera button.
let isGenerating = false;

const DEFAULT_SYSTEM_PROMPT = `You are an expert prompt engineer for text-to-image models. You receive a roleplay scene: a [CHARACTER] block, a [USER PERSONA] block, a [CHAT LOG], and sometimes a [TRACKER STATE]. Your task is to turn the most recent moment of the chat log into a highly effective image-generation prompt.

Think step by step inside a <think> block before writing the answer:
- What is happening in the last message, who is in it, and what is the mood?
- What lighting would fit the moment? The style is fixed (rule 10), so do not weigh other styles or mediums.
- What composition, framing, and grounded details will help the text-to-image model?

Then close the <think> block, leave a blank line, and output a single prompt paragraph. Put nothing after it.

Follow these rules strictly:
1. **Faithfulness First:** Depict the moment the last message of the chat log describes. Preserve its subjects, actions, colors, and spatial relationships, and take the character's appearance from the [CHARACTER] block. Earlier messages and the [TRACKER STATE], when present, are context for where things are and what is being worn. Do not add new objects, props, characters, or animals unless the scene clearly implies them.
2. **Point of View:** The image is seen through the eyes of the user persona. The persona is not in frame, except for hands, arms, torso, or legs where the moment calls for them, and never their face.
3. **Only What Is Visible:** Describe what a camera would capture. Leave out sounds, smells, thoughts, dialogue, and anything outside the frame.
4. **Practical T2I Structure:** Write a prompt that a text-to-image model can parse cleanly. Group subjects with their own attributes and actions. Use grounded phrasing for poses, interactions, and spatial layout.
5. **Style Planning Stays Internal:** Use the <think> block to choose framing and lighting. Do not emit planning tags, headings, or wrappers in the prompt paragraph.
6. **Text Rendering:** If the moment contains visible text, signs, labels, or typography, specify the exact text clearly and wrap the words in quotes.
7. **Avoid Over-Specification:** Do not invent highly specific clothing, colors, materials, or scene details unless the character description, the chat log, or the tracker state supports them.
8. **Structure:** Write one cohesive paragraph of natural sentences after the <think> block. No bullets, JSON, or markdown.
9. **Respect Existing Detail:** If the chat already describes the moment in detail, keep its phrasing and direction rather than heavily expanding it.
10. **Fixed Style:** Every image is a candid photo with imperfect camera framing, as if taken quickly by hand: slightly off-centre, a little tilted, or cut off at an edge. State this in the prompt. Never use another style or medium, such as an illustration, painting, sketch or 3D render, even if the scene names one.`;

// Name under which DEFAULT_SYSTEM_PROMPT is seeded into the presets dropdown so
// users can always switch back to it after editing.
const DEFAULT_PRESET_NAME = 'Krea 2 (default)';

// Extension-owned presets: force-synced to their shipped text on every load and
// read-only in the UI (Save/overwrite blocked, Save As only).
const SHIPPED_PRESETS = new Set([DEFAULT_PRESET_NAME]);

const defaultSettings = {
    comfyUrl: 'http://192.168.1.x:8188',
    llmBaseUrl: '',
    llmApiKey: '',
    llmModel: '',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    systemPromptPresets: {},
    activeSystemPromptPreset: '',
    promptPrefix: '',
    promptSuffix: '',
    negativePrompt: '',
    workflows: {},
    activeWorkflow: '',
    characterLoras: {},   // { [character.avatar]: { lora, strength, trigger } }
    imageCount: 1,
    chatHistoryLimit: 20,   // latest N chat messages to send to LLM; 0 = all
    senderName: 'Camera',
    maxTokens: 8192,
    temperature: 0.7,
};

// ── Helpers ────────────────────────────────────────────────────────────────

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function toast(msg, type = 'info') {
    const t = SillyTavern.libs?.toastr ?? window.toastr;
    if (!t) return;
    if (type === 'error') t.error(msg);
    else if (type === 'success') t.success(msg);
    else if (type === 'warning') t.warning(msg);
    else t.info(msg);
}

// ── Settings UI ────────────────────────────────────────────────────────────

function populateWorkflowDropdown() {
    const settings = getSettings();
    const select = document.getElementById('comfy-imagine-active-workflow');
    if (!select) return;

    select.innerHTML = '<option value="">— none —</option>';
    for (const name of Object.keys(settings.workflows || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
    // activeWorkflow is the persisted selection — keep it authoritative so a
    // fresh upload (which sets activeWorkflow) auto-selects instead of the stale option.
    select.value = settings.workflows?.[settings.activeWorkflow] ? settings.activeWorkflow : '';
}

function populateSystemPromptPresetDropdown() {
    const settings = getSettings();
    const select = document.getElementById('comfy-imagine-sp-preset');
    if (!select) return;

    select.innerHTML = '<option value="">— select preset —</option>';
    for (const name of Object.keys(settings.systemPromptPresets || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
    const active = settings.activeSystemPromptPreset || '';
    select.value = settings.systemPromptPresets?.[active] ? active : '';
    updateSpSaveButtonState();
}

// Grey out the Save (overwrite) button when the selected preset can't be
// overwritten — the extension-owned default (rewritten each load) or nothing
// selected. Save As stays available so custom edits can always be kept.
function updateSpSaveButtonState() {
    const btn = document.getElementById('comfy-imagine-sp-preset-overwrite');
    const select = document.getElementById('comfy-imagine-sp-preset');
    if (!btn || !select) return;
    const name = select.value;
    const shipped = SHIPPED_PRESETS.has(name);
    btn.disabled = !name || shipped;
    btn.title = shipped
        ? `'${name}' is read-only — use Save As to keep changes`
        : (name ? 'Overwrite the selected preset with the current system prompt' : 'Select a preset to overwrite');

    // Delete is blocked for shipped presets too (they'd re-seed on reload anyway).
    const del = document.getElementById('comfy-imagine-sp-preset-delete');
    if (del) {
        del.disabled = !name || shipped;
        del.title = shipped ? `'${name}' is built-in and can't be deleted` : (name ? 'Delete the selected preset' : 'Select a preset to delete');
    }
}

// Returns the active character object (has .avatar, .name) or null when none is
// selected (e.g. group chat or welcome screen). avatar is the stable per-card key.
function getActiveCharacter() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId === undefined || ctx.characterId === null) return null;
    return ctx.characters?.[ctx.characterId] ?? null;
}

// Pull installed LoRA filenames from ComfyUI. The /object_info/LoraLoader node
// schema lists them under input.required.lora_name[0].
async function fetchLoraList() {
    const url = getSettings().comfyUrl.replace(/\/$/, '');
    const resp = await fetch(`${url}/object_info/LoraLoader`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const names = data?.LoraLoader?.input?.required?.lora_name?.[0];
    if (!Array.isArray(names)) throw new Error('No LoraLoader node in ComfyUI');
    return names;
}

// True on phones/tablets. ST exposes isMobile() (Bowser UA) via getContext.
function isMobileDevice() {
    const fn = SillyTavern.getContext()?.isMobile;
    return typeof fn === 'function' ? fn() : false;
}

// Make the LoRA <select> searchable via ST's bundled select2 — but only on
// desktop. ST itself gates its model-select select2 behind !isMobile()
// (openai.js) because the search dropdown is unusable on touch: the soft
// keyboard resizes the viewport and closes it. On mobile we leave the plain
// <select> so the device's native picker is used instead.
function refreshLoraSelect2(select) {
    if (!$.fn?.select2) return;
    const $sel = $(select);
    if ($sel.hasClass('select2-hidden-accessible')) $sel.select2('destroy');
    if (isMobileDevice() || select.disabled) return;
    $sel.select2({
        width: '100%',
        placeholder: 'Select a LoRA',
        searchInputPlaceholder: 'Search LoRAs…',
        searchInputCssClass: 'text_pole',
        // No allowClear: its × is absolutely positioned over the right edge of
        // the control, where it collides with the dropdown caret and the
        // ellipsis once a LoRA path is long enough to truncate. The panel has
        // its own clear button next to the dropdown, which also works on
        // mobile, where select2 is never applied at all.
        allowClear: false,
    });
}

// Refresh the Character LoRAs panel for whoever is active right now. Called on
// settings load and on CHAT_CHANGED so the fields track character switches.
async function populateCharacterLoraUI() {
    const nameEl = document.getElementById('comfy-imagine-lora-charname');
    const select = document.getElementById('comfy-imagine-lora-select');
    const strengthEl = document.getElementById('comfy-imagine-lora-strength');
    const triggerEl = document.getElementById('comfy-imagine-lora-trigger');
    if (!nameEl || !select) return;

    // Tear down any existing select2 before mutating the underlying <select>.
    const $sel = $(select);
    if ($.fn?.select2 && $sel.hasClass('select2-hidden-accessible')) $sel.select2('destroy');

    const char = getActiveCharacter();
    if (!char) {
        nameEl.textContent = '— no character selected —';
        select.innerHTML = '<option value="">— none —</option>';
        select.disabled = true;
        if (strengthEl) strengthEl.disabled = true;
        if (triggerEl) triggerEl.disabled = true;
        return;
    }
    select.disabled = false;
    if (strengthEl) strengthEl.disabled = false;
    if (triggerEl) triggerEl.disabled = false;
    nameEl.textContent = char.name ?? char.avatar;

    if (!loraListCache) {
        select.innerHTML = '<option value="">— loading… —</option>';
        try {
            loraListCache = await fetchLoraList();
        } catch {
            select.innerHTML = '<option value="">— fetch failed, check ComfyUI &amp; reload —</option>';
            return;
        }
    }

    const saved = getSettings().characterLoras?.[char.avatar] ?? {};
    select.innerHTML = '<option value="">— none —</option>';
    for (const name of loraListCache) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
    select.value = (saved.lora && loraListCache.includes(saved.lora)) ? saved.lora : '';
    if (strengthEl) strengthEl.value = saved.strength ?? 1;
    if (triggerEl) triggerEl.value = saved.trigger ?? '';

    refreshLoraSelect2(select);
}

// Persist the current panel selection against the active character's avatar.
// Empty LoRA removes the entry so the workflow's own default is used.
function saveCharacterLora() {
    const char = getActiveCharacter();
    if (!char) return;
    const select = document.getElementById('comfy-imagine-lora-select');
    const strengthEl = document.getElementById('comfy-imagine-lora-strength');
    const triggerEl = document.getElementById('comfy-imagine-lora-trigger');
    const settings = getSettings();
    if (!settings.characterLoras) settings.characterLoras = {};
    const lora = select?.value ?? '';
    if (!lora) {
        delete settings.characterLoras[char.avatar];
    } else {
        // parseFloat first, then default only a truly empty/NaN field to 1 — a
        // typed 0 is a valid strength (LoRA off) and must not become 1.
        const parsed = parseFloat(strengthEl?.value);
        settings.characterLoras[char.avatar] = {
            lora,
            strength: Number.isNaN(parsed) ? 1 : Math.min(2, Math.max(-2, parsed)),
            trigger: (triggerEl?.value ?? '').trim(),
        };
    }
    saveSettings();
}

function loadSettingsIntoUI() {
    const s = getSettings();

    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val ?? '';
    };

    set('comfy-imagine-url', s.comfyUrl);
    set('comfy-imagine-llm-url', s.llmBaseUrl);
    set('comfy-imagine-llm-key', s.llmApiKey);
    set('comfy-imagine-llm-model', s.llmModel);
    set('comfy-imagine-system-prompt', s.systemPrompt);
    set('comfy-imagine-prompt-prefix', s.promptPrefix);
    set('comfy-imagine-prompt-suffix', s.promptSuffix);
    set('comfy-imagine-negative-prompt', s.negativePrompt);
    set('comfy-imagine-image-count', s.imageCount);
    set('comfy-imagine-chat-limit', s.chatHistoryLimit);
    set('comfy-imagine-sender-name', s.senderName);
    set('comfy-imagine-max-tokens', s.maxTokens);
    set('comfy-imagine-temperature', s.temperature);

    populateWorkflowDropdown();
    populateSystemPromptPresetDropdown();
    populateCharacterLoraUI();
}

function bindSettingsEvents() {
    // Tabs. jQuery UI is bundled by ST, which uses it for its own background
    // tabs (backgrounds.js). bindSettingsEvents runs once, from init(), after
    // the template has been rendered into the DOM, so no re-init guard needed.
    // Guarded: a throw here would abort the function before any binding below
    // runs, leaving every field silently read-only. Worst case without the
    // widget, jQuery UI never hides the inactive panels, so all four tabs
    // render stacked instead of tabbed — ugly but fully functional, and far
    // better than a settings panel that looks fine but can't be edited.
    try {
        $('#comfy-imagine-tabs').tabs();
    } catch (err) {
        console.error('[comfy-imagine] tabs widget failed to initialise', err);
    }

    const bind = (id, key, transform) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            getSettings()[key] = transform ? transform(el.value) : el.value;
            saveSettings();
        });
    };

    bind('comfy-imagine-url', 'comfyUrl');
    bind('comfy-imagine-llm-url', 'llmBaseUrl');
    bind('comfy-imagine-llm-key', 'llmApiKey');
    bind('comfy-imagine-llm-model', 'llmModel');
    bind('comfy-imagine-system-prompt', 'systemPrompt');

    document.getElementById('comfy-imagine-edit-system-prompt')?.addEventListener('click', async () => {
        const current = getSettings().systemPrompt ?? '';
        const ta = document.createElement('textarea');
        ta.id = 'comfy-sp-popup-editor';
        ta.className = 'text_pole';
        ta.value = current;

        const popup = new Popup(ta, POPUP_TYPE.TEXT, '', {
            large: true,
            okButton: 'Save',
            cancelButton: 'Cancel',
        });
        const result = await popup.show();
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            const val = ta.value;
            getSettings().systemPrompt = val;
            saveSettings();
            const inlineEl = document.getElementById('comfy-imagine-system-prompt');
            if (inlineEl) inlineEl.value = val;
        }
    });
    document.getElementById('comfy-imagine-sp-preset')?.addEventListener('change', e => {
        const name = e.target.value;
        if (!name) return;
        const preset = getSettings().systemPromptPresets?.[name];
        if (preset == null) return;
        getSettings().systemPrompt = preset;
        getSettings().activeSystemPromptPreset = name;
        saveSettings();
        const inlineEl = document.getElementById('comfy-imagine-system-prompt');
        if (inlineEl) inlineEl.value = preset;
        toast(`Loaded preset '${name}'.`);
    });

    // Keep the Save button's enabled/greyed state in sync with the selection
    // (runs regardless of the loader handler's early returns above).
    document.getElementById('comfy-imagine-sp-preset')?.addEventListener('change', updateSpSaveButtonState);

    document.getElementById('comfy-imagine-sp-preset-overwrite')?.addEventListener('click', () => {
        const settings = getSettings();
        const name = settings.activeSystemPromptPreset;
        if (!name || !settings.systemPromptPresets?.[name]) {
            toast('No preset selected — use Save As.', 'error');
            return;
        }
        // Shipped presets are extension-owned and rewritten with their shipped text
        // on every load, so a Save here would be silently wiped. Block it and steer
        // the user to Save As, which persists under their own name.
        if (SHIPPED_PRESETS.has(name)) {
            toast(`'${name}' can't be overwritten — use Save As to keep your changes.`, 'error');
            return;
        }
        settings.systemPromptPresets[name] = settings.systemPrompt ?? '';
        saveSettings();
        toast(`Preset '${name}' saved.`, 'success');
    });

    document.getElementById('comfy-imagine-sp-preset-save')?.addEventListener('click', async () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text_pole';
        input.placeholder = 'Preset name';
        const popup = new Popup(input, POPUP_TYPE.TEXT, '', {
            okButton: 'Save',
            cancelButton: 'Cancel',
        });
        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        const name = input.value.trim();
        if (!name) {
            toast('Preset name required.', 'error');
            return;
        }
        const settings = getSettings();
        if (!settings.systemPromptPresets) settings.systemPromptPresets = {};
        settings.systemPromptPresets[name] = settings.systemPrompt ?? '';
        settings.activeSystemPromptPreset = name;
        saveSettings();
        populateSystemPromptPresetDropdown();
        toast(`Preset '${name}' saved.`, 'success');
    });

    document.getElementById('comfy-imagine-sp-preset-delete')?.addEventListener('click', () => {
        const select = document.getElementById('comfy-imagine-sp-preset');
        const name = select?.value;
        const settings = getSettings();
        if (!name || !settings.systemPromptPresets?.[name]) {
            toast('No preset selected.', 'error');
            return;
        }
        // Shipped presets are re-seeded on every load, so a delete here would just
        // reappear on reload — block it like Save, so they can't be removed.
        if (SHIPPED_PRESETS.has(name)) {
            toast(`'${name}' is built-in and can't be deleted.`, 'error');
            return;
        }
        delete settings.systemPromptPresets[name];
        if (settings.activeSystemPromptPreset === name) settings.activeSystemPromptPreset = '';
        saveSettings();
        populateSystemPromptPresetDropdown();
        toast(`Preset '${name}' deleted.`);
    });

    bind('comfy-imagine-prompt-prefix', 'promptPrefix');
    bind('comfy-imagine-prompt-suffix', 'promptSuffix');
    bind('comfy-imagine-negative-prompt', 'negativePrompt');
    bind('comfy-imagine-sender-name', 'senderName');
    bind('comfy-imagine-image-count', 'imageCount', v => Math.min(8, Math.max(1, parseInt(v, 10) || 1)));
    bind('comfy-imagine-chat-limit', 'chatHistoryLimit', v => Math.max(0, parseInt(v, 10) || 0));
    bind('comfy-imagine-max-tokens', 'maxTokens', v => Math.min(32768, Math.max(1, parseInt(v, 10) || 8192)));
    bind('comfy-imagine-temperature', 'temperature', v => Math.min(2, Math.max(0, parseFloat(v) || 0.7)));

    document.getElementById('comfy-imagine-active-workflow')?.addEventListener('change', e => {
        getSettings().activeWorkflow = e.target.value;
        saveSettings();
    });

    document.getElementById('comfy-imagine-test-connection')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('comfy-imagine-connection-status');
        const url = getSettings().comfyUrl.replace(/\/$/, '');
        statusEl.textContent = 'Testing…';
        statusEl.className = 'comfy-imagine-status';
        try {
            const resp = await fetch(`${url}/system_stats`);
            if (resp.ok) {
                statusEl.textContent = 'Connected ✓';
                statusEl.className = 'comfy-imagine-status success';
            } else {
                statusEl.textContent = `Failed (HTTP ${resp.status})`;
                statusEl.className = 'comfy-imagine-status error';
            }
        } catch {
            statusEl.textContent = 'Unreachable';
            statusEl.className = 'comfy-imagine-status error';
        }
    });

    document.getElementById('comfy-imagine-workflow-upload')?.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (!file) return;
        const statusEl = document.getElementById('comfy-imagine-upload-status');
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                JSON.parse(ev.target.result); // validate
            } catch {
                statusEl.textContent = 'Invalid JSON — not saved.';
                statusEl.className = 'comfy-imagine-status error';
                return;
            }
            const settings = getSettings();
            if (!settings.workflows) settings.workflows = {};
            settings.workflows[file.name] = ev.target.result;
            settings.activeWorkflow = file.name;
            saveSettings();
            populateWorkflowDropdown();
            statusEl.textContent = `Workflow '${file.name}' uploaded successfully`;
            statusEl.className = 'comfy-imagine-status success';
        };
        reader.onerror = () => {
            statusEl.textContent = 'Failed to read file.';
            statusEl.className = 'comfy-imagine-status error';
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    document.getElementById('comfy-imagine-reload-workflows')?.addEventListener('click', () => {
        populateWorkflowDropdown();
    });

    // jQuery .on (not addEventListener): desktop select2 emits a jQuery-only
    // 'change'; on mobile the native <select> emits a normal 'change'. jQuery
    // catches both. Survives select2 destroy/re-init.
    $('#comfy-imagine-lora-select').on('change', saveCharacterLora);
    document.getElementById('comfy-imagine-lora-strength')?.addEventListener('input', saveCharacterLora);
    document.getElementById('comfy-imagine-lora-trigger')?.addEventListener('input', saveCharacterLora);
    // Clear reuses the handler above rather than saving directly, so there is
    // exactly one clear path: it is what picking the '— none —' option does.
    // saveCharacterLora() reads '' and deletes the character's entry, which
    // injectCharacterLora() then treats as "neutralise" — strength 0 and an
    // empty trigger. Needed because select2's clear affordance is desktop-only.
    document.getElementById('comfy-imagine-lora-clear')?.addEventListener('click', () => {
        $('#comfy-imagine-lora-select').val('').trigger('change');
    });
    document.getElementById('comfy-imagine-lora-reload')?.addEventListener('click', () => {
        loraListCache = null;
        populateCharacterLoraUI();
    });

    document.getElementById('comfy-imagine-delete-workflow')?.addEventListener('click', () => {
        const settings = getSettings();
        const name = settings.activeWorkflow;
        if (!name || !settings.workflows?.[name]) {
            toast('No workflow selected.', 'error');
            return;
        }
        delete settings.workflows[name];
        settings.activeWorkflow = '';
        saveSettings();
        populateWorkflowDropdown();
        toast(`Workflow '${name}' deleted.`);
    });

    document.getElementById('comfy-imagine-workflow-upload-btn')?.addEventListener('click', () => {
        document.getElementById('comfy-imagine-workflow-upload')?.click();
    });

    document.getElementById('comfy-imagine-test-llm')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('comfy-imagine-llm-status');
        const s = getSettings();
        const base = (s.llmBaseUrl || '').replace(/\/$/, '');
        if (!base) {
            statusEl.textContent = 'No API URL set';
            statusEl.className = 'comfy-imagine-status error';
            return;
        }
        statusEl.textContent = 'Testing…';
        statusEl.className = 'comfy-imagine-status';
        try {
            const resp = await fetch(`${base}/models`, {
                headers: s.llmApiKey ? { Authorization: `Bearer ${s.llmApiKey}` } : {},
            });
            if (resp.ok) {
                statusEl.textContent = 'Connected ✓';
                statusEl.className = 'comfy-imagine-status success';
            } else {
                statusEl.textContent = `Failed (HTTP ${resp.status})`;
                statusEl.className = 'comfy-imagine-status error';
            }
        } catch {
            statusEl.textContent = 'Unreachable';
            statusEl.className = 'comfy-imagine-status error';
        }
    });

    document.getElementById('comfy-imagine-migrate-btn')
        ?.addEventListener('click', migrateCurrentChat);
}

// ── Context Assembly ────────────────────────────────────────────────────────

function assembleContext(uptoIndex = null) {
    const ctx = SillyTavern.getContext();
    const character = ctx.characters?.[ctx.characterId] ?? {};
    // ctx.persona is undefined in ST v1.18.0; use powerUserSettings from context
    // powerUserSettings.persona_description is synced to the active persona on selection
    const userName = ctx.name1 ?? 'User';
    const userDescription = ctx.substituteParams(ctx.powerUserSettings?.persona_description ?? '');

    const lines = [];

    lines.push('[CHARACTER]');
    lines.push(`Name: ${character.name ?? 'Unknown'}`);
    if (character.description) lines.push(`Description: ${character.description}`);
    if (character.personality) lines.push(`Personality: ${character.personality}`);
    if (character.scenario)    lines.push(`Scenario: ${character.scenario}`);

    lines.push('');
    lines.push('[USER PERSONA]');
    lines.push(`Name: ${userName}`);
    if (userDescription) lines.push(`Description: ${userDescription}`);

    lines.push('');
    lines.push('[CHAT LOG]');
    // Cut at uptoIndex (inclusive) for per-message generation, filter system
    // messages, then apply the history limit. limit <= 0 means the whole log.
    const limit = getSettings().chatHistoryLimit || 0;
    const chatMsgs = selectChatWindow(ctx.chat ?? [], uptoIndex, limit);
    for (const msg of chatMsgs) {
        const speaker = msg.is_user ? userName : (character.name ?? 'Character');
        lines.push(`${speaker}: ${msg.mes}`);
    }

    // Tracker snapshot must match the scene's point in time: search only up to
    // the cutoff, not the whole chat.
    const trackerScope = uptoIndex == null ? (ctx.chat ?? []) : (ctx.chat ?? []).slice(0, uptoIndex + 1);
    const lastTrackerMsg = [...trackerScope].reverse().find(
        msg => msg.extra?.WTracker?.value != null
    );
    if (lastTrackerMsg) {
        lines.push('');
        lines.push('[TRACKER STATE]');
        lines.push(JSON.stringify(lastTrackerMsg.extra.WTracker.value, null, 2));
    }

    return lines.join('\n');
}

// ── LLM Call ────────────────────────────────────────────────────────────────

async function generatePromptViaLLM(contextString, signal) {
    const s = getSettings();
    const baseUrl = s.llmBaseUrl.replace(/\/$/, '');
    const body = {
        model: s.llmModel,
        messages: [
            { role: 'system', content: s.systemPrompt },
            { role: 'user', content: contextString },
        ],
        max_tokens: s.maxTokens,
        temperature: s.temperature,
    };

    const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // Omit the header entirely when no key is set, matching the Test API
            // Connection path. A local server may reject `Bearer ` with an empty
            // token while accepting no header at all.
            ...(s.llmApiKey ? { 'Authorization': `Bearer ${s.llmApiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        throw new Error(`HTTP ${resp.status} — ${text}`);
    }

    const data = await resp.json();
    const message = data.choices?.[0]?.message ?? {};
    const content = message.content?.trim() ?? '';
    // Reasoning models split their thinking out: inline as a <think> block in
    // content, or a separate field (reasoning_content on DeepSeek, reasoning on
    // OpenRouter/others). Capture whichever exists so the debug modal can show it.
    const reasoning = (message.reasoning_content ?? message.reasoning ?? '').trim();
    // ponytail: on any failure below, the reasoning/finish_reason is the whole
    // debug story but there's no success message to hang a sidecar on — so just
    // dump it to the console. Open devtools to see why it burned the budget.
    const logFailure = () => console.error('[comfy-imagine] LLM produced no usable prompt', {
        finish_reason: data.choices?.[0]?.finish_reason,
        max_tokens: s.maxTokens,
        reasoning,
        content,
        raw: data,
    });
    if (!content) {
        logFailure();
        // 200 OK but no text — the reason is usually buried in the body
        // (provider error object, content filter, or a stop with no output).
        const code = data.error?.code ?? data.error?.type;
        const finish = data.choices?.[0]?.finish_reason;
        if (!data.error && !data.message && finish === 'length') {
            throw new Error(`LLM hit the token limit before returning a prompt — raise Max Tokens (currently ${s.maxTokens}).`);
        }
        const reason =
            data.error?.message ??
            data.message ??
            finish ??
            JSON.stringify(data);
        throw new Error(`LLM returned no prompt (${code != null ? `${code}: ` : ''}${reason})`);
    }
    // Split any tagged/inline reasoning out of the content, then fold in the
    // separate-field reasoning (DeepSeek/OpenRouter). Prompt is what's clean.
    const { prompt, reasoning: inlineReasoning } = separateReasoning(content);
    const combinedReasoning = [reasoning, inlineReasoning].filter(Boolean).join('\n');
    if (!prompt) {
        logFailure();
        throw new Error(`LLM returned only reasoning, no prompt — it likely ran out of tokens mid-thought. Raise Max Tokens (currently ${s.maxTokens}). Full reasoning in devtools console.`);
    }
    return { content: prompt, reasoning: combinedReasoning };
}

// ── Workflow Injection ──────────────────────────────────────────────────────

function setNodeText(node, value) {
    if (node.inputs && typeof node.inputs.text === 'string') {
        node.inputs.text = value;
    } else if (node.inputs && typeof node.inputs.value === 'string') {
        // PrimitiveString / PrimitiveStringMultiline nodes store their literal in `value`
        node.inputs.value = value;
    } else if (Array.isArray(node.widgets_values) && node.widgets_values.length > 0) {
        node.widgets_values[0] = value;
    } else if (node.inputs) {
        // text/value exists but is a link array — node is wired as input, not a text source
        throw new Error(`Node "${node._meta?.title ?? node.class_type}" has no literal text/value field (wired as link). Cannot inject.`);
    } else {
        throw new Error(`Node "${node._meta?.title ?? node.class_type}" has no settable text field.`);
    }
}

function injectPromptIntoWorkflow(workflow, positivePrompt, negativePrompt) {
    // Title-convention targets override CLIPTextEncode detection.
    // In ComfyUI, set a node's title to IMAGINE_PROMPT or IMAGINE_NEGATIVE
    // to make it the injection target instead of the first/second CLIPTextEncode.
    let positiveTarget = null;
    let negativeTarget = null;
    const clipNodes = [];

    for (const node of Object.values(workflow)) {
        const title = node._meta?.title;
        if (title === 'IMAGINE_PROMPT') positiveTarget = node;
        else if (title === 'IMAGINE_NEGATIVE') negativeTarget = node;
        if (node.class_type === 'CLIPTextEncode') clipNodes.push(node);
    }

    if (!positiveTarget) {
        if (clipNodes.length === 0) {
            // UI-export format has a `nodes` array (type/title) instead of the
            // API format's node-id → {class_type, inputs} map the injector needs.
            if (Array.isArray(workflow.nodes)) {
                throw new Error('Workflow looks like a UI export, not API format. In ComfyUI use "Export (API)" (or enable Dev Mode → "Save (API Format)") and upload that JSON.');
            }
            throw new Error('Workflow JSON is invalid or missing CLIPTextEncode node.');
        }
        positiveTarget = clipNodes[0];
    }

    setNodeText(positiveTarget, positivePrompt);

    if (negativePrompt) {
        if (!negativeTarget) negativeTarget = clipNodes[1] ?? null;
        if (negativeTarget) setNodeText(negativeTarget, negativePrompt);
    }
}

function randomiseSeed(workflow) {
    for (const node of Object.values(workflow)) {
        if ((node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') &&
            node.inputs?.seed !== undefined) {
            node.inputs.seed = Math.floor(Math.random() * 2 ** 32);
        }
    }
}

// Apply the active character's saved LoRA (Option A: stored in extension settings,
// keyed by character.avatar). This ONLY ever touches the nodes explicitly titled
// IMAGINE_LORA and IMAGINE_LORA_TRIGGER — never any other LoraLoader in the
// workflow — so permanent/style LoRAs are left exactly as exported.
//
// When the active character has NO saved LoRA (or no character is active), the
// IMAGINE_LORA node is neutralised rather than left at the workflow's baked
// default: strength is forced to 0 (identity merge — image identical to no-LoRA;
// API-format JSON can't express a true ComfyUI node bypass) and the trigger node
// is cleared to "". When neither titled node exists, nothing is touched.
// Returns an error string only if a LoRA IS set but no IMAGINE_LORA node exists.
function injectCharacterLora(workflow) {
    const char = getActiveCharacter();
    const entry = char ? getSettings().characterLoras?.[char.avatar] : null;
    const hasLora = !!entry?.lora;

    // Trigger word → IMAGINE_LORA_TRIGGER node. Empty string when no LoRA so a
    // stale baked trigger doesn't leak into the prompt.
    for (const node of Object.values(workflow)) {
        if (node._meta?.title === 'IMAGINE_LORA_TRIGGER') {
            try { setNodeText(node, hasLora ? (entry.trigger ?? '') : ''); } catch { /* wired as link — skip */ }
            break;
        }
    }

    let target = null;
    for (const node of Object.values(workflow)) {
        if (node._meta?.title === 'IMAGINE_LORA') { target = node; break; }
    }
    if (!target?.inputs) {
        // No IMAGINE_LORA node: an error only when the character actually has a
        // LoRA set (so they know to title it). Otherwise a clean no-op.
        return hasLora ? `'${char.name}' has a LoRA set but the workflow has no node titled IMAGINE_LORA. Title your LoraLoader node IMAGINE_LORA.` : null;
    }

    if (hasLora) target.inputs.lora_name = entry.lora;
    const strength = hasLora ? (entry.strength ?? 1) : 0;
    if (target.inputs.strength_model !== undefined) target.inputs.strength_model = strength;
    if (target.inputs.strength_clip !== undefined) target.inputs.strength_clip = strength;
    return null;
}

// ── ComfyUI Submit & Poll ───────────────────────────────────────────────────

async function submitAndPoll(workflowJson, signal) {
    const s = getSettings();
    const comfyUrl = s.comfyUrl.replace(/\/$/, '');

    let promptId;
    try {
        const resp = await fetch(`${comfyUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflowJson }),
            signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        promptId = data.prompt_id;
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error(`Comfy Imagine: Cannot reach ComfyUI at ${comfyUrl}`);
    }

    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        try {
            const resp = await fetch(`${comfyUrl}/history/${promptId}`, { signal });
            if (!resp.ok) continue;
            const history = await resp.json();
            const entry = history[promptId];
            if (entry?.status?.completed) {
                const outputs = entry.outputs ?? {};
                for (const nodeOut of Object.values(outputs)) {
                    const images = nodeOut.images ?? [];
                    if (images.length > 0) {
                        const img = images[0];
                        // Custom savers (e.g. Image Saver Simple) report images as
                        // type "temp", not "output" — honour the reported type
                        // instead of hardcoding, or /view 404s.
                        const type = img.type ?? 'output';
                        // Some savers embed the subfolder into filename with an OS
                        // separator (e.g. "Krea2\image.webp") and leave subfolder
                        // empty. /view needs them split, with forward-slash subfolder.
                        let filename = String(img.filename).replace(/\\/g, '/');
                        let subfolder = (img.subfolder ?? '').replace(/\\/g, '/');
                        const slash = filename.lastIndexOf('/');
                        if (slash !== -1) {
                            const dir = filename.slice(0, slash);
                            filename = filename.slice(slash + 1);
                            subfolder = subfolder ? `${subfolder}/${dir}` : dir;
                        }
                        return `${comfyUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
                    }
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            // transient poll error — keep trying
        }
    }

    throw new Error('timeout');
}

async function fetchImageAsDataUrl(imageUrl, signal) {
    const resp = await fetch(imageUrl, { signal });
    if (!resp.ok) throw new Error('fetch_failed');
    const blob = await resp.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// Uploads raw base64 to ST's image store (POST /api/images/upload), returns the
// saved relative path (e.g. "user/images/Alice/imagine_123_0.png"). Hand-rolled
// because getContext() does not expose ST's own saveBase64AsFile.
async function uploadImageToST(rawB64, format, chName, filename) {
    const { getRequestHeaders } = SillyTavern.getContext();
    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ image: rawB64, format, ch_name: chName || undefined, filename }),
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'upload_failed');
    }
    return (await res.json()).path;
}

// Stores a debug JSON blob as a file on the ST server (POST /api/files/upload,
// writes under data/<user>/user/files/), so the large context+prompt lives on
// disk instead of bloating the chat .jsonl. Returns the saved relative path.
async function uploadDebugToST(name, jsonString) {
    const { getRequestHeaders } = SillyTavern.getContext();
    // UTF-8 safe base64 (context/prompt may contain non-Latin1 characters).
    const bytes = new TextEncoder().encode(jsonString);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, data: btoa(bin) }),
    });
    if (!res.ok) throw new Error('debug_upload_failed');
    return (await res.json()).path;
}

// ST's /api/files/upload rejects any '/' (validateAssetFileName: ^[A-Za-z0-9_.-]+$),
// so debug sidecars can't live in a per-character SUBfolder like images do. Next
// best: fold the (sanitised) character name into the filename so one character's
// sidecars sort together in the flat user/files/ dir. isOwnDebugPath's
// imagine_debug_[^/]+\.json gate still matches.
function debugFileName(chName, tag) {
    const safe = String(chName || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'comfy';
    return `imagine_debug_${safe}_${Date.now()}_${tag}.json`;
}

// All server file paths (images + debug sidecars) referenced by comfy-imagine
// messages in the chat. Used as the cleanup baseline.
function collectImaginePaths() {
    const { chat } = SillyTavern.getContext();
    const set = new Set();
    for (const msg of chat) {
        if (msg?.extra?.title !== 'comfy-imagine') continue;
        if (msg.extra.imaginePath) set.add(msg.extra.imaginePath);
        if (msg.extra.debugPath) set.add(msg.extra.debugPath);
    }
    return set;
}

// Best-effort delete of one of our files from ST's store. Routes to the file
// endpoint for debug sidecars (under user/files/) and the image endpoint for
// generated images. Failures are swallowed: a leftover file is harmless.
async function deleteOwnedFile(path) {
    const { getRequestHeaders } = SillyTavern.getContext();
    const endpoint = isOwnDebugPath(path) ? '/api/files/delete' : '/api/images/delete';
    await fetch(endpoint, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path }),
    }).catch(() => {});
}

// On message deletion, delete files whose messages are gone. MESSAGE_DELETED
// cannot report which message was removed (payload is only the new length), so
// we diff the current referenced-path set against the cached baseline. Orphans
// are removed from the shared baseline Set in place, one at a time, after each
// file's delete succeeds, instead of reassigning the whole Set from a stale
// snapshot, so a concurrent generate() or CHAT_CHANGED rebuild during the
// await gap can't be clobbered.
async function reconcileImagineOrphans() {
    const current = collectImaginePaths();
    const orphans = [...knownImaginePaths].filter(p => !current.has(p) && (isOwnImaginePath(p) || isOwnDebugPath(p)));
    for (const p of orphans) {
        await deleteOwnedFile(p);
        knownImaginePaths.delete(p);
    }
}

// One-time conversion of already-embedded base64 images in the CURRENT chat to
// files. Idempotent (a message already holding a path has no data: URL to match)
// and non-destructive (a failed upload leaves that message's base64 intact).
async function migrateCurrentChat() {
    const { chat, saveChat, getCurrentChatId, reloadCurrentChat } = SillyTavern.getContext();
    const statusEl = document.getElementById('comfy-imagine-migrate-status');
    if (!getCurrentChatId()) { toast('Comfy Imagine: No chat open.', 'warning'); return; }

    let imgMigrated = 0, imgSkipped = 0, dbgMigrated = 0, dbgSkipped = 0;
    let imageRendered = false;
    const active = getActiveCharacter();
    const chName = active?.name || 'comfy-imagine';

    // Embedded base64 image in a mes-like string -> uploaded file. Returns the
    // rewritten "![...](path)" string, or null when there's no data: URL to convert.
    // Throws on upload failure so callers can count it as a skip.
    const externaliseImage = async (mesText, tag) => {
        const m = /!\[[^\]]*\]\((data:image\/[^)]+)\)/.exec(mesText || '');
        if (!m) return null;
        const { format, rawB64 } = splitDataUrl(m[1]);
        const path = await uploadImageToST(rawB64, format, chName, `imagine_migrated_${Date.now()}_${tag}`);
        knownImaginePaths.add(path);
        return { path, mes: `![generated image](${toMarkdownImagePath(path)})` };
    };

    // Inline debug info on an extra-like object -> file. Mutates the object
    // (adds debugPath, drops debugContext/debugPrompt). Returns true if it did
    // anything. Throws on upload failure so callers can count it as a skip.
    const externaliseDebug = async (extra, tag) => {
        if (!extra || extra.debugPath || (extra.debugContext === undefined && extra.debugPrompt === undefined)) return false;
        const debugJson = JSON.stringify({ context: extra.debugContext ?? '', prompt: extra.debugPrompt ?? '' });
        const dpath = await uploadDebugToST(debugFileName(chName, `migrated_${tag}`), debugJson);
        extra.debugPath = dpath;
        delete extra.debugContext;
        delete extra.debugPrompt;
        knownImaginePaths.add(dpath);
        return true;
    };

    for (let idx = 0; idx < chat.length; idx++) {
        const msg = chat[idx];
        if (msg?.extra?.title !== 'comfy-imagine') continue;

        // 1. Embedded base64 image -> file, in the live mes AND every swipe copy.
        //    ST keeps mes in sync with swipes[swipe_id], but rewriting mes does
        //    NOT touch swipes[] — the base64 copies there are what keep bloating
        //    the .jsonl after an old-style migration. Skipped when already a path.
        let mesResult = null;
        try {
            mesResult = await externaliseImage(msg.mes, `${idx}`);
            if (mesResult) { msg.mes = mesResult.mes; msg.extra.imaginePath ??= mesResult.path; imgMigrated++; imageRendered = true; }
        } catch { imgSkipped++; }              // leave base64 untouched
        if (Array.isArray(msg.swipes)) {
            for (let si = 0; si < msg.swipes.length; si++) {
                // The active swipe is a copy of mes; reuse its result instead of
                // re-uploading the identical base64 as a second on-disk file.
                if (si === msg.swipe_id && mesResult) { msg.swipes[si] = mesResult.mes; continue; }
                try {
                    const r = await externaliseImage(msg.swipes[si], `${idx}_s${si}`);
                    if (r) { msg.swipes[si] = r.mes; imgMigrated++; imageRendered = true; }
                } catch { imgSkipped++; }
            }
        }

        // 2. Inline debug info -> file. Only ever written to the top-level extra
        //    (never per-swipe), so swipe_info is not walked. Skipped when already
        //    externalised or absent.
        try { if (await externaliseDebug(msg.extra, `${idx}`)) dbgMigrated++; }
        catch { dbgSkipped++; }
    }

    if (imgMigrated || dbgMigrated) {
        await saveChat();
        if (imageRendered) reloadCurrentChat?.();   // re-render only when an <img> src changed
    }
    const skipped = imgSkipped + dbgSkipped;
    const summary = `Migrated ${imgMigrated} image(s), ${dbgMigrated} debug record(s)` + (skipped ? `, skipped ${skipped}` : '');
    if (statusEl) statusEl.textContent = summary;
    toast(`Comfy Imagine: ${summary}`, skipped ? 'warning' : 'success');
}

// ── Debug Viewer ────────────────────────────────────────────────────────────

async function showDebugModal(mesid) {
    const { chat, callGenericPopup, POPUP_TYPE, getRequestHeaders } = SillyTavern.getContext();
    const msg = chat[mesid];
    if (!msg) return;
    // Newer messages store debug info in a server file (extra.debugPath); older
    // ones kept it inline (extra.debugContext/debugPrompt). Prefer the file, fall
    // back to inline, then to a placeholder.
    let rawContext = msg.extra?.debugContext;
    let rawPrompt = msg.extra?.debugPrompt;
    let rawReasoning = '';
    if (msg.extra?.debugPath) {
        try {
            const r = await fetch(msg.extra.debugPath, { headers: getRequestHeaders() });
            if (r.ok) {
                const d = JSON.parse(await r.text());
                rawContext = d.context;
                rawPrompt = d.prompt;
                rawReasoning = d.reasoning ?? '';
            }
        } catch { /* fall back to inline / placeholder below */ }
    }
    // Generation timing: this image's own phase times (from extra) + GLOBAL last-10
    // averages read from the rolling logs in extensionSettings. Global (not per-chat)
    // so they hold across character/chat switches, where the loaded chat only ever
    // contains its own messages.
    const gs = getSettings();
    const secs = ms => (ms / 1000).toFixed(1);
    const avg10 = log => { const a = (log ?? []).slice(-10); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; };
    const thisMs = msg.extra?.elapsedMs;
    const timing = typeof thisMs === 'number'
        ? `This image — total ${secs(thisMs)}s`
            + (typeof msg.extra?.llmMs === 'number' ? ` &nbsp;(LLM ${secs(msg.extra.llmMs)}s · ComfyUI ${secs(msg.extra.comfyMs)}s)` : '')
            + `<br>Global last-10 avg — total ${secs(avg10(gs.genTimes))}s · LLM ${secs(avg10(gs.llmTimes))}s · ComfyUI ${secs(avg10(gs.comfyTimes))}s`
        : 'Not recorded (generate a new image with /imagine to capture timing)';

    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const sys = esc(getSettings().systemPrompt ?? '');
    const ctx = esc(rawContext ?? '(not stored — regenerate with /imagine to capture)');
    const prompt = esc(rawPrompt ?? '(not stored)');
    const reasoning = esc(rawReasoning ?? '');
    const html = `<div style="display:flex;flex-direction:column;gap:12px;min-width:min(600px,80vw)">
        <div style="font-size:0.9em;opacity:0.85">⏱ ${timing}</div>
        <div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">System Prompt</label>
            <textarea readonly rows="6" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${sys}</textarea>
        </div>
        <div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">User Message (character + persona + chat log)</label>
            <textarea readonly rows="12" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${ctx}</textarea>
        </div>
        ${reasoning ? `<div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">Model Reasoning (&lt;think&gt;)</label>
            <textarea readonly rows="8" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${reasoning}</textarea>
        </div>` : ''}
        <div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">Generated Prompt (returned)</label>
            <textarea readonly rows="6" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${prompt}</textarea>
        </div>
    </div>`;
    callGenericPopup(html, POPUP_TYPE.TEXT, '', { okButton: 'Close' });
}

function injectDebugButtonOnMessage(mesid) {
    const mesEl = document.querySelector(`.mes[mesid="${mesid}"]`);
    if (!mesEl) return;
    if (mesEl.querySelector('.comfy-imagine-debug-btn')) return;
    const container = mesEl.querySelector('.extraMesButtons') ?? mesEl.querySelector('.mes_buttons');
    if (!container) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button comfy-imagine-debug-btn fa-solid fa-circle-info interactable';
    btn.title = 'View LLM context & prompt';
    btn.tabIndex = 0;
    container.prepend(btn);
}

function injectAllDebugButtons() {
    const { chat } = SillyTavern.getContext();
    chat.forEach((msg, i) => {
        if (msg?.extra?.title === 'comfy-imagine' && (msg.extra.debugPath || msg.extra.debugContext || msg.extra.debugPrompt)) {
            injectDebugButtonOnMessage(i);
        }
    });
}

// Camera button: per-message "generate image for this scene". Injected into
// the same three-dots row as the debug button, on every message except our
// own generated-image messages.
function injectImagineButtonOnMessage(mesid) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[mesid];
    if (!msg || msg.extra?.title === 'comfy-imagine') return;
    const mesEl = document.querySelector(`.mes[mesid="${mesid}"]`);
    if (!mesEl) return;
    if (mesEl.querySelector('.comfy-imagine-gen-btn')) return;
    const container = mesEl.querySelector('.extraMesButtons') ?? mesEl.querySelector('.mes_buttons');
    if (!container) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button comfy-imagine-gen-btn fa-solid fa-camera interactable';
    btn.title = 'Generate image for this scene';
    btn.tabIndex = 0;
    container.prepend(btn);
}

function injectAllImagineButtons() {
    const { chat } = SillyTavern.getContext();
    chat.forEach((_msg, i) => injectImagineButtonOnMessage(i));
}

// ── /imagine Slash Command ──────────────────────────────────────────────────

async function runImagine(args) {
    // ST passes a SlashCommandAbortController (custom class, not DOM AbortController)
    // as args._abortController. Bridge it to a native AbortController so fetch() responds.
    const stAbortController = args?._abortController;
    const nativeAbort = new AbortController();
    const onAbort = () => nativeAbort.abort();
    stAbortController?.addEventListener('abort', onAbort);
    try {
        return await generateImages({ signal: nativeAbort.signal });
    } finally {
        stAbortController?.removeEventListener('abort', onAbort);
    }
}

// Shared generation core. targetIndex == null → slash-command tail path
// (context from chat tail, image appended). targetIndex set → per-message
// camera path (context cut at that message; insertion handled in Task 4).
async function generateImages({ targetIndex = null, signal = null } = {}) {
    if (isGenerating) {
        toast('Comfy Imagine: already generating.', 'error');
        return '';
    }

    let chatIdAtStart = null;
    let insertedCount = 0;
    // Path of the first image spliced mid-chat; the finally uses it to scroll
    // back to the insertion point after reloadCurrentChat lands at the bottom.
    let firstInsertedPath = null;

    try {

    isGenerating = true;

    chatIdAtStart = SillyTavern.getContext().getCurrentChatId();

    // Per-message path: hold the target by object identity so concurrent
    // inserts/deletes can't shift the index out from under us.
    const targetMsg = targetIndex != null ? SillyTavern.getContext().chat[targetIndex] : null;
    const isMidChat = targetMsg != null;

    const s = getSettings();

    if (!s.activeWorkflow || !s.workflows?.[s.activeWorkflow]) {
        toast('Comfy Imagine: No workflow selected. Check extension settings.', 'error');
        return '';
    }

    let workflowBase;
    try {
        workflowBase = JSON.parse(s.workflows[s.activeWorkflow]);
    } catch {
        toast('Comfy Imagine: Workflow JSON is invalid or missing CLIPTextEncode node.', 'error');
        return '';
    }

    toast('Generating image…');

    // Wall-clock start for generation timing (click → image saved). Stored per
    // image as extra.elapsedMs; the debug modal shows it + a last-10 average.
    // ponytail: single t0 → for imageCount>1 later images carry the shared LLM
    // time cumulatively, not per-image. Fine for the 1-image camera quick-click.
    const t0 = performance.now();

    // Step 1 — gather context (cut at targetIndex for per-message generation)
    const contextString = assembleContext(targetIndex);

    // Step 2 — call LLM
    let llmOutput, llmReasoning;
    try {
        ({ content: llmOutput, reasoning: llmReasoning } = await generatePromptViaLLM(contextString, signal));
    } catch (err) {
        if (err.name === 'AbortError') return '';
        toast(`Comfy Imagine: LLM error — ${err.message}`, 'error');
        return '';
    }

    // LLM phase time (t0 → prompt returned). Shared across all images in the call,
    // so it's logged once, not per image.
    const llmMs = Math.round(performance.now() - t0);
    (s.llmTimes ??= []).push(llmMs);
    if (s.llmTimes.length > 50) s.llmTimes.shift();

    const finalPrompt = (s.promptPrefix ?? '') + llmOutput + (s.promptSuffix ?? '');
    toast('Prompt ready, submitting to ComfyUI…');

    // Steps 3–N: for each image
    const imageCount = Math.min(8, Math.max(1, s.imageCount || 1));
    for (let i = 0; i < imageCount; i++) {
        const workflow = JSON.parse(JSON.stringify(workflowBase)); // deep clone

        try {
            injectPromptIntoWorkflow(workflow, finalPrompt, s.negativePrompt);
        } catch (err) {
            toast(`Comfy Imagine: ${err.message}`, 'error');
            return '';
        }

        const loraErr = injectCharacterLora(workflow);
        if (loraErr && i === 0) toast(`Comfy Imagine: ${loraErr}`, 'error');

        if (imageCount > 1) randomiseSeed(workflow);

        // ComfyUI phase start for THIS image (submit + poll + fetch + upload).
        // Per-image, so multi-image calls get an accurate comfy time each.
        const tComfyStart = performance.now();

        let imageUrl;
        try {
            imageUrl = await submitAndPoll(workflow, signal);
        } catch (err) {
            if (err.name === 'AbortError') return '';
            if (err.message === 'timeout') {
                toast('Comfy Imagine: Generation timed out.', 'error');
            } else {
                toast(err.message, 'error');
            }
            return '';
        }

        let dataUrl;
        try {
            dataUrl = await fetchImageAsDataUrl(imageUrl, signal);
        } catch (err) {
            if (err.name === 'AbortError') return '';
            toast('Comfy Imagine: Image generated but could not be retrieved.', 'error');
            return '';
        }

        const active = getActiveCharacter();
        const chName = active?.name || 'comfy-imagine';
        // _${i}: two images generated in the same millisecond would otherwise
        // share a filename, and deleting one message would orphan-delete the
        // file the other still uses.
        const filename = `imagine_${Date.now()}_${i}`;

        let path;
        try {
            const { format, rawB64 } = splitDataUrl(dataUrl);
            path = await uploadImageToST(rawB64, format, chName, filename);
        } catch (err) {
            if (err.name === 'AbortError') return '';
            toast('Comfy Imagine: Image generated but could not be saved to disk.', 'error');
            return '';
        }

        // Store the debug info (LLM context + generated prompt) as a file on the
        // server rather than inline in the chat, which would bloat the .jsonl with
        // the whole context per image. Best-effort: on failure just skip it.
        let debugPath = null;
        try {
            const debugJson = JSON.stringify({ context: contextString, prompt: llmOutput, reasoning: llmReasoning });
            debugPath = await uploadDebugToST(debugFileName(chName, i), debugJson);
        } catch { /* debug is optional; a missing sidecar just shows "not stored" */ }

        // Timing: total (click → saved), plus this image's ComfyUI phase alone.
        // All three phases keep a global rolling log in extensionSettings so the
        // averages survive chat/character switches — the loaded chat only ever
        // holds its own messages. llmTimes was already pushed once above.
        const now = performance.now();
        const elapsedMs = Math.round(now - t0);
        const comfyMs = Math.round(now - tComfyStart);
        (s.genTimes ??= []).push(elapsedMs);
        (s.comfyTimes ??= []).push(comfyMs);
        if (s.genTimes.length > 50) s.genTimes.shift();   // keep last 50; modal averages last 10
        if (s.comfyTimes.length > 50) s.comfyTimes.shift();
        saveSettings();

        const { chat, addOneMessage, saveChat, getCurrentChatId } = SillyTavern.getContext();

        // Chat-switch guard: the user may have opened another chat during the
        // async generation. Inserting now would put the image into the wrong
        // chat's array — discard instead. (The uploaded file stays on disk but
        // is invisible; acceptable for a rare race.)
        if (getCurrentChatId() !== chatIdAtStart) {
            toast('Comfy Imagine: chat changed during generation — image discarded.', 'error');
            return '';
        }

        const imageMessage = {
            name: s.senderName || 'Camera',
            is_user: false,
            is_system: true,
            send_date: new Date().toISOString(),
            // Encoded for markdown only; imaginePath below stays raw so the
            // delete gate and /api/images/delete still match the file on disk.
            mes: `![generated image](${toMarkdownImagePath(path)})`,
            extra: {
                title: 'comfy-imagine',
                imaginePath: path,
                elapsedMs,
                llmMs,
                comfyMs,
                ...(debugPath ? { debugPath } : {}),
            },
        };
        if (isMidChat) {
            // Insert directly after the target message. indexOf === -1 with the
            // same chat id means the target was deleted mid-generation → append
            // at the end of the (correct) chat instead.
            const at = chat.indexOf(targetMsg);
            if (at === -1 && insertedCount === 0) toast('Comfy Imagine: original message was deleted — image appended at end.');
            const insertAt = at === -1 ? chat.length : at + 1 + insertedCount;
            chat.splice(insertAt, 0, imageMessage);
            insertedCount++;
            if (firstInsertedPath == null) firstInsertedPath = path;
            // No addOneMessage / per-image save here: the DOM would get stale
            // mesid attributes. One saveChat + reloadCurrentChat in the finally
            // renders everything consistently (ST's own mid-chat insert pattern).
        } else {
            chat.push(imageMessage);
            await addOneMessage(imageMessage, { scroll: true });
            await saveChat();
            injectDebugButtonOnMessage(chat.length - 1);
        }
        knownImaginePaths.add(path);
        if (debugPath) knownImaginePaths.add(debugPath);
    }

    } finally {
        isGenerating = false;
        // Mid-chat inserts are in-memory only until saved; reloadCurrentChat
        // re-fetches the chat from the server, so save MUST come first. Runs
        // even after a mid-loop error/abort so images 1..k of n survive.
        // reloadCurrentChat emits CHAT_CHANGED (script.js getChatResult), which
        // re-injects debug/camera buttons and rebuilds knownImaginePaths.
        if (insertedCount > 0) {
            try {
                const { saveChat, reloadCurrentChat, getCurrentChatId } = SillyTavern.getContext();
                // Never persist into a different chat than we spliced into: a
                // switch mid-generation means the save would target whatever
                // chat is current NOW. Skip and say so — the uploaded files
                // stay on disk but unreferenced.
                if (getCurrentChatId() !== chatIdAtStart) {
                    toast(`Comfy Imagine: chat changed — ${insertedCount} generated image(s) may not have been saved.`, 'error');
                } else {
                    // ST's printMessages schedules two delayed scroll-to-bottoms
                    // after the reload (a rAF one, and scrollOnMediaLoad which
                    // re-fires when the chat's images — including the one we just
                    // generated — finish loading, up to ~1.4s later). Both early-
                    // return when auto_scroll_chat_to_bottom is off, so suppress
                    // it around the reload and restore it after that window; a
                    // plain scrollIntoView here would just be yanked back down.
                    // CAUTION: power_user is serialised into settings.json by any
                    // saveSettingsDebounced that fires while the flag is off (our
                    // own timing-log saveSettings() a moment ago is debounced ~1s,
                    // landing squarely inside the 2s window) — which persisted the
                    // suppressed `false` and made every NEW chat open at the top.
                    // So: stash a restore-pending marker (it rides along in the
                    // same settings save), re-persist `true` after the restore,
                    // and let init() heal the flag if the tab dies mid-window.
                    const pu = SillyTavern.getContext().powerUserSettings;
                    const hadAutoScroll = pu?.auto_scroll_chat_to_bottom === true;
                    if (hadAutoScroll) {
                        pu.auto_scroll_chat_to_bottom = false;
                        getSettings().autoScrollRestorePending = true;
                    }
                    try {
                        await saveChat();
                        await reloadCurrentChat();
                        // Bring the user back to the image they just generated.
                        // Path lookup (not a saved index) survives any index
                        // shift across the reload. ponytail: if the insert sits
                        // above ST's lazy-render fold ("Load more messages"),
                        // the element doesn't exist and we stay at the bottom —
                        // hook showMoreMessages if it matters.
                        if (firstInsertedPath != null) {
                            const idx = (SillyTavern.getContext().chat ?? [])
                                .findIndex(m => m.extra?.imaginePath === firstInsertedPath);
                            const mesEl = idx !== -1 ? document.querySelector(`.mes[mesid="${idx}"]`) : null;
                            if (mesEl) {
                                mesEl.scrollIntoView({ block: 'center' });
                                // The generated image loads async and shifts the
                                // layout; re-center once it's actually in.
                                const img = mesEl.querySelector('.mes_block img');
                                if (img && !img.complete) {
                                    img.addEventListener('load', () => mesEl.scrollIntoView({ block: 'center' }), { once: true });
                                }
                            }
                        }
                    } finally {
                        // Restore only after ST's media-load scroll window has
                        // passed, or the deferred scrolls sneak back to bottom.
                        if (hadAutoScroll) setTimeout(() => {
                            pu.auto_scroll_chat_to_bottom = true;
                            delete getSettings().autoScrollRestorePending;
                            // Re-persist: a debounced settings save very likely
                            // fired during the false-window and wrote `false`.
                            saveSettings();
                        }, 2000);
                    }
                }
            } catch (err) {
                toast(`Comfy Imagine: failed to refresh chat — ${err.message}`, 'error');
            }
        }
    }

    return '';
}

// ── Initialisation ──────────────────────────────────────────────────────────

// ST update hook (wired via manifest.json "hooks".update). ST calls this right
// after the USER manually updates the extension — the moment new files land on
// disk — then only toasts "reload to apply" without reloading. We reload here so
// the new build (and its force-synced preset/prompt) takes effect immediately.
// Updates stay fully manual: this fires only in response to the user clicking
// Update, and never triggers an update itself.
export function onExtensionUpdate() {
    location.reload();
}

(async function init() {
    const { extensionSettings, renderExtensionTemplateAsync } = SillyTavern.getContext();
    const lodash = SillyTavern.libs.lodash;

    // Merge defaults into extensionSettings
    if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = {};
    lodash.merge(extensionSettings[MODULE_NAME], { ...defaultSettings, ...extensionSettings[MODULE_NAME] });

    // Keep the extension-owned default preset in sync with DEFAULT_SYSTEM_PROMPT so
    // shipped updates reach existing installs. This preset is authoritative — to
    // customise, use Save As under a different name (that one is never overwritten).
    const settings = extensionSettings[MODULE_NAME];
    if (!settings.systemPromptPresets) settings.systemPromptPresets = {};
    // Legacy rename cleanup: the default preset used to be 'Krea 2 Turbo (default)'.
    // It was read-only/force-synced, so a copy under the old name is the old shipped
    // default (not user work) — drop it so the dropdown doesn't show a stale twin.
    delete settings.systemPromptPresets['Krea 2 Turbo (default)'];
    // The 'Krea 2 - Intimate POV' preset is no longer shipped; it was force-synced,
    // so any copy is the old shipped text, not user work.
    delete settings.systemPromptPresets['Krea 2 - Intimate POV'];
    if (settings.systemPrompt?.startsWith('# Krea 2 Image Prompt Writer')) settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    settings.systemPromptPresets[DEFAULT_PRESET_NAME] = DEFAULT_SYSTEM_PROMPT;

    // Heal auto-scroll if a previous session died inside the 2s suppression
    // window around the mid-chat reload (see generateImages' finally): the
    // pending marker means the user's flag was `true` before we flipped it,
    // so restoring `true` here is always correct.
    if (settings.autoScrollRestorePending) {
        delete settings.autoScrollRestorePending;
        const pu = SillyTavern.getContext().powerUserSettings;
        if (pu) pu.auto_scroll_chat_to_bottom = true;
        saveSettings();
    }

    // Render settings panel
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    document.getElementById('extensions_settings')?.insertAdjacentHTML('beforeend', settingsHtml);

    loadSettingsIntoUI();
    bindSettingsEvents();

    // Delegated click handler for debug buttons (works for buttons injected at any time)
    $(document).on('click', '.comfy-imagine-debug-btn', e => {
        const mesid = parseInt($(e.currentTarget).closest('.mes').attr('mesid'));
        if (!isNaN(mesid)) showDebugModal(mesid);
    });

    // Delegated click for camera buttons. mesid is resolved at click time, so
    // buttons injected after any re-render keep working.
    $(document).on('click', '.comfy-imagine-gen-btn', e => {
        const mesid = parseInt($(e.currentTarget).closest('.mes').attr('mesid'));
        if (isNaN(mesid)) return;

        // Mirror the slash-command path's abort UX with ST's own stop button.
        // ST's chat-input script pipeline (which shows its stop UI for /imagine)
        // is not exposed via getContext(), so we drive #mes_stop directly:
        // show it, wire a listener that aborts our native controller, hide it
        // when done. ST's delegated .mes_stop handler (stopGeneration) fires on
        // the same click but is harmless with no ST generation running.
        // Only touch the button if it isn't already visible — if it is, an ST
        // generation owns it and we must not hide it out from under that.
        const nativeAbort = new AbortController();
        const stopBtn = document.querySelector('#mes_stop');
        const ownStopBtn = stopBtn && getComputedStyle(stopBtn).display === 'none';
        const onStop = () => nativeAbort.abort();
        if (ownStopBtn) {
            stopBtn.addEventListener('click', onStop);
            stopBtn.style.display = 'flex';
        }
        generateImages({ targetIndex: mesid, signal: nativeAbort.signal })
            .catch(err => toast(`Comfy Imagine: ${err.message}`, 'error'))
            .finally(() => {
                if (ownStopBtn) {
                    stopBtn.removeEventListener('click', onStop);
                    stopBtn.style.display = 'none';
                }
            });
    });

    // Inject debug buttons on chat load/switch and at startup
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, () => {
        injectAllDebugButtons();
        injectAllImagineButtons();
        populateCharacterLoraUI();
        // Rebuild the baseline for the newly-opened chat. No deletion here:
        // switching chats is not deleting.
        knownImaginePaths = collectImaginePaths();
    });
    eventSource.on(event_types.MESSAGE_DELETED, () => { reconcileImagineOrphans(); });
    // A character rename CHANGES the avatar filename: ST derives it from the new
    // name (getPngName -> sanitize(name) + uniqueness suffix) and unlinks the old
    // file (src/endpoints/characters.js, POST /characters/rename). So characterLoras,
    // keyed by avatar, loses its entry on rename and the LoRA silently neutralises.
    // ST core has the same problem with its own avatar-keyed data and solves it the
    // same way — renameTagKey/charLore/charNote are remapped immediately before this
    // event is emitted (script.js, renameCharacter).
    eventSource.on(event_types.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        const loras = getSettings().characterLoras;
        if (!oldAvatar || !newAvatar || oldAvatar === newAvatar || !loras?.[oldAvatar]) return;
        loras[newAvatar] = loras[oldAvatar];
        delete loras[oldAvatar];
        saveSettings();
    });
    // New messages during a session: CHAT_CHANGED doesn't fire for them, so
    // hook the per-message render events.
    eventSource.on(event_types.USER_MESSAGE_RENDERED, mesid => injectImagineButtonOnMessage(mesid));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, mesid => injectImagineButtonOnMessage(mesid));
    // Older messages render lazily ("Load more messages"); walk again when a
    // batch appears so they get their buttons too. Both walkers are idempotent.
    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
        injectAllImagineButtons();
        injectAllDebugButtons();
    });
    injectAllDebugButtons();
    injectAllImagineButtons();
    knownImaginePaths = collectImaginePaths();   // seed baseline at startup

    // Register /imagine slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'imagine',
        callback: runImagine,
        helpString: 'Generate an image based on the current chat context using ComfyUI.',
    }));
})();
