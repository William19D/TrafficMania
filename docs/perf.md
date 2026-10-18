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
