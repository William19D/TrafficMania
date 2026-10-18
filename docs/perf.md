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
