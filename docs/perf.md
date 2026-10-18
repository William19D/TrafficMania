# Performance

Target: a steady 60 fps on an Intel UHD integrated GPU at 1920x1080 with a big city (~200 buildings, ~500 road edges, ~300 cars), with no slowdown at 4x.

## Benchmark

`npm run bench` (`scripts/bench.mjs`, plain Node, no dependencies; `-- --secs N` changes the scenario length, default 8):

1. Reuses this project's dev server on :5173, or starts Vite on a free port.
2. Launches headless Chrome (`--headless=new`, own temp profile, GPU on) and prints the WebGL renderer string. A SwiftShader/software string means the numbers are not the real GPU.
3. Loads `/?seed=bench` at 1920x1080 (dpr 1), restores `scripts/fixtures/bench-city.json` (194 buildings, 511 edges, 481 nodes) with `Save.restore`, seeds the rng and pre-rolls 45 game seconds at the 1/60 s step. Saves hold no cars, so the pre-roll fills the roads: 344 cars, the same every run.
4. Wraps `game.update`, `renderer.render` and `hud.update` with timers and counts `requestAnimationFrame` ticks.
5. Scenarios, each after 1 s of settling, with a CDP Profiler sample (200 us):
   - paused draw-only, whole city (runs first, on the pre-roll's state, so it is the same every run)
   - 1x whole city, 4x whole city, 4x zoomed in 3x (these run in real time, so the city moves on: car counts drift by a few percent)
6. Census of one paused frame, averaged over 30 frames: `drawImage`, `fill`, `stroke`, `fillRect`, `fillText` calls inside `renderer.render`, and megapixels blitted (`drawImage` destination area times the transform scale, unclipped; `srcMpx` is the source area).
7. Prints the table and the top self-time functions per scenario, writes `bench-results.json` (gitignored), kills Chrome and any Vite it started.

Columns: `fps` real frame rate, `worst` longest frame gap in ms, `sim`/`draw`/`hud` ms per frame spent in `game.update` (all substeps), `renderer.render`, `hud.update`.

## Baseline (before the optimization round)

Laptop GPU `ANGLE (Intel, Intel(R) UHD Graphics (0x000046A3) Direct3D11)`, commit c0fb33c, median of 3 runs (range in brackets):

| scenario | fps | worst ms | sim ms | draw ms | hud ms | cars |
|---|---|---|---|---|---|---|
| 1x whole city | 20.8 (20.7-21.3) | 63 | 6.5 | 10.8 | 0.51 | 317 |
| 4x whole city | 21.3 (20.9-22.0) | 97 | 22.4 | 10.6 | 0.94 | 350 |
| 4x zoom 3x | 26.5 (17.8-26.6) | 672 | 18.2 | 12.3 | 0.89 | 450 |
| paused draw-only | 21.3 (21.0-21.3) | 111 | 0 | 11.5 | 0.10 | 345 |

Paused frame census: 888 drawImage, 1487 fill, 1217 stroke, 1010 fillRect, 39 fillText; 4.3 Mpx blitted (6.9 Mpx of source).

Reading it: paused, the main thread is ~65% idle yet the frame rate is 21, so drawing is GPU-bound (thousands of small draws plus large layer blits), not JS-bound. At 4x the sim adds ~22 ms per frame; its top self time is `Car.update` (13%), `RoadGraph.update` (7%), `approachOf` (4%), `findPath` (4%), `turn` (3%), `defaultPlan` (3%). The 4x zoom run has a single ~600 ms frame shortly after the zoom.

## P1: static art cached in layers

What a paused frame used to redraw every time now lives in offscreen layers over the view plus a quarter view of margin, at the half-power-of-2 zoom bucket the road layer already used (`CanvasRenderer.statics`):

- roads layer: the ground roads as before, now with the lane arrows and the signal poles. Key: `netKey`, which now also covers the junction plans' lane connections and legacy bans, plus the island decor.
- scene layer, the one blitted each frame: lots, then the roads layer, then every building (shadow, sprite, dashed no-road outline), then the static parts of the highway exits. Key: `sceneKey` over the lots and buildings (placement, model, abandoned, empty home, road access). It is repainted when either key changes.
- night layer: the lamp pools and lit windows, added up in one canvas and blitted with `lighter` at the night's strength. Repainted only when the scene changes and it is night.
- deck layers: one per elevated level, bounded to that level's own extent (the first one also holds every deck's ground shadow). Cleared with the roads.

