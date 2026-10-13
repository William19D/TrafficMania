# TrafficMania HUD design spec

Goal: replace the black-and-white text pills with a HUD you can read at a glance. Use icons with numbers, one accent colour, and explain each control where it sits.
Scope: `src/ui/HUD.ts`, `src/ui/Tutorial.ts`, `src/ui/Input.ts`, `src/style.css`, plus small hover hooks in `CanvasRenderer`.
No new dependencies. Icons are inline SVG strings in one `src/ui/icons.ts` (`ICONS: Record<IconName, string>`, 24x24 viewBox, `stroke="currentColor"`, stroke-width 2, round caps).

Game state the HUD reads (no new game state except where noted):
`inventory {asphalt, bridges, tunnels, lights, roundabouts}`, `score`, `week`, `day`, `time`, `speed 0|1|2|4`, `tool`, `level 0..10`, `setLevel()`, `message`, `pendingReward`, `gameOver`, `applyReward(i)`, `tutorialActive`, `cities[].overcrowd 0..1`, `DAY_SECONDS = 15`.

## 1. Layout regions (reference 1920x1080)

```
+--------------------------------------------------------------------------+
| [A resources]           [B clock | trips | week dots]          [C ? help] |
|                                                                          |
|                         (map centre: no HUD)                             |
|                                                        [F tutorial card] |
|                          [E toasts, max 2]                               |
|           [D  Road  Light  Roundabout  |  Elevation  |  Demolish]        |
+--------------------------------------------------------------------------+
```

| Region | Anchor | Size at 1080p | Notes |
|---|---|---|---|
| A Resources | top-left, `top/left: max(12px, env(safe-area-inset-*))` | auto width, 48px tall | low visual weight; horizontal chips |
| B Status | top-centre, `left:50%; translateX(-50%)` | max 640px | the score is the most prominent number on screen |
| C Help | top-right | 48x48 button | opens the controls popover underneath it |
| D Tool dock | bottom-centre, `bottom: 16px` | auto width, 72px tall | primary interaction; replaces the left vertical toolbar |
| E Toasts | bottom-centre, `bottom: dock height + 28px` | max 480px | `pointer-events:none`; never covers the dock |
| F Tutorial | bottom-right, `right:16px; bottom: dock height + 28px` | width 360px | never covers the dock or toasts |
| Modal | full-screen scrim, box centred | max 560px | blocks input; the game is already paused by `pendingReward`/`gameOver` |

Scaling: `#hud { font-size: clamp(13px, 0.75vw + 4px, 16px); }`. Size everything in `em`/`rem`, never in absolute pixels. Use flex containers with `gap` and no fixed widths on labels, so text wraps or grows and never overflows. Keep at least 12px from every edge (safe-area aware).

## 2. Element inventory

Icon set (`IconName`): `road, curve, light, roundabout, demolish, elevation, asphalt, bridge, tunnel, car, pause, play, fast, faster, help, week, gift, close, check, warning`.

### A. Resources bar
One chip per resource, in this order: asphalt, bridges, tunnels. Each chip shows an icon and a number in tabular-nums 16px bold.
- Content: `[asphalt] 60`, `[bridge] 2`, `[tunnel] 1`. Lights and roundabouts show their stock on their tool buttons in the dock instead (one place per number).
- States: default (ink). Low (asphalt < 10, others = 1): `warning` dot plus a warning-coloured number. Zero: number `0`, muted gray, the icon gets a diagonal strikethrough (`.zero` class with a CSS `::after` line), and the chip border is dashed.
- Feedback: when a value changes, flash the chip for 200ms (green tint and `+n` on gain, red tint and `-n` on spend), then return to default.
- Tooltip: "Asphalt: 1 per road tile. Demolish refunds it." / "Bridges: 1 per water crossing or viaduct." / "Tunnels: 1 per ground road through a mountain."
- Danger chip (only while any `city.overcrowd > 0`): `[warning] Overcrowding 63%`, showing the highest overcrowd value, in danger colour. Tooltip: "A city has too many waiting cars. Connect it or add capacity before its ring fills."

### B. Status cluster (one panel, three groups separated by 1px dividers)
1. Clock: 4 icon buttons, 40x40, in a segmented control. `pause [Space]`, `play 1x`, `fast 2x`, `faster 4x`. The active button gets an accent fill with a white icon, and `aria-pressed="true"`. Each button has a small label under its icon (`II`, `1x`, `2x`, `4x`) so the speed is never shown by colour alone. When paused, the whole panel gets a 2px dashed muted outline and a "Paused" label replaces the day text.
2. Trips: `[car] 128`, 24px bold. On increment the number scales to 1.08 and back in 150ms (disabled under reduced motion). Tooltip: "Trips completed: cars that reached their destination."
3. Week: `Week 3`, then 7 day-dots, then a `gift` icon. Past days are filled ink, the current day is filled accent and grows within the day (`--p` from `(time % DAY_SECONDS) / DAY_SECONDS`, drawn as a conic fill), future days are hollow. Tooltip: "Day 4 of 7. At the end of the week you choose a reward."
- Keyboard: Space toggles pause (already in Input). Buttons are focusable and Enter/Space activates them.

