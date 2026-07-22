# Per-Message Generate-Image Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Camera button in every message's three-dots menu generates an image for that scene and inserts it immediately after the message.

**Architecture:** Extract `runImagine`'s body into a shared `generateImages({ targetIndex, signal })` core. Tail path (slash command) keeps `chat.push` + `addOneMessage`; mid-chat path (`targetIndex` set) uses `chat.splice` + `saveChat()` + `reloadCurrentChat()` — ST's own canonical mid-chat insert pattern. Context assembly gains an `uptoIndex` cutoff, with the pure slicing logic extracted to `image-helpers.js` for node testing.

**Tech Stack:** Plain browser ES modules, no build step. jQuery (ST-bundled) for delegated clicks. Node only for `test/*.test.mjs`.

**Spec:** `docs/superpowers/specs/2026-07-22-per-message-imagine-design.md`

## Global Constraints

- All ST access via `SillyTavern.getContext()` — never import from ST internals.
- Errors surface as toasts only, never as chat messages.
- No build step, no `node_modules`; `index.js` must stay valid ESM (`node --check index.js` passes).
- Camera icon is `fa-camera`; button class `comfy-imagine-gen-btn`.
- Message shape of generated images is unchanged (`is_system: true`, `extra.title: 'comfy-imagine'`, `extra.imaginePath`, timing fields, optional `extra.debugPath`).
- `saveChat()` MUST run before `reloadCurrentChat()` — reload re-fetches the chat from the server and discards unsaved splices.

---

### Task 1: Pure chat-window helper `selectChatWindow`

**Files:**
- Modify: `image-helpers.js` (append)
- Test: `test/image-helpers.test.mjs` (append)

**Interfaces:**
- Produces: `selectChatWindow(messages, uptoIndex = null, limit = 0)` → array of message objects. Cuts at `uptoIndex` (inclusive) when non-null, filters `is_system`, then keeps the last `limit` (`limit <= 0` = all). Task 2 consumes it.

- [ ] **Step 1: Write the failing tests**

