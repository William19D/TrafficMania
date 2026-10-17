# TrafficMania game-v3 design spec: from sandbox to a game

Round plan: `feat/game-v3`, steps F1 (ring roundabouts and overlaps), F2 (flat HUD), G1 (zones and demand), G2 (tiers and specials), G3 (campaign, modes, profile), G4 (achievements, milestone choices), G5 (events), G6 (onboarding), G7 (relax and juice).
Base: [`gameplay.md`](gameplay.md) and [`../hud-design.md`](../hud-design.md). This file replaces their tray, level batches, career fail and tutorial parts. Everything else in them stands.
Rules: the code wins for what exists, this spec wins for what is new. A step that deviates writes the change back here. Every number lives in `config.ts` (or `Campaign.ts` for map data), never inline.

Product goals:
- **Traffic first.** The only buildings are the ones traffic needs: four zones, their tiers and four specials. No parks or services.
- **A reason to build:** demand calls for lots, and lots grow only where traffic works.
- **Relaxing and clear for newcomers:** one drag paints a street of lots, failure is soft, and tips arrive when they are needed.
- **No luck in rewards.** Lights must stay useful next to roundabouts.

---

## 1. Ring roundabouts (F1)

A roundabout is no longer a node with a fake ring. Placing one removes the junction node and builds a real one-way ring of edges:
- The ring is a polygon of `RING_CHORDS[size]` vertices at radius `R` around the old node position, joined by one-way, 1-lane ring edges (counter-clockwise on screen, as today).
- Each arm road, followed through its bends, is cut where it crosses the circle, and the cut point is the arm's ring vertex. Each arc between two arms is split into `round(arc / (360° / chords))` equal chords, so arms sit exactly on vertices.
- Ring vertices are plain degree-2 nodes. Arm vertices are T-junctions (arm, ring-in, ring-out) with control `none`; the entry rules below key on `onRing(n)`.
- Turns at every vertex use the normal `arcPos` blend, so heading and speed are continuous. `ringPos`, `ringIn`, `ringStop` and the roundabout cap in `may()` go.

| Size | R (lane centre) | Ring road width | Outer radius | Island radius | Chords (length) | Ring limit px/s (km/h) | Max arms | Max arm lanes/dir | Clear radius | Cost x | Stored cars |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Small | 22 | 12 | 28 | 16 | 7 (19.1) | 45 (20) | 4 | 1 | 52 | 1 | ~6 |
| Medium | 34 | 12 | 40 | 28 | 11 (19.2) | 58 (25) | 5 | 2 | 64 | 1.6 | ~10 |
| Large | 50 | 12 | 56 | 44 | 16 (19.5) | 70 (30) | 6 | 3 | 80 | 2.4 | ~15 |

- **Ring road width** = `LANE_W + 2 x 1.5` shoulder. Outer radius = `R + 6` and island radius = `R − 6`.
- **Chord length** is about `CAR_LEN + GAP`, so no car straddles more than two ring edges.
- **Ring limit** is about `sqrt(100 x R)`: a comfortable lateral acceleration.
- **Clear radius** = outer radius + `2 x NODE_R`. No other junction node, driveway join or split may sit inside it. `DRIVE_SNAP` and road splits refuse it, and Small rings get the same `ringRoom` rule as the others.
- **Stored cars** = `2πR / 20`. It replaces the 3/5/8 cap: throughput comes from geometry, not a counter.
- Price: `ROUNDABOUT_COST x Cost x` + `ROUNDABOUT_UPKEEP x Cost x` per day, with the ring edges free (they are part of the control). These are the old multipliers.
- Placement needs 3..Max arms arms, at least `360 / (max arms + 1)` degrees apart. Refusals: `Too many lanes for a Small roundabout`, `Arms too close together`, `Too close to the next junction`.
- Ring edges are one-way 1-lane avenue edges (12px wide) with `Edge.ring` pointing at their `Ring` (null = none). They are free, not access roads (no driveways, no lots), and drawn as arcs of the circle around a grass island (decor: section 7 cosmetics).

**Ring record:** `Ring { hub: Node; nodes: Node[] }` in `RoadGraph.rings`. The hub is a node off the graph at the centre with control `roundabout`, `ring` = size and `controlDay`: the junction panel, the control price, refunds and upkeep use it as they used the old roundabout node.
- Edit-clicking any ring edge or vertex opens the roundabout panel: size S/M/L with the price difference, and Remove.
- Changing size rebuilds the ring. Cars on it go back to their trip origin, as on demolish.
- Remove restores a plain node joining the arms (refunded under the road rule, by `controlDay`).

**Entry and exit:**
- An arm vertex is a `yield` node whose main edges are the two ring edges.
- **Entry:** an entering car (arm to ring-out) uses a gap-merge like the driveway one (`ringNear`). Every ring car still to pass the vertex, and every car granted in at an upstream entry, must be its braking distance plus `MERGE_GAP` s plus the entering car's own time to the vertex away. Ring cars leaving at that vertex are ignored, because they don't cross.
- **No courtesy merge on rings.** `MERGE_S` starvation does not hold ring traffic, which would gridlock the ring.
- **Room check:** a car enters only if every lane on its ring path plus its exit lane has room for it (`fits` over the whole ring path), so a blocked exit holds cars at the entry line, not on the ring.
- Inbound lanes of a multi-lane arm enter one car at a time per vertex.

**Lights stay useful.**
- A ring is one lane, so under load an entry admits about one car per `MERGE_GAP` s.
- A light with 3-lane arms and protected lefts moves 2-3 lanes at once.
- Rings win at medium, balanced flows. Lights win on big unbalanced crossings and in tight grids where a ring doesn't fit. Map 7 is built around that (section 4).
- ponytail: single-lane rings. Add 2-lane rings (inner lane for far exits) only if Large rings with 3-lane arms still jam in playtest.

