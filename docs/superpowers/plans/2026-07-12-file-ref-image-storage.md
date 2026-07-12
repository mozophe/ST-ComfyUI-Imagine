# File-Reference Image Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store `/imagine`-generated images as files on disk (via ST's image API) with only a short path in the chat message, add automatic orphan-file cleanup on message delete, and a one-time button to migrate already-embedded base64 images.

**Architecture:** Two pure, ST-independent helpers (`splitDataUrl`, `isOwnImaginePath`) move to a sibling ES module `image-helpers.js` so the security-relevant delete gate is unit-testable in plain node. All ST-coupled logic stays in `index.js`: upload/delete fetch wrappers, a module-level `knownImaginePaths` Set, a reconciler that diffs referenced paths on `MESSAGE_DELETED`, and a migration walker. `settings.html` gains one section with the migrate button.

**Tech Stack:** Plain browser ES-module JS (no build, no bundler), SillyTavern `getContext()` API, ST REST endpoints `/api/images/upload` and `/api/images/delete`. Node (already on the dev machine) runs the one automated check with `node --test`-free plain `assert`.

## Global Constraints

- Target SillyTavern `release` **v1.18.0**. All endpoints/APIs verified against the `1.18.0` git tag.
- Access ST internals **only** through `SillyTavern.getContext()`. Never import from ST internal script files. `saveBase64AsFile` is NOT in getContext — hand-roll the upload.
- `format` sent to `/api/images/upload` must be in `MEDIA_EXTENSIONS` (`bmp,png,jpg,webp,jpeg,jfif`). `mime.split('/')[1]` yields a valid value for PNG/JPEG/WEBP.
- Never put `extra.image` on a message (double-renders with the `mes` markdown). Use the private key `extra.imaginePath`.
- Orphan deletion scope: **only files this extension created** — path must match `imagine_` prefix under `user/images/<sub>/`. The server additionally refuses any path outside `userImages`.
- Errors surface as `toast()` only; cleanup-delete failures are swallowed (best-effort, non-user-facing).
- Commit as `mozophe <mozophe@gmail.com>`.
- No em-dashes in shipped copy/docs (repo convention).

---

### Task 1: Pure helpers + automated check

**Files:**
- Create: `image-helpers.js`
- Create: `test/image-helpers.test.mjs`

**Interfaces:**
- Produces: `splitDataUrl(dataUrl) -> { format: string, rawB64: string }` (throws `Error('bad_data_url')` on non-match). `isOwnImaginePath(path) -> boolean`.

- [ ] **Step 1: Write the failing test**

Create `test/image-helpers.test.mjs`:

```js
import assert from 'node:assert/strict';
import { splitDataUrl, isOwnImaginePath } from '../image-helpers.js';

// splitDataUrl
{
    const r = splitDataUrl('data:image/png;base64,AAAB');
    assert.equal(r.format, 'png');
    assert.equal(r.rawB64, 'AAAB');
}
{
    const r = splitDataUrl('data:image/jpeg;base64,ZZZ');
    assert.equal(r.format, 'jpeg');
}
assert.throws(() => splitDataUrl('user/images/x/imagine_1.png'), /bad_data_url/);
assert.throws(() => splitDataUrl('data:text/plain;base64,AAAA'), /bad_data_url/);

// isOwnImaginePath — must ONLY match our own generated files
assert.equal(isOwnImaginePath('user/images/Alice/imagine_1720000000000_0.png'), true);
assert.equal(isOwnImaginePath('user/images/comfy-imagine/imagine_migrated_1720000000000_3.webp'), true);
assert.equal(isOwnImaginePath('user/images/Alice/imagine_1.JPG'), true);
// must NOT match foreign files
assert.equal(isOwnImaginePath('user/images/Alice/vacation.png'), false);
assert.equal(isOwnImaginePath('user/images/Alice/portrait_imagine.png'), false);
assert.equal(isOwnImaginePath('user/files/Alice/imagine_1.png'), false);
assert.equal(isOwnImaginePath('../../etc/passwd'), false);
assert.equal(isOwnImaginePath('user/images/imagine_1.png'), false); // no subfolder

console.log('image-helpers: all checks passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/image-helpers.test.mjs`
Expected: FAIL — `Cannot find module '.../image-helpers.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `image-helpers.js`:

```js
// Pure, SillyTavern-independent helpers for image storage. Kept separate from
// index.js so the security-relevant delete gate is testable in plain node.