### C. Help button and controls popover
- `help` icon button, 48x48. Shortcut `?` (or `H`). Tooltip "Controls [?]".
- Popover: a two-column table listing every control (section 4). Close it with the `close` button, Esc, or a click outside. Focus moves into the popover and returns to the button on close.
- Contains a "Replay tutorial" button (this replaces the old top-bar Tutorial button).

### D. Tool dock
Order: `Road`, `Traffic Light`, `Roundabout`, divider, Elevation stepper, divider, `Demolish`. Demolish sits at the far right, separated from the primary tools by the stepper.

| Button | Icon | Label | Key badge | Stock badge |
|---|---|---|---|---|
| Road | road | Road | 1 | none (asphalt is in A) |
| Traffic Light | light | Light | 2 | `inventory.lights` |
| Roundabout | roundabout | Roundabout | 3 | `inventory.roundabouts` |
| Demolish | demolish | Demolish | 4 | none |

- Button: 64x64 minimum (hit area at least 48), icon 24px above a 13px label, key badge in the top-left corner (11px on muted background, `aria-hidden`), stock badge as a top-right circle (13px bold).
- States:
  - default: panel background, ink icon.
  - hover/focus: soft background; tooltip after 300ms.
  - active (selected tool): accent background, white icon and label, 3px accent bar under the button, `aria-pressed="true"`. Demolish uses danger instead of accent when active.
  - zero stock (light/roundabout = 0): badge shows `0` in gray, icon muted with strikethrough, label stays legible, button stays clickable, and a click toasts the reason (see E).
  - hint (tutorial): 3px accent ring pulsing at 1.2s. Under reduced motion it is a static ring.
- Feedback: the stock badge updates right away when a control is placed or refunded. Switching tools changes the cursor (section 4).
- Tooltips (one line each with the shortcut):
  - Road: "Click start, click end. Drag the end to bend. Esc cancels. [1]"
  - Light: "Click an intersection (3+ roads). Uses 1 light. [2]"
  - Roundabout: "Click an intersection. Lets 3 cars through at once. Uses 1. [3]"
  - Demolish: "Click a road or a light/roundabout to remove it and get a refund. [4]"

Elevation stepper (inside the dock):
- `[-]  [pictogram]  label  [+]`. The buttons are 40x40 with `aria-label` "Lower road [PageDown]" / "Raise road [PageUp]".
- Label: `Ground` at level 0, otherwise `L3` (bold 16px), with a hint line under it (12px muted, the only text allowed below 13px because it repeats what the pictogram shows):
  - 0: "Ground · tunnels through mountains"
  - 1-5: "Viaduct · 1 bridge"
  - 6-10: "Viaduct · clears mountains"
- Pictogram: a 40x24 inline SVG with a deck line at `y = 20 - level*1.6` and two pillars down to `y = 22`. At level 0 the deck sits on the ground line and has no pillars. It is updated by setting attributes, not by rebuilding the SVG.
- Disabled: `-` at 0 and `+` at 10 get `disabled` (opacity 0.4, `cursor: not-allowed`).
- Feedback: a level change pulses the label for 150ms, and the road preview label already appends `· L3`.
- The stepper is disabled (dimmed, with the tooltip "Elevation applies to the Road tool") when the tool is not `road`, except that Demolish keeps using it, because `demolishAt` prefers the current level.

### E. Toasts
- Source: `game.message`. The HUD keeps a queue of at most 2 `{text, kind, until}` entries. A message identical to one already showing restarts its timer and gets a count suffix `x2` instead of stacking. Each auto-dismisses after 2.5s, newest at the bottom.
- Kind by text prefix:
  - error (`warning` icon, danger left border, light danger tint): `Not enough …`, `Too low …`, `Invalid terrain`, `Already exists`, `Place on an intersection`, `No … left`.
  - info (`check` icon, ink): everything else.
- Error text is rewritten to say what to do, through a small map in HUD.ts:
  - `Not enough asphalt` -> "Not enough asphalt: demolish a road or wait for the weekly reward"
  - `Not enough bridges` -> "Not enough bridges: lower the road to Ground (L0) or demolish a bridge"
  - `Not enough tunnels` -> "Not enough tunnels: raise the road to L6+ to pass over the mountain"
  - `Too low for the mountain` -> "Too low: raise to L6+ or use Ground (L0) to dig a tunnel"
  - `Invalid terrain` -> "Roads cannot start or end in water or on a mountain"
  - `Place on an intersection` -> "Click a junction where 3 or more roads meet"
  - `No traffic lights left` / `No roundabouts left` -> "... left: earn more in the weekly reward"