**Migration:** on load, every node with `control: 'roundabout'` (old saves) is rebuilt as a ring of its saved `ring` size, a smaller one where an arm is too short for it, else a plain junction. Its lane connections are dropped: a ring arm has one move. Saves keep `v: 1` and gain `rings` and `edges[].ring` (indexes).

**Building and joining:**
- Driveways joining inside the new ring's clear radius are laid again outside it (`connect` slides a join along the road out of every clear radius).
- A new road may join a ring at its ends only, from outside, on a vertex without a road or by splitting a ring edge, within the size's arm, lane and spacing rules. It may not cross a ring, nor split, join or end an arm inside a clear radius (`Too close to the roundabout`).

**Overlap fixes** (from the plan):
- A blocked hand-off waits where it was that tick (before the line), and `Car.ts` never snaps to `s = length`.
- Left turns at a junction bow `LANE_OFFSET` toward the inside of the turn, so opposite lefts pass side by side.
- `commitBend` and `setEdgeType` re-space cars (`RoadGraph.respace`) and drop the ones that don't fit back to their origin.
- A car looks for the car ahead through the links ahead (same lane index) within 150px, not just the next lane, and keeps its lane index through bends and driveway joins where the lane count stays the same.
- Two lanes never feed one exit lane at once: `fits` refuses a car while one from another lane is granted into it.
- A driveway merge also counts a car granted onto the road at the upstream node.

**simcheck:** cross-node gap, drawn overlap (`carPos` distance ≥ 0.8 x car length for same-heading pairs), ring heading change ≤ 35° per 0.1 s and no speed reset at entry, short link next to a Large ring, and invariants for each ring size.

---

## 2. Zones, demand, growth, soft fail (G1)

The tray, batches and click-per-building flow go. The player paints zones along roads, and buildings grow there by themselves.

### Lots
- A lot is `LOT_W = 32` px of frontage by `LOT_D = 56` px of depth. The door sits on the lot's front edge and the footprint (at most 42 px deep) starts `DOOR_D` behind it.
- It sits on one side of a ground access edge (not highway, bridge, tunnel, viaduct, ring or driveway). Its front edge is `half road width + 2` px from the road centre line.
- Lots are cut along each edge from its middle outward, at whole `LOT_W` steps. Curved roads are fine, because chords are one tile long.
- A lot is skipped silently when its rect overlaps water, a mountain, a road, a building, another lot, or a junction's `NODE_R + 8`.
- A building's door is at the middle of its lots' front. Its driveway is laid as today.

**Brush** (Build menu, Zones group: Residential, Commercial, Office, Industrial, Unzone; `Z` toggles the brush, `Tab` cycles the zone):
- Press within 40 px of an access road and drag. The brush follows the network path from the press point to the edge nearest the cursor (up to 1,500 px) and paints both sides. `Shift` paints only the side the cursor is on.
- A drag that **starts on a lot of the held zone erases** instead (the toggle paint of pixel editors). Unzone always erases.
- Painting a different zone over a built lot re-zones it. The building on it is demolished, with the two-click arm of the Demolish tool.
- The preview outlines the lots in the zone colour, with the label `+14 lots · $560 · Residential demand 0.6 → 0.2` (the Islanders score preview). Release commits and Esc cancels.

| Zone | $ per lot | Refund (empty lot) |
|---|---|---|
| Residential | 40 | 100% |
| Commercial | 60 | 100% |
| Office | 80 | 100% |
| Industrial | 80 | 100% |