// "data:image/png;base64,AAAA" -> { format: "png", rawB64: "AAAA" }
// Throws on anything that is not a base64 image data URL.
export function splitDataUrl(dataUrl) {
    const m = /^data:image\/(\w+);base64,(.*)$/s.exec(dataUrl ?? '');
    if (!m) throw new Error('bad_data_url');
    return { format: m[1], rawB64: m[2] };
}

// True only for files THIS extension created: an `imagine_` file inside a
// character subfolder under user/images/. Gates the delete endpoint so a
// foreign image referenced in chat can never be removed by cleanup.
export function isOwnImaginePath(path) {
    return /(^|\/)user\/images\/[^/]+\/imagine_[^/]+\.(png|jpe?g|webp)$/i.test(path ?? '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/image-helpers.test.mjs`
Expected: PASS — prints `image-helpers: all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add image-helpers.js test/image-helpers.test.mjs
git commit -m "feat: add pure image-helpers (splitDataUrl, isOwnImaginePath) with node check"
```

---

### Task 2: Upload on generate (replace base64 embed)

**Files:**
- Modify: `index.js:1-3` (add import), `index.js:768` area (add `uploadImageToST`), `index.js:914-930` (runImagine message block)

**Interfaces:**
- Consumes: `splitDataUrl` from Task 1; existing `fetchImageAsDataUrl`, `getActiveCharacter`, `getSettings`, `toast`.
- Produces: `uploadImageToST(rawB64, format, chName, filename) -> Promise<string>` (returns relative path, throws `Error` on failure); module Set `knownImaginePaths`. Messages now carry `extra.imaginePath`.

- [ ] **Step 1: Add the helper import**

Modify top of `index.js` — after line 3 (`import { Popup, ... } from '../../../popup.js';`) add:

```js
import { splitDataUrl, isOwnImaginePath } from './image-helpers.js';
```

- [ ] **Step 2: Add module state**

After `index.js:17` (`let loraListCache = null;`) add. (Task 3's reconciler reuses this same Set; it is declared here because this task is the first to write to it.)

```js
// Baseline of image paths referenced by comfy-imagine messages in the current
// chat. Diffed on MESSAGE_DELETED to find files whose messages were removed.
let knownImaginePaths = new Set();
```

- [ ] **Step 3: Add `uploadImageToST`**

Insert immediately after `fetchImageAsDataUrl` (after `index.js:778`):

```js
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
```

- [ ] **Step 4: Replace the message-construction block in `runImagine`**

Replace `index.js:914-930` (from `const { chat, addOneMessage, saveChat } = SillyTavern.getContext();` through `injectDebugButtonOnMessage(chat.length - 1);`) with:

```js
        const { format, rawB64 } = splitDataUrl(dataUrl);
        const active = getActiveCharacter();
        const chName = active?.name || 'comfy-imagine';
        // _${i}: two images generated in the same millisecond would otherwise
        // share a filename, and deleting one message would orphan-delete the
        // file the other still uses.
        const filename = `imagine_${Date.now()}_${i}`;

        let path;
        try {
            path = await uploadImageToST(rawB64, format, chName, filename);
        } catch (err) {
            if (err.name === 'AbortError') return '';
            toast('Comfy Imagine: Image generated but could not be saved to disk.', 'error');
            return '';
        }

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
                debugContext: contextString,
                debugPrompt: llmOutput,
            },
        };
        chat.push(imageMessage);
        await addOneMessage(imageMessage, { scroll: true });
        await saveChat();
        injectDebugButtonOnMessage(chat.length - 1);
        knownImaginePaths.add(path);
```

- [ ] **Step 5: Manual verification in SillyTavern**

This is a browser extension with no runtime harness. On the Pi (or dev ST):
1. Reload ST, run `/imagine`.
2. Open the chat's `.jsonl` (`data/<user>/chats/<char>/...`). Confirm the generated message's `mes` contains `![generated image](user/images/...)` — a short path, NOT `data:image/...`.
3. Confirm the image renders in the chat UI.
4. Confirm the file exists at `data/<user>/user/images/<char>/imagine_*.png`.
5. Set Image Count to 3, `/imagine` again. Confirm 3 distinct filenames on disk (no collision).

Expected: paths in jsonl, files on disk, images render.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: store generated images as files, embed path not base64"
```

---

### Task 3: Orphan cleanup via reconciliation

**Files:**
- Modify: `index.js` (module state near line 17; new functions after `uploadImageToST`; `init` event wiring at `index.js:970-976`)

**Interfaces:**
- Consumes: `isOwnImaginePath` from Task 1; `knownImaginePaths` (declared in Task 2 Step 2); `getContext().chat`, `getRequestHeaders`, `eventSource`, `event_types`.
- Produces: `collectImaginePaths()`, `deleteImageFromST(path)`, `reconcileImagineOrphans()`.

- [ ] **Step 1: Add reconciliation functions**

Insert after `uploadImageToST` (added in Task 2). `knownImaginePaths` is already declared (Task 2 Step 2).

```js
// All image paths currently referenced by comfy-imagine messages in the chat.
function collectImaginePaths() {
    const { chat } = SillyTavern.getContext();
    const set = new Set();
    for (const msg of chat) {
        if (msg?.extra?.title === 'comfy-imagine' && msg.extra.imaginePath) {
            set.add(msg.extra.imaginePath);
        }
    }
    return set;
}

// Best-effort delete of one image file from ST's store. Failures are swallowed:
// a leftover file is harmless; a toast for it would be noise.
async function deleteImageFromST(path) {
    const { getRequestHeaders } = SillyTavern.getContext();
    await fetch('/api/images/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path }),
    }).catch(() => {});
}

// On message deletion, delete files whose messages are gone. MESSAGE_DELETED
// cannot report which message was removed (payload is only the new length), so
// we diff the current referenced-path set against the cached baseline.
async function reconcileImagineOrphans() {
    const current = collectImaginePaths();
    const orphans = [...knownImaginePaths].filter(p => !current.has(p) && isOwnImaginePath(p));
    for (const p of orphans) await deleteImageFromST(p);
    knownImaginePaths = current;
}
```

- [ ] **Step 2: Wire events in `init`**

In `init()`, replace the existing `CHAT_CHANGED` block (`index.js:971-976`) with:

```js
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
```

- [ ] **Step 3: Manual verification in SillyTavern**

1. Reload ST. `/imagine` to create an image; note its file on disk.
2. `/del 1` (delete that image message). Confirm the file is gone from `data/<user>/user/images/<char>/`.
3. `/imagine` twice, then `/cut 0-1` (or a range covering both). Confirm both files removed.
4. Switch to another chat and back. Confirm NO files were deleted (baseline rebuild only).
5. Manually add to a chat a normal message referencing a gallery image (`![x](user/images/Alice/somephoto.png)`), then delete a comfy-imagine message. Confirm `somephoto.png` is untouched (safety gate; it is not tracked and would not match `isOwnImaginePath` anyway).

Expected: own files deleted on message delete; foreign files never touched; no deletion on chat switch.

- [ ] **Step 4: Commit**

```bash
git add index.js
git commit -m "feat: delete orphaned image files when generated messages are removed"
```

---

### Task 4: One-time migration button

**Files:**
- Modify: `settings.html` (new section before line 184), `index.js` (new `migrateCurrentChat`; bind in `bindSettingsEvents`)

**Interfaces:**
- Consumes: `splitDataUrl` (Task 1), `uploadImageToST` (Task 2), `knownImaginePaths` (Task 3), `getActiveCharacter`, `getContext().chat/saveChat/getCurrentChatId/reloadCurrentChat`, `toast`.
- Produces: `migrateCurrentChat()`; DOM ids `#comfy-imagine-migrate-btn`, `#comfy-imagine-migrate-status`.

- [ ] **Step 1: Add settings section**

In `settings.html`, insert before the `<!-- Section 6: Quick Reply Setup -->` block (currently line 184):

```html
            <!-- Section: Image Storage -->
            <div class="comfy-imagine-section">
                <h5>Image Storage</h5>
                <div class="comfy-imagine-info">
                    Older generated images embedded directly in the chat can be converted to
                    files to shrink the chat. Acts on the <strong>currently open chat</strong>.
                    Safe to run more than once.
                </div>
                <div class="comfy-imagine-row--inline">
                    <button id="comfy-imagine-migrate-btn" class="menu_button">
                        <i class="fa-solid fa-file-arrow-down"></i> Migrate embedded images to files
                    </button>
                    <span id="comfy-imagine-migrate-status" class="comfy-imagine-status"></span>
                </div>
            </div>
```

- [ ] **Step 2: Add `migrateCurrentChat`**

Insert after `reconcileImagineOrphans` (Task 3) in `index.js`:

```js
// One-time conversion of already-embedded base64 images in the CURRENT chat to
// files. Idempotent (a message already holding a path has no data: URL to match)
// and non-destructive (a failed upload leaves that message's base64 intact).
async function migrateCurrentChat() {
    const { chat, saveChat, getCurrentChatId, reloadCurrentChat } = SillyTavern.getContext();
    const statusEl = document.getElementById('comfy-imagine-migrate-status');
    if (!getCurrentChatId()) { toast('Comfy Imagine: No chat open.', 'warning'); return; }

    let migrated = 0, skipped = 0;
    const active = getActiveCharacter();
    const chName = active?.name || 'comfy-imagine';

    for (let idx = 0; idx < chat.length; idx++) {
        const msg = chat[idx];
        if (msg?.extra?.title !== 'comfy-imagine') continue;
        const m = /!\[[^\]]*\]\((data:image\/[^)]+)\)/.exec(msg.mes || '');
        if (!m) continue;                       // already migrated or no embedded image
        try {
            const { format, rawB64 } = splitDataUrl(m[1]);
            const path = await uploadImageToST(rawB64, format, chName, `imagine_migrated_${Date.now()}_${idx}`);
            msg.mes = `![generated image](${path})`;
            msg.extra.imaginePath = path;
            knownImaginePaths.add(path);
            migrated++;
        } catch {
            skipped++;                          // leave base64 untouched
        }
    }

    if (migrated) {
        await saveChat();
        reloadCurrentChat?.();                  // re-render so new <img src=path> shows
    }
    const summary = `Migrated ${migrated} image(s)` + (skipped ? `, skipped ${skipped}` : '');
    if (statusEl) statusEl.textContent = summary;
    toast(`Comfy Imagine: ${summary}`, migrated || !skipped ? 'success' : 'warning');
}
```

- [ ] **Step 3: Bind the button**

In `bindSettingsEvents()` (`index.js:281`), alongside the other button bindings, add:

```js
    document.getElementById('comfy-imagine-migrate-btn')
        ?.addEventListener('click', migrateCurrentChat);
```

- [ ] **Step 4: Manual verification in SillyTavern**

1. Check out an OLD chat (or a backup) that still has base64-embedded comfy-imagine images (or generate one on a pre-Task-2 build).
2. Open extension settings, click **Migrate embedded images to files**.
3. Confirm the status/toast reports a migrated count. Confirm the chat `.jsonl` for those messages now holds `user/images/...` paths, the file(s) exist on disk, and images still render after the auto-reload.
4. Click the button again. Confirm it reports `Migrated 0`.
5. (Optional) Temporarily point ComfyUI/URL wrong to force one upload to fail; confirm that message stays base64 and is counted as skipped, nothing lost.

Expected: base64 converted to paths, chat shrinks, idempotent on re-click, non-destructive on failure.

- [ ] **Step 5: Commit**

```bash
git add index.js settings.html
git commit -m "feat: add one-time migration of embedded base64 images to files"
```

---

## Post-implementation

- [ ] Update `CLAUDE.md` Function Map and the Injecting Chat Messages / Image Retrieval sections to reflect file-path storage, the reconciler, and migration. Note the `image-helpers.js` module. Commit as `docs:`.
- [ ] Manual full run-through on the Pi (screenshot-driven) per the user's usual workflow.