Still drawn live each frame: cars, signal heads (a cached sprite per lamp state, so one drawImage), trip dots (one fill per purpose plus one stroke), smoke, pins, events, overlays, selection/hover, previews, juice and ambience. Pedestrians and birds are batched into a few paths. The vehicle sprites now include the tail lights (a dim and a braking variant) and the indicator, so cars need no per-frame `fillRect`.

A whole layer is repainted when it goes stale: about 3 ms when a building changes, and about 20 ms when a road change repaints the roads under it. That happens at most once per in-game hour for growth, and otherwise only on player edits or when the view pans out of the margin. Screenshots before and after at the same camera, with the clock frozen, differ only in edge antialiasing (0.3% of pixels by more than 24/255; day, zoom 3x, night, night zoom).

Same laptop GPU, median of 3 runs (range in brackets):

| scenario | fps before | fps after | draw ms before | draw ms after | sim ms after | worst ms after |
|---|---|---|---|---|---|---|
| 1x whole city | 20.8 | 76.0 (71.9-77.2) | 10.8 | 6.2 | 2.3 | 49 |
| 4x whole city | 21.3 | 59.7 (56.0-59.8) | 10.6 | 5.5 | 7.7 | 56 |
| 4x zoom 3x | 26.5 | 33.7 (32.6-35.8) | 12.3 | 8.6 | 15.1 | 554 |
| paused draw-only | 21.3 | 81.7 (81.1-82.8) | 11.5 | 6.7 | 0 | 97 |

Paused frame census: 748 drawImage (was 888), 87 fill (was 1487), 55 stroke (was 1217), 21 fillRect (was 1010), 27 fillText; 4.3 Mpx blitted. Fills plus strokes went from 2704 to 142.

Sim ms per frame dropped only because there are more frames per second; the sim's cost per game second is unchanged. The 4x zoom run is now sim-bound: `Car.update`, `RoadGraph.update`, `Junction.diff`, `turn` and `findPath` lead its profile. Its single ~550 ms frame right after the zoom is still there.

## P2: visible-rect blits, culling, far-zoom cars, sprite sheets

What changed (`CanvasRenderer`, `VehicleArt`, `Ambience`):

- Every large cached canvas (the terrain, the scene layer, its night glow, the deck layers) is blitted through `blit`, which draws only the source rect in view (in whole source px, so it lands where the full blit did). At the whole-city view the whole world is on screen, so this saves little there; at 3x zoom the blitted area dropped from 22.7 to 5.6 Mpx.
- Culling: cars whose road is out of view (45 px margin, room for a headlight beam) are skipped before `carPos`; trip dots, smoke, roof pins and signal heads are culled to the view. Cars are bucketed by deck level in one pass, with each node's level memoised for the frame (it used to be recomputed per car per level).
- Cars: placed with `setTransform` instead of save/translate/rotate/restore, with all shadows drawn first, then all bodies. Every vehicle model at one pixel scale lives on a shared atlas page (`VehicleArt.frame`), so consecutive draws batch on the GPU. At 0.8 px per world px or less, which includes the default whole-city view at 1080p, each car is drawn as a few flat `fillRect`s instead: shadow, body, glass, roof, the indicator while it blinks, and the VIP, ambulance and purpose extras (`farShapes`). Tail lights are dropped there because they are under a px.
- Pedestrians and trip dots are sprites off one small sheet each, drawn per item, where they used to be Path2D batches. On this GPU a path with hundreds of parts was the slow case: one fill of the 171 trip dots cost about 20 fps, the 140 pedestrians about 30 fps at 1.5x, and Path2D-batched far cars were slower than sprites.
- Boats and birds are skipped below 0.5 px per world px. Pedestrians were already zoom-gated.

Measured, not kept: flat-shape headlight beams at far zoom were no faster than the beam sprite, so beams stay sprites. Leaving out the terrain blit (one of the two screen-sized blits at the whole-city view) gained only about 4 fps, so the terrain was not merged into the scene layer. That merge would have needed the animated water (glints, boats) re-composited under bridges and shore roads.