- Creative is free.
- The Grid tool (Trafficity's "grid in 3 clicks") gets a `Zone blocks` toggle: the planned grid also paints its frontage with the held zone, and the cost shows in the same label.
- When a road is split, lots move to the new edge under them. When their road is demolished, lots go, and a building on them stays with a `No road` badge.

### Demand (RCI+O), recomputed hourly, each −1..+1

```
workers   = Σ residents x EMPLOY_RATE
jobs      = Σ jobs (all workplaces, specials included)
unemp     = workers − jobs
shopNeed  = residents / 12 + visitorsPerDay / 4          // shop jobs wanted
indNeed   = shopJobs x 0.6 + 10 x linkedExits             // industry jobs wanted (goods for shops, exports)
R = clamp(−unemp / max(60, workers) + 0.2, −1, 1)         // a job surplus pulls homes; +0.2 keeps homes trickling
C = clamp((shopNeed − shopJobs) / max(10, shopNeed), −1, 1)
I = clamp((indNeed − indJobs) / max(15, indNeed), −1, 1)
O = clamp((unemp − max(0, shopNeed − shopJobs) − max(0, indNeed − indJobs)) / max(60, workers), −1, 1)
```

- While population is under 100, R is at least 0.5, so a fresh map always calls for homes.
- A zone the map has not unlocked shows its bar greyed out.
- The HUD shows four thin vertical bars (+ up, − down) in region A. The brush shows them large.

### Access score A (0..1), hourly, per building and per empty lot
```
A = 0.6 x trips + 0.25 x (1 − heat) + 0.15 x reach
```
- **trips:** the mean outcome score of the last 24 h trips from or to the building. For an empty lot, or a building with no trips: the mean over buildings within 150 px, else 0.7.
- **heat:** the max `heat` of the frontage edge and the edges one junction away.
- **reach:** for homes, 0.5 for a reachable workplace plus 0.5 for a reachable shop. For workplaces, `staffed`.

### Growth (deterministic: no dice anywhere)
- **Spawn:**
  - Per zone, `acc_z += max(0, D_z) x SPAWN_RATE (1.5/h) x growthMult`. Each whole unit spawns a tier-1 building on the empty connected lot of that zone with the highest A. Ties go to the lot nearest the town centroid.
  - Lots with `A < 0.35` never spawn.
  - Homes move in at `PLACED_OCC` (40%) and fill by the existing happiness growth.
- **Upgrade:**
  - Conditions: A ≥ 0.7, the next tier is unlocked, the zone's demand is above 0.1, and the extra lots are free. For homes also residents ≥ 90% of capacity and happiness ≥ 65. For workplaces also `staffed ≥ 0.8`.
  - When all of these hold for `UPGRADE_H = 12` in-game hours in a row, the building goes up one tier.
  - The extra lots are the next lots along the same frontage and side: empty, or tier-1 buildings of the same zone, which merge in (their residents move in).
  - Residents and jobs carry over.
- **Downgrade:**
  - Trigger: `A < 0.35`, or a home's happiness under 30, for `DOWN_H = 36` h. The building drops one tier: capacity is cut (the excess moves out) and the freed lots go back to empty.
  - At tier 1 the building becomes **abandoned**: grey art, no residents, no jobs, no trips.
  - After another `DOWN_H` still bad, it is cleared and its lot stays zoned.
  - An abandoned building recovers to tier 1 at 40% after `A ≥ 0.5` for 6 h.
- **Pin on the building** (Mini Motorways): while a downgrade timer runs, an amber pin with a countdown ring floats over the building. Hovering it gives the cause, which is its weakest part:
  - `Trips take 2.6x longer than on empty roads`
  - `No job within reach`
  - `Jam on Oak St`
  - `Noise from the highway`

  A feed alert (section 9) jumps to the longest stop on its recent trips: the place to fix.

### Soft fail (Campaign, Endless, Creative) and the bank
- No game over outside Challenge. The happiness collapse becomes downgrades and abandoned buildings, and bankruptcy becomes a loan.
- **Loan:**
  - Granted automatically at any hourly tick with `money < 0` and `loan < LOAN_CAP`: `+LOAN_STEP` $10,000, with the toast `Bank loan: +$10,000 at 1.5%/day`.
  - `LOAN_CAP` = $50,000 x (difficulty money / 40,000): $75k on Easy, $50k on Normal, $31k on Hard.
  - Interest: `LOAN_RATE = 1.5%` of the balance per day, charged hourly as the ledger line `interest`.
  - Repayment: `Repay $10,000` in the money panel while money ≥ $10,000. Nothing repays automatically.
- **Frozen:** at the cap with `money < 0`, new buildings and upgrades stop and zone painting is refused (`The bank froze the city: earn money to grow again`). It lifts when money ≥ 0.
- **Challenge only:** no loans, and the old rules apply: bankruptcy after `debtDays` midnights in debt, and city happiness under `failHappy` (see section 5).

---

## 3. Building tiers and specials (G2)

Lot footprints are drawn `LOT_W x n − 4` wide. Height reads through roof detail and longer shadows (top-down).

Trips/day are rough totals of both legs on Normal:
- Commute: `capacity x 0.5 / 5 x 2`.
- Shopping: `residents / 5 x 0.35 x 2`.
- Freight: trucks x 2.
- Shops share the city's shopping trips by gravity weight, which is `jobs x draw`.

| Zone | Tier | Name | Lots | Footprint px | Capacity | Trips/day | Extra | Unlocked by map |
|---|---|---|---|---|---|---|---|---|
| Residential | 1 | House | 1 | 28x24 | 30 res | ~10 | | 1 |
| Residential | 2 | Townhouses | 2 | 60x28 | 70 res | ~24 | | 2 |
| Residential | 3 | Apartment block | 2 | 60x40 | 160 res | ~54 | | 4 |
| Residential | 4 | Tower | 3 | 92x42 | 320 res | ~108 | noise weight x1.5 | 8 |
| Commercial | 1 | Corner shop | 1 | 28x28 | 10 jobs | 4 + customers | draw 1 | 1 |
| Commercial | 2 | Store | 2 | 60x32 | 25 jobs | 10 + customers | draw 1 | 3 |
| Commercial | 3 | Mall | 4 | 124x44 | 80 jobs | 32 + customers + 24 visitors | draw 1.5, 12 visitors/day | 6 |
| Office | 1 | Office | 1 | 28x36 | 30 jobs | 12 + 4 visitors | 2 visitors/day | 2 |
| Office | 2 | Office tower | 2 | 60x42 | 120 jobs | 48 + 12 visitors | 6 visitors/day | 5 |
| Industrial | 1 | Workshop | 1 | 28x36 | 12 jobs | 5 + 8 trucks | 4 trucks/day, pollution r 160 | 4 |
| Industrial | 2 | Factory | 2 | 60x40 | 30 jobs | 12 + 16 trucks | 8 trucks/day, pollution r 260 | 4 |
| Industrial | 3 | Logistics park | 4 | 124x44 | 60 jobs | 24 + 40 trucks | 20 trucks/day, `EXPORT_SHARE` 0.7, noise 0.5 | 5 |

- Trucks/day scale with `staffed`, as today. Visitors need a linked highway exit, as today.
- Tiers are a `TIER_DEFS` table in `config.ts` keyed by zone and tier. `ZONES` keeps the colours.
- A **legacy** building (from an old save, or a starter-town building not on lots) keeps its old `ZONES` footprint and capacity and never changes tier. `Building.lots = []` marks it.
- **Automatic detail** (Townscaper): the art picks gardens, fences, parking, trees, rooftop units and loading bays from the tier, the lot count and the neighbours. It is seeded by building id, so the same building always looks the same.

**Specials** are placed with the existing place tool (ghost, snapping, driveway, `R` rotates) once the map or a milestone unlocks them. They are traffic attractors, not services.

| Special | Footprint | Cost | Upkeep/day | Jobs | Traffic | Effect | Limit | Unlocked by map |
|---|---|---|---|---|---|---|---|---|
| Mall plaza | 124x88 | $10,000 | $50 | 100 | draw 2, 30 visitors/day from exits | counts as 100 shop jobs in C | 2 | 6 |
| Freight terminal | 120x90 | $12,000 | $60 | 40 | 30 trucks/day; every import/export routes exit ↔ terminal ↔ town | exports pay x1.5 | 1 per linked exit, ≤ 400 px from it | 5 |
| Stadium | 140x100 | $15,000 | $80 | 20 | match surge (section 8) every 2nd day | $25 per fan on time | 1 | 7 |
| Hospital | 100x80 | $12,000 | $70 | 60 | 1 emergency call per 200 residents/day (vehicle kind `ambulance`) | a Fast call gives +3 happiness to homes within 300 px for a day; ambulances act as main road at yields and turn lights green when 60 px out | 1 per 2,000 pop | 8 |

- The place ghost shows `+140 trips/day · $12,000 · upkeep $70` before placing (Islanders).
- Demolishing a special refunds 50%.

---

## 4. Campaign (G3)

The same grading on every map, so a newcomer learns it once (Freeways, Poly Bridge):
- **★** all objectives met.
- **★★** also smooth share of the last 24 h ≥ the map's flow bar.
- **★★★** also total network spend (roads, controls, specials; zoning excluded) ≤ the map's budget.

Grading:
- Objectives are checked live. When they all hold at once, the `Map complete` modal grades the map.
- The player can then keep playing (the map turns Endless) and the grade re-runs every midnight, keeping the best.
- The modal also shows the **efficiency score**: `round(1000 x smoothTrips24h / (1 + spend / 10,000) / (1 + junctions / 50))`. It is for bragging, and it is the Daily score.

| # | Map | Biome, size, seed idea | Constraint | Objectives (★) | ★★ flow | ★★★ budget | Start $ | Teaches and unlocks | Unlock |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Meadowbrook | temperate small, `meadowbrook`, one gentle river, no mountains, no exits | dirt and street only | pop 300 | 80% | $9,000 | $20,000 | roads, Residential and Commercial zones, Edit, Demolish (scripted tutorial, section 6) | start |
| 2 | Two Bridges | temperate small, a wide river across the middle; starter offices north, homes south | every crossing is a bridge (x4) | pop 600; 25 trips/h | 75% | $20,000 | $30,000 | avenue, bridges, Office zone, townhouses, Grid tool, heat map | 1★ |
| 3 | Cedar Crossing | temperate medium, flat, a central crossroads of avenues | rush hour: `COMMUTE_SD` 0.4, so everyone leaves 7-9 | pop 900; 55 trips/h at 08:00 | 80% | $30,000 | $40,000 | roundabouts S/M/L, one-way, store | 3★ |
| 4 | Pine Pass | alpine medium, a mountain wall with one pass; highway exit beyond it | tunnels x5, few flat lots | pop 1,000; 20 exports/day | 70% | $55,000 | $60,000 | viaducts L1-10, ramps, tunnels, Industrial zone, apartment block, factory | 5★ |
| 5 | Harbor Isles | archipelago medium, islands joined by short bridges, freight exit on the largest | small islands, so lots are scarce and density matters | pop 1,200; 60 exports/day | 75% | $50,000 | $60,000 | boulevard, lane connections, freight terminal, office tower, logistics park | 7★ |
| 6 | Sunvale Corridor | desert large, two exits on opposite edges joined by a through route | visitors x3, plus 100 through-trips/day driving exit to exit | pop 1,500; 150 visitor arrivals/day; a mall plaza | 75% | $90,000 | $90,000 | highway, interchanges, mall, mall plaza | 9★ |
| 7 | Stadium Heights | temperate medium, hills; a 3-lane boulevard crossing next to the stadium site | match surges; ring space is tight by the stadium | pop 1,800; one match with ≥ 85% fans on time | 75% | $70,000 | $80,000 | stadium, events, light phase editor, protected lefts | 12★ |
| 8 | Riverside Metro | temperate large, 2 rivers, mountains, 3 exits | all of the above at scale | pop 3,000; ambulance Fast ≥ 90% (last 10) | 75% | $140,000 | $120,000 | hospital, towers | 15★ |
| B1 | Lakeside Loop | archipelago-lite, one big lake ringed by land | one ring road around the lake | pop 1,500 | 80% | $40,000 | $50,000 | (bonus) | achievement Star Collector |
| B2 | Canyon Gate | desert medium, canyon walls, 2 exits | tight budget | pop 2,000; 60 exports/day | 80% | $60,000 | $60,000 | (bonus) | achievement Perfectionist |

- Unlocks are cumulative: map N has the tools of maps 1..N. The map's new tool is announced when the map opens, and its tip fires on first use (Railbound, shapez).
- Maps run with Normal multipliers. Difficulty is picked only in Endless.
- 8 maps give 24 stars. The unlock bars (1, 3, 5, 7, 9, 12, 15) ask for about 2★ on average.
- **Map data:** `CAMPAIGN: MapDef[]` in `src/core/Campaign.ts`:
  ```
  { id, name, biome, size, seed, terrain overrides (rivers, mountains, lakes, exits), money, tools: Feature[], zones: Zone[],
    tiers: Record<Zone, number>, specials, objectives: Objective[], flow, budget, unlock, modifiers }
  Objective = { kind: 'pop' | 'tripsHour' | 'tripsAt' | 'exports' | 'visitors' | 'special' | 'match' | 'ambulance', target, at?, label }
  ```
- ponytail: maps are seeds plus overrides on the existing generator. Hand-placed terrain only if no seed gives the layout.
- **Unlocks go through one function,** `Game.unlocked(feature)`:
  - Campaign and Challenge read the map's tools.
  - Endless reads the profile's tools.
  - Creative has everything.

  `TIERS[t].level`, `UNLOCKS` and `LEVELS` go.

---

## 5. Modes (G3)

| Mode | Map | Money | Fail | Unlocks | Extras |
|---|---|---|---|---|---|
| Campaign | a campaign map | map start $ | soft (loan, downgrades) | the map's tools | objectives, stars, scripted tutorial on map 1 |
| Endless | any map with ≥ 1★, or a random seed after map 1 is cleared | difficulty money | soft | every tool the profile has unlocked | milestone choices (section 7), difficulty picker |
| Creative | any unlocked map or a seed | ∞ | none | all | events toggle (off by default), no achievements |
| Challenge | a campaign map's Challenge, unlocked by 3★ on it (Mini Metro's Extreme behind a feat) | map start $ x 0.7 | hard (below) | the map's tools | Hard multipliers, a deadline, permanent roads, no loans, events x1.5 |
| Daily | date-seeded, unlocked once map 3 is cleared | per template | hard | template tools | one map template and one modifier per day; score = efficiency, best kept locally |