Append to `test/image-helpers.test.mjs` (follow the file's existing `assert`-based style; adjust the import line to match how the file already imports from `../image-helpers.js`):

```js
import { selectChatWindow } from '../image-helpers.js';

// ── selectChatWindow ─────────────────────────────────────────────
{
    const msgs = [
        { mes: 'a' },                    // 0
        { mes: 'b', is_system: true },   // 1
        { mes: 'c' },                    // 2
        { mes: 'd' },                    // 3
        { mes: 'e', is_system: true },   // 4
        { mes: 'f' },                    // 5
    ];

    // no cutoff, no limit → all non-system
    assert.deepStrictEqual(selectChatWindow(msgs).map(m => m.mes), ['a', 'c', 'd', 'f']);

    // no cutoff, limit 2 → last two non-system
    assert.deepStrictEqual(selectChatWindow(msgs, null, 2).map(m => m.mes), ['d', 'f']);

    // cutoff at index 3 (inclusive) → later messages excluded
    assert.deepStrictEqual(selectChatWindow(msgs, 3).map(m => m.mes), ['a', 'c', 'd']);

    // cutoff + limit → limit counts non-system messages before the cutoff
    assert.deepStrictEqual(selectChatWindow(msgs, 3, 2).map(m => m.mes), ['c', 'd']);

    // cutoff on a system message → it stays filtered
    assert.deepStrictEqual(selectChatWindow(msgs, 4).map(m => m.mes), ['a', 'c', 'd']);

    // cutoff 0 → just the first message
    assert.deepStrictEqual(selectChatWindow(msgs, 0).map(m => m.mes), ['a']);

    // limit 0 explicitly = all
    assert.deepStrictEqual(selectChatWindow(msgs, null, 0).map(m => m.mes), ['a', 'c', 'd', 'f']);

    // empty chat
    assert.deepStrictEqual(selectChatWindow([]), []);

    // input array is not mutated
    const before = msgs.length;
    selectChatWindow(msgs, 2, 1);
    assert.strictEqual(msgs.length, before);
    console.log('selectChatWindow tests passed');
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/image-helpers.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../image-helpers.js' does not provide an export named 'selectChatWindow'`

- [ ] **Step 3: Write minimal implementation**

Append to `image-helpers.js`:

```js
/**
 * Selects the chat-log window fed to the prompt LLM.
 * Cuts the log at uptoIndex (inclusive) when given, drops system messages,
 * then keeps the last `limit` messages (limit <= 0 = all). Pure; does not
 * mutate the input array.
 * @param {Array<{is_system?: boolean}>} messages Full chat array.
 * @param {?number} uptoIndex Index of the last message to include, or null for the whole log.
 * @param {number} limit Max non-system messages to keep (0 = all).
 * @returns {Array} The selected messages, oldest first.
 */
export function selectChatWindow(messages, uptoIndex = null, limit = 0) {
    let msgs = uptoIndex == null ? messages.slice() : messages.slice(0, uptoIndex + 1);
    msgs = msgs.filter(m => !m.is_system);
    if (limit > 0) msgs = msgs.slice(-limit);
    return msgs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/image-helpers.test.mjs`
Expected: all existing output plus `selectChatWindow tests passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add image-helpers.js test/image-helpers.test.mjs
git commit -m "feat: add selectChatWindow pure helper for chat-log cutoff"
```

---

### Task 2: `assembleContext(uptoIndex)` cutoff

**Files:**
- Modify: `index.js` — `assembleContext()` (currently lines 881–924) and the import line at the top of the file that pulls from `./image-helpers.js`

**Interfaces:**
- Consumes: `selectChatWindow(messages, uptoIndex, limit)` from Task 1.
- Produces: `assembleContext(uptoIndex = null)` — same return string as today; `uptoIndex` cuts both the `[CHAT LOG]` and `[TRACKER STATE]` sections at that message (inclusive). Task 4 calls it with a number; the existing call site stays argument-less.

- [ ] **Step 1: Extend the import**

At the top of `index.js`, find the existing import from `./image-helpers.js` (it currently imports `splitDataUrl`, `isOwnImaginePath`, and possibly others) and add `selectChatWindow` to the named imports.

- [ ] **Step 2: Modify `assembleContext`**

Replace the chat-log block and tracker block inside `assembleContext` so the function reads:

```js
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
```

- [ ] **Step 3: Verify syntax and tests**

Run: `node --check index.js && node test/image-helpers.test.mjs`
Expected: no syntax error; tests pass.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: assembleContext accepts uptoIndex cutoff"
```

---

### Task 3: Extract `generateImages` core with re-entrancy + chat-switch guards

**Files:**
- Modify: `index.js` — `runImagine` (currently lines 1405–1572), module-level state near line 19

This task is a behavior-preserving refactor of the tail path plus two new guards. **No mid-chat insertion yet** (Task 4).

**Interfaces:**
- Consumes: `assembleContext(uptoIndex)` from Task 2.
- Produces: `async function generateImages({ targetIndex = null, signal = null } = {})` → `Promise<string>` (always resolves `''`). `targetIndex` is accepted and passed to `assembleContext` but insertion still appends at the tail (Task 4 changes that). Module-level `let isGenerating = false;`. `runImagine(args)` remains the slash-command entry and keeps its exact signature.

- [ ] **Step 1: Add module-level flag**

Near the other module-level state (below `let knownImaginePaths = new Set();`):

```js
// Re-entrancy guard: one generation at a time, shared by the slash command
// and the per-message camera button.
let isGenerating = false;
```

- [ ] **Step 2: Restructure `runImagine` into wrapper + core**

Replace the whole `runImagine` function with the two functions below. The core body is `runImagine`'s current body with these changes only:
1. abort-bridge lines removed (they stay in the wrapper);
2. new `isGenerating` guard at the top, cleared in `finally`;
3. `chatIdAtStart` captured once, checked before the per-image `chat.push` — on mismatch the image is discarded with a toast (fixes the latent wrong-chat bug);
4. `assembleContext(targetIndex)` instead of `assembleContext()`.

```js
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
    isGenerating = true;

    const chatIdAtStart = SillyTavern.getContext().getCurrentChatId();

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
            mes: `![generated image](${path})`,
            extra: {
                title: 'comfy-imagine',
                imaginePath: path,
                elapsedMs,
                llmMs,
                comfyMs,
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
        isGenerating = false;
    }

    return '';
}
```

- [ ] **Step 3: Verify syntax**

Run: `node --check index.js`
Expected: silent, exit 0.

- [ ] **Step 4: Manual smoke test (tail path unchanged)**

Copy `index.js` to the ST extension folder on the Pi, reload ST, run `/imagine` in a chat. Expected: identical behaviour to before (toasts, image appended at end, debug button appears). Run `/imagine` twice concurrently (click Quick Reply twice fast): second call toasts "already generating.".

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "refactor: extract generateImages core with re-entrancy and chat-switch guards"
```

