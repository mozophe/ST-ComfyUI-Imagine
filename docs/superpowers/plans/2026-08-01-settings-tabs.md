# Tabbed Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the seven flat sections in the ComfyUI-Imagine settings panel with four tabs — Character, Generate, Prompt, Connection — so the controls you touch often are reachable without scrolling past one-time setup.

**Architecture:** `settings.html` gets restructured into the markup jQuery UI Tabs expects; `index.js` gains a single `.tabs()` call; `style.css` gains a CSS custom property token layer plus the tab rules. No JavaScript logic changes — every input keeps its existing id, so all existing bindings continue to work untouched.

**Tech Stack:** Plain browser JS (no build step, no bundler), jQuery and jQuery UI as bundled by SillyTavern, CSS custom properties.

## Global Constraints

- **SillyTavern internals are reached only through `SillyTavern.getContext()`.** Never import from `script.js` or other ST paths.
- **jQuery UI is already bundled by ST** — `backgrounds.js:1861` calls `$('#bg_tabs').tabs()`. Do not add a dependency.
- **Colour comes only from ST theme variables**, aliased through `--ci-*` tokens. No hardcoded palette. `prefers-color-scheme` reports the OS preference, not the active ST theme, so it must not be used to branch panel colours.
- **Accent (`--ci-accent`) goes on icons and borders, never on body text.** It resolves to a user-chosen colour, so no text-contrast requirement may depend on it.
- **Every existing input id is preserved.** If a task changes an id, it is wrong.
- **README carries no em-dashes**, per existing repo convention.
- **No build step.** Verification is loading SillyTavern in a browser and looking.

**A note on testing:** this repo's only automated tests are `test/image-helpers.test.mjs`, which cover pure SillyTavern-independent helpers under Node. This change adds no pure logic — it is markup, CSS, and one widget-init call. There is nothing meaningful to unit test, and adding a DOM test harness for it would be more machinery than the change. Each task therefore ends with a **concrete manual verification step** naming what to click and what to expect. Do not skip them, and do not invent tests to satisfy a TDD habit that does not apply here.

**Reference:** the design spec is `docs/superpowers/specs/2026-08-01-settings-tabs-design.md`. Read it before starting.

---

### Task 1: Token layer in `style.css`

Introduces the CSS custom properties everything later styles through, and converts the existing rules to use them. Independently reviewable: after this task the panel looks slightly more polished and nothing else has changed.

**Files:**
- Modify: `style.css` (add token block at top; update rules at `:4`, `:15`, `:86-100`)

**Interfaces:**
- Consumes: nothing.
- Produces: the tokens `--ci-border`, `--ci-field`, `--ci-accent`, `--ci-surface`, `--ci-surface-strong`, `--ci-radius`, all scoped to `#comfy-imagine-settings`. Task 2 styles the tab bar entirely through these.

- [ ] **Step 1: Add the token block at the very top of `style.css`**

```css
/* Token layer. Alias SillyTavern's theme variables once, then style through
   these. Nothing here is a fixed colour: the panel follows whatever theme the
   user picked. Surface tints derive from the body colour rather than a
   hardcoded white overlay, so they stay visible on light themes too. */
#comfy-imagine-settings {
    --ci-border: var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.16));
    --ci-field: var(--SmartThemeBlurTintColor, rgba(18, 18, 24, 0.86));
    --ci-accent: var(--SmartThemeQuoteColor, #66b2ff);
    --ci-surface: color-mix(in srgb, var(--SmartThemeBodyColor) 6%, transparent);
    --ci-surface-strong: color-mix(in srgb, var(--SmartThemeBodyColor) 10%, transparent);
    --ci-radius: 8px;
}
```

- [ ] **Step 2: Convert the existing rules to the tokens**

Replace the section border at `style.css:4`:

```css
    border-top: 1px solid var(--ci-border);
```

Replace the info box rules currently at `style.css:86-100`:

```css
/* Info boxes */
#comfy-imagine-settings .comfy-imagine-info {
    font-size: 0.82em;
    opacity: 0.8;
    padding: 0.4em 0.6em;
    background: var(--ci-surface);
    border-left: 2px solid var(--ci-accent);
    border-radius: 0 var(--ci-radius) var(--ci-radius) 0;
    margin-bottom: 0.5em;
}

#comfy-imagine-settings .comfy-imagine-info code {
    font-family: monospace;
    background: var(--ci-surface-strong);
    padding: 0.1em 0.35em;
    border-radius: 3px;
}
```

Leave `h5`, `label`, `.comfy-imagine-status.success` and `.comfy-imagine-status.error` alone. The status colours are semantic (`--green` / `--red`), not theme accent, and must stay that way.

- [ ] **Step 3: Verify in the browser**

