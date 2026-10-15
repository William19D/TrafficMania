# TrafficMania HUD design spec

Goal: a HUD you can read at a glance for a traffic-management city game. It uses icons with numbers and one accent colour, explains each control where it sits, and keeps the map centre clear.
Scope: `src/ui/HUD.ts` (chips, dock, panels, toasts, modals), `src/ui/Menu.ts` (main and pause menus), `src/ui/Tutorial.ts`, `src/ui/Input.ts`, `src/style.css`, and the hover hooks in `CanvasRenderer`. The game model behind it is in [`design/gameplay.md`](design/gameplay.md).
No dependencies. Icons are inline SVG strings in `src/ui/icons.ts` (24x24 viewBox, `stroke="currentColor"`, stroke width 2, round caps).

## 1. Layout regions (reference 1280x800 and up)

```
+------------------------------------------------------------------------------------+
| [A money · people · happy · Lv · danger]  [B speed | trips | clock]  [C views ≡] [?] |
|                                                                [G panel column]    |
|                          (map centre: no HUD)                                      |
| [H tray]                                                                           |
| [H legend]                    [E toasts]                      [F tutorial card]    |
|  [D Road Grid | type | elevation | Light Roundabout Interchange | Buildings | Edit Demolish] |
+------------------------------------------------------------------------------------+
```

| Region | Anchor | Notes |
|---|---|---|
| A Resources | top-left | chips that wrap into rows before they reach B |
| B Status | top-centre (left column under A below 1280px) | speed, trips today, clock |
| C Views + Help | top-right | overlay and panel buttons and Menu (`.views`), then Help `?` |
| D Tool dock | bottom-centre | primary interaction |
| E Toasts | bottom-centre above the dock | `pointer-events: none`, never cover the dock |
| F Tutorial | bottom-right above the dock | moves left of G while a panel is open |
| G Panel column | right, under C | junction, interchange, car, building, trip reports, metrics; it scrolls |
| H Left column | bottom-left above the dock | building tray, then the map legend |
| Modals | full-screen scrim, box centred | level up / city complete, game over |
| Menu | its own `#menu` root above `#hud` | main menu, pause menu; `#hud` goes `inert` while it is open |

Scaling: `#hud { font-size: clamp(13px, .75vw + 4px, 16px) }`. Everything is sized in `em`, and flex containers use `gap`. Every region keeps at least 12px from the edges (safe-area aware).

## 2. Element inventory

### A. Resources
- **Money** `[money] $24,310 +$310/day`: whole dollars (`$1.2M` from 1e6, `∞` in creative).
  - The net per day is taxes at today's rate plus yesterday's business income, minus upkeep.
  - Below zero the chip reads in the danger colour.
  - Tooltip: the ledger for yesterday and today (taxes, business, upkeep, building, grants) and the bankruptcy rule.
  - A change flashes the chip for 200ms with a `+n` / `−n` label.
- **People** `[people] 1,240 / 1,400`: the population and the next milestone, with a thin progress bar.
- **Happiness** `[smile] 72%`: the icon is a smile at 60+, neutral at 30-60 and a frown under 30, so shape is the second cue next to colour. Tooltip: the weighted parts (jobs, shops, trips, pollution, noise) and the fail rule.
- **Level** `[star] Lv 5`: the tooltip lists the next two levels' unlocks. It bumps on a level-up.
- **Danger chips**:
  - `3 buildings without a road`: a click jumps the camera to the next one.
  - `Debt: 2 days to bankruptcy` / `Unhappy: 1 day left`.

### B. Status
- **Speed**: a segmented control, `Pause [Space]`, `1x`, `2x`, `4x`. Each button has an icon and a text label, and the active one is `aria-pressed`. While paused the panel gets a dashed outline and the clock reads "Paused".
- **Trips** `[car] 312 · 86% smooth`: today's arrivals and their smooth share. Tooltip: every outcome and the all-time arrivals.
- **Clock** `Day 4 · 08:20` in 10-minute steps, with one compact day bar (4.5em, 3.5em on phones).
  - Rush hours (7-10, 16-20) are tinted bands on the track.
  - The elapsed day fills from the left in the same 10-minute steps, and an accent tick marks now.

### C. Views, Menu, Help
- **Views**:
  - Heat map and Noise / pollution: toggles, `aria-pressed`. `C` cycles none -> heat -> noise.
  - Trip reports `T` and Metrics `M`: open their panels in G.
  - Menu: opens the pause menu (`Esc` does too when nothing else takes it).
- **Help `?`** (or `H`): the controls popover, with every row of `CONTROLS` and a "Replay tutorial" button. It closes with `×`, `Esc` or a click outside. Focus moves in and returns to the button.

### D. Tool dock
Order, left to right. Number keys follow the dock order. Buildings is `B`.

| Group | Contents | Key |
|---|---|---|
| Build | Road, Grid | `1`, `2` |
| Type | tier swatches (dirt, street, avenue, boulevard, highway), the tier name and km/h, lanes 1/2/3, One-way, Flip (only for a selected one-way run) | |
| Elevation | `−` pictogram `Ground` / `L3` `+` (Grid swaps it for the block size 3/4/6) | `PageDown` / `PageUp` |
| Junctions | Light, Roundabout, Interchange | `3`, `4`, `5` |
| City | Buildings, with a badge of unplaced buildings that pulses when a batch arrives | `B` |
| Change | Edit, Demolish | `6`, `7` |