---

### Task 4: Mid-chat insertion path

**Files:**
- Modify: `index.js` — `generateImages` from Task 3

**Interfaces:**
- Consumes: `generateImages` from Task 3; `getContext().reloadCurrentChat` (verified exposed in ST `st-context.js:30`).
- Produces: `generateImages({ targetIndex })` inserts each image directly after the target message and persists via `saveChat()` → `reloadCurrentChat()`. Task 5 calls it from the camera button.

- [ ] **Step 1: Capture target identity and inserted count**

In `generateImages`, right after `const chatIdAtStart = ...`, add:

```js
    // Per-message path: hold the target by object identity so concurrent
    // inserts/deletes can't shift the index out from under us.
    const targetMsg = targetIndex != null ? SillyTavern.getContext().chat[targetIndex] : null;
    const isMidChat = targetMsg != null;
    let insertedCount = 0;
```

Note: if `targetIndex` is non-null but `chat[targetIndex]` is undefined (stale mesid), `isMidChat` is false and the call degrades to a tail append — acceptable.

- [ ] **Step 2: Branch the insertion**

Replace the block from `chat.push(imageMessage);` through `injectDebugButtonOnMessage(chat.length - 1);` with:

```js
        if (isMidChat) {
            // Insert directly after the target message. indexOf === -1 with the
            // same chat id means the target was deleted mid-generation → append
            // at the end of the (correct) chat instead.
            const at = chat.indexOf(targetMsg);
            if (at === -1) toast('Comfy Imagine: original message was deleted — image appended at end.');
            const insertAt = at === -1 ? chat.length : at + 1 + insertedCount;
            chat.splice(insertAt, 0, imageMessage);
            insertedCount++;
            // No addOneMessage / per-image save here: the DOM would get stale
            // mesid attributes. One saveChat + reloadCurrentChat in the finally
            // renders everything consistently (ST's own mid-chat insert pattern).
        } else {
            chat.push(imageMessage);
            await addOneMessage(imageMessage, { scroll: true });
            await saveChat();
            injectDebugButtonOnMessage(chat.length - 1);
        }
```

(`knownImaginePaths.add(path)` and the `debugPath` add stay below the branch, unchanged — they apply to both paths.)

- [ ] **Step 3: Persist and reload in `finally`**

Extend the `finally` block so partial multi-image failures still persist what succeeded:

```js
    } finally {
        isGenerating = false;
        // Mid-chat inserts are in-memory only until saved; reloadCurrentChat
        // re-fetches the chat from the server, so save MUST come first. Runs
        // even after a mid-loop error/abort so images 1..k of n survive.
        // reloadCurrentChat emits CHAT_CHANGED (script.js getChatResult), which
        // re-injects debug/camera buttons and rebuilds knownImaginePaths.
        if (insertedCount > 0) {
            try {
                const { saveChat, reloadCurrentChat } = SillyTavern.getContext();
                await saveChat();
                await reloadCurrentChat();
            } catch (err) {
                toast(`Comfy Imagine: failed to refresh chat — ${err.message}`, 'error');
            }
        }
    }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check index.js`