Reload SillyTavern, open **Extensions → ComfyUI-Imagine**. Expected: the panel renders as before, except info boxes now have a coloured left edge and a faint tinted background. Nothing is unreadable. Switch ST to a **light** theme (User Settings → Theme) and confirm the info box tint is still visible — this is the specific thing the `color-mix` approach fixes, so it is the specific thing to check.

- [ ] **Step 4: Commit**

```bash
git add style.css
git commit -m "style: add CSS token layer for the settings panel

Aliases SillyTavern's theme variables once as --ci-* tokens and styles the
existing rules through them. Surface tints derive from the body colour rather
than a hardcoded white overlay, so they stay visible on light themes."
```

---

### Task 2: The tabs

Restructures the panel markup, adds the tab CSS, and initialises the widget. These ship together because the intermediate states are broken: tab CSS alone styles nothing, and the new markup without `.tabs()` renders all four panels stacked.

**Files:**
- Modify: `settings.html` (full restructure, currently 210 lines)
- Modify: `style.css` (append tab rules)
- Modify: `index.js:635` — inside `bindSettingsEvents()`

**Interfaces:**
- Consumes: the `--ci-*` tokens from Task 1.
- Produces: four panels with ids `comfy-imagine-tab-character`, `comfy-imagine-tab-generate`, `comfy-imagine-tab-prompt`, `comfy-imagine-tab-connection`, inside a `#comfy-imagine-tabs` wrapper. Task 3 documents these names.

- [ ] **Step 1: Restructure `settings.html`**

Keep the outer `#comfy-imagine-settings` / `inline-drawer` / `inline-drawer-toggle` / `inline-drawer-content` wrapper exactly as it is — ST's drawer toggle depends on it. Inside `inline-drawer-content`, replace all seven `.comfy-imagine-section` divs with:

```html
<div id="comfy-imagine-tabs">
    <ul class="comfy-imagine-tab-list">
        <li><a href="#comfy-imagine-tab-character">
            <i class="fa-solid fa-user"></i><span>Character</span></a></li>
        <li><a href="#comfy-imagine-tab-generate">
            <i class="fa-solid fa-image"></i><span>Generate</span></a></li>
        <li><a href="#comfy-imagine-tab-prompt">
            <i class="fa-solid fa-pen"></i><span>Prompt</span></a></li>
        <li><a href="#comfy-imagine-tab-connection">
            <i class="fa-solid fa-gear"></i><span>Connection</span></a></li>
    </ul>

    <div id="comfy-imagine-tab-character"><!-- see Step 2 --></div>
    <div id="comfy-imagine-tab-generate"><!-- see Step 2 --></div>
    <div id="comfy-imagine-tab-prompt"><!-- see Step 2 --></div>
    <div id="comfy-imagine-tab-connection"><!-- see Step 2 --></div>
</div>
```

The `<ul>` must be the **first child** of `#comfy-imagine-tabs` and each `href` must match a sibling panel id — jQuery UI Tabs requires both.

- [ ] **Step 2: Move the existing markup into the panels**

Move the inner content of each old section across **verbatim**. Do not retype it and do not rename any id. Drop the old `.comfy-imagine-section` wrapper divs and their `<h5>` headings, since the tab label now carries the name. The one exception is the Connection panel, which keeps sub-headings because it holds three distinct groups.

| Panel | Takes from the old file |
|---|---|
| `comfy-imagine-tab-character` | all of old Section 4 (Character LoRAs) |
| `comfy-imagine-tab-generate` | all of old Section 3 (Workflows), then Image Count and Sender Name from old Section 5 |
| `comfy-imagine-tab-prompt` | the preset row, system prompt row, prefix, suffix and negative prompt from old Section 2, then **Chat History Limit** and its info box, moved out of old Section 5 |
| `comfy-imagine-tab-connection` | old Section 1 (ComfyUI Connection), then the LLM URL / key / model / max tokens / temperature / test-button rows from old Section 2, then old Section: Image Storage and old Section 6 (Quick Reply Setup) |

Chat History Limit is the only control that changes neighbours. It governs how much chat the prompt LLM sees, which makes it a prompt input, not a generation dial. Its markup:

```html
<div class="comfy-imagine-row">
    <label for="comfy-imagine-chat-limit">Chat History Limit</label>
    <input id="comfy-imagine-chat-limit" type="number" class="text_pole" min="0" placeholder="0 = all" />
</div>
<div class="comfy-imagine-info">
    Latest messages sent to the prompt LLM. <code>0</code> sends the entire chat.
</div>
```

Give the Connection panel three sub-headings so its three groups stay legible:

```html
<div class="comfy-imagine-subhead">ComfyUI</div>
<!-- base URL, both info boxes, Test ComfyUI Connection -->
<div class="comfy-imagine-subhead">LLM (Prompt Generator)</div>
<!-- API base URL, key, model, max tokens, temperature, Test API Connection -->
<div class="comfy-imagine-subhead">Maintenance</div>
<!-- migrate button + status, Quick Reply info box -->
```