- Button: icon above a label, the key badge top-left, `aria-pressed` for the active tool plus a 3px underline. Demolish uses danger instead of accent.
- **Locks.** A locked tool (Grid, Roundabout, Interchange), tier, One-way or the next viaduct level:
  - is `aria-disabled` and faded, with a lock icon in the corner;
  - stays clickable, so the game toasts `Unlocks at level N: <feature>`;
  - prefixes its tooltip with the same text.
  The locks lift on the level-up that unlocks them.
- **Type picker.** It sets the type of new roads. With Edit and a selected run, it shows and retypes that run, and the tooltips give the cost or refund of each change. It is dimmed outside Road, Grid and Edit.
- **Elevation stepper.** It is dimmed outside Road and Demolish. Its hint line gives the price multiplier for viaducts L1-5 and "clears mountains" from L6.

### E. Toasts
- At most 2. A duplicate restarts its timer with a `x2` count, and each auto-hides after 2.5s.
- Errors (matched by `ERROR_RE`) get a warning icon and a danger border. Everything else gets a check.
- `FRIENDLY` rewrites the terse game messages to say what to do. For example, `Not enough money` becomes "Not enough money: wait for income or demolish a road built today for a full refund".

### F. Tutorial card
- Step counter `3 / 9` with a progress bar, a title, the task line, and the body text.
- `Skip` is on the left and `Next` / `Finish` is the primary button on the right.
- While the task is not done, Next is disabled and reads "Do it to continue". The task line gets a success check once the task is done.
- Each step can pulse HUD controls (`hint`, a CSS selector list) and put target rings on the map (`tutorialTargets`).
- Enter = Next while the card has focus. Esc never skips.
- Steps:
  1. Welcome.
  2. Connect the homes to the office.
  3. Watch the first commute (4x).
  4. Place a home from the tray.
  5. Connect the shop to the middle of a road (trip reports `T`).
  6. Add a traffic light (`3`).
  7. Edit (`6`) the light and give a phase more seconds. The tutorial lifts the level-4 lock on the phase editor.
  8. Turn on the heat map (`C`).
  9. Money and levels.
- `done` predicates are pure reads of the game. `simcheck` checks this and plays them through on a scripted town.

### G. Panel column (`.rcol`, newest state, scrolls when full)
- **Junction** (Edit click on a junction):
  - control picker: None, Yield, Stop, Light, Roundabout, each with its price or refund;
  - Signals / Turn bans toggle;
  - arm diagram with L/S/R turn buttons that you can reach from the keyboard;
  - phase rows (select, `−`/`+` seconds, remove), Add phase, and presets.
  The phase editor and turn bans are locked below level 4.
- **Interchange** (Interchange tool on a junction): Diamond / Cloverleaf / Trumpet, the reason or the net price, Build / Cancel.
- **Car** (Edit click on a car): trip, from -> to, kind, time so far vs on empty roads, speed in km/h, stopped and the longest stop. The camera follows the car, and the route is drawn dashed.
- **Building** (Edit click on a building):
  - a home shows residents, happiness and its five parts as bars, and commuters with a job;
  - a workplace shows jobs, staffed share and goods;
  - both list their last 5 trips.
- **Trip reports** `T`: today's outcome counts, then the last 30 reports in the resident's voice. A click jumps the camera to the trip's longest stop.
- **Metrics** `M`: sparklines with now and the range, for waiting cars, average trip, trips per hour, failed trips per hour, money (not in creative), population and happiness.

### H. Left column
- **Tray** "To place": one card per zone with buildings left (`[swatch] Home ×6`). A click picks the zone up for the Buildings tool.
- **Legend**: the car colours by trip purpose, or the active overlay's key.

### Modals
- **Level up**: `Level 4!` (or `City complete!` at level 10). It shows the new buildings, the unlocks and the grant. The game pauses, and Continue / Enter resumes the previous speed.
- **Game over**: `Bankrupt` / `The residents left`. It shows the reason, days, level, population, trips, smooth share and money, with Main menu and Play again (Enter, focused).
- While a modal is open, every other HUD region is `inert` and no key reaches the tools.

### Menu (`#menu`)
- **Main**:
  - Continue (the autosave, with day, residents and level);
  - New game (mode, difficulty with its money / tax / upkeep line, biome, size, and a seed with a dice button);
  - Load (autosave + 3 slots);
  - Controls.
- **Pause**: Resume (Esc), Save (3 slots), Load, Controls, Quit to menu, and the seed with a copy button.

## 3. Visual language

