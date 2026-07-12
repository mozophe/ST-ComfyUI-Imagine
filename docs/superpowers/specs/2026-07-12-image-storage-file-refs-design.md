# Design: File-reference image storage (replace base64 embed)

Date: 2026-07-12
Status: Approved for planning

## Problem

`/imagine` currently embeds each generated image as a base64 data URL directly
in the chat message's `mes` field (`index.js:920`). On a Raspberry Pi this is
the wrong trade:

- Base64 is ~33% larger than raw bytes, inlined into the chat `.jsonl`.
- ST loads the whole chat file into memory on open — bloat costs RAM and GC.
- Every message write rewrites the fat file — more SD-card I/O and wear.

The user generates many images and keeps few, so the file grows fast.

## Goal

Store generated images as **files on disk** (served by ST) and put only a short
relative path in `mes`. This is exactly how ST's own Image Generation extension
behaves (`saveBase64AsFile` → `POST /api/images/upload`).

Three deliverables:

1. **Upload swap** — new images go to disk; `mes` holds the path.
2. **Orphan cleanup** — when a generated-image message is deleted, delete its
   file from disk too (restores the current self-cleaning behaviour).
3. **One-time migration** — a settings button that converts already-embedded
   base64 images in the current chat to files.

Target: ST `release` v1.18.0. All endpoints/APIs below verified against the
`1.18.0` git tag.

## Verified platform facts (ST 1.18.0)

- `POST /api/images/upload` — body `{ image: <rawBase64>, format, ch_name?, filename? }`,
  returns `{ path: "user/images/<ch_name>/<file>.<fmt>" }`. Writes under the
  user's `userImages` dir. `format` must be in `MEDIA_EXTENSIONS`
  (`bmp,png,jpg,webp,jpeg,jfif`). (`src/endpoints/images.js:39`)
- `POST /api/images/delete` — body `{ path }`. Server rejects any path not under
  `userImages` via `isPathUnderParent` — cannot escape the images dir.
  (`src/endpoints/images.js:133`)
- `getContext()` exposes `getRequestHeaders`, `eventSource`, `event_types`
  (`public/scripts/st-context.js`). It does **not** expose `saveBase64AsFile`,
  so we hand-roll the upload fetch (CLAUDE.md forbids importing ST internals).
- `MESSAGE_DELETED` fires **after** the message is spliced out of `chat`, with
  payload `chat.length` only — the deleted message is unreadable from the event.
  This shapes the cleanup design (reconciliation, below).
- `/del N` (power-user.js) and single-message delete both end in
  `MESSAGE_DELETED`. No pre-delete event, no per-message payload.

## Non-goals