Expected: silent, exit 0.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: mid-chat image insertion via splice + saveChat + reloadCurrentChat"
```

---

### Task 5: Camera button UI

**Files:**
- Modify: `index.js` — new functions next to `injectDebugButtonOnMessage` (currently line 1381), init IIFE (delegated click at ~line 1614, `CHAT_CHANGED` hook at ~line 1621)

**Interfaces:**
- Consumes: `generateImages({ targetIndex })` from Task 4.
- Produces: `injectImagineButtonOnMessage(mesid)`, `injectAllImagineButtons()`; camera button (`.comfy-imagine-gen-btn`, `fa-camera`) in every eligible message's `.extraMesButtons`.

- [ ] **Step 1: Add injection functions**

Directly below `injectAllDebugButtons()`:

```js
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
```

- [ ] **Step 2: Wire clicks and events in the init IIFE**

Below the existing delegated debug-button click handler (`$(document).on('click', '.comfy-imagine-debug-btn', ...)`), add:

```js
    // Delegated click for camera buttons. mesid is resolved at click time, so
    // buttons injected after any re-render keep working.
    $(document).on('click', '.comfy-imagine-gen-btn', e => {
        const mesid = parseInt($(e.currentTarget).closest('.mes').attr('mesid'));
        if (!isNaN(mesid)) generateImages({ targetIndex: mesid });
    });
```

In the existing `CHAT_CHANGED` handler, add `injectAllImagineButtons();` right after `injectAllDebugButtons();`.

Below the `MESSAGE_DELETED` hook, add render hooks so new messages get the button without a chat switch (CHAT_CHANGED alone fires only on load/switch/reload):

```js
    // New messages during a session: CHAT_CHANGED doesn't fire for them, so
    // hook the per-message render events.
    eventSource.on(event_types.USER_MESSAGE_RENDERED, mesid => injectImagineButtonOnMessage(mesid));
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, mesid => injectImagineButtonOnMessage(mesid));
```

After the startup `injectAllDebugButtons();` line, add `injectAllImagineButtons();`.

- [ ] **Step 3: Verify syntax**

Run: `node --check index.js && node test/image-helpers.test.mjs`
Expected: clean check, tests pass.

- [ ] **Step 4: Full manual test on the Pi install**

Copy changed files to the ST extension folder, reload ST. Checklist (from spec §Testing):

1. Every user/character message shows a camera icon in its three-dots menu; comfy-imagine image messages don't.
2. Click camera on an old message mid-chat → toasts → image message appears **directly after** that message; chat re-renders once.
3. After the reload: edit and delete on messages **after** the insert target the correct message (mesid consistency).
4. `imageCount > 1` → images appear in generation order after the target.
5. Camera on the **last** message ≈ same result as `/imagine` (context identical, image at end).
6. Send a new message → the new message has a camera button without switching chats.
7. Delete a generated image message → file cleanup still fires (check server `user/images/<char>/`).
8. `/imagine` still works; clicking camera while generating toasts "already generating.".
9. Debug (ⓘ) modal on a camera-generated image shows the cut-off context (no later messages in `[CHAT LOG]`).
10. Mobile (or devtools mobile emulation): three-dots menu → camera tap works.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: per-message camera button generates image for that scene"
```

---

### Task 6: Documentation

**Files:**
- Modify: `CLAUDE.md` (Function Map + architecture sections), `README.md` (usage)

- [ ] **Step 1: Update CLAUDE.md**

- Function Map: add rows for `selectChatWindow` (in `image-helpers.js` note), `generateImages`, `injectImagineButtonOnMessage`, `injectAllImagineButtons`; update `runImagine` row (thin abort-bridge wrapper) and `assembleContext` row (`uptoIndex` param); update `init()` row (camera click delegate, render-event hooks).
- Add a short "Per-Message Generation" subsection under Architecture Constraints documenting: splice + `saveChat` + `reloadCurrentChat` pattern (and why `addOneMessage({insertAfter})` is forbidden — no mesid renumbering), chat-switch guard, object-identity insert, `isGenerating` guard, render-event button injection.

- [ ] **Step 2: Update README.md**

Add a paragraph to the usage section: camera icon in any message's three-dots menu generates an image for that point in the story and places it right after the message; context is cut at that message.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document per-message generation feature"
```