Tokens (`:root`):
```
--land #ECEAE4  --panel #FFFFFF  --line #D8D6D0  --soft #F4F3EF
--ink #2B2B2B   --muted #6B6B68
--accent #2F6FED  --accent-soft #E6EEFD
--success #2E9E5B --danger #E5484D --danger-soft #FDECEC --warning #E0A100
--radius 12px  --shadow 0 2px 8px rgba(0,0,0,.08)  --ease cubic-bezier(.2,.7,.3,1)
```
- **Colour roles.**
  - The accent marks selection, primary buttons and tutorial hints.
  - Danger marks Demolish, errors, debt and game over.
  - Warning marks the level star and long-wait reports.
- **Contrast.** Text on white is at least 4.5:1, so positive and negative numbers use darker greens and reds (`#1B6E3D`, `#B42F34`). `--warning` is never used as text.
- **Type.** system-ui, 13px minimum, weights 500/600/700, and `tabular-nums` on every number. The only text under 13px is the hint lines that repeat a pictogram.
- **Shape.** Panels have a white background, a 1px line border, a 12px radius and a soft shadow. Anything over the map sits on a panel.
- **Second cues.** No state relies on colour alone: there is always an icon, a lock, `aria-pressed`, a dashed outline or label text as well.
- **Focus.** `:focus-visible` gets a 3px accent outline.
- **Motion.** Transitions are 200ms or less. `prefers-reduced-motion` removes pulses and slides and keeps opacity fades.

## 4. Interaction details

- **Tooltips.** One shared `.tip` element. It shows 300ms after hover or at once on keyboard focus, takes its text from `data-tip`, and renders the shortcut in `data-key` as `<kbd>`. It sits above dock and tutorial controls and below the rest, clamped to the viewport. On touch, a 500ms long-press on a dock button shows its tooltip for 2.5s.
- **Keys** (`CONTROLS` in `HUD.ts` is the single table, shown by the help popover and the menu's Controls):
  - Tools: `1`-`7` in dock order, and `B` for Buildings.
  - `R` turns a free-standing building ghost.
  - `PageUp` / `PageDown` (`+` / `-`) change the elevation.
  - `C` cycles the overlay, and `T` / `M` open the trip reports and the metrics.
  - `Space` pauses.
  - `Esc` cancels a road, bend or grid. Otherwise it closes the selection, panel or Place tool. With nothing left to close, it opens the pause menu.
  - `?` opens help.
- **Modals capture keys.** The HUD's keydown runs in the capture phase, so modal keys never reach Input. The menu's capture listener is registered first and swallows every key while it is open.
- **Canvas cursor.** It is set from `body[data-tool]`: road and grid use crosshair, light, roundabout, edit and interchange use pointer, demolish uses cell, and place uses copy.
- **On-map feedback** (the renderer draws it, with no DOM work):
  - road previews with the price or the reason;
  - Demolish hover with the refund;
  - control hover rings;
  - the Place ghost with its validity, driveway and pollution ring;
  - the Edit hover naming the car or building it would pick;
  - tutorial target rings;
  - off-screen markers toward buildings without a road.
- **DOM discipline.** `update()` keeps the last values and writes the DOM only when something changed. The panels re-render on a change key, and the trip feed at most twice a second.

## 5. Responsive

- **Below 1440px**: the tier caption hides and the tools pack tighter.
- **Below 1340px**: the elevation hint hides.
- **Below 1280px**: A and B stack in one top-left column (`.topl`), so a wrapped resources row pushes the status bar down instead of under it.
- **Phones (768px and below)**:
  - Chips are icons and numbers only. The milestone and the legend hide.
  - The clock shows `D4 · 08:20` and its day bar shrinks to 3.5em; on narrow phones the clock wraps under the speed buttons.
  - The views stack under Help, and the panel column sits beside them.
  - The dock spans the width and scrolls sideways with scroll-snap. Buttons are 56px and the key badges hide.
  - Toasts span the width.
  - The tutorial card spans the width above the dock (max 40vh, scrolls). While it shows, the left column hides (the dock's Buildings button still opens the tray), the panel column stops above it, and toasts move under the status bar.

## 6. Verification checklist
- [ ] At 1280x800 and 390x844 nothing overlaps: A/B, C/G, D/F/E/H. The map centre stays clear.
- [ ] Every dock button shows an icon, a label and its key badge (`1`-`7`, `B`), in dock order. Pressing each key selects that tool.
- [ ] At level 1 in career, Grid, Roundabout, Interchange, avenue and up, One-way and viaducts show a lock. A click toasts `Unlocks at level N: …`, and the lock lifts at that level.
- [ ] The money chip flashes on spends and gains, goes red in debt, and its tooltip has both days' ledgers.
- [ ] The clock advances in 10-minute steps, the paused state shows, and Space toggles it.
- [ ] Error toasts show a warning icon and a "what to do" text. At most 2 show, and duplicates merge.
- [ ] The junction panel edits phases and bans. The focus survives the re-render on each phase change.
- [ ] The tutorial runs start to end on a new career map: each step waits for its task, hints pulse, and targets ring the right spot.
- [ ] The level-up modal pauses and resumes, and Enter continues. The game-over modal focuses Play again.
- [ ] The help popover lists every shortcut and can replay the tutorial.
- [ ] Tab reaches every control with a visible focus outline.
- [ ] With `prefers-reduced-motion`, nothing pulses or slides.