Same laptop GPU. Both columns are measured in this session, median of 3 runs: before is commit ddcbdd9 (the P1 numbers above came from another session, and this laptop varies about 10% between sessions).

| scenario | fps before | fps after | draw ms before | draw ms after | sim ms after | worst ms after |
|---|---|---|---|---|---|---|
| 1x whole city | 68.6 | 107.1 (106.0-115.0) | 6.72 | 4.71 | 2.23 | 69 |
| 4x whole city | 53.4 | 73.5 (70.9-79.8) | 6.01 | 4.44 | 6.83 | 63 |
| 4x zoom 3x | 33.2 | 53.2 (50.5-55.3) | 8.64 | 4.22 | 10.30 | 563 |
| paused draw-only | 76.0 | 124.5 (122.4-130.4) | 7.42 | 5.20 | 0 | 118 |

Paused frame census (whole-city view): 229 drawImage (was 748), 84 fill, 54 stroke, 1656 fillRect (the far cars; was 21), 27 fillText; 4.22 Mpx blitted (was 4.34). At 3x zoom: 431 drawImage (was 743), 5.6 Mpx (was 22.7).

Screenshots before and after at the same camera, with the clock frozen, differ only where the far-zoom cars are (0.46% of pixels by more than 24/255 at the whole-city view). At 1.7x, at 3x and at night the difference (0.14-0.23%) is the same as between two runs of unchanged code (0.08-0.19%).

Known gaps:

- About 4.2 Mpx are blitted at the whole-city view, against a target of 2. With the whole world on screen, the terrain and the scene layer are each about one screen (1.75 and 1.94 Mpx), and cloud shadows add 0.36. Only merging the terrain into the scene would get under 2, and that merge measured as worth about 4 fps.
- The ~550 ms frame right after a zoom remains. It is `paintTerrain` (about 310 ms at any scale) plus the layer repaints. A terrain kept across zoom buckets or tiles would remove it.
- 4x at 3x zoom is now sim-bound: 10 ms of sim per frame against 4 ms of drawing.

## P3: graphics quality setting and Auto

Settings (renamed from Sound in the main and pause menus) has a Graphics row: Auto, High, Medium or Low. The choice is saved in `localStorage` (`tm_quality`), and `?quality=` overrides it for tests. `npm run bench` pins `?quality=high` (`--quality low|medium|auto` to change it) so Auto cannot move mid-run.

- High: everything, as before. The backing store is `devicePixelRatio` capped at 1.5 (`Quality.pxRatio`), so this only changes screens above 1.5x.
- Medium: full resolution, pedestrians capped at 60 (instead of 140), no birds.
- Low: the canvas backing store at 0.75 of that, CSS-scaled to the window. 30 pedestrians, no birds, no cloud shadows, and flat cars (`farCars`) at every zoom.
- Auto (`AutoQuality`, the default) counts frames over 2 s windows. Under 52 fps it steps down one level. It steps back up after `wait` windows in a row at 58 fps or more, and `wait` doubles on every step down (2, 4, 8 ... 64 windows), so a level that could not hold is not retried every few seconds. The window right after a change is ignored, and so is any window with a frame gap over 250 ms (a zoom repaint, a hidden tab). simcheck covers the steps.
- F3 toggles a small `fps · level` readout in the bottom-left corner.

Same laptop GPU, median of 3 runs. Before is commit d1af903, measured in this session; the medium column ignores one run in which the 4x zoom scenario stalled (sim 103 ms per frame).

| scenario | fps before | High | Medium | Low | draw ms before / Low |
|---|---|---|---|---|---|
| 1x whole city | 104.0 | 106.6 | 113.5 | 120.2 | 4.88 / 4.33 |
| 4x whole city | 70.1 | 75.2 | 76.1 | 81.6 | 4.38 / 3.99 |
| 4x zoom 3x | 52.8 | 54.9 | 58.4 | 65.4 | 4.36 / 3.57 |
| paused draw-only | 119.0 | 124.1 | 132.1 | 139.8 | 6.03 / 4.88 |

