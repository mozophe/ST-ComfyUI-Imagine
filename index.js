import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { splitDataUrl, isOwnImaginePath, isOwnDebugPath } from './image-helpers.js';

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

const DEFAULT_SYSTEM_PROMPT = `You are an expert image prompt writer for Krea 2 Turbo, an aesthetic-first, photorealistic diffusion model. Krea 2 rewards specific, detailed description over rigid structure — the more concretely you describe the subject, setting, lighting, color, and style, the tighter and more accurate its output. There is no required element order; write it the way it reads best.

You will be given a roleplay chat log, character description, and user persona. The user persona is the viewer. Write a single image prompt (about 80–150 words) describing the current scene as a first-person POV photograph taken from the viewer's own eyes.

Hard rules:
- The camera is always the viewer's first-person point of view. The viewer (the user persona) is NOT in the frame, except possibly their own hands, arms, torso, legs, or an object they are holding reaching into view. Never describe the viewer's face.
- Describe ONLY what is actually visible in the viewer's field of view at this moment. Do not mention sounds, smells, thoughts, dialogue, past events, or anything outside or behind the frame.
- Always begin with exactly "POV shot," followed by 2–4 comma-separated photographic framing terms (e.g. "low angle, close-up, shallow depth of field"), then a period. Begin the subject and scene description in a new sentence. Do not embed the viewer's posture or actions inside the camera clause.
- Explicitly state the photographic medium and style somewhere in the prompt. Default to "shot on an iPhone, grainy texture, captured from a messy angle, soft focus, minor lens imperfections, realistic skin textures." Use the character card's implied art style only if it is clearly non-realistic.

Cover these elements, in whatever order reads naturally:
- Style & medium — weave the photographic medium and style fixed by the hard rules through the whole image, keeping textures, grain, and detail consistent with it.
- Subject(s) in view — each character the viewer is looking at, with 2–4 concrete physical traits and explicit clothing, in a precise pose framed from the viewer's POV.
- Setting — the visible environment, specific but not cluttered.
- Lighting — name its quality (e.g. soft diffused daylight, warm candlelight, cinematic rim lighting).
- Color & mood — the palette and the feeling it conveys (e.g. warm earthy tones, cool muted blues).
- Camera & composition — any further composition cues beyond the opening framing terms (e.g. how the subject is framed, focal length, depth cues) where they suit the POV.

Write in vivid, specific language — rich descriptive phrases or full sentences, not bare keyword tags. Avoid vague subjective words like "beautiful" or "amazing". Output only the prompt. Do not explain or comment.`;