- `role="status"`, `aria-live="polite"`. Motion: fade/slide 8px in 150ms ease-out. Under reduced motion: opacity only.

### F. Tutorial card
- Card: step counter `3 / 12` with a thin progress bar, title 18px, body 14px with line-height 1.5, `[Skip]` (ghost button, left) and `[Next]` (primary accent button, right). The primary button is always on the right.
- While waiting for a `done` condition, Next is disabled and reads "Do it to continue", with a `check` icon that turns success-coloured once the condition is met.
- Inline key references like `[2]` render as `<kbd>` chips. Hints pulse the matching dock buttons, and steps 7-8 also hint the elevation stepper (`data-hint="elev"`).
- Keyboard: Enter activates Next while the card has focus. Esc does not skip (Esc is reserved for cancelling a road).

### Modals
Reward (when `pendingReward` is set):
- Title `[gift] Week 2 complete`, subtitle "Choose one upgrade".
- Two cards, each at least 200x160: the key badge `1`/`2` top-left, then one row per item with a 32px icon and `+25` (24px bold) and the noun ("asphalt", "bridge"). Cards are `button`s with `aria-pressed` for the selection.
- Interaction: pressing 1/2 or clicking selects a card (accent 3px border plus `check` icon). Enter or the `Confirm` primary button (bottom-right) calls `applyReward`. Double-click confirms directly. The first card has focus by default.
- Input.ts must ignore tool keys 1-4 while `pendingReward || gameOver` (the current `keydown` does not, so pressing 1 switches tool behind the modal).

Game over:
- `[warning] Overcrowded!` (danger icon and title), the name of the city that filled if it is available, and a stat grid: `[car] Trips 128`, `[week] Weeks 5`. The `Play again` primary button (bottom-right) has focus by default, and Enter activates it.

## 3. Visual language

Tokens (`:root`):
```
--land #ECEAE4  --panel #FFFFFF  --line #D8D6D0  --soft #F4F3EF
--ink #2B2B2B   --muted #6B6B68
--accent #2F6FED  --accent-soft #E6EEFD
--success #2E9E5B --danger #E5484D --danger-soft #FDECEC --warning #E0A100
--radius 12px  --shadow 0 2px 8px rgba(0,0,0,.08)  --ease cubic-bezier(.2,.7,.3,1)
```
- The map palette stays as it is. The accent is used only for the selection state and primary buttons; danger only for Demolish, errors and game over; warning only for low stock and overcrowding.
- Contrast: ink on panel 14:1, muted on panel 5.3:1 (minimum for secondary text), white on accent ~4.7:1, white on danger ~3.9:1 (so danger buttons use 16px bold+ or an ink label on danger-soft). `--warning` is never used as a text colour on white (2.1:1). Use it for icons/dots only, with ink text beside them.
- Type: system-ui. Scale 13 (labels, tooltips), 14 (body), 16 (numbers, levels), 18 (titles), 24 (score, reward quantities). Weights 500/600/700 only, never below 500. `font-variant-numeric: tabular-nums` on every number.
- Panels: panel bg, 1px line border, radius 12, shadow. Anything drawn over the map sits on a panel. Canvas labels keep their existing halo.
- Hit areas: interactive elements at least 40x40, with at least 8px gap between them.
- Never colour alone: every state change has a second cue (icon, strikethrough, dashed border, label text, `aria-pressed`).
- Focus: `:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }`, plus `--ink` outline on accent-filled buttons.
- Motion: transitions at most 200ms with `var(--ease)`, no bounce or shake. `@media (prefers-reduced-motion: reduce)` sets `animation: none; transition-duration: 0s` except opacity fades.

## 4. Interaction details

Tooltips: one shared `.tip` element, shown 300ms after `pointerenter` or immediately on `focus`, hidden on leave/blur/Esc. Text comes from `data-tip`, and the shortcut from `data-key` renders as `<kbd>`. Placement is above for the dock and below for the top bar, clamped to the viewport. Never shown on touch-only (`@media (hover: none)`).

Controls popover content:
| Action | Input |
|---|---|
| Road / Light / Roundabout / Demolish | 1 / 2 / 3 / 4 |
| Place road | click start, click end |
| Bend road | hold on the end point and drag |
| Cancel road | Esc or right-click |
| Raise / lower road | PageUp / PageDown or + / - |
| Pause / resume | Space |
| Zoom / pan | wheel / right- or middle-drag |
| Reward choice | 1 / 2, then Enter |
| Help | ? |

Canvas cursor (`canvas.style.cursor`, set only when the tool changes): road `crosshair`, light/roundabout `pointer` over a valid node, otherwise `not-allowed`, demolish `cell`, panning `grabbing`.