- **Challenge hard fail:**
  - **Bankrupt:** `debtDays` midnights in debt.
  - **Residents left:** city happiness under `failHappy` at 2 midnights.
  - **Gridlock:** over 40% of a day's trips gave up.
- **Challenge deadline:** the map's objectives by day `6 + map index`. A clear earns the map's medal, and the profile keeps the best clear day.
- **Permanent roads:** roads, controls and specials can be demolished or downgraded only on the day they were built. Undo has the same limit.
- **Daily modifiers** (one per day, picked by the date seed):
  - rush hour (`COMMUTE_SD` 0.4)
  - bridges x2
  - no lights
  - rain all day
  - half budget
  - trucks x2
- `GameConfig.mode` becomes `'campaign' | 'endless' | 'creative' | 'challenge' | 'daily'`, and `GameConfig` adds `map?: string`. An old `'career'` save loads as `'endless'` (section 10).

---

## 6. Onboarding (G6)

Map 1, Meadowbrook, is the tutorial. The old generic tutorial is retired, and its `done` predicates move into scripted objectives.

The objectives panel (region O) shows the step's goal with a progress bar. Arrows at the screen edge point to off-screen targets. During steps 1-6 growth runs x4, events are off, and money tops up to $20,000.

| Step | Goal shown | Done when | Pulses / targets |
|---|---|---|---|
| 1 | Welcome to Meadowbrook: "People here need to get to work. You build the roads." | Next | camera eases to the starter town |
| 2 | Connect the homes to the office | every starter home reaches the office | Road tool; rings on the doors |
| 3 | Watch the first commute (try 4x) | 3 commutes arrived | speed control |
| 4 | Paint 8 Residential lots along a road | 8 Residential lots | Zones group, Residential; a dashed brush path along the longest road |
| 5 | Watch Meadowbrook grow | 3 houses grew | R demand bar |
| 6 | People want shops: paint Commercial lots | 2 Commercial lots zoned and 1 shop grown | C demand bar |
| 7 | Fix the jam | the scripted 8:00 jam on the main junction: heat map turned on, then that edge's heat < 0.4 for 1 h | heat map button; ring on the junction |
| 8 | Reach 300 residents | map objective | objectives panel; tips take over |