- [ ] **Step 3: Append the tab rules to `style.css`**

```css
/* --- Tabs --------------------------------------------------------------- */

/* Strip jQuery UI's own chrome. ST writes the same overrides for its
   background tabs in css/backgrounds.css. */
#comfy-imagine-tabs.ui-widget-content,
#comfy-imagine-tabs.ui-widget {
    border: none;
    background: none;
    padding: 0;
    font-family: inherit;
    font-size: inherit;
    color: inherit;
}

#comfy-imagine-settings .comfy-imagine-tab-list::before,
#comfy-imagine-settings .comfy-imagine-tab-list::after {
    display: none;
}

#comfy-imagine-settings .comfy-imagine-tab-list {
    position: sticky;
    top: 0;
    z-index: 2;
    display: grid;
    /* auto-fit reflows into rows instead of overflowing. Four tabs need
       4*74 + 3*3 = 305px for a single row; every phone clears that, a desktop
       window near 1000px does not and wraps to two rows. */
    grid-template-columns: repeat(auto-fit, minmax(74px, 1fr));
    gap: 3px;
    list-style: none;
    margin: 0 0 0.6em 0;
    padding: 3px;
    border: 1px solid var(--ci-border);
    border-radius: var(--ci-radius);
    background: var(--SmartThemeBlurTintColor, transparent);
}

#comfy-imagine-settings .comfy-imagine-tab-list li {
    margin: 0;
    list-style: none;
    float: none;      /* jQuery UI floats tab <li>s; the grid handles layout */
    border: none;
    background: none;
    white-space: normal;
}

#comfy-imagine-settings .comfy-imagine-tab-list li a {
    display: flex;
    /* Icon above label at every width, not just on mobile. This is what lets
       a 74px track hold the word "Connection" without wrapping. */
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 100%;
    padding: 5px 3px;
    float: none;
    font-size: 0.82em;
    font-weight: 600;
    text-align: center;
    color: var(--SmartThemeBodyColor, inherit);
    background: var(--ci-surface);
    border: 1px solid transparent;
    border-radius: calc(var(--ci-radius) - 3px);
    cursor: pointer;
    opacity: 0.75;
    transition: opacity 0.15s, background 0.15s;
}

#comfy-imagine-settings .comfy-imagine-tab-list li a:hover {
    opacity: 1;
    background: var(--ci-surface-strong);
}

#comfy-imagine-settings .comfy-imagine-tab-list li a:focus-visible {
    outline: 2px solid var(--ci-accent);
    outline-offset: 1px;
}

/* Accent on icons only, never on body text. */
#comfy-imagine-settings .comfy-imagine-tab-list li a i {
    color: var(--ci-accent);
    font-size: 1.05em;
}

#comfy-imagine-settings .comfy-imagine-tab-list li.ui-tabs-active a {
    opacity: 1;
    border-color: var(--ci-border);
    /* Same treatment ST uses for its own active tab. */
    background: color-mix(in srgb, var(--ci-accent) 33%, var(--ci-field) 66%);
}

#comfy-imagine-settings .comfy-imagine-tab-list li.ui-tabs-active a i {
    color: inherit;
}

#comfy-imagine-settings .ui-tabs-panel {
    padding: 0;
}

/* Sub-headings inside the Connection panel */
#comfy-imagine-settings .comfy-imagine-subhead {
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    font-weight: bold;
    opacity: 0.55;
    margin: 1em 0 0.4em 0;
    padding-bottom: 0.2em;
    border-bottom: 1px solid var(--ci-border);
}

#comfy-imagine-settings .comfy-imagine-subhead:first-child {
    margin-top: 0;
}
```

The `float: none` declarations matter: jQuery UI's stylesheet floats tab list items, which would fight the grid.

- [ ] **Step 4: Initialise the widget**

In `index.js`, inside `bindSettingsEvents()` (starts at `:635`), add as the **first** statement in the function:

```js
    // Tabs. jQuery UI is bundled by ST, which uses it for its own background
    // tabs (backgrounds.js). bindSettingsEvents runs once, from init(), after
    // the template has been rendered into the DOM, so no re-init guard needed.
    $('#comfy-imagine-tabs').tabs();
```

- [ ] **Step 5: Verify in the browser**

Reload SillyTavern and open the extension settings. Check each of these:

