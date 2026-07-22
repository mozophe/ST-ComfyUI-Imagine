# Per-Message Generate-Image Button — Design

**Date:** 2026-07-22
**Status:** Approved

## Goal

Generate an image for any older chat message, not just the latest. A camera button in each
message's three-dots menu (`.extraMesButtons`) triggers generation; the resulting image
message is inserted immediately after the clicked message.

## Decisions (user-confirmed)

- **LLM context:** chat log cut at the target message (inclusive). `chatHistoryLimit` still
  applies — the last N non-system messages *before the cutoff*. Later messages never leak in.
- **Button scope:** all normal messages (user + character). Skipped on comfy-imagine's own
  image messages (`extra.title === 'comfy-imagine'`).
- **Icon:** `fa-camera`.
- **Insertion:** Approach 1 — splice + `reloadCurrentChat()` (ST's own canonical mid-chat
  insert pattern, see below). Approach 2 (`addOneMessage({ insertAfter })`) rejected: ST does
  not renumber existing `mesid` attributes, producing duplicate/off-by-one ids that corrupt
  edit/delete targeting.

## Components

### 1. Button injection

- `injectImagineButton(mesid)` — mirror of `injectDebugButtonOnMessage`: skip if already
  present, skip comfy-imagine messages, create `div.mes_button.comfy-imagine-gen-btn
  .fa-solid.fa-camera.interactable`, title "Generate image for this scene", prepend to
  `.extraMesButtons` (fallback `.mes_buttons`).
- `injectAllImagineButtons()` — walk current chat, inject on every eligible message.
  Called from init and `CHAT_CHANGED` (alongside `injectAllDebugButtons`).
- New messages arriving during a session: subscribe `USER_MESSAGE_RENDERED` and
  `CHARACTER_MESSAGE_RENDERED` (verified in `public/scripts/events.js`) and inject on the
  reported mesid — `CHAT_CHANGED` alone would leave new messages buttonless until a chat
  switch. A delegated click handler on the chat container (like the debug button's) means
  the handler itself needs no per-message binding.
- Click resolves `mesid` from `closest('.mes')`, then calls the generation core with
  `targetIndex = Number(mesid)`.

### 2. Context cutoff

`assembleContext(uptoIndex = null)`:

- `uptoIndex == null` → current behaviour (whole chat tail).
- Otherwise chat log = `chat.slice(0, uptoIndex + 1)`, then filter `is_system`, then apply
  `chatHistoryLimit` tail. `[TRACKER STATE]` block also searches only `slice(0, uptoIndex+1)`
  so the tracker snapshot matches the scene's point in time.

### 3. Generation core refactor

Extract the body of `runImagine` into `generateImages({ targetIndex = null, signal = null })`:

- `targetIndex == null` → behave exactly as today: context from chat tail, message appended
  via `chat.push` + `addOneMessage` (no full reload; tail-append is safe).
- `targetIndex` set → context via `assembleContext(targetIndex)`; insertion per image:
  `chat.splice(insertAt, 0, imageMessage)` where `insertAt = chat.indexOf(targetMsg) + 1 + i`
  (`targetMsg` captured at click time — object identity survives concurrent index shifts;
  multi-image keeps generation order via `i`). After all images: `await saveChat()` then
  `await reloadCurrentChat()` — **order is a hard requirement**: reload re-fetches the chat
  from the server (`script.js:7599` replaces the array wholesale), so unsaved splices would
  be silently discarded. Verified: `reloadCurrentChat` → `getChat` → `getChatResult` emits
  `CHAT_CHANGED` (`script.js:7641`) and is mutex-wrapped, so debug/camera buttons and
  `knownImaginePaths` are rebuilt by the existing `CHAT_CHANGED` handler — no explicit
  re-injection call needed.
- **Partial failure:** save + reload run in a `finally` whenever ≥ 1 message was spliced,
  so a failure on image 3 of 4 still persists and renders images 1–2 instead of losing
  them in memory.
- **Chat-switch guard:** capture `getCurrentChatId()` (exposed via `getContext()`,
  `st-context.js:19`) at click time. Before each splice — and before the tail-path
  `chat.push` too — compare against the current id; on mismatch discard the image and
  toast ("chat changed, image discarded"), never insert into the now-active chat. This
  also fixes the latent bug in the existing `/imagine` tail path (a chat switch during
  generation would push the image into the wrong chat's array).
- `runImagine` (slash command) becomes a thin wrapper: bridges ST abort controller →
  native `AbortController`, calls `generateImages({ signal })`.
- Button path: plain `new AbortController()`, no stop-button integration (ST offers none
  outside slash commands). Errors/progress via toasts as today.
- Timing capture (`elapsedMs`/`llmMs`/`comfyMs`, rolling logs) and `knownImaginePaths`
  bookkeeping stay in the shared core — identical for both paths.
- Re-entrancy: module-level `isGenerating` flag; button click while a generation is running
  → toast "Already generating" and return. (Slash command path gets the same guard.)

### 4. Unchanged

Image upload/storage, cleanup reconciliation, debug modal, LoRA injection, workflow
injection, settings — all untouched. Message shape identical, so `collectImaginePaths`,
`reconcileImagineOrphans`, `showDebugModal` work as-is (they scan by content, not index).

## ST API facts (verified against release branch)

- `addOneMessage({ insertAfter })` computes new `mesid = insertAfter + 1` but never
  renumbers existing messages (`public/script.js`).
- ST's own mid-chat insert (`sendMessageAsUser` with `insertAt`, `script.js:5848`):
  `chat.splice` → `saveChatConditional` → `reloadCurrentChat`.
- `reloadCurrentChat` is exposed via `getContext()` (`public/scripts/st-context.js:30`).

## Error handling

Same toast-only policy. New case: target message deleted mid-generation (index shifted) —
recompute insert index by object identity: capture `const targetMsg = chat[targetIndex]` at
click time, at insert time `insertAt = chat.indexOf(targetMsg) + 1`. `indexOf === -1` with
the **same chat id** means the target was deleted → append at end of the (correct) chat and
toast a note. `indexOf === -1` because the **chat id changed** → discard (see chat-switch
guard above).

## Testing

- Pure helpers unchanged; no new node-testable surface (all new code touches ST DOM/context).
- Manual: generate from an old message mid-chat → image appears directly after it, edit/delete
  on later messages still target correct messages after reload; multi-image (count > 1) keeps
  order; generate from last message ≈ same result as `/imagine`; delete generated image →
  file cleanup still fires; button absent on comfy-imagine image messages; mobile tap works.