High runs the same code as before at 1x DPR, and its census is identical (229 drawImage, 4.22 Mpx blitted), so the High column is the same as before within run-to-run noise. Low census: 223 drawImage, 63 fill, 38 stroke, 2.17 Mpx blitted (was 4.22).

Known gaps:

- Low gains about 15-25%. That is not a 2x: at 4x the sim is now the larger part of the frame (6-8 ms against 4 ms of drawing).
- A display or browser capped under 60 Hz (30 Hz battery saver) reads as slow, so Auto ends on Low there.
- Auto starts at High each session, so a slow machine spends its first ~6 s stepping down. Saving the last Auto level would skip that.
- On Low, text drawn on the canvas (labels, offscreen markers) is a little soft from the 0.75 upscale.

## P4: simulation hot paths

`npm run simbench` (`scripts/simbench.ts`) times the sim alone in Node: it restores the bench city, pre-rolls 45 game seconds like `npm run bench`, then runs 60 more at the 1/60 s step. It prints ms per step, ms per 4x frame (4 steps) and a fingerprint of the final state (score, car count, a sum over car positions and speeds). For a pure optimization the fingerprint must not change. It is `score=27476 cars=449 ... sum=38216.90515950716` both before and after this step, and simcheck's whole output is identical too.

What changed (no gameplay change):

- `Junction.planOf`: the default plan was rebuilt on every call (atan2 per arm, a sort, the phase arrays), several times per light or sign junction per tick. It is now cached per node and rebuilt when the node's roads change: `addEdge` pushes onto `n.edges` and `unlink` replaces the array, so the cache is keyed by that array and its length. Node positions never change, and plan edits always replace the plan object.
- `Junction.approachOf` (the `diff` calls in the old profile) is memoised per plan object and edge.
- `RoadGraph.lanesFrom` returns per-edge lane lists built with the lanes (`Edge.fwd` / `Edge.back`) instead of filtering a new array per call. `edgeBetween` is a plain loop that skips the hidden-set lookup when nothing is hidden. `drivewayJunction` counts instead of filtering. `speedX` skips the event map when it is empty.
- `RoadGraph.update`: each node's queue is compacted in place, and a node with no queue that is not a light is skipped before the plan, ambulance and closure setup. The ambulance lane set is only built when there is an ambulance, and the per-lane hold set is an array.
- `findPath`: g-scores and closed flags live in reused typed arrays stamped per search, and the heap uses parallel arrays with hole sifting, so a search no longer allocates a Map, a Set and a tuple per push. It does the same comparisons in the same order, so routes are unchanged.
- `Car.update` checks the cheap `arrows(lane) !== ANY` before `arrowLanes`, and `arrowLanes` returns before `edgeBetween` at nodes with no plan.

Not done: a route cache per destination. Cars recompute their route on every new edge with the live congestion, so reusing a route would change where they drive. The binary heap was already there.

simbench, the same machine: 1.42-1.49 ms per step before, 0.77 after (median of 5), so 5.7 ms per 4x frame becomes 3.1.

`npm run bench`, same laptop GPU, both columns measured in this session. Before is commit 81b5184, median of 3 runs. After is the median of 3 runs: a fourth run was left out because everything in it ran about 2x slower, drawing and HUD included, which points to CPU throttling rather than the sim.

| scenario | fps before | fps after | sim ms before | sim ms after | draw ms after | worst ms after |
|---|---|---|---|---|---|---|
| 1x whole city | 115.2 | 121.0 | 2.06 | 1.49 | 4.48 | 49 |
| 4x whole city | 79.7 | 104.8 | 6.14 | 3.28 | 3.88 | 76 |
| 4x zoom 3x | 56.2 | 80.9 | 9.64 | 4.66 | 4.16 | 447 |
| paused draw-only | 130.4 | 131.5 | 0 | 0 | 4.75 | 111 |

The 4x sim cost is now 3-5 ms per frame against a 15 ms target. The paused frame census is unchanged (229 drawImage, 4.22 Mpx blitted).

Known gaps:

- `Car.update`, `RoadGraph.update`, `findPath` and `turn` still lead the sim profile. What is left is mostly the per-car route search on each new edge and the junction logic's closures for nodes with a queue.
- The roughly 450 ms frame right after a zoom (the terrain repaint) is unchanged.