1. Four tabs render in a single row, labels not wrapped, Character active.
2. Clicking each tab switches the panel; only one panel is visible at a time.
3. Focus a tab and press Left/Right/Home/End — focus and selection move. This is the proof jQuery UI initialised; if nothing happens, `.tabs()` did not run.
4. **Character tab:** the LoRA dropdown is searchable on desktop (type to filter). Its width is correct and not collapsed — `refreshLoraSelect2` passes `width: '100%'` (`index.js:521`), so initialising inside a hidden panel is safe, but confirm it.
5. **Generate tab:** upload a workflow, confirm it appears in the dropdown.
6. **Prompt tab:** Chat History Limit is present here, not under Generate.
7. **Connection tab:** both **Test ComfyUI Connection** and **Test API Connection** still run and show their status text.
8. Change one field in each tab, reload ST, confirm all four persisted.
9. Scroll the panel: the tab bar stays pinned, then scrolls away when the panel does.
10. Narrow the browser window to about 1000px: the bar wraps to two rows. Expected, not a bug.

- [ ] **Step 6: Commit**

```bash
git add settings.html style.css index.js
git commit -m "feat: reorganise settings panel into four tabs

Character, Generate, Prompt and Connection, split by how often a control is
touched rather than by how advanced it is. Uses jQuery UI Tabs, which
SillyTavern already bundles and calls itself in backgrounds.js, so ARIA roles
and arrow-key navigation come for free.

Chat history limit moves from Generation Settings to Prompt, since it governs
how much chat the prompt LLM sees. Every input id is unchanged, so all
existing bindings continue to work."
```

---

### Task 3: Documentation

`CLAUDE.md` describes the structure this change replaces, and four places in `README.md` name the old sections. Both would send a reader to a section that no longer exists.

**Files:**
- Modify: `CLAUDE.md` — the "Settings Panel Pattern" section
- Modify: `README.md:103`, `:112`, `:419`, `:489`, `:509`

**Interfaces:**
- Consumes: the panel ids produced by Task 2.
- Produces: nothing further depends on this.

- [ ] **Step 1: Rewrite the `CLAUDE.md` "Settings Panel Pattern" section**

Keep the existing explanation of the `inline-drawer` structure — that wrapper is unchanged and still required. Replace the enumeration of six sections with the tab structure. State:

- The four tabs in order, with their panel ids, and what each holds.
- That `$('#comfy-imagine-tabs').tabs()` runs in `bindSettingsEvents()`, and that jQuery UI is ST-bundled rather than an added dependency.
- That the `<ul>` must be the first child and each `href` must match a sibling panel id.
- That chat history limit lives under Prompt, not Generate.
- That colour flows through the `--ci-*` token layer, which aliases ST theme variables, and that a fixed palette is deliberately rejected because CSS cannot detect the active ST theme.

- [ ] **Step 2: Update the five `README.md` references**

| Line | Change |
|---|---|
| `:103` | "Enter the base URL" becomes "In the **Connection** tab, enter the base URL" |
| `:112` | "Enter the **API base URL**" becomes "Still in the **Connection** tab, enter the **API base URL**" |
| `:419` | "open the **Character LoRAs** section" becomes "open the **Character** tab" |
| `:489` | Add a **Tab** column to the Generation settings table: Image count and Sender name are Generate; Chat history limit, Prompt prefix / suffix and Negative prompt are Prompt; Max tokens and Temperature are Connection |
| `:509` | "find the **Image Storage** section" becomes "open the **Connection** tab and find the **Maintenance** block" |

No em-dashes, per the existing README convention.

- [ ] **Step 3: Verify**

Re-read the Quick Start (`README.md:47-211`) start to finish as though setting the extension up for the first time. Every instruction that names a control must say which tab it is on, and every tab name must match a label in `settings.html`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update settings panel references for the tab layout

CLAUDE.md described the seven flat sections the tabs replace. README named
the Character LoRAs and Image Storage sections and gave Quick Start steps
without saying which tab a control is on."
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: tab order and contents to Task 2 Steps 1-2; the token layer and no-fixed-theme decision to Task 1 and Task 2 Step 3; `index.js` to Task 2 Step 4; `CLAUDE.md` and `README.md` to Task 3; the spec's verification list to Task 2 Step 5. The five ST-source constraints are settled facts the plan builds on rather than work items, except constraint 6 (widths), which surfaces as verification checks 1 and 10.

**Placeholders.** None. The two `<!-- see Step 2 -->` markers in Task 2 Step 1 are pointers to the table in the immediately following step, which names every piece of markup to move, not deferred decisions.

**Naming consistency.** Panel ids `comfy-imagine-tab-{character,generate,prompt,connection}` are identical in Task 2 Steps 1, 2 and Task 3. Token names `--ci-border`, `--ci-field`, `--ci-accent`, `--ci-surface`, `--ci-surface-strong`, `--ci-radius` are defined once in Task 1 Step 1 and every later use matches. `.comfy-imagine-tab-list` and `.comfy-imagine-subhead` are used consistently between the markup in Task 2 Step 2 and the CSS in Step 3.
