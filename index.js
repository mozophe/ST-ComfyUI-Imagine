import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

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

const DEFAULT_SYSTEM_PROMPT = `You are an expert image prompt writer for Z-Image Turbo, a diffusion model that reads natural-language sentences rather than comma-separated tag lists.

You will be given a roleplay chat log, character description, and user persona. Write a single image prompt (80–150 words) that visually captures the current scene.

Follow this structure in order:
1. Shot type and angle — e.g. "medium shot from eye level", "close-up", "wide establishing shot"
2. Subject(s) — describe each character present with 2–4 physical traits and explicit clothing details
3. Environment — the setting, specific but not cluttered
4. Lighting — name the quality: "soft diffused daylight", "warm candlelight", "cinematic rim lighting", etc.
5. Mood and atmosphere — the emotional tone of the scene
6. Style — default to "realistic photograph"; use the character card's implied art style if clearly non-realistic
7. Cleanup constraints — always end with: "sharp focus, correct human anatomy, no extra limbs, no text, no watermark, no logos"

Write in complete sentences, not comma-separated tags. Output only the prompt. Do not explain or comment.`;

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
    characterLoras: {},   // { [character.avatar]: { lora, strength } }
    imageCount: 1,
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

// Refresh the Character LoRAs panel for whoever is active right now. Called on
// settings load and on CHAT_CHANGED so the fields track character switches.
async function populateCharacterLoraUI() {
    const nameEl = document.getElementById('comfy-imagine-lora-charname');
    const select = document.getElementById('comfy-imagine-lora-select');
    const strengthEl = document.getElementById('comfy-imagine-lora-strength');
    if (!nameEl || !select) return;

    const char = getActiveCharacter();
    if (!char) {
        nameEl.textContent = '— no character selected —';
        select.innerHTML = '<option value="">— none —</option>';
        select.disabled = true;
        if (strengthEl) strengthEl.disabled = true;
        return;
    }
    select.disabled = false;
    if (strengthEl) strengthEl.disabled = false;
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
}

// Persist the current panel selection against the active character's avatar.
// Empty LoRA removes the entry so the workflow's own default is used.
function saveCharacterLora() {
    const char = getActiveCharacter();
    if (!char) return;
    const select = document.getElementById('comfy-imagine-lora-select');
    const strengthEl = document.getElementById('comfy-imagine-lora-strength');
    const settings = getSettings();
    if (!settings.characterLoras) settings.characterLoras = {};
    const lora = select?.value ?? '';
    if (!lora) {
        delete settings.characterLoras[char.avatar];
    } else {
        settings.characterLoras[char.avatar] = {
            lora,
            strength: Math.min(2, Math.max(-2, parseFloat(strengthEl?.value) || 1)),
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

    document.getElementById('comfy-imagine-sp-preset-overwrite')?.addEventListener('click', () => {
        const settings = getSettings();
        const name = settings.activeSystemPromptPreset;
        if (!name || !settings.systemPromptPresets?.[name]) {
            toast('No preset selected — use Save As.', 'error');
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

    document.getElementById('comfy-imagine-lora-select')?.addEventListener('change', saveCharacterLora);
    document.getElementById('comfy-imagine-lora-strength')?.addEventListener('input', saveCharacterLora);
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
    for (const msg of (ctx.chat ?? [])) {
        if (msg.is_system) continue;
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
        throw new Error(text);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() ?? '';
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
// keyed by character.avatar). Target is the node titled IMAGINE_LORA, else the
// first LoraLoader. No saved LoRA → leave the workflow untouched (its own default).
// Returns an error string if a LoRA is set but no loader node exists, else null.
function injectCharacterLora(workflow) {
    const char = getActiveCharacter();
    if (!char) return null;
    const entry = getSettings().characterLoras?.[char.avatar];
    if (!entry?.lora) return null;

    let target = null;
    for (const node of Object.values(workflow)) {
        if (node._meta?.title === 'IMAGINE_LORA') { target = node; break; }
    }
    if (!target) {
        for (const node of Object.values(workflow)) {
            if (node.class_type === 'LoraLoader' || node.class_type === 'LoraLoaderModelOnly') { target = node; break; }
        }
    }
    if (!target?.inputs) {
        return `'${char.name}' has a LoRA set but the workflow has no LoraLoader node. Title one IMAGINE_LORA.`;
    }

    target.inputs.lora_name = entry.lora;
    const strength = entry.strength ?? 1;
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

// ── Debug Viewer ────────────────────────────────────────────────────────────

function showDebugModal(mesid) {
    const { chat, callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
    const msg = chat[mesid];
    if (!msg) return;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const sys = esc(getSettings().systemPrompt ?? '');
    const ctx = esc(msg.extra?.debugContext ?? '(not stored — regenerate with /imagine to capture)');
    const prompt = esc(msg.extra?.debugPrompt ?? '(not stored)');
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
        if (msg?.extra?.title === 'comfy-imagine' && (msg.extra.debugContext || msg.extra.debugPrompt)) {
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

        const { chat, addOneMessage, saveChat } = SillyTavern.getContext();
        const imageMessage = {
            name: s.senderName || 'Camera',
            is_user: false,
            is_system: true,
            send_date: new Date().toISOString(),
            mes: `![generated image](${dataUrl})`,
            extra: {
                title: 'comfy-imagine',
                debugContext: contextString,
                debugPrompt: llmOutput,
            },
        };
        chat.push(imageMessage);
        await addOneMessage(imageMessage, { scroll: true });
        await saveChat();
        injectDebugButtonOnMessage(chat.length - 1);
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
    });
    injectAllDebugButtons();

    // Register /imagine slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'imagine',
        callback: runImagine,
        helpString: 'Generate an image based on the current chat context using ComfyUI.',
    }));
})();
