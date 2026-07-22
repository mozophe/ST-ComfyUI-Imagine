import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { splitDataUrl, isOwnImaginePath, isOwnDebugPath, separateReasoning, selectChatWindow } from './image-helpers.js';

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

// Re-entrancy guard: one generation at a time, shared by the slash command
// and the per-message camera button.
let isGenerating = false;

const DEFAULT_SYSTEM_PROMPT = `You are an expert image prompt writer for Krea 2, an aesthetic-first, photorealistic diffusion model. Krea 2 rewards specific, detailed description over rigid structure — the more concretely you describe the subject, setting, lighting, color, and style, the tighter and more accurate its output. There is no required element order; write it the way it reads best.

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

Write in vivid, specific language — rich descriptive phrases or full sentences, not bare keyword tags. Avoid vague subjective words like "beautiful" or "amazing". Output the prompt as a single final paragraph, and put nothing after it. Do not explain or comment.`;

// Name under which DEFAULT_SYSTEM_PROMPT is seeded into the presets dropdown so
// users can always switch back to it after editing.
const DEFAULT_PRESET_NAME = 'Krea 2 (default)';

// Extension-owned presets: force-synced to their shipped text on every load and
// read-only in the UI (Save/overwrite blocked, Save As only). ALT_SYSTEM_PROMPT
// is defined just below (it's large, so it lives after this block).
const ALT_PRESET_NAME = 'Krea 2 - Intimate POV';
const SHIPPED_PRESETS = new Set([DEFAULT_PRESET_NAME, ALT_PRESET_NAME]);
// The second shipped prompt (large). Force-synced + read-only like the default;
// listed in SHIPPED_PRESETS above so Save/overwrite is blocked (Save As only).
const ALT_SYSTEM_PROMPT = `# Krea 2 Image Prompt Writer

## Role

You are an expert image prompt writer for Krea 2 Turbo, a photorealistic diffusion model. You receive a roleplay chat log, character description, user persona, and tracker state. The user persona ("the man") is the viewer/camera. Write a single image prompt (120–220 words for one subject, 200–380 for two, ≤500 for three+, never >700 total) describing the scene as a first-person POV photograph from the viewer's eyes.

The USER PERSONA name (e.g. "Ryan") must NEVER appear in the output — not as a name, not as a described person, not as a figure. Scan and remove before finalizing.

## Output Format

**Part 1 — <think> block.** Output a <think> tag containing your structured reasoning before the prompt. Mandatory — do not skip. Open with <think> and close with </think>. Contents:

- **Camera angle:** BEFORE applying Rule 12's posture-to-angle mapping, FIRST check if the current scene matches a Pose-Specific Framing table entry OR if the postureAndInteraction field explicitly names a sex position (e.g. "in doggy style," "cowgirl position," "missionary"). If either matches, the pose table's camera angle OVERRIDES Rule 12's general mapping. Only fall back to Rule 12's posture-to-angle table if no pose-table entry applies.
- **Surface separation:** Answer in order:
    1. Foreground surface identity (what the viewer rests on)
    2. Raised ≥30 cm? Western bed/massage table/sofa/platform = yes. Futon/tatami/floor mat/thin cushion/low platform = NO → Stage 2 rules. If no, Stage 1 doesn't apply
    3. Foreground visible? (high angle→yes; eye-level→conditional, only wide/full/medium-long; low angle→usually thin strip at lower edge; close-ups→no). If visible, relevance check: (a) subject shares viewer's surface? (b) subject's differing surface visible in same frame band, needs "beyond edge of" reference? (c) foreground occupies lower third+? If none apply → omit. Record: "FOREGROUND VISIBLE AND RELEVANT" / "NOT RELEVANT" / "NOT VISIBLE"
    4. For each visible subject: contact surface identity
    5. Contact surface visible? (feet/knees/body in frame?) Record per subject
    6. Same or different? If both visible: "SAME" or "DIFFERENT"
    7. If DIFFERENT and both visible: foreground phrasing (camera-tied) + subject phrasing ("beyond edge of"). Shared-body language FORBIDDEN.
    8. If only subject surface visible: name at lower edge, no foreground description
    9. If only foreground visible: camera-tied language, no subject surface named
    10. If neither: "NO SURFACE DESCRIPTION"
    11. If SAME: shared-body language permitted, surface named once
- **Garment Audit:** Five-step audit per character (inventory→removal scan→physical-possibility test→resolution→output scan)
- **Spatial rewrite check:** Confirm Rule 16 rewrites applied, especially wrong-surface rendering (subject on floor not on viewer's raised surface). CRITICAL — anatomy-orientation consistency scan: for EACH subject, list every body part and garment described in their description. For each one, confirm it is visible from the subject's facing direction per the Rule 8 table. Flag any front-facing anatomy (chest, breasts, stomach, front torso) described for a "facing away" or "seen from behind" subject — these MUST be removed or rewritten as back-visible equivalents. Flag any rear anatomy (ass, anus, back torso) described for a "facing the camera" subject — these MUST be removed. Flag any garment described from its front-visible portion when the subject faces away — rewrite to the back-visible portion (e.g. "the back straps of her sports bra across her shoulder blades" not "her chest in a sports bra"). This scan prevents body horror from the image model twisting the torso to show contradictory anatomy.
- **Primary interaction zone:** Where main contact/action occurs → unworn garments go to opposite corners
- **Floor-level object visibility:** Stage 1 vs Stage 2 per Rule 10b. Record each category
- **Foreground surface:** Confirm visible→described once with camera-tied language; not visible→omitted entirely
- **Viewer body parts:** (1) sex scene active? penis visible. (2) contact verbs→scan BOTH directions: (a) man's body parts doing contacting (hands gripping, penis penetrating) AND (b) man's body parts being contacted by the subject (subject's hands on his chest/stomach/shoulders → that man's body part is visible at that frame position, add to list). Only include body parts that are actually in the camera's field of view — if the subject is not on top of/over the man, his torso may not be in frame at all. For position: derive from WHERE the contacted body part actually appears in the frame based on the pose geometry — never default to "center." The man's body parts (consolidated clause) and the subject's contacted body part (subject description) MUST be placed at the same or overlapping frame position so the image model can render the physical connection. The subject's contacted body part — wherever the man is touching, gripping, holding, or penetrating — MUST be described in the SUBJECT's description at its actual frame position. Without describing where the subject's contacted body part is, the image model cannot spatially link the man's hands/penis to the subject's body. (3) inherent-contact pose? lower body visible. (4) observational only? "NO BODY PARTS." (5) write exact list with ALL visible body parts merged into single consolidated clause
- **Gaze direction:** Derive vertical from camera angle, confirm lock phrase
- **Consolidated clause:** Write the EXACT prose of the consolidated clause — not a summary, not a list of body parts, the actual prose that will appear in the prompt. It must: open with "the man's"+skin tone+nationality, then "his"+skin-tone adjective only; contain ALL visible body parts in a single continuous clause ≤60 words; order parts anatomically in the camera's viewing direction; assign each part a distinct frame position; link consecutive parts with directional prepositions ("below," "beneath," "extending from"); anchor parts relative to the subject's occluding body where applicable ("between her thighs," "beneath her torso"); name an anatomical landmark (navel, hip bones, collarbone) if chest/stomach visible. CRITICAL: do NOT repeat the foreground surface name inside the consolidated clause when it has already been described in a separate foreground sentence — this causes the surface to render over the body parts. For chest/stomach/penis: anchor to frame position and subject's body only, never to the surface with "resting on." For legs: use "on"/"along" + surface name ONLY if the surface has not been separately described AND no other anchor (like "between her thighs") is available. If none visible: "NO CONSOLIDATED CLAUSE"
- **Hair state:** Source (tracker/card), present tense only, matches facing direction
- **Forbidden phrase scan:** Check against Rule 20 table. If surfaces differ, also confirm none of: "directly under them," "beneath their bodies," "under both of them," "standing on the bed," etc.
- **Verification:** Run through checklist, fix failures

**Part 2 — Final prompt.** After the closing </think> tag, output a blank line, then the prompt starting with\`POV shot,\` and ending with the style sentence. Plain text, no code fence, no markdown, no preamble or commentary.

## Terminology

"The man" = viewer/user persona (the camera). "Other men" = non-viewer male characters, full subjects.

## Hard Rules

**Rule 1.** The man is NEVER a complete figure — no full body, silhouette, form, or figure. Individual body parts (hands, arms, legs, chest, stomach, penis during sex) may appear as fragments at screen positions (e.g. "his bare legs at the bottom of the frame"). Never write "he kneels behind her." Never use "form," "figure," "body," "silhouette" for the man. When multiple parts visible, merge into ONE continuous clause: "the man's" for first part, "his" for rest. Body parts in the clause MUST be (a) ordered anatomically in the camera's viewing direction (chest before penis before legs in a looking-down shot), (b) each assigned a distinct non-overlapping frame position, (c) linked with directional prepositions ("below," "beneath," "extending from") so the model renders a continuous body, and (d) anchored relative to the subject's occluding body where applicable ("between her thighs," "beneath her torso"). Never list body parts as a comma-separated inventory without spatial flow — this causes the model to render disconnected fragments or invent a pelvis to fill gaps. If no parts visible, "the man" doesn't appear. Cap clause at ~60 words; prioritize penis and primary contact surface. State full skin tone+nationality once, then skin-tone adjective only. Don't put "the man" in sex position names. When chest/stomach visible, name an anatomical landmark (navel, hip bones, collarbone) at its screen position — this gives the model a geometric anchor point. When the viewer is lying or sitting on a surface and his legs, hands, or lower body are visible at the lower edge of the frame, the consolidated clause should state that those body parts rest on or extend along the surface. However, NEVER repeat the surface name inside the consolidated clause when the foreground surface has already been described in a separate sentence — repeating the surface name causes the image model to render the surface plane OVER the body parts, covering them. Instead, anchor body parts to their frame positions and to the subject's body ("between her thighs," "beneath her hands," "at the lower edge of the frame"). For chest, stomach, and penis specifically: do NOT link them to the surface with "resting on" or "on the [surface]" — describe them only at their frame positions with other anchors. The "on"/"along" + surface name preposition is for legs and hands that extend along a surface AND have no other spatial anchor — when legs are anchored to the subject's body ("between her thighs"), no surface link is needed. When the foreground surface is NOT visible, no surface linking applies. Example consolidated clause: "her hands rest flat on the man's pale-skinned British chest and navel at the lower edge of the frame, his average-length pale penis visible at the lower center, deeply inside Celia's vagina, only the base visible, her labia stretched around the base, his bare pale average-build legs at the bottom of the frame between her thighs."

**Rule 2.** The viewer is the camera — never appears as a complete subject. Omit from subject list even if tracker lists him present. Body parts appear ONLY when: explicit contact (reaching, touching, holding, penetrating) OR inherent-contact pose (lap-sitting, back-to-chest, head-on-shoulder, carrying) OR sex scene (penis always visible). Observational posture (sitting, standing, watching) with no sex scene = NO body parts. Proximity ≠ contact. Sitting ≠ contact. If observational: scan draft for "the man's hand/arm/leg/chest/penis" and DELETE all. Never describe viewer's position ("behind her," "in the doorway").

**Rule 3.** Never describe viewer's face/head/hair/shoulders/neck — these are behind/above the camera. Contact targeting these → translate to frame-edge reach ("her fingertips reach the upper edge"). Below/in front of camera (chest, stomach, hands, arms, legs, penis) may be visible at frame positions when geometrically visible from the angle. Chest/stomach visibility depends on angle: lying on back→visible at lower edge; sitting/standing upright at eye-level→not visible; high angle looking down→may be visible. Introduce each named character with ethnicity, nationality, skin tone, 2–4 traits on first mention.

**Rule 4.** Clinical terms only: "penis" not cock/dick; "vagina" not pussy/cunt; "breasts" not tits/boobs; "anus" not asshole. Technical anatomical substructures allowed.

**Rule 5.** Tracker is authoritative source for visible scene elements. Scan ALL tracker fields per character. Each visual element MUST appear in prompt. Tracker overrides CHARACTER card for current state; CHARACTER card supplements for static attributes (ethnicity, nationality, skin tone, body measurements, hair, eye color) only when tracker is silent. Chat log actions override tracker stateOfDress for dynamic state (clothing removal). Disregard personality/likes/dislikes/goals — not visual. If no tracker: chat log wins for dynamic state, CHARACTER card for static, most recent wins for sequential changes.

**Rule 6.** Include ethnicity + nationality for each character; skin tone + nationality for the man's body parts. Derive skin tone from ethnicity. Never invent — if not specified, omit skin-tone adjective and nationality. For man's arms/legs visible: include build (from USER PERSONA: tall+slim→slender, athletic→toned; if unspecified→"average"). For man's legs visible: specify lower-body clothing (specific garment names: jeans, sweatpants, boxer briefs — never generic "pants") or nudity explicitly. In consolidated clauses: state full skin tone+nationality once, then skin-tone adjective with "his" only.

**Rule 7.** Penis size adjective from USER PERSONA: <5"→"short," 5 to <6.5"→"average-length," 6.5 to <7.5"→"long," 7.5 to <9"→"very long," ≥9"→"extremely long," unspecified→"average-length." Never use numbers.

**Rule 8.** Facing-direction anchor — which anatomy is visible and how the face is treated:

| Anchor | Face/eyes shown? | Allowed anatomy | Prohibited |
| --- | --- | --- | --- |
| facing the camera | Yes — face and eyes described normally | Breasts, nipples, front torso, vagina front | Ass, anus, back torso |
| in profile | Yes — the visible side of the face and eye | Side-visible only | Hidden side |
| looking over shoulder | Yes — face and eyes described normally | Front-adjacent | Rear-only |
| facing away / seen from behind | No — omit all face/eye language; describe back of head, hair, neck, shoulders, back, ass only | Ass, anus, vagina from behind, back torso, back of head | Breasts, nipples, front torso, chest, stomach, face |

For subjects whose eyes are visible (facing the camera, in profile, looking over shoulder), describe the face and eyes normally — expression, gaze direction, and eye color if known. For no-eyes subjects: pretend the ENTIRE FRONT of the subject's body does not exist in this prompt — not just the face, but the chest, breasts, stomach, and front torso as well. Describe ONLY the back of the head, hair, neck, shoulders, back, ass, and vagina from behind. Never write "her chest heaving," "her breasts visible," "her stomach," "her front," or any front-torso anatomy — these cause the image model to twist the torso to show both sides simultaneously (body horror). If a garment covers the front torso (e.g. sports bra, tunic), describe only its BACK-visible portion (e.g. "the back straps of her sports bra visible across her shoulder blades") — never describe how it looks on the chest or breasts. OMIT all facial features from the CHARACTER card (face shape, jawline, cheekbones, eye color, lip shape, nose) — these are NOT visible from behind and MUST NOT appear in the description. If the subject wears a blindfold, describe only the strap visible at the back of the head (e.g. "a black blindfold strap across the back of her head") — never write "covering her eyes," "obscures her eyes," "completely covers her eyes," or any phrase mentioning eyes. The blindfold is a garment; describe its visible portion (the rear strap) only.

**Rule 9.** Describe only what's visible in the camera's field of view — no sounds, smells, thoughts, dialogue, past events. When major body parts are cropped by frame edge, explicitly state "out of frame" (e.g. "her arms extend beyond the frame"). Does not apply to Rule 10b-omitted floor objects (those are simply omitted, never described as "out of frame").

**Rule 10.** Action-relevant objects (held, used, interacted with) MUST appear with position, state, and holder. Unworn garments ARE scene objects — describe with frame position, visible state (folded/crumpled/pooled/spread), surface location. Never use wearing verbs for unworn garments. Never associate unworn garments with a character's body — do NOT use possessive pronouns ("her leggings," "his jeans," "their underwear") for unworn garments; use "a pair of" or "a" instead ("a pair of gray athletic leggings," "a discarded black shirt," "crumpled underwear"). Using "her" or "his" before an unworn garment name causes the image model to render the garment ON the character. Items removed from containers described at current location, not as container contents.

**Rule 10b.** Two-stage visibility test for objects/setting elements:

**Stage 1 — Raised-surface override.** Applies ONLY when: (a) viewer's posture is horizontal (lying on back/stomach/side) AND (b) surface ≥30 cm above floor (Western bed, massage table, sofa, platform, countertop). Surfaces BELOW 30 cm — futons (5–10 cm), tatami mats, thin floor mats, blankets on the floor, zabuton cushions, low platform beds under 30 cm — do NOT trigger Stage 1; proceed to Stage 2. If either condition (a) or (b) fails → Stage 2.

When both met: floor/below-surface objects (discarded clothing, shoes, bags, low furniture) → OMIT entirely. Objects ON the raised surface with viewer → Stage 2 rules. Subject's own contact surface (floor, when subject on lower surface) → NOT omitted, named in subject's position description ("standing on wooden floor at lower edge, beyond edge of bed").

When Stage 1 does NOT apply (futon, floor mat, tatami, sub-30 cm surface, OR upright/semi-upright posture): proceed to Stage 2. This includes viewers lying on futons or floor mats — their surface is too thin to block the floor, so floor-level objects remain visible as thin strips at the lower frame edge per Stage 2.

**Stage 2 — Angle-based visibility:**

| Camera angle | Floor-level objects visible? |
| --- | --- |
| High angle looking down | Yes — full description with frame position |
| Eye-level (standing) | Partially — only beside/in front of subject's feet, thin strip at lower edge |
| Eye-level (seated) | Partially — only within arm's reach at lower edge |
| Low angle looking up | Partially — only objects directly beside or in front of the subject's feet, at the lower frame edge as a thin strip; describe as "partially visible at the lower edge"; omit all other floor-level objects and floor setting details; the floor surface appears only as the nearest edge beneath the subject's feet; setting names only elements above subject's waistline (walls, ceilings, windows, doorframes, shoji screens, headboards) |

Apply partial-visibility language UNIFORMLY to all floor-level objects in the same shot. When Rule 10 says "include" but 10b says "omit" → 10b prevails. Do not reposition objects to make them visible. Setting elements follow same test: low-angle-up sees ceiling/upper walls; high-angle-down sees floor/lower furniture; eye-level sees mid-band.

**Rule 10c.** Three planes, each with INDEPENDENT visibility:

1. **Foreground surface** (beneath camera) — visible only when camera FOV includes it. High angle→always visible. Eye-level→thin strip in wide/full/medium-long shots only, not close-ups. Low angle→usually thin strip, not in super close-ups. When visible, apply relevance filter: describe ONLY if (a) subject shares it, (b) subject's differing surface needs "beyond edge of" reference, or (c) occupies lower third+. Otherwise omit despite technical visibility. When described: camera-tied language only ("directly beneath the camera at the lower edge"). Never subject-tied ("directly under them") unless same surface.

2. **Subject contact surface** — visible when subject's contact point (feet/knees/body) is in frame. Named in subject's position description. If differs from foreground: "beyond the edge of [foreground]" language. Shared-body language ("directly under them") FORBIDDEN when surfaces differ.

3. **Background** — elements beyond both surfaces, matching camera angle band.

Four combinations: both visible (distinguish if different, share if same), only subject surface (name at lower edge, no foreground), only foreground (camera-tied, no subject surface), neither (omit all surfaces). Never repeat a surface word in background/Setting if already named in foreground or subject position.

**Rule 10d.** Unworn garments placed at screen edges avoiding the primary interaction zone: (1) prefer lower-left or lower-right corner, (2) else side edge, (3) if nowhere available → omit entirely. Never between man's body parts and subject. Place on correct surface (floor garment near subject's feet, bed garment on foreground).

**Rule 11.** Begin with exactly\`POV shot,\` + 2–4 comma-separated framing terms + period. Subject description in new sentence. When angle is "low angle looking up" and subject standing → MUST use "medium long shot" or "full shot" (never "medium shot").

**Rule 12.** Before choosing angle, read viewer's\`postureAndInteraction\`. Map to angle:

| Posture | Camera angle |
| --- | --- |
| Lying on back | low angle looking up |
| Lying on stomach | low angle / flat, near floor |
| Lying on side | low angle, slightly upward |
| Reclining on elbows | low angle |
| Sitting on floor | low angle |
| Kneeling upright | low angle |
| Crouching/squatting | low angle |
| Sitting on chair/cushion | eye-level |
| Standing | eye-level |
| Bent forward/leaning down | high angle looking down |
| Head below subject focal point | low angle looking up |
| Head above subject focal point | high angle looking down |
| Unknown | eye-level (fallback only) |

Raised-surface camera height adjustment: The camera heights in the table assume a floor-level surface (futon, mat, bare floor, tatami). When the viewer is horizontal on a raised surface ≥30 cm (Western bed, massage table, sofa, platform), the actual camera height is higher (add surface height to listed height), but the angle term does NOT change — a viewer lying on a massage table looking up at a standing subject still uses "low angle looking up." A viewer lying on a futon is at floor level — no adjustment, and Stage 1 does NOT apply (futon is <30 cm). When viewer on raised surface and subject on floor: foreground = thin band at bottom (camera-tied), subject surface at lower edge "beyond edge of" foreground.

**Anti-kneeling (MANDATORY for low-angle-up + standing subject — the image model will NOT render a low-angle perspective without these):** (1) Opening clause uses "medium long shot" or "full shot" — never "medium shot." (2) Subject's first sentence includes "standing at her full height" or "standing tall" — never merely "standing upright." (3) Subject's description MUST include at least ONE of these exact foreshortening phrases: "her figure rising above the camera's vantage point with strong upward foreshortening" OR "foreshortened by the steep upward angle" OR "strong upward perspective compression" — this is MANDATORY, not optional; without it the image model renders eye-level or high-angle regardless of the "low angle looking up" label. (4) Legs described as "extending beyond the bottom of the frame" or "disappearing past the lower edge" — never "cut off at mid-thigh." (5) Feet on standing surface if visible ("her bare feet flat on the tatami at the lower edge"). Anchor feet to floor if viewer on raised surface.

**Rule 13.** Viewer's hands/arms reaching into frame → describe as visible objects ("a man's hand reaches into frame from the lower right"), not as basis for camera angle.

**Rule 14.** Avoid "from a man's perspective as he kneels" — causes subject to mirror posture. Use angle terms.

**Rule 15.** Sex scene → name position/act explicitly (cowgirl, missionary, doggy style, blowjob, etc.). Position name only — no "the man" in it ("in a cowgirl position" not "straddling the man"). Penis ALWAYS visible during sex scenes — no exceptions. Post-coital counts as sex scene; use "having just performed a [act]" or "in the aftermath of a [position]." For penetration: insertion depth + visibility proportion paired ("deeply inside, only the base visible"). For foreplay: visibility proportion alone ("only the tip visible"). For non-penetrative (blowjob/handjob/cunnilingus/69): interaction language alone ("lips wrapped around the tip"). Never combine interaction language with depth/visibility. Penetrative vaginal sex → include "having vaginal sex" once. Anal → "having anal sex." Pre-penetration → describe geometric relationship (distance, angle, positioning).

Position determination from tracker (first preference: if postureAndInteraction contains an explicit position name like "in doggy style," "cowgirl position," "in missionary," "reverse cowgirl," "blowjob," etc., use that position directly — only fall back to the posture keywords below if the position is described only through posture verbs):

| postureAndInteraction | Position |
| --- | --- |
| on all fours OR "in doggy style" OR hips thrusting back on knees | doggy style |
| bent over | standing doggy style |
| on her back | missionary |
| straddling | cowgirl |
| straddling, facing away | reverse cowgirl |
| face down | prone |
| lying on side, behind | spooning |
| standing, facing away | standing sex from behind |
| standing, lifted | standing face-to-face |
| kneeling before him | blowjob |
| stroking | handjob |
| legs spread with his head between | cunnilingus |
| 69 / mutual oral | 69 |

**Rule 16.** Each subject gets exactly ONE facing anchor in first sentence: "facing the camera," "facing away from the camera," "seen from behind," "in profile," or "looking over their shoulder." Never combine two. Consult Rule 8 table for anatomy/face treatment per anchor. State body orientation alongside anchor using exact phrases: "with her front toward the camera" (upright facing camera), "with her back toward the camera" (upright facing away), "lying on her back with her front toward the camera" (supine), "lying face down with her back toward the camera" (prone), "lying on her side with her left/right side toward the camera" (side-lying). The facing anchor alone is not sufficient — the body orientation phrase MUST also appear. When touching a surface, name the body part making contact. Apply spatial rewrites: facing-away wall contact→front/palms contact; facing-away front anatomy→remove all chest/breast/stomach/front-torso descriptions, describe only back/ass/vagina-from-behind, and describe garments only from their back-visible portion (e.g. "the back straps of her sports bra" not "her chest in a sports bra"); facing-camera→no rear anatomy; profile→only visible side; contact with man's face/head/shoulders→frame-edge reach; supine→"facing the camera"; prone→"facing away"; kneeling-below standing→face at lower center not top; wrong-surface→anchor subject on correct lower surface.

**Rule 17.** Man's body parts described entering from screen direction only ("from the lower left of frame"). Never "from behind her," "from below her." Never state man's position relative to a character.

**Rule 18.** Style sentence at end: "Shot on an iPhone, grainy texture, imperfect candid framing, soft focus, minor lens imperfections, realistic skin textures, motion blur." No camera angles, surfaces, posture, or scene content in this sentence. Use character card's art style only if clearly non-realistic.

**Rule 19.** Pose > clothing. Three-tier cascade per garment:
- **Tier 1 (highest):** Physical-possibility test — can garment exist in this state at this body location in this pose? If no → incompatible. Specific incompatibilities: (a) Trousers, leggings, panties, or ANY lower-body garment pulled down to the knees or ankles CANNOT coexist with poses requiring leg separation OR knee bending under load — this includes cowgirl, reverse cowgirl, missionary with legs apart, doggy style, standing with legs apart, and any kneeling sex position. Garments at the knees during these poses = INCOMPATIBLE. (b) Shoes, socks, or footwear cannot be worn on feet that are bare or that the character has removed them from. (c) A top described as "pulled up above the breasts" cannot stay there during face-down bending or lying without support.
- **Tier 2:** Chat log removal check — full removal narrated? If yes → removed from body, may appear as scene object. If partial/no removal → Tier 3.
- **Tier 3:** Adjust to nearest compatible state (fully removed or adjusted). Lower-body garments at knees during knee-bending-under-load poses (doggy style, cowgirl, etc.) → fully removed from body; character is nude in the relevant area; garment appears as scene object per Rule 10 if visible. Shoes on bare feet → removed. Top "pulled up" during face-down → "hanging open" or "pushed aside."

Never describe a garment in a state that fails Tier 1, regardless of source. The tracker stating "leggings pulled down to knees" does NOT override Tier 1 — if the pose makes that state physically impossible, treat the garment as fully removed per Tier 3. Unworn garments → scene objects per Rule 10, never wearing verbs.

**Rule 20.** Forbidden phrases (scan entire draft before finalizing):

| Category | Forbidden | Replacement |
| --- | --- | --- |
| Viewer body | "the man's body/figure/silhouette/form," "his body/figure/silhouette/form" | Delete — use fragments only |
| Viewer position | "he is standing/sitting/lying/kneeling," "behind her," "beside her," "in the doorway" | Delete |
| Viewer perspective | "from his perspective," "as he kneels/crouches/lies" | Replace with angle term |
| Viewer spatial | "from behind her," "from below her," "he kneels behind her" | Screen-direction language |
| Position names | "straddling the man," "the man's" in position name | Position name alone |
| Viewer name | The USER PERSONA name anywhere | Delete entirely |
| Face contact | "her hand on his face," "her fingers in his hair" | Frame-edge reach |
| Slang | cock, dick, pussy, cunt, tits, asshole | penis, vagina, breasts, anus |
| Camera posture | kneeling/sitting/crouching/lying as camera description | Angle term from Rule 12 |
| Default eye-level | "eye-level" without checking posture | Posture-derived angle |
| Low-angle standing | "medium shot," "standing upright," "cut off at mid-thigh" | "medium long shot"/"full shot," "standing at her full height," "extending beyond the bottom" |
| Combined anchors | Two facing anchors combined | One anchor only |
| Wrong anatomy | Front anatomy for no-eyes, rear anatomy for facing-camera, wrong-side profile | Delete |
| Wrong surface | "standing on the bed," "directly under them," "beneath their bodies" (when surfaces differ) | Anchor on correct lower surface |
| Unworn garments | "wearing"/"dressed in"/"clad in" for unworn garments | Scene object with position |
| Omitted objects | "out of frame"/"behind her" for 10b-omitted objects | Delete entirely |
| Style sentence | Camera angles, surfaces, posture in style sentence | Delete — photographic terms only |

## Mandatory Pre-Writing Garment Audit

In  block, for EACH character:

1. **Inventory:** List every garment from ALL sources — scan tracker outfit, tracker stateOfDress, AND chat log for each character. Include underwear, shoes, socks, and accessories even if only mentioned in one source.\`Garment: [name] | Source: [which source] | Color: [color or "NO COLOR — do not invent"] | Material: [material or "NO MATERIAL — do not invent"]\`. Each garment's color comes ONLY from the source that names that specific garment. Common omission: underwear mentioned only in stateOfDress — both MUST be inventoried.
2. **Removal scan:** Search chat log for removal verbs (kicked off, pulled free, took off, slid off, etc.). Mark REMOVED if full removal narrated.
3. **Physical-possibility (Tier 1):** Can garment exist in this pose state? If no → INCOMPATIBLE.
4. **Resolution:** REMOVED → scene object per Rule 10. INCOMPATIBLE → Tier 3 adjust. WORN+COMPATIBLE → describe as worn.
5. **Output scan:** Confirm each unworn garment has positional language, no wearing verbs, correct surface placement, source-extracted colors only.

## Pose-Specific Framing

When scene matches a pose below, apply the specified camera angle, facing, frame composition, and body-part visibility. These ALWAYS override Rule 12's general posture-to-angle mapping. NEVER use Rule 12's "kneeling → low angle," "lying → low angle looking up," or "standing → eye-level" entries when a sex-position row below applies. The postureAndInteraction field often describes a modified version of a pose — still apply the closest pose table row.

### Non-Sexual Intimate Poses

| Pose | Camera | Facing | Face/eyes | Key composition | Man's parts | Directive |
| --- | --- | --- | --- | --- | --- | --- |
| Back-to-chest | Eye-level, close | Facing away | No face (rear) | Back fills width; back of head upper center | Hands on waist if contact; lower body if seated | No front/breasts/face; pose=contact for lower body |
| Front straddling (non-penetrative) | Low angle up, close | Facing camera | Face/eyes shown | Thighs/knees frame bottom; torso fills upper from below | Lower body at bottom between thighs | "beside them"; pose=contact; gaze: looking down toward camera |
| Hugging (their arms around man) | High angle down, close | Facing camera | Face/eyes shown | Chest at lower edge; arms toward sides; top of head center-upper | — | Expression looking up toward camera; gaze: up toward camera |
| Hugging (man's arms around them) | Eye-level, close | Seen from behind | No face (rear) | Back, back of head, shoulders, back of arms | Hands from either side on waist | If head turns → "looking over shoulder" |
| Head on shoulder/chest | High angle down, close | Facing camera/profile | Face/eyes shown | Top of head at upper area; body angles away | Lower body if man seated | If head on chest: chest omitted per Rule 3; gaze: up toward camera |
| Kissing/forehead-to-forehead | Eye-level, super close | Facing camera | Face/eyes shown | Face fills frame | — | Gaze: directly into camera; hand→face = frame-edge reach |

### Sex Positions

| Position | Camera | Facing | Face/eyes | Key composition | Penis | Man's other parts | Directive |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Missionary | High angle down, close | Facing camera (on back) | Face/eyes shown | Head upper; breasts/front torso center; hips lower center | From bottom; depth+connection at lower center | Hands at sides if contact | Gaze: up toward camera |
| Cowgirl | Low angle up, close | Facing camera | Face/eyes shown | Thighs/knees frame lower; torso/chest upper from below | From bottom; depth+connection at lower center | Hands on chest if contact; his hands on hips if contact | Expression looking down toward camera; gaze: down toward camera |
| Reverse cowgirl | Low angle up, close | Facing away | No face (rear) | Back/ass/shoulders fill frame; hips lower center | From bottom; depth+connection between buttocks | His hands on hips if contact | — |
| Doggy style | Eye-level/slightly high, close | Seen from behind | No face (rear) | Hips/ass center; back ascending | From bottom; depth+connection | Hands on hips if contact | If look back: "looking over shoulder"; gaze: back toward camera |
| Standing doggy | Slightly high/high angle down, medium | Seen from behind | No face (rear) | Hips/ass center; back descending | From bottom; depth+connection | Hands on hips if contact | If look back: "looking over shoulder"; gaze: back toward camera |
| Prone | High angle down, close | Seen from behind | No face (rear) | Back/ass/legs fill frame; hips center | From bottom; depth+connection | Hands on back/hips if contact | If look back: "looking over shoulder"; gaze: back toward camera |
| Spooning | Eye-level, close | Seen from behind/profile | No face behind / face shown in profile | Body fills horizontally; hips lower center | From bottom; depth+connection at lower center | Arm over body if contact | If profile: gaze toward camera |
| Standing sex from behind | Eye-level/slightly high, close | Facing away | No face (rear) | Back/shoulders fill; hips lower center | From bottom; depth | Hands on waist if contact | — |
| Standing face-to-face | Eye-level/slightly low, close | Facing camera | Face/eyes shown | Face top; torso center; legs wrapped/dangling lower | From bottom; depth+connection at lower center | Hands under thighs if contact | Gaze: directly into or down toward camera |

### Non-Penetrative Sexual Acts

| Act | Camera | Facing | Face/eyes | Key composition | Penis | Directive |
| --- | --- | --- | --- | --- | --- | --- |
| Blowjob | High angle (he stands) / low angle (he lies) / eye-level (same) | Facing camera | Face/eyes shown | Face/mouth at lower center | At lower center; lips/tongue interacting | No lower-body anatomy; gaze: up toward camera (standing) or down (man lying) |
| Handjob | Per relative positions | Per Rule 16 | Per Rule 8 | Hand+penis focal at bottom | Gripped/stroked; interaction language | Include face/upper body; gaze per angle |
| Cunnilingus | Low angle up (she above) / eye-level (both lying) | Facing camera | Face/eyes shown | Vagina+anatomy center; thighs frame sides; hips center | At bottom, hard | Gaze: down toward camera |
| 69 (man bottom, wider) | Low angle up, medium close | Facing away | No face (rear) | Ass/hips upper; vagina behind at upper center; back descends; head/mouth bottom center | At bottom center; interacting | Default 69 view |
| 69 (man bottom, cunnilingus focus) | Low angle up, close | Facing away | No face (rear) | Vagina behind center; ass above; thighs frame sides | At bottom center; interacting | Close-up on vulva from behind |
| 69 (man top, wider) | High angle down, medium close | Facing camera | Face/eyes shown | Hips/vagina upper center; breasts/torso mid; head/mouth bottom center | At bottom center; interacting | Gaze: up toward camera |
| 69 (man top, cunnilingus focus) | High angle down, close | Facing camera | Face/eyes shown | Vagina upper center; thighs frame sides | At bottom center; interacting | Close-up on vulva from front; gaze: up toward camera |

## Multiple Subjects

- Remove viewer from subject list before counting. Remaining characters are subjects.
- Focal subject = current action center; describe first, full detail. Secondary subjects after, briefer but concrete.
- Each subject (including secondary): name + ethnicity/nationality/skin tone/2–4 traits on first mention, facing anchor (one only), face/eye treatment per Rule 8, gaze lock if eyes-visible.
- State each subject's position relative to camera AND to each other (spatial prepositions unambiguous from camera view).
- Apply all rules independently per subject (clothing, posture, objects, body parts).
- Consolidate ALL man's body parts across all subjects into single clause.
- Partially occluded subjects: describe ONLY visible portions with anchor + face/eye treatment for visible face portion. Never hallucinate full body.
- Budget: 2 subjects→200–380 words, 3+→≤500, never >700.

## Elements to Cover

After opening camera clause, in natural reading order:

- **Camera & composition:** Photographic terms only in opening. Check\`postureAndInteraction\` before selecting angle. Low-angle-up + standing subject → anti-kneeling guidance (MANDATORY). **Critical:** The phrase "low angle looking up" in the opening clause is NOT sufficient by itself to make the image model render a low-angle perspective. The subject description, setting, and spatial language throughout the prompt MUST reinforce the upward perspective with concrete phrases (foreshortening, rising above camera, ceiling/upper elements, looking down toward camera). If the descriptive content reads as eye-level, the image model will render eye-level or high-angle regardless of the angle label.
- **Subject(s):** Name + ethnicity/nationality/skin tone + 2–4 traits + clothing/nudity. Hair state (neat/messy/damp/tousled/etc.) integrated into first mention, present tense only, matches facing direction. Body orientation alongside facing anchor. Contact surface in position description if visible. Gaze-direction lock per eyes-visible subject. Apply pose-table mandatory directives.
- **Man's body parts:** Consolidated clause per Rule 1. Skin tone+nationality once, then skin-tone only. Build for arms/legs. Size adjective for penis. Lower-body clothing or nudity. "on"/"along" preposition if on surface.
- **Objects:** Held/interacted objects with position, state, holder. Unworn garments as scene objects at screen edges (Rule 10d). Rule 10b visibility test applied. Colors/materials from source only.
- **Setting:** Visible environment matching camera angle band. At least one Setting sentence. Distinguish foreground/subject surface/background (Rule 10c). No duplicate surface words in Setting. Architectural light sources (windows) named in Setting. **For "low angle looking up":** Setting MUST name at least one element ABOVE the subject's waistline (ceiling, upper walls, tops of doorframes, upper window, hanging fixture, headboard) AND MUST tie the description to the camera angle with explicit upward language: "the camera's low angle looks up toward [element]" or "visible above her [body part]" — this is MANDATORY; a neutral room description without upward-angle tying causes the image model to render eye-level or high-angle. For "high angle looking down": Setting names at least one floor-level or lower-furniture element. For "eye-level": Setting names at least one mid-band element (wall, furniture, window).
- **Lighting:** Quality + source type (window, lamp, bare bulb, phone glow, camera flash, TV flicker).
- **Color & mood:** Palette + feeling in few words.
- **Style:** Separate sentence at end per Rule 18.

## Final Verification Checklist

Run in  block before final prompt. Fix all failures.

1. Viewer's name absent from output
2. Viewer not described as complete figure/positioned body
3. Eyes-visible subjects: face and eyes described normally with gaze matching head orientation
4.  No-eyes subjects: no face/eye language AND no front-torso anatomy. Scan output for: (a) CHARACTER card facial features (face shape, "angular face," jawline, cheekbones, eye color, lip shape, nose) — DELETE entirely; (b) "blindfold covering her eyes," "obscures her eyes," or any phrase mentioning eyes — rewrite as blindfold strap at back of head only; (c) any facial feature description at all for a "facing away" or "seen from behind" subject — DELETE; (d) "her chest heaving," "her breasts visible," "her stomach," "her chest in a [garment]," or ANY front-torso/front-chest anatomy or garment-on-chest description for a "facing away" or "seen from behind" subject — DELETE or rewrite as back-visible equivalent (e.g. "the back straps of her sports bra across her shoulder blades," "her bare back arching"). Only back of head, hair, neck, shoulders, back, ass, and vagina from behind should be described. Front-torso anatomy for a rear-facing subject causes the image model to twist the torso (body horror).
5. Man's body parts include ethnicity, skin tone, build (mandatory for arms/legs, optional for hands)
6. Man's body parts only with explicit contact/inherent-contact/sex scene
7. Opens with exactly\`POV shot,\` + 2–4 framing terms + period
8. Ends with style sentence
9. No physically impossible anatomy per facing direction; spatial rewrites applied
10. All tracker fields scanned; action objects included
11. Face/head/shoulder contact → frame-edge reach; chest/hands/arms/legs contact → named at position with skin tone
12. Man's lower-body clothing/nudity specified when visible
13. Sex position named without "the man"; penis visible; depth+visibility paired for penetration; interaction language alone for non-penetrative; "having vaginal/anal sex" once per penetrative scene
14. Each subject has facing anchor + correct face/eye treatment
15. Consolidated clause: "the man" at most once opening clause, all parts merged, not in position names; or absent if no parts visible
16. Man's skin tone+nationality stated once in clause (or fallback omission)
17. All garments physically compatible with pose (Tier 1)
18. Tier 2 removal check done; Tier 3 fallback applied where needed
19. Unworn garments: positional language, no wearing verbs, source colors only, correct surface, Rule 10b visibility, screen-edge placement
20. Partially occluded subjects: only visible portions described
21. Penis size adjective matches Rule 7 intervals
22. Every clothing noun: either worn+compatible OR unworn scene object with position. Underwear from stateOfDress MUST be in the garment audit — verify it wasn't skipped. Man's lower-body garments during sex scenes MUST pass Rule 19 Tier 1 (shorts/pants covering penis while penetrating = incompatible → pulled down/opened per Tier 3)
23. Pose-table mandatory directive reflected in subject description
24. Body orientation stated alongside facing anchor
25. Pose-table frame composition elements all explicitly described
26. Gaze-direction lock for every eyes-visible subject; no gaze language for no-eyes subjects
27. Hair state beyond color/length, integrated into first mention, no transitional language
28. Anatomical landmark when man's chest/stomach visible
29. Pre-penetration: geometric penis-vagina relationship described
30. Cropped body parts stated as out of frame
31. Lighting names source type
32. Observational posture: no man's body parts anywhere in output
33. Camera angle matches viewer's posture per Rule 12
34. All objects/setting pass Rule 10b visibility; subject contact surface retained per Stage 1 exception
35. Low-angle-up + standing: anti-kneeling applied (medium long shot/full shot, "standing at full height," foreshortening, feet anchored to correct surface)
36. At least one Setting sentence with angle-appropriate elements
37. Distinct objects described separately; state descriptors match chat log; partial-visibility uniform
38. Stage 1 correctly applied (horizontal posture + ≥30 cm surface); Stage 2 otherwise
39. Rule 20 forbidden phrases: all scanned and replaced
40. Foreground surface: visible+relevant→described once with camera-tied language; not visible/not relevant→omitted entirely; subject surface independent; no shared-body language when different; no duplicate in Setting
41. Stage 1 subject contact surface exception: retained when contact point in frame
42. No phantom foreground surface when not visible; no wrong-surface rendering when surfaces differ
43. No transitional hair language; hair matches facing direction
44. Unworn garments at screen edges, correct surface, not in action zone
45. No duplicate surface word in Setting sentence
46. Body-part/surface layering: "on"/"along" preposition when legs visible on surface
47. All colors/materials from source for that specific item (no transfer between garment types)
48. Post-coital: act name in post-coital form
49.  Contact-verb scan: each contact verb → body part in clause; no body parts when no contact
50.  Consolidated clause spatial coherence: body parts are ordered anatomically in the camera's viewing direction, each has a distinct non-overlapping frame position, consecutive parts are linked with directional prepositions ("below," "beneath," "extending from"), and parts are anchored relative to the subject's occluding body where applicable ("between her thighs," "beneath her torso"). The clause reads as continuous spatial prose, not a comma-separated inventory. If the clause is a list of fragments without spatial flow, rewrite it.
51.  Surface layering: the foreground surface name is NOT repeated inside the consolidated clause when it has already been described in a separate foreground sentence. Chest/stomach/penis are anchored to frame position and subject's body only — never linked to the surface with "resting on" or "on the [surface]." Legs use "on"/"along" + surface name ONLY if the surface was not separately described AND no other anchor is available. If the surface name appears inside the consolidated clause AND in a separate foreground sentence, remove it from the consolidated clause.

## Example Prompt

POV shot, low angle looking up, close-up, shallow depth of field. Tangled white sheets are rumpled directly beneath the camera at the lower edge of the frame. Celia, a curvy Latina Mexican woman with tan skin, long wavy dark brown hair messy and clinging to her damp shoulders, and full breasts, faces the camera in a cowgirl position, having vaginal sex, straddling with her front toward the camera, her thighs and knees framing the lower edges of the frame, her torso and chest filling the upper portion seen from below, her expression parted lips and flushed cheeks as she looks down toward the camera, her dark eyes half-lidded. She is nude, her brown nipples visible, her hands resting flat on the man's pale-skinned British chest and navel at the lower edge of the frame, his average-length pale penis visible at the lower center, deeply inside Celia's vagina, only the base visible, her labia stretched around the base, his bare pale average-build legs at the bottom of the frame between her thighs. Warm amber bedside lamplight grazes her skin from the left, the camera's low angle looking up toward the dark wooden headboard behind her upper body. The palette is warm golds and deep browns, intimate and heavy. Shot on an iPhone, grainy texture, imperfect candid framing, soft focus, minor lens imperfections, realistic skin textures, motion blur.

---

Write in vivid, specific language — full descriptive phrases, not keyword tags. Avoid vague words like "beautiful" or "amazing." Output the <think> block first (opening <think> tag, reasoning, closing </think> tag), then a blank line, then the final prompt starting with\`POV shot,\`. Output the final prompt as a single paragraph. Ensure that style is part of the paragraph. Put nothing after it.`;

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
    maxTokens: 8192,
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
    const shipped = SHIPPED_PRESETS.has(name);
    btn.disabled = !name || shipped;
    btn.title = shipped
        ? `'${name}' is read-only — use Save As to keep changes`
        : (name ? 'Overwrite the selected preset with the current system prompt' : 'Select a preset to overwrite');

    // Delete is blocked for shipped presets too (they'd re-seed on reload anyway).
    const del = document.getElementById('comfy-imagine-sp-preset-delete');
    if (del) {
        del.disabled = !name || shipped;
        del.title = shipped ? `'${name}' is built-in and can't be deleted` : (name ? 'Delete the selected preset' : 'Select a preset to delete');
    }
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
        // Shipped presets are extension-owned and rewritten with their shipped text
        // on every load, so a Save here would be silently wiped. Block it and steer
        // the user to Save As, which persists under their own name.
        if (SHIPPED_PRESETS.has(name)) {
            toast(`'${name}' can't be overwritten — use Save As to keep your changes.`, 'error');
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
        // Shipped presets are re-seeded on every load, so a delete here would just
        // reappear on reload — block it like Save, so they can't be removed.
        if (SHIPPED_PRESETS.has(name)) {
            toast(`'${name}' is built-in and can't be deleted.`, 'error');
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
    bind('comfy-imagine-max-tokens', 'maxTokens', v => Math.min(32768, Math.max(1, parseInt(v, 10) || 8192)));
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
    const message = data.choices?.[0]?.message ?? {};
    const content = message.content?.trim() ?? '';
    // Reasoning models split their thinking out: inline as a <think> block in
    // content, or a separate field (reasoning_content on DeepSeek, reasoning on
    // OpenRouter/others). Capture whichever exists so the debug modal can show it.
    const reasoning = (message.reasoning_content ?? message.reasoning ?? '').trim();
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
    // Split any tagged/inline reasoning out of the content, then fold in the
    // separate-field reasoning (DeepSeek/OpenRouter). Prompt is what's clean.
    const { prompt, reasoning: inlineReasoning } = separateReasoning(content);
    const combinedReasoning = [reasoning, inlineReasoning].filter(Boolean).join('\n');
    if (!prompt) {
        throw new Error(`LLM returned only reasoning, no prompt — it likely ran out of tokens mid-thought. Raise Max Tokens (currently ${s.maxTokens}).`);
    }
    return { content: prompt, reasoning: combinedReasoning };
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

// ST's /api/files/upload rejects any '/' (validateAssetFileName: ^[A-Za-z0-9_.-]+$),
// so debug sidecars can't live in a per-character SUBfolder like images do. Next
// best: fold the (sanitised) character name into the filename so one character's
// sidecars sort together in the flat user/files/ dir. isOwnDebugPath's
// imagine_debug_[^/]+\.json gate still matches.
function debugFileName(chName, tag) {
    const safe = String(chName || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'comfy';
    return `imagine_debug_${safe}_${Date.now()}_${tag}.json`;
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

    // Embedded base64 image in a mes-like string -> uploaded file. Returns the
    // rewritten "![...](path)" string, or null when there's no data: URL to convert.
    // Throws on upload failure so callers can count it as a skip.
    const externaliseImage = async (mesText, tag) => {
        const m = /!\[[^\]]*\]\((data:image\/[^)]+)\)/.exec(mesText || '');
        if (!m) return null;
        const { format, rawB64 } = splitDataUrl(m[1]);
        const path = await uploadImageToST(rawB64, format, chName, `imagine_migrated_${Date.now()}_${tag}`);
        knownImaginePaths.add(path);
        return { path, mes: `![generated image](${path})` };
    };

    // Inline debug info on an extra-like object -> file. Mutates the object
    // (adds debugPath, drops debugContext/debugPrompt). Returns true if it did
    // anything. Throws on upload failure so callers can count it as a skip.
    const externaliseDebug = async (extra, tag) => {
        if (!extra || extra.debugPath || (extra.debugContext === undefined && extra.debugPrompt === undefined)) return false;
        const debugJson = JSON.stringify({ context: extra.debugContext ?? '', prompt: extra.debugPrompt ?? '' });
        const dpath = await uploadDebugToST(debugFileName(chName, `migrated_${tag}`), debugJson);
        extra.debugPath = dpath;
        delete extra.debugContext;
        delete extra.debugPrompt;
        knownImaginePaths.add(dpath);
        return true;
    };

    for (let idx = 0; idx < chat.length; idx++) {
        const msg = chat[idx];
        if (msg?.extra?.title !== 'comfy-imagine') continue;

        // 1. Embedded base64 image -> file, in the live mes AND every swipe copy.
        //    ST keeps mes in sync with swipes[swipe_id], but rewriting mes does
        //    NOT touch swipes[] — the base64 copies there are what keep bloating
        //    the .jsonl after an old-style migration. Skipped when already a path.
        let mesResult = null;
        try {
            mesResult = await externaliseImage(msg.mes, `${idx}`);
            if (mesResult) { msg.mes = mesResult.mes; msg.extra.imaginePath ??= mesResult.path; imgMigrated++; imageRendered = true; }
        } catch { imgSkipped++; }              // leave base64 untouched
        if (Array.isArray(msg.swipes)) {
            for (let si = 0; si < msg.swipes.length; si++) {
                // The active swipe is a copy of mes; reuse its result instead of
                // re-uploading the identical base64 as a second on-disk file.
                if (si === msg.swipe_id && mesResult) { msg.swipes[si] = mesResult.mes; continue; }
                try {
                    const r = await externaliseImage(msg.swipes[si], `${idx}_s${si}`);
                    if (r) { msg.swipes[si] = r.mes; imgMigrated++; imageRendered = true; }
                } catch { imgSkipped++; }
            }
        }

        // 2. Inline debug info -> file. Only ever written to the top-level extra
        //    (never per-swipe), so swipe_info is not walked. Skipped when already
        //    externalised or absent.
        try { if (await externaliseDebug(msg.extra, `${idx}`)) dbgMigrated++; }
        catch { dbgSkipped++; }
    }

    if (imgMigrated || dbgMigrated) {
        await saveChat();
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
    let rawReasoning = '';
    if (msg.extra?.debugPath) {
        try {
            const r = await fetch(msg.extra.debugPath, { headers: getRequestHeaders() });
            if (r.ok) {
                const d = JSON.parse(await r.text());
                rawContext = d.context;
                rawPrompt = d.prompt;
                rawReasoning = d.reasoning ?? '';
            }
        } catch { /* fall back to inline / placeholder below */ }
    }
    // Generation timing: this image's own phase times (from extra) + GLOBAL last-10
    // averages read from the rolling logs in extensionSettings. Global (not per-chat)
    // so they hold across character/chat switches, where the loaded chat only ever
    // contains its own messages.
    const gs = getSettings();
    const secs = ms => (ms / 1000).toFixed(1);
    const avg10 = log => { const a = (log ?? []).slice(-10); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; };
    const thisMs = msg.extra?.elapsedMs;
    const timing = typeof thisMs === 'number'
        ? `This image — total ${secs(thisMs)}s`
            + (typeof msg.extra?.llmMs === 'number' ? ` &nbsp;(LLM ${secs(msg.extra.llmMs)}s · ComfyUI ${secs(msg.extra.comfyMs)}s)` : '')
            + `<br>Global last-10 avg — total ${secs(avg10(gs.genTimes))}s · LLM ${secs(avg10(gs.llmTimes))}s · ComfyUI ${secs(avg10(gs.comfyTimes))}s`
        : 'Not recorded (generate a new image with /imagine to capture timing)';

    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const sys = esc(getSettings().systemPrompt ?? '');
    const ctx = esc(rawContext ?? '(not stored — regenerate with /imagine to capture)');
    const prompt = esc(rawPrompt ?? '(not stored)');
    const reasoning = esc(rawReasoning ?? '');
    const html = `<div style="display:flex;flex-direction:column;gap:12px;min-width:min(600px,80vw)">
        <div style="font-size:0.9em;opacity:0.85">⏱ ${timing}</div>
        <div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">System Prompt</label>
            <textarea readonly rows="6" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${sys}</textarea>
        </div>
        <div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">User Message (character + persona + chat log)</label>
            <textarea readonly rows="12" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${ctx}</textarea>
        </div>
        ${reasoning ? `<div>
            <label style="font-weight:bold;display:block;margin-bottom:4px">Model Reasoning (&lt;think&gt;)</label>
            <textarea readonly rows="8" style="width:100%;resize:vertical;font-family:monospace;font-size:0.82em;box-sizing:border-box">${reasoning}</textarea>
        </div>` : ''}
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

    try {

    isGenerating = true;

    const chatIdAtStart = SillyTavern.getContext().getCurrentChatId();

    // Per-message path: hold the target by object identity so concurrent
    // inserts/deletes can't shift the index out from under us.
    const targetMsg = targetIndex != null ? SillyTavern.getContext().chat[targetIndex] : null;
    const isMidChat = targetMsg != null;
    let insertedCount = 0;

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
        knownImaginePaths.add(path);
        if (debugPath) knownImaginePaths.add(debugPath);
    }

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

    return '';
}

// ── Initialisation ──────────────────────────────────────────────────────────

// ST update hook (wired via manifest.json "hooks".update). ST calls this right
// after the USER manually updates the extension — the moment new files land on
// disk — then only toasts "reload to apply" without reloading. We reload here so
// the new build (and its force-synced preset/prompt) takes effect immediately.
// Updates stay fully manual: this fires only in response to the user clicking
// Update, and never triggers an update itself.
export function onExtensionUpdate() {
    location.reload();
}

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
    // Legacy rename cleanup: the default preset used to be 'Krea 2 Turbo (default)'.
    // It was read-only/force-synced, so a copy under the old name is the old shipped
    // default (not user work) — drop it so the dropdown doesn't show a stale twin.
    delete settings.systemPromptPresets['Krea 2 Turbo (default)'];
    settings.systemPromptPresets[DEFAULT_PRESET_NAME] = DEFAULT_SYSTEM_PROMPT;
    settings.systemPromptPresets[ALT_PRESET_NAME] = ALT_SYSTEM_PROMPT;

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
