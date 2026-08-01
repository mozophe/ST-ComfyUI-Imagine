# Settings Panel: Flat Sections to Tabs

Date: 2026-08-01
Status: approved, not yet implemented

## Problem

`settings.html` is one `inline-drawer` containing seven flat `.comfy-imagine-section`
blocks, every control visible at once. Reaching the Character LoRA or the active
workflow means scrolling past the ComfyUI URL, the LLM credentials and two info
boxes that are set once and never touched again.

The panel renders into `#extensions_settings`, which ST styles as
`class="flex1 wide50p"` inside `.drawer-content` — roughly half the drawer width.
Vertical space is the scarce resource.

## Approach

Replace the seven flat sections with four tabs, split by how often a control is
touched rather than by how advanced it is.

Reference: [vadash/Extension-Summaryception](https://github.com/vadash/Extension-Summaryception),
whose settings panel uses a sticky auto-fit tab grid. Its `easy`/`advanced` mode
radio is **not** adopted — this extension has no off state and no tuning dials deep
enough to warrant a second mode.

### Tab order

`Character | Generate | Prompt | Connection`

Character is tab 0 and therefore the default active tab. It is the only tab whose
contents change on their own: it is bound to the active character and already
refreshes on `CHAT_CHANGED`. Open the panel after switching chats and the relevant
state is already showing.

Connection is last by the usual convention that plumbing goes last, and it is the
one tab a user stops opening after the first day.

No tab persistence. The panel always opens on Character.

### Tab contents

Section contents move **verbatim** from the current `settings.html`. Every input
keeps its existing id, so `bindSettingsEvents`, `loadSettingsIntoUI` and
`populateCharacterLoraUI` need no changes.

| Panel id | Icon | Contents |
|---|---|---|
| `comfy-imagine-tab-character` | `fa-user` | active character name, LoRA select + reload, strength, trigger, both info boxes |
| `comfy-imagine-tab-generate` | `fa-image` | workflow upload / select / delete + API-format info box, image count, sender name |
| `comfy-imagine-tab-prompt` | `fa-pen` | preset row, system prompt + expand button, prefix, suffix, negative, **chat history limit** |
| `comfy-imagine-tab-connection` | `fa-gear` | ComfyUI URL + test + `--listen`/CORS info boxes, LLM URL/key/model/max tokens/temperature + test, then a Maintenance block: migrate button, Quick Reply info |

One control moves between sections: **chat history limit** leaves Generation
Settings for Prompt. It governs how much chat the prompt LLM sees, which makes it a
prompt-input knob, not a generation knob. Without this move the fourth tab is a junk
drawer with no honest name.

## Constraints verified against SillyTavern source

Checked against `SillyTavern/SillyTavern` at time of writing.

1. **jQuery UI Tabs is bundled and used by ST itself.** `backgrounds.js:1861` calls
   `$('#bg_tabs').tabs()`. `$.fn.tabs` is therefore available to extensions. Using it
   gives ARIA roles and arrow-key/Home/End navigation for free.

2. **`position: sticky` works for the tab list.** The only scroll container in the
   ancestry is `.drawer-content.openDrawer { overflow-y: auto }` (`#rm_extensions_block`).
   Nothing between it and the tab list sets overflow: `#extensions_settings` is only
   `display:flex; flex-direction:column` (`css/extensions-panel.css:139`) and
   `.inline-drawer-content` is only `display:none` (`style.css:5535`). Sticky is
   confined to its parent box, so the bar pins while the panel is onscreen and scrolls
   away with it.

3. **ST's accessibility and keyboard helpers are closed to extensions.**
   `a11y.js:55` hardcodes `'#bg_tabs .bg_tabs_list'` and `keyboard.js:23` hardcodes
   `'.bg_tabs_list .bg_tab_button'`. There is no registration hook. Reusing those class
   names to piggyback would be fragile and would gain no styling either, since every
   rule in `backgrounds.css` is scoped under `#bg_tabs`. jQuery UI covers what these
   would have provided.

4. **Theme variables.** Use ST's, not Summaryception's `--sc-*`. Copy ST's own active
   tab treatment from `backgrounds.css:373` so our tabs match native ones:
   `color-mix(in srgb, var(--SmartThemeQuoteColor) 33%, var(--SmartThemeBlurTintColor) 66%)`,
   with `var(--SmartThemeBorderColor)` and `var(--SmartThemeBodyColor)`.

5. **`bindSettingsEvents()` is called exactly once**, from `init()` at `index.js:1820`,
   after the template renders. `.tabs()` can be initialised there with no re-init guard.

## Changes by file

### `settings.html`

The seven `.comfy-imagine-section` divs become four panels inside a
`#comfy-imagine-tabs` wrapper, in the markup shape jQuery UI Tabs requires:

```html
<div id="comfy-imagine-tabs">
    <ul class="comfy-imagine-tab-list">
        <li><a href="#comfy-imagine-tab-character">
            <i class="fa-solid fa-user"></i><span>Character</span></a></li>
        <!-- generate, prompt, connection -->
    </ul>
    <div id="comfy-imagine-tab-character"><!-- panel --></div>
    <!-- ... -->
</div>
```

### `style.css`

Roughly 35 lines:

- `.comfy-imagine-tab-list` — `position: sticky; top: 0; z-index: 2;`
  `display: grid; grid-template-columns: repeat(auto-fit, minmax(74px, 1fr)); gap: 3px;`
- `.comfy-imagine-tab-list a` — `flex-direction: column` at **all** widths, so the icon
  stacks above the label. This is what lets a 74px track hold the word "Character".
- Active state and borders from the theme variables in constraint 4.
- Strip jQuery UI's default chrome, mirroring what ST writes for its own tabs:
  `#comfy-imagine-tabs.ui-widget-content { border: none !important }` and hiding
  `.comfy-imagine-tab-list::before` / `::after`.

### `index.js`

One line in `bindSettingsEvents()`:

```js
$('#comfy-imagine-tabs').tabs();
```

### `CLAUDE.md`

The "Settings Panel Pattern" section documents six flat sections and describes the
structure being replaced. Rewrite it to the tab layout, including the note that
chat history limit now lives under Prompt.

## Non-goals

- Tab persistence across reloads. Re-picking a tab is one click.
- Summaryception's off/easy/advanced mode radio.
- Hand-rolled ARIA or keyboard navigation. jQuery UI provides both.
- Any change to generation logic, storage, or the LoRA injection path. This is a
  presentation change only.

## Verification

No automated test. The change is markup plus one widget-init call; there is no pure
logic for `test/image-helpers.test.mjs` to cover. Manual checks on the Pi install:

1. Four tabs render; clicking each switches panels; Character is active on load.
2. Arrow keys move between tabs (confirms jQuery UI initialised).
3. LoRA select is still searchable via select2 on desktop and a native picker on
   mobile. `refreshLoraSelect2` passes `width: '100%'` (`index.js:521`), so select2
   takes its width from CSS rather than measuring, and initialising inside a hidden
   panel is safe.
4. Tab bar stays pinned while the panel scrolls, and scrolls away with it.
5. Every control still saves: change one field per tab, reload ST, confirm it persisted.
6. Labels do not wrap in the half-width panel.

## Known risk

Tab label width in a `wide50p` container cannot be verified from source. If
"Character" wraps despite the stacked icon, drop the grid minimum from 74px to
about 64px. Do not shorten the labels — abbreviating is what makes a tab bar hard
to scan, and the stacked layout exists precisely to avoid it.
