# Settings Panel: Flat Sections to Tabs

Date: 2026-08-01
Status: approved, not yet implemented

## Problem

`settings.html` is one `inline-drawer` containing seven flat `.comfy-imagine-section`
blocks, every control visible at once. Reaching the Character LoRA or the active
workflow means scrolling past the ComfyUI URL, the LLM credentials and two info
boxes that are set once and never touched again.

The panel renders into `#extensions_settings`. On desktop ST styles it
`class="flex1 wide50p"` inside `.drawer-content` — roughly half the drawer width. On
mobile that is overridden to full viewport width (see constraint 6). Vertical space is
the scarce resource in both cases.

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

6. **Mobile gets a full-width panel, not a half-width one.** Under
   `@media screen and (max-width: 1000px)`, `mobile-styles.css:260` sets
   `.drawer-content { width: 100dvw; min-width: unset }` and `mobile-styles.css:180` sets
   `#extensions_settings { width: 100% !important }`. The available bar width is therefore
   the viewport minus about 12px (the drawer's 5px padding and 1px border per side).

   Four tabs at `minmax(74px, 1fr)` with a 3px gap need `4×74 + 3×3` = **305px**.

   | Context | Bar width | Result |
   |---|---|---|
   | iPhone SE, 375pt | 363px | one row, 87px per tab |
   | iPhone 16 / 16 Pro, 393–402pt | 381–390px | one row, 93–95px per tab |
   | Pro Max, 440pt | 428px | one row, 105px per tab |
   | Desktop 1920px wide | ~474px | roomy |
   | Desktop 1280px wide | ~315px | one row, barely |
   | Desktop ~1000px wide | ~244px | drops to 3 columns, fourth tab wraps |

   Desktop maths: `--sheldWidth: 50vw` (`style.css:92`), `.drawer-content` takes that with
   `min-width: 450px`, and `wide50p` halves it.

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

**Token layer.** Alias ST's variables once on the root element, then style through the
tokens. This is the technique that makes Summaryception's panel look considered
(`style.css:1-9` there); it is not a private palette, and every value still follows the
user's chosen ST theme.

```css
#comfy-imagine-settings {
    --ci-border: var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.16));
    --ci-field: var(--SmartThemeBlurTintColor, rgba(18, 18, 24, 0.86));
    --ci-accent: var(--SmartThemeQuoteColor, #66b2ff);
    --ci-surface: color-mix(in srgb, var(--SmartThemeBodyColor) 6%, transparent);
    --ci-surface-strong: color-mix(in srgb, var(--SmartThemeBodyColor) 10%, transparent);
    --ci-radius: 8px;
}
```

The surface tints deliberately diverge from Summaryception, which hardcodes
`rgba(255, 255, 255, 0.045)` and therefore vanishes on a light ST theme. Deriving them
from `--SmartThemeBodyColor` makes the tint light on dark grounds and dark on light ones
with no branching, since the body colour is by definition legible against the ground.

**No fixed theme.** A settings drawer sits inline with ST's own chrome, and CSS cannot
detect which ST theme is active — `prefers-color-scheme` reports the OS preference, not
the theme the user picked in ST. Any hardcoded palette would therefore be low-contrast
for some users with no way to branch. Identity comes from structure instead: the accent
on tab icons, consistent radius, layered surfaces.

**Tab rules**, roughly 35 further lines:

- `.comfy-imagine-tab-list` — `position: sticky; top: 0; z-index: 2;`
  `display: grid; grid-template-columns: repeat(auto-fit, minmax(74px, 1fr)); gap: 3px;`
  plus `padding: 3px`, `border: 1px solid var(--ci-border)`, `border-radius: var(--ci-radius)`.
- `.comfy-imagine-tab-list a` — `flex-direction: column` at **all** widths, so the icon
  stacks above the label. This is what lets a 74px track hold the word "Character".
- Tab icons take `color: var(--ci-accent)`. Accent goes on icons, never on body text,
  so no contrast requirement is riding on a user-chosen colour.
- Active tab: `background: color-mix(in srgb, var(--ci-accent) 33%, var(--ci-field) 66%)`,
  matching what ST does for its own tabs (`backgrounds.css:373`).
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

### `README.md`

Four places name the old sections or assume a flat panel:

- `:103` and `:112` (Quick Start steps 4 and 5) — name the **Connection** tab so the
  fields are findable.
- `:419` — "open the **Character LoRAs** section" becomes the **Character** tab.
- `:489` — the Generation settings table already mixes controls from several sections,
  so give it a **Tab** column rather than restructuring it.
- `:509` — "find the **Image Storage** section" becomes the Maintenance block at the
  bottom of the **Connection** tab.

Existing README conventions apply: no em-dashes anywhere in it.

## Non-goals

- Tab persistence across reloads. Re-picking a tab is one click.
- Summaryception's off/easy/advanced mode radio.
- A fixed or opt-in custom palette. Considered and rejected above.
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
6. Labels do not wrap. Check on a narrow desktop window, not on the phone — per
   constraint 6, mobile has the most room, not the least.

## Known risk

Tab labels are safe on every phone and on a maximised desktop window. The failure case
is a **narrow desktop browser window**, roughly 1100px or less, where the half-width
panel falls under 305px and `auto-fit` drops to three columns, wrapping Connection onto
a second row.

A two-row bar is not broken, just less tidy, so the first response is to accept it. If
it grates, drop the grid minimum from 74px to about 64px. Do not shorten the labels —
abbreviating is what makes a tab bar hard to scan, and the stacked icon layout exists
precisely so full words fit.