- **Skip** ends the script but keeps the map.
- `tm_tutorial_done = '1'` from older versions marks the script seen: map 1 starts with the panel and no script.
- simcheck plays the steps through on a scripted town, as it does today.

**Tips** (Factorio style) are bottom-right cards (region F) shown the first time something happens. Each tip is shown once per profile (`profile.tips`), at most one is on screen, the rest queue, and a menu toggle turns them off.

| Trigger | Tip |
|---|---|
| an edge with heat > 0.7 for 1 h | Red roads are jammed. Turn on the heat map (C) to find the worst spot. |
| a building with no road | This building has no road. Connect its door. |
| a home below 30 happiness | Unhappy homes stop growing. Hover one to see why. |
| first downgrade pin | The pin shows how long until this building moves down a tier. Fix the cause it names. |
| first loan | The bank lent you $10,000 at 1.5% a day. Repay it from the money panel. |
| first gave-up trip | A driver gave up. Their trip report shows where they got stuck. |
| a demand bar above 0.8 for 1 day | Commercial demand is high: paint more shops. |
| first highway exit linked | Exports, imports and visitors now use this exit. |
| noise > 0.4 at a home | Residents dislike loud roads. Keep big roads away from homes. |
| first use of each new tool | one line per tool (ring sizes, lane connections, tunnels, ...) |
| first event of each kind | what it is and how to earn its reward |
| first milestone choice | Pick one. The other offer comes back later. |

---

## 7. Achievements, cosmetics, milestones (G4)

Achievements are checked on game events and at hourly ticks; none fire in Creative. Each shows as a toast and on the profile page. Progress counters live in `profile.progress`.