On-map hover feedback (Input tracks `hover: Vec | null` on pointermove and exposes it like `preview`; the renderer draws it, so no DOM work):
- Demolish: the edge from `graph.nearestEdge(hover, ROAD_W, level) ?? nearestEdge(hover, ROAD_W)` is redrawn with a 3px danger outline and a canvas label `Demolish · +7 asphalt` (+bridge/tunnel refund). A control node within `NODE_R + 4` gets a danger ring and `Remove light`.
- Light/Roundabout: the node within `NODE_R + 6`. Valid (`!city && edges.length >= 3`) shows a success ring and the label `Place light`. Invalid or none within reach shows a danger ring with `Needs 3+ roads` or, at zero stock, `No lights left`. Use the same checks as `placeControl`, extracted into `Game.controlTarget(p, kind): {node, reason}` so the message and the preview never disagree.
- Road: unchanged (preview with cost/reason label). An invalid preview label gets a `warning` glyph prefix and danger colour.

HUD update discipline: `update()` keeps the previous values (`last.score`, `last.inv`, `last.speed`, `last.tool`, `last.level`, `last.day`, `last.dayFrac` rounded to 1/20, `last.msg`, `last.danger` rounded to 5%) and writes the DOM only when something changed. It never sets `innerHTML` per frame. The modal is only built when `pendingReward` or `gameOver` changes (as now).

## 5. Responsive (max-width 768px)
- A: icons and numbers only, 40px chips. The danger chip collapses to icon and percentage.
- B: the clock keeps 4 buttons at 40px, the week dots shrink to 6px, and the "Week n" text becomes `W3`.
- D: full width minus 12px gutters, `overflow-x: auto; scroll-snap-type: x mandatory`. Buttons are 56x56 with the key badges hidden (no keyboard assumed) and labels at 12px are allowed because the icon carries the meaning. The elevation hint line is hidden and the label stays.
- E: toasts are full width minus 24px, above the dock.
- F: the tutorial card is full width minus 24px, sits above the dock, and has a max-height of 40vh with internal scroll.
- `@media (hover: none)`: no tooltips. A long-press of 500ms on a dock button shows its tooltip for 2.5s.

## 6. Verification checklist
- [ ] Map centre (middle 50% of the viewport) has no HUD element at 1920x1080 and at 390x844.
- [ ] Every dock button shows an icon, a label and a key badge. The selected tool is identifiable in grayscale (`aria-pressed`, underline bar).
- [ ] Light/roundabout stock badges decrement on placement and increment on demolish. At 0 they show `0`, gray, and a strikethrough icon.
- [ ] The elevation stepper shows `Ground`/`L1`..`L10`, the pillars grow, the hint text changes at 1 and 6, and -/+ disable at 0/10.
- [ ] Each clock button has an icon and a speed label. The active one is visible without colour. Space toggles pause, and the paused state is shown.
- [ ] Day-dots advance during a week, the current one fills smoothly, and the gift icon sits at the end.
- [ ] Each error message produces an error toast with an icon and a "what to do" text. At most 2 toasts show, duplicates merge, and they auto-hide after 2.5s.
- [ ] Hovering a road with Demolish highlights it red with a refund label. Light/Roundabout hover shows a green valid or red invalid ring with a reason.
- [ ] The canvas cursor changes per tool.
- [ ] Reward modal: 1/2 select, Enter confirms. Pressing 1-4 while it is open does not change the tool.
- [ ] Game-over modal shows trips and weeks. Play again has focus and Enter restarts.
- [ ] Help popover lists every shortcut, opens with `?`, closes with Esc, and can replay the tutorial.
- [ ] Tab reaches every control with a visible focus outline. All hit areas are at least 40px.
- [ ] Text is 13px or larger (except the elevation hint), and the contrast of all text tokens is at least 4.5:1 (checked with devtools).
- [ ] With `prefers-reduced-motion`, nothing pulses or slides, and transitions are 200ms or less otherwise.
- [ ] Performance panel: no DOM mutations on frames where the game state did not change.

## 7. Road types and the Edit tool
- Dock: Road, Light, Roundabout | lane picker (1/2/3 lanes per direction, One-way, Flip) | elevation | Edit, Demolish.
- The picker sets the type of new roads; with the Edit tool (5) and a selected run it shows and changes that run's type (tooltips show the asphalt cost/refund). Flip only shows for a selected one-way run. It is dimmed outside Road and Edit.
- Edit: hover highlights the run (accent), click selects it (accent halo), drag bends it from its first to its last node; the label shows the net asphalt. Esc or switching tool clears the selection.
- Canvas: road width = lanes x 9 px (x2 when two-way). Two-way keeps the yellow centre line; same-direction lanes get dashed gray separators; one-way roads get gray chevrons instead of the yellow line.