// Name under which DEFAULT_SYSTEM_PROMPT is seeded into the presets dropdown so
// users can always switch back to it after editing.
const DEFAULT_PRESET_NAME = 'Krea 2 Turbo (default)';

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
    maxTokens: 350,
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
    btn.disabled = !name || name === DEFAULT_PRESET_NAME;
    btn.title = name === DEFAULT_PRESET_NAME
        ? `'${DEFAULT_PRESET_NAME}' is read-only — use Save As to keep changes`
        : (name ? 'Overwrite the selected preset with the current system prompt' : 'Select a preset to overwrite');
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
        allowClear: true,
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
        // The default preset is extension-owned and rewritten with the shipped
        // default on every load, so a Save here would be silently wiped. Block it
        // and steer the user to Save As, which persists under their own name.
        if (name === DEFAULT_PRESET_NAME) {
            toast(`'${DEFAULT_PRESET_NAME}' can't be overwritten — use Save As to keep your changes.`, 'error');
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
    bind('comfy-imagine-max-tokens', 'maxTokens', v => Math.min(4096, Math.max(1, parseInt(v, 10) || 350)));
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

function assembleContext() {
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
    // Filter system messages first so the limit counts real dialogue, not hidden
    // injected images. limit <= 0 means send the whole log.
    const limit = getSettings().chatHistoryLimit || 0;
    let chatMsgs = (ctx.chat ?? []).filter(m => !m.is_system);
    if (limit > 0) chatMsgs = chatMsgs.slice(-limit);
    for (const msg of chatMsgs) {
        const speaker = msg.is_user ? userName : (character.name ?? 'Character');
        lines.push(`${speaker}: ${msg.mes}`);
    }

    const lastTrackerMsg = [...(ctx.chat ?? [])].reverse().find(
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
            'Authorization': `Bearer ${s.llmApiKey}`,
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => resp.statusText);
        throw new Error(`HTTP ${resp.status} — ${text}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) {
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
    return content;
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
        if (clipNodes.length === 0) throw new Error('Workflow JSON is invalid or missing CLIPTextEncode node.');
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
                        return `${comfyUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? '')}&type=output`;
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

    for (let idx = 0; idx < chat.length; idx++) {
        const msg = chat[idx];
        if (msg?.extra?.title !== 'comfy-imagine') continue;

        // 1. Embedded base64 image -> file. Skipped when already a path.
        const m = /!\[[^\]]*\]\((data:image\/[^)]+)\)/.exec(msg.mes || '');
        if (m) {
            try {
                const { format, rawB64 } = splitDataUrl(m[1]);
                const path = await uploadImageToST(rawB64, format, chName, `imagine_migrated_${Date.now()}_${idx}`);
                msg.mes = `![generated image](${path})`;
                msg.extra.imaginePath = path;
                knownImaginePaths.add(path);
                imgMigrated++;
                imageRendered = true;
            } catch {
                imgSkipped++;                   // leave base64 untouched
            }
        }

        // 2. Inline debug info -> file. Skipped when already externalised
        //    (has debugPath) or never had any.
        if (!msg.extra.debugPath && (msg.extra.debugContext !== undefined || msg.extra.debugPrompt !== undefined)) {
            try {
                const debugJson = JSON.stringify({ context: msg.extra.debugContext ?? '', prompt: msg.extra.debugPrompt ?? '' });
                const dpath = await uploadDebugToST(`imagine_debug_migrated_${Date.now()}_${idx}.json`, debugJson);
                msg.extra.debugPath = dpath;
                delete msg.extra.debugContext;
                delete msg.extra.debugPrompt;
                knownImaginePaths.add(dpath);
                dbgMigrated++;
            } catch {
                dbgSkipped++;                   // leave inline debug untouched
            }
        }
    }

    console.log('[comfy-imagine][DEBUG] migrate counts img=', imgMigrated, 'dbg=', dbgMigrated, 'imgSkip=', imgSkipped, 'dbgSkip=', dbgSkipped);
    const sample = chat.find(msg => msg?.extra?.title === 'comfy-imagine');
    console.log('[comfy-imagine][DEBUG] sample after mutate: mes[0..40]=', (sample?.mes || '').slice(0, 40), 'extra keys=', sample ? Object.keys(sample.extra) : null);
    if (imgMigrated || dbgMigrated) {
        console.log('[comfy-imagine][DEBUG] calling saveChat, typeof=', typeof saveChat);
        await saveChat();
        console.log('[comfy-imagine][DEBUG] saveChat returned; imageRendered=', imageRendered);
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
    if (msg.extra?.debugPath) {
        try {
            const r = await fetch(msg.extra.debugPath, { headers: getRequestHeaders() });
            if (r.ok) {
                const d = JSON.parse(await r.text());
                rawContext = d.context;
                rawPrompt = d.prompt;
            }
        } catch { /* fall back to inline / placeholder below */ }
    }
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const sys = esc(getSettings().systemPrompt ?? '');
    const ctx = esc(rawContext ?? '(not stored — regenerate with /imagine to capture)');
    const prompt = esc(rawPrompt ?? '(not stored)');
    const html = `<div style="display:flex;flex-direction:column;gap:12px;min-width:min(600px,80vw)">
        <div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">System Prompt</label>
            <textarea readonly rows="6" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${sys}</textarea>
        </div>
        <div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">User Message (character + persona + chat log)</label>
            <textarea readonly rows="12" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${ctx}</textarea>
        </div>
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

// ── /imagine Slash Command ──────────────────────────────────────────────────

async function runImagine(args) {
    // ST passes a SlashCommandAbortController (custom class, not DOM AbortController)
    // as args._abortController. Bridge it to a native AbortController so fetch() responds.
    const stAbortController = args?._abortController;
    const nativeAbort = new AbortController();
    const signal = nativeAbort.signal;
    const onAbort = () => nativeAbort.abort();
    stAbortController?.addEventListener('abort', onAbort);

    try {

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

    // Step 1 — gather context
    const contextString = assembleContext();

    // Step 2 — call LLM
    let llmOutput;
    try {
        llmOutput = await generatePromptViaLLM(contextString, signal);
    } catch (err) {
        if (err.name === 'AbortError') return '';
        toast(`Comfy Imagine: LLM error — ${err.message}`, 'error');
        return '';
    }

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
            const debugJson = JSON.stringify({ context: contextString, prompt: llmOutput });
            debugPath = await uploadDebugToST(`imagine_debug_${Date.now()}_${i}.json`, debugJson);
        } catch { /* debug is optional; a missing sidecar just shows "not stored" */ }

        const { chat, addOneMessage, saveChat } = SillyTavern.getContext();
        const imageMessage = {
            name: s.senderName || 'Camera',
            is_user: false,
            is_system: true,
            send_date: new Date().toISOString(),
            mes: `![generated image](${path})`,
            extra: {
                title: 'comfy-imagine',
                imaginePath: path,
                ...(debugPath ? { debugPath } : {}),
            },
        };
        chat.push(imageMessage);
        await addOneMessage(imageMessage, { scroll: true });
        await saveChat();
        injectDebugButtonOnMessage(chat.length - 1);
        knownImaginePaths.add(path);
        if (debugPath) knownImaginePaths.add(debugPath);
    }

    } finally {
        stAbortController?.removeEventListener('abort', onAbort);
    }

    return '';
}

// ── Initialisation ──────────────────────────────────────────────────────────

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
    settings.systemPromptPresets[DEFAULT_PRESET_NAME] = DEFAULT_SYSTEM_PROMPT;

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

    // Inject debug buttons on chat load/switch and at startup
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, () => {
        injectAllDebugButtons();
        populateCharacterLoraUI();
        // Rebuild the baseline for the newly-opened chat. No deletion here:
        // switching chats is not deleting.
        knownImaginePaths = collectImaginePaths();
    });
    eventSource.on(event_types.MESSAGE_DELETED, () => { reconcileImagineOrphans(); });
    injectAllDebugButtons();
    knownImaginePaths = collectImaginePaths();   // seed baseline at startup

    // Register /imagine slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'imagine',
        callback: runImagine,
        helpString: 'Generate an image based on the current chat context using ComfyUI.',
    }));
})();