- Migrating other chats automatically (button acts on the **current** chat only).
- Touching non-comfy-imagine images or ST's own SD images.
- Changing the `is_system: true` / debug-button / abort behaviour.
- Using `extra.image` / `extra.media[]` structures (CLAUDE.md: `extra.image`
  double-renders; `extra.media[]` is a larger rewrite we don't need).

## Design

### 1. Upload helper

New module-level function, ~12 lines:

```js
// Uploads raw base64 to ST's image store, returns the relative path.
async function uploadImageToST(rawB64, format, chName, filename) {
    const { getRequestHeaders } = SillyTavern.getContext();
    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ image: rawB64, format, ch_name: chName || undefined, filename }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'upload_failed');
    return (await res.json()).path;
}
```

Small parse helper reused by generate + migration:

```js
// "data:image/png;base64,AAAA" -> { rawB64: "AAAA", format: "png" }
function splitDataUrl(dataUrl) {
    const m = /^data:image\/(\w+);base64,(.*)$/s.exec(dataUrl);
    if (!m) throw new Error('bad_data_url');
    return { format: m[1], rawB64: m[2] };   // format already valid: png/jpeg/webp
}
```

`fetchImageAsDataUrl` (`index.js:768`) is unchanged — both flows start from a
data URL and convert.

### 2. Generate flow change (`runImagine`)

Replace the base64-in-`mes` block (`index.js:905-930`). After
`dataUrl = await fetchImageAsDataUrl(...)`:

```js
const { format, rawB64 } = splitDataUrl(dataUrl);
const active = getActiveCharacter();
const chName = active?.name || 'comfy-imagine';
const filename = `imagine_${Date.now()}_${i}`;   // _${i}: unique within a multi-image call

let path;
try {
    path = await uploadImageToST(rawB64, format, chName, filename);
} catch (err) {
    if (err.name === 'AbortError') return '';
    toast('Comfy Imagine: Image generated but could not be saved to disk.', 'error');
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
        imaginePath: path,        // authoritative handle for reconciliation
        debugContext: contextString,
        debugPrompt: llmOutput,
    },
};
chat.push(imageMessage);
await addOneMessage(imageMessage, { scroll: true });
await saveChat();
injectDebugButtonOnMessage(chat.length - 1);
knownImaginePaths.add(path);      // keep reconciler baseline in sync
```

**Unique-filename note:** `Date.now()` alone collides when a multi-image call
loops within one millisecond — two messages would share one file, and deleting
one message would orphan-delete a file the other still uses. `_${i}` (loop
index) guarantees uniqueness within a call; `Date.now()` differs across calls.

`extra.imaginePath` is a private key — ST does not render it (unlike
`extra.image`), so no double image.

### 3. Orphan cleanup — path-set reconciliation

Because `MESSAGE_DELETED` can't identify the deleted message, we diff the set of
image paths the chat references now against a cached baseline. Anything that
dropped out was deleted → remove its file.

Module-level state and helpers:

```js
let knownImaginePaths = new Set();

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

// Safety gate: only ever delete files this extension created.
function isOwnImaginePath(path) {
    return /(^|\/)user\/images\/.+\/imagine_[^/]+\.(png|jpe?g|webp)$/i.test(path);
}

async function deleteImageFromST(path) {
    const { getRequestHeaders } = SillyTavern.getContext();
    await fetch('/api/images/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path }),
    }).catch(() => {});   // best-effort; a failed cleanup is not user-facing
}

async function reconcileImagineOrphans() {
    const current = collectImaginePaths();
    const orphans = [...knownImaginePaths].filter(p => !current.has(p) && isOwnImaginePath(p));
    for (const p of orphans) await deleteImageFromST(p);
    knownImaginePaths = current;
}
```

Wiring in `init()`:

- `MESSAGE_DELETED` → `reconcileImagineOrphans()` (delete orphans, update baseline).
- `CHAT_CHANGED` → `knownImaginePaths = collectImaginePaths()` (rebuild baseline
  for the newly-opened chat; **no** deletion — switching chats isn't deleting).
  Fold into the existing `CHAT_CHANGED` handler alongside the debug/LoRA refresh.
- At startup after the first render, seed `knownImaginePaths = collectImaginePaths()`.

**Safety:** deletion is doubly bounded — (a) `isOwnImaginePath` regex requires
our `imagine_` filename prefix under `user/images/<sub>/`, and (b) the server
refuses anything outside `userImages`. The user's own gallery images or ST-SD
images can never be touched. Matches the user's chosen "only our own files" scope.

**Failure mode named:** `// ponytail: reconciler runs only while the extension
is loaded; images whose messages are deleted with the ext disabled are left on
disk (rare). Manual cleanup via ST Gallery.`

### 4. One-time migration (manual button)

New settings section (between Generation Settings and Quick Reply):

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

Handler `migrateCurrentChat()` bound in `bindSettingsEvents()`:

```js
async function migrateCurrentChat() {
    const { chat, saveChat, getCurrentChatId } = SillyTavern.getContext();
    if (!getCurrentChatId()) { toast('Comfy Imagine: No chat open.', 'warning'); return; }

    let migrated = 0, skipped = 0;
    const active = getActiveCharacter();
    const chName = active?.name || 'comfy-imagine';

    for (let idx = 0; idx < chat.length; idx++) {
        const msg = chat[idx];
        if (msg?.extra?.title !== 'comfy-imagine') continue;
        const m = /!\[[^\]]*\]\((data:image\/[^)]+)\)/.exec(msg.mes || '');
        if (!m) continue;                       // already a path, or no image -> idempotent skip
        try {
            const { format, rawB64 } = splitDataUrl(m[1]);
            const path = await uploadImageToST(rawB64, format, chName, `imagine_migrated_${Date.now()}_${idx}`);
            msg.mes = `![generated image](${path})`;
            msg.extra.imaginePath = path;
            knownImaginePaths.add(path);
            migrated++;
        } catch {
            skipped++;                          // leave this message as base64, untouched
        }
    }

    if (migrated) await saveChat();
    // re-render so converted messages show the new <img src=path>
    if (migrated) SillyTavern.getContext().reloadCurrentChat?.();
    toast(`Comfy Imagine: migrated ${migrated} image(s)` + (skipped ? `, skipped ${skipped}` : ''), 'success');
}
```

Notes:

- **Idempotent** — a message whose `mes` already holds a path has no
  `data:image` match and is skipped, so re-clicking is safe.
- **Non-destructive on failure** — any upload that throws leaves the message's
  base64 intact; nothing is lost.
- **Re-render** — after rewriting `mes`, call `reloadCurrentChat()` so the DOM
  picks up the new `<img>` src. Verified exposed via `getContext()` at 1.18.0
  (`st-context.js:129`), as are `getCurrentChatId` and `saveChat`
  (aliased to `saveChatConditional`).

## Data flow

```
GENERATE:  ComfyUI /view -> fetchImageAsDataUrl -> splitDataUrl
           -> uploadImageToST -> path -> mes + extra.imaginePath -> knownImaginePaths.add

DELETE:    /del N -> ST splices msg -> MESSAGE_DELETED
           -> reconcileImagineOrphans -> diff baseline vs chat -> delete orphan files

MIGRATE:   button -> walk current chat -> for each base64 comfy msg:
           splitDataUrl -> uploadImageToST -> rewrite mes -> saveChat -> reload
```

## Error handling

- Upload fails on generate → toast, abort that image (existing pattern).
- Delete (cleanup) fails → swallowed (best-effort, non-user-facing).
- Migration upload fails per-image → skipped, base64 kept, counted in toast.
- No chat open on migrate → warning toast, no-op.
- Abort during generate upload → silent (existing `AbortError` convention).

## Testing / verification

Manual, in ST on the Pi (no automated harness in this repo):

1. `/imagine` → confirm chat `.jsonl` stores a short `user/images/...` path, not
   base64; image renders; file exists on disk.
2. Multi-image count → N distinct files, no filename collision.
3. `/del 1` on a generated image → file removed from disk; baseline updated.
4. `/cut` a range including generated images → all their files removed.
5. Switch chats → no deletions; baseline rebuilt.
6. Delete a **non**-comfy message referencing a gallery image → that file
   untouched (safety gate).
7. Migration on a chat with old base64 images → converts, chat shrinks, images
   still render; re-click → 0 migrated (idempotent); one forced upload failure →
   that message stays base64.

## Function map delta (`index.js`)

| Function | Change |
|---|---|
| `uploadImageToST` | new — POST /api/images/upload |
| `splitDataUrl` | new — data URL → {format, rawB64} |
| `deleteImageFromST` | new — POST /api/images/delete (best-effort) |
| `collectImaginePaths` | new — Set of referenced paths |
| `isOwnImaginePath` | new — safety regex |
| `reconcileImagineOrphans` | new — diff + delete orphans |
| `migrateCurrentChat` | new — one-time base64 → file |
| `runImagine` | upload instead of embed; store `extra.imaginePath` |
| `bindSettingsEvents` | bind migrate button |
| `init` | seed baseline; hook MESSAGE_DELETED; extend CHAT_CHANGED |
| module state | new `knownImaginePaths` Set |

Files touched: `index.js`, `settings.html`. No `style.css` change required
(reuses existing section/row classes).