| # | Id | Name | Condition | Reward |
|---|---|---|---|---|
| 1 | first | First Commute | a trip arrives | |
| 2 | paint | Paint the Town | 20 lots in one drag | |
| 3 | rings | Round and Round | one roundabout of each size | Flowerbed island |
| 4 | nolights | No Lights Needed | finish a campaign map with no traffic lights | Fountain island |
| 5 | halfoff | Half Off | finish a map spending ≤ 50% of its ★★★ budget | Gold car paint |
| 6 | streak | Smooth Operator | 1,000 trips in a row with no gave-up | |
| 7 | mall | Mall Rat | a mall with mean stopped time under 20 s over 24 h (≥ 50 trips) | |
| 8 | tower | Skyline | the first tower | |
| 9 | rush | Rush Hour Hero | 150 trips/h at ≥ 85% smooth | |
| 10 | bridges | Bridge Builder | 5 bridges in one city | |
| 11 | tunnel | Tunnel Vision | a tunnel through a mountain | |
| 12 | flyover | Flyover | a viaduct at L6 or higher | |
| 13 | clover | Cloverleaf | a cloverleaf interchange | |
| 14 | exports | Export Economy | 100 exports in one day | |
| 15 | ambulance | Clear the Way | 20 Fast ambulance calls | Statue island |
| 16 | fullhouse | Full House | a match with ≥ 90% fans on time | |
| 17 | rain | Weather the Storm | ≥ 75% smooth through a rain event | |
| 18 | detour | Detour Master | 5 roadworks with no gave-up trips | |
| 19 | debtfree | Debt Free | repay a loan in full | |
| 20 | nored | Never in the Red | finish a map without a loan | |
| 21 | quiet | Quiet Streets | 500 residents with noise under 0.1 | |
| 22 | lanes | Lane Wizard | 10 edited lane connections and a city mean junction delay under 5 s | |
| 23 | stars12 | Star Collector | 12 stars | bonus map Lakeside Loop |
| 24 | stars24 | Perfectionist | 24 stars | bonus map Canyon Gate |
| 25 | challenger | Challenger | clear any Challenge | Retro car paint |
| 26 | daily | Daily Driver | clear 5 Daily challenges | Pastel car paint |
| 27 | metro | Metropolis | 5,000 population in Endless | Neon car paint |

**Cosmetics** (profile page picker, purely visual):
- Car paint sets: Classic (default), Pastel, Retro, Neon, Gold.
- Roundabout island decor: Grass (default), Flowerbed, Fountain, Statue.

**Milestone choices** (Mini Motorways, Islanders):
- Campaign: at 25%, 50% and 75% of the population objective. Endless: every 500 population up to 3,000, then every 1,000.
- A modal pauses the game and offers 2 cards, and the player picks 1.
- **No luck:** the pair comes from a fixed pool rotation (Money + Upgrade, Money + Special, Special + Upgrade, then repeat). Within a pool the pick is by need: the special matching the highest demand, or the upgrade for the city's worst metric. An offer not taken comes back first next time.

| Pool | Offers |
|---|---|
| Money | $5,000 x milestone number x taxMult; with a loan, the same amount paid off the loan instead (the card says which) |
| Special | a free token for one special the run has unlocked (upkeep still applies); with none unlocked, the pool falls back to Money |
| Upgrade (permanent for this run) | **Road crew**: roads −20%<br>**Smart lights**: phases stretch with the queue (actuated, ±50%)<br>**Wide rings**: ring limits +20%<br>**Express lanes**: highway limit +15%<br>**Zoning office**: zoning free, spawning +25%<br>**Tow trucks**: accidents clear 2x faster<br>**Bank deal**: loan interest halved, cap +$25,000<br>**Sound walls**: road noise −50% |

---

## 8. Events (G5)

- **Scheduling:** from day 2, each hour from 07:00 to 21:00 an eligible event starts with probability 6% (about 1 a day), drawn from the seeded `random()` stream.
- **Caps:** 1 active event (2 from 2,000 population), at least 4 in-game hours between starts, and none during the map 1 script.
- **Off:** Creative (toggle). **x1.5 frequency:** Challenge.
- **Warning:** each event is announced in the feed. Timed ones show a countdown ring on the road or building itself (Mini Motorways).
- **Rewards** are fixed amounts x taxMult. A missed quest only misses its reward.

| Event | Trigger / eligibility | Warning | Duration | Effect | Quest and reward |
|---|---|---|---|---|---|
| Roadworks | a non-exit edge ≥ 60 px with heat > 0.3, 09:00-16:00 | 1 h, cones and a countdown on the road | 6 h | the edge closes both ways (cars reroute; cars on it finish their pass) | keep smooth ≥ 70% while it is closed: $1,500 |
| Accident | an edge with ≥ 6 queued cars and heat > 0.6 | none | 2 h (1 h with Tow trucks) | one lane blocked; a 1-lane road is closed one way | the queue behind it drops under 3 cars before it clears: $800 |
| Match day | a stadium exists; every 2nd day, announced 12:00 | countdown on the stadium | fans arrive 17:00-19:00, kickoff 19:00, leave 22:00-23:00 | `min(240, 60 + pop / 15)` fans: 60% from homes, 40% from exits | $25 per fan before kickoff, + $2,000 at ≥ 85% on time |
| VIP convoy | pop ≥ 1,000, a linked exit, at most once per 3 days | 1 h, flag on the target | until it arrives | 3 cars from an exit to an office tower or the stadium | arrive within 1.5x ideal: $3,000 |
| Emergency call | homes exist; a hospital (or with none, the nearest linked exit) | siren icon on the home | until it returns | an ambulance drives out and back with priority (section 3) | Fast (≤ 1.3x ideal): $500 |
| Rain | at most once per 2 days | 1 h, clouds roll in | 4 h | top speed x0.8, braking x0.7, headway +30%; rain streaks, wet sheen | keep ≥ 70% smooth: $1,000 |
| Request (Dorfromantik) | a building above tier 1; at most 2 active | pin with a 1-day countdown on the building | 1 day | the building asks for one thing: "commute under 2 min", "a shop within reach", "no jam on my street" (frontage heat < 0.3) | met while the pin runs: $1,000 and an instant tier upgrade (if lots allow; else $2,000) |

