import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';

const MODULE_NAME = 'comfy_imagine';
// Capture everything after scripts/extensions/ up to index.js — this preserves
// the third-party/ prefix that ST uses for externally installed extensions.
const EXTENSION_FOLDER = (() => {
    const m = new URL(import.meta.url).pathname.match(/scripts\/extensions\/(.+)\/index\.js$/);
    return m ? m[1] : new URL(import.meta.url).pathname.split('/').slice(-2, -1)[0];
})();
const POLL_INTERVAL_MS = 1500;
const GENERATION_TIMEOUT_MS = 120_000;

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
    promptPrefix: '',
    promptSuffix: '',
    negativePrompt: '',
    workflows: {},
    activeWorkflow: '',
    imageCount: 1,
    senderName: 'Camera',
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

    const prev = select.value;
    select.innerHTML = '<option value="">— none —</option>';
    for (const name of Object.keys(settings.workflows || {})) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
    select.value = settings.workflows?.[prev] ? prev : (settings.activeWorkflow || '');
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

    populateWorkflowDropdown();
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
    bind('comfy-imagine-prompt-prefix', 'promptPrefix');
    bind('comfy-imagine-prompt-suffix', 'promptSuffix');
    bind('comfy-imagine-negative-prompt', 'negativePrompt');
    bind('comfy-imagine-sender-name', 'senderName');
    bind('comfy-imagine-image-count', 'imageCount', v => Math.min(8, Math.max(1, parseInt(v, 10) || 1)));

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
        reader.readAsText(file);
        e.target.value = '';
    });

    document.getElementById('comfy-imagine-reload-workflows')?.addEventListener('click', () => {
        populateWorkflowDropdown();
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
    const persona = ctx.persona ?? {};

    const lines = [];

    lines.push('[CHARACTER]');
    lines.push(`Name: ${character.name ?? 'Unknown'}`);
    if (character.description) lines.push(`Description: ${character.description}`);
    if (character.personality) lines.push(`Personality: ${character.personality}`);
    if (character.scenario)    lines.push(`Scenario: ${character.scenario}`);

    lines.push('');
    lines.push('[USER PERSONA]');
    lines.push(`Name: ${persona.name ?? ctx.name1 ?? 'User'}`);
    if (persona.description) lines.push(`Description: ${persona.description}`);

    lines.push('');
    lines.push('[CHAT LOG]');
    for (const msg of (ctx.chat ?? [])) {
        if (msg.is_system) continue;
        const speaker = msg.is_user ? (persona.name ?? ctx.name1 ?? 'User') : (character.name ?? 'Character');
        lines.push(`${speaker}: ${msg.mes}`);
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
        max_tokens: 300,
        temperature: 0.7,
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

function injectPromptIntoWorkflow(workflow, positivePrompt, negativePrompt) {
    const clipNodes = [];
    for (const [id, node] of Object.entries(workflow)) {
        if (node.class_type === 'CLIPTextEncode') {
            clipNodes.push({ id, node });
        }
    }

    if (clipNodes.length === 0) {
        throw new Error('Workflow JSON is invalid or missing CLIPTextEncode node.');
    }

    clipNodes[0].node.inputs.text = positivePrompt;

    if (negativePrompt && clipNodes.length >= 2) {
        clipNodes[1].node.inputs.text = negativePrompt;
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

        const { chat, addOneMessage } = SillyTavern.getContext();
        const imageMessage = {
            name: s.senderName || 'Camera',
            is_user: false,
            is_system: true,
            send_date: new Date().toISOString(),
            mes: `![generated image](${dataUrl})`,
            extra: {
                title: 'comfy-imagine',
            },
        };
        chat.push(imageMessage);
        await addOneMessage(imageMessage, { scroll: true, save: true });
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

    // Register /imagine slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'imagine',
        callback: runImagine,
        helpString: 'Generate an image based on the current chat context using ComfyUI.',
    }));
})();