---

## 9. HUD regions after this round (F2, G1, G3, G6)

F2 makes every HUD fill flat: solid colours and flat offset shadows, no gradients, sheens or vignettes. Only the heat legend and the rush-hour bands keep their gradients. `docs/hud-design.md` is updated by F2.

```
+----------------------------------------------------------------------------------------+
| [A $ · loan · pop/goal · happy · R C O I bars]  [B speed | trips | clock]  [C views 🔔 ≡ ?] |
| [O objectives: map, ★ goals, bars]                                    [G panel column]  |
|                               (map centre: no HUD; off-screen arrows)                   |
| [H legend]           [D' Build menu: Roads | Junctions | Zones | Specials]              |
|                      [E toasts]                                         [F tip card]    |
|        [D Build^ | tool options (zone swatches, side) | Edit Demolish | Undo Redo]        |
+----------------------------------------------------------------------------------------+
```

- **A:**
  - The Lv chip goes. In Endless, pop/goal shows the next milestone. A loan chip shows only while a loan is out.
  - The danger chip stays for Challenge countdowns and `Frozen`.
- **O (new):** top-left under A, collapsible. It shows the map name, the objectives with bars, and the ★★/★★★ bars (flow now vs bar, spend vs budget). In Endless it shows the next milestone.
- **C:** a bell opens the **notification feed** as a G panel. A badge counts unread items. The feed lists downgrades, events, requests, loans, milestones and achievements; a click jumps the camera there.
- **D, D':**
  - The Buildings group becomes Zones (4 swatches + Unzone, with demand bars on them) and Specials (cards with price and limit).
  - Undo/Redo buttons sit at the dock end.
- **H:** only the legend. The tray is gone.
- **Modals:**
  - Milestone choice (2 cards).
  - Map complete: the stars stamp in one by one, then efficiency, Continue (Endless on this map) or Map select.
  - Challenge failed.
- **Menu:**
  - Main menu: Campaign (map select grid: cards with stars, lock `★ 5 to unlock`, Play / Endless / Challenge buttons), Endless (seed + difficulty), Creative, Daily, Profile, Load, Sound.
  - **Profile page:** achievements grid (locked items greyed out with their condition), cosmetics picker, stats.

---

## 10. Data model, save and profile

New and changed types (owner step in brackets):

```ts
// config.ts
type Mode = 'campaign' | 'endless' | 'creative' | 'challenge' | 'daily';          // [G3] 'career' read as 'endless'
interface GameConfig { seed; mode; difficulty; biome; size; map?: string; modifier?: string }
// RoadGraph.ts [F1]
interface Ring { id: number; x: number; y: number; size: RingSize; nodes: Node[] }
Edge.ring: number; RoadGraph.rings: Ring[]
// Zones.ts [G1]
interface Lot { id: number; edge: Edge; side: 1 | -1; s: number; zone: Zone; building: Building | null; x; y; angle }
Game: lots: Lot[]; demand: Record<Zone, number>; spawnAcc: Record<Zone, number>; loan: number; frozen: boolean
// Building.ts [G1, G2]
Building: tier: 1..4; lots: Lot[]; special: Special | null; access: number; upH: number; downH: number; abandoned: boolean
// Campaign.ts / Profile.ts [G3, G4]
Game: objectives state; best grade; milestone: number; offers: Offer[] | null; upgrades: Upgrade[]
// Events.ts [G5]
Game: events: ActiveEvent[]; nextEventAt: number; requests
// G7: Game.history: Action[] (not saved)
```

**SaveData stays `v: 1`.** New fields are optional, and `deserialize` fills defaults:

| Field | Default for an old save |
|---|---|
| `rings?` | rebuilt from nodes with `control: 'roundabout'` and their `ring` size |
| `edges[].ring?` | 0 |
| `lots?` | [] (legacy buildings stay put; the player paints new lots) |
| `buildings[].tier?` / `lots?` / `special?` / `access?` / `upH?` / `downH?` / `abandoned?` | 1 / [] (legacy) / null / 0.7 / 0 / 0 / false |
| `loan?`, `frozen?` | 0, false |
| `demand?`, `spawnAcc?` | recomputed at the first hourly tick, zeros |
| `milestone?`, `offers?`, `upgrades?` | from `cityLevel` (the milestone count it reached), null, [] |
| `events?`, `nextEventAt?` | [], now + 4 h |
| `cfg.mode: 'career'` | `'endless'` |
| `tray` | still written as zeros until a later cleanup, ignored on load |

- `peek` accepts the new modes and `'career'`.
- The autosave key and the three slots stay.
- simcheck round-trips a v1 fixture with a roundabout and a tray.

**Profile** in `localStorage['tm_profile']` (`src/core/Profile.ts`). Every read and write is wrapped in try/catch. Bad or missing data gives defaults. Writes are debounced to 1 s.

```ts
interface Profile {
  v: 1;
  stars: Record<string, 0 | 1 | 2 | 3>;                        // map id
  best: Record<string, { efficiency: number; smooth: number; spend: number; day: number }>;
  challenge: Record<string, number>;                           // best clear day, 0 = none
  daily: { last: string; cleared: number; best: Record<string, number> };
  tools: Feature[];                                            // unlocked through the campaign (Endless uses them)
  achievements: Record<string, number>;                        // id -> unlock time (ms)
  progress: Record<string, number>;                            // counters (streak, bridges, ambulances, ...)
  cosmetics: { paint: 'classic' | 'pastel' | 'retro' | 'neon' | 'gold'; island: 'grass' | 'flowers' | 'fountain' | 'statue' };
  tips: string[]; tipsOff: boolean;
  stats: { trips: number; roadsPx: number; seconds: number };
}
```

- Migration: `tm_tutorial_done = '1'` adds `'tutorial'` to `tips`.
- `tm_audio` stays separate.

---

## 11. Relax and juice (G7)

**Undo/redo:**
- `Ctrl+Z` / `Ctrl+Y` (and `Ctrl+Shift+Z`), 50 actions.
- It covers road build, demolish, retype and bend, controls and rings, zone paint and erase, and special placement.
- Undo reverses the change and its money exactly.
- The stack clears at midnight and on load, so it is never a late refund. In Challenge it only reaches today's actions, which midnight already guarantees.

**Juice cues** (the sim raises them in `Game.sfx` or `Game.fx`; the renderer and `Sound.ts` play them):

| Cue | Trigger | Visual | Sound |
|---|---|---|---|
| Jam cleared | an edge's heat falls from > 0.6 to < 0.3 | 12 green sparkles along the edge, 0.6 s | pentatonic chime, pitch by edge length |
| Income | business income ≥ $10 on an arrival | `+$25` float at the door (max 4/s, merged) | existing blip (1.5 s throttle) |
| Grow | a building spawns | scale 0 → 1.08 → 1 over 0.35 s, dust puff | soft pop |
| Upgrade | tier up | scale pulse, a crane silhouette for 0.5 s | rising two-note |
| Downgrade / abandon | tier down | grey puff | low thud |
| Paint | each lot added during a drag | lot fills along the drag | brush tick, pitch rising per lot |
| Star | each star while grading | stamp, 0.25 s apart | fanfare note per star |
| Achievement | unlock | badge toast slides in | short arpeggio |
| Milestone | choice opens | cards flip in | drum roll |
| Event | start / quest met | pin pop / gold burst | alert tone / success jingle |

**Music follows the network** (Mini Motorways):
- Layers over the existing loop:
  - pad, always
  - bass, from 30 trips/h
  - melody, while smooth ≥ 80%
  - soft percussion, during the rush hours 7-10 and 16-20
- While the worst junction delay is above 10 s, the pad shifts to Am7 (tension). It resolves on the next jam-cleared cue.
- Layers fade in and out over 2 bars.

---

## 12. Research notes: what we borrow

| Game | Mechanic | Here |
|---|---|---|
| Mini Motorways | demand pins with a countdown on the building; pick 1 of 2 weekly; Endless/Expert; daily; procedural music from the network | downgrade pins and request pins (2, 8); milestone choice (7); Endless/Challenge/Daily (5); flow-driven music layers (11) |
| Mini Metro | 34 maps, daily challenge, Extreme unlocked by a feat | 8 + 2 bonus maps; Daily; Challenge unlocked by 3★ (4, 5) |
| Freeways | end-of-level efficiency from flow, concrete used, complexity | efficiency score on Map complete and as the Daily score (4) |
| Poly Bridge 2 | budget stars, "Half off" | ★★★ = budget; Half Off achievement |
| Islanders | score preview before placing; packs by score; a new island at a bigger threshold | brush and special previews (2, 3); stars unlock maps (4) |
| Dorfromantik | quests on tiles pay more; achievements unlock content; relaxing loop | requests on buildings (8); achievements unlock bonus maps and cosmetics (7); soft fail |
| Townscaper | one click, automatic detail | one drag paints a street; detail picked from tier and neighbours (2, 3) |
| Railbound, shapez | each level unlocks and teaches one tool | one new tool per map with a first-use tip (4, 6) |
| Factorio | tips triggered on first encounter | tip table (6) |
| Traffic Architect | hand-built interchange challenges; heat map; Creative | Challenge deadlines and trips/h objectives; heat map kept; Creative (5) |
| Trafficity | grid in 3 clicks, lane connections, residents dislike noise | Grid `Zone blocks`; lane connections on map 5; noise in happiness and Sound walls |

Rejected:
- random reward cards and loot (luck)
- services and parks sprawl
- lights as a placeholder that rings beat everywhere (section 1 keeps a job for each)

---

## 13. Step checks (simcheck, per step)

- **F1:** see section 1.
- **G1:** a painted street spawns homes under positive R and none at R ≤ 0; a jammed frontage (forced heat 1) downgrades after `DOWN_H` and recovers; the loan triggers below $0 and stops at the cap; zoning cost and refund add up.
- **G2:** upgrade merges lots and keeps residents; specials respect their limits; trips/day per tier within ±30% of the table.
- **G3:** objective and star evaluation on a scripted city; unlock rule; profile round-trip; v1 fixture loads (roundabout rebuilt as a ring, tray ignored, `'career'` → `'endless'`).
- **G4:** each achievement predicate on a fixture; the milestone rotation is deterministic for a given city.
- **G5:** caps hold over 10 simulated days; roadworks closes and reopens the edge with no car lost.
- **G6:** the tutorial steps' `done` predicates are pure reads.
- **G7:** undo after build, then redo, leaves graph and money identical.
