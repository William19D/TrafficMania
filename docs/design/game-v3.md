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
- Remove restores a plain node joining the arms (refunded under the road rule, by `controlDay`). Each spoke is the arm piece the build took out there (`Ring.spokes`: the cheapest type per px and the oldest build day of the pieces, with driveway / exit flags), so a build and removal never turn a cheap stub into a free copy of the outer road. A road joined to the ring later (or a ring saved before spokes) gets a fresh spoke of its type, priced into the removal (`controlRefund` less it).

**Entry and exit:**
- An arm vertex is a `yield` node whose main edges are the two ring edges.
- **Entry:** an entering car (arm to ring-out) uses a gap-merge like the driveway one (`ringNear`). Every ring car still to pass the vertex, and every car granted in at an upstream entry, must be its braking distance plus `MERGE_GAP` s plus the entering car's own time to the vertex away. Ring cars leaving at that vertex are ignored, because they don't cross.
- **No courtesy merge on rings.** `MERGE_S` starvation does not hold ring traffic, which would gridlock the ring.
- **Room check:** a car enters only if every lane on its ring path plus its exit lane has room for it (`fits` over the whole ring path), so a blocked exit holds cars at the entry line, not on the ring.
- Inbound lanes of a multi-lane arm enter one car at a time per vertex, except onto a multi-lane ring (below).

**Ring lanes (R2):** a ring has 1, 2 or 3 lanes (`Ring.lanes`): Small 1, Medium up to 2, Large up to 3 (`RINGS rl`). Picked beside Build next to the size (kept for a bigger size, capped by the chosen one) and in the roundabout panel, where a change rebuilds the ring like a resize. Price and upkeep x `1 + 0.5 x (lanes - 1)` on top of the size's (`ringCost`).
- **Geometry:** the ring nodes and the outer lane stay at `R`; the extra lanes lie inside (`buildLanes` puts a ring edge's outer lane on its axis), so they take room from the island (`ringIn`), never from the clear radius, and the arms keep meeting the outer lane. Drawn with a dashed line between lanes and, before every arm, an arrow in each inner lane bending out: the spiral to the exit.
- **Lane by how far round:** an entering car takes the outer lane for the next exit and one lane further in per arm it passes first (`ringGoal`), within its arm lane's share (an arm's right lane feeds only the outer lane, the others the rest, the left one the innermost). Lane picking on the arm (`turn`) sends first-exit cars right and far ones left.
- **Moving out:** at each plain ring vertex a car moves one lane out toward its goal (which rises as it passes arms) when `ringGap` allows: room behind the leader in the target lane, a car's length more behind the car it pulls out from behind, no car beside it or close behind in the target lane (back over the chord before), no entering car granted into that lane at either end of the chord. Never at an arm vertex, never inward, never two chords running.
- **Entry:** an entering car yields to the ring lanes it crosses and enters (`ringNear` from its lane out): ring cars in those lanes or heading out into them by the vertex (their goal there), cars moving out into them just past it, and any car leaving there from an inner lane. Two cars of a multi-lane arm may go together (right one to the more outer lane) when the second is at least a car's length behind (`beside`). Ring cars keep back from a car granted onto their next lane.
- **Inner exit:** a car still in an inner lane at its exit (no gap let it out) waits mid-chord for a grant at the exit vertex, given when the outer lanes are clear (`ringNear` from the lane past its own) and nobody else is in the box. If it waits past `REROUTE_S` it reroutes, usually once more round.
- Arcs onto or off a ring past the plain case (arm first lane to outer lane) run at half the corner speed, and cars don't speed up until out of the arc.
- simcheck: a flooded large ring with 2-lane avenue arms carries more cars a minute with 2 lanes than 1, and with 3 than 2 (about 72 / 76 / 78); cars ride inside and move out; inner exits are always granted; nothing overlaps on lanes, across nodes or on screen between ring cars.

**Lights stay useful.**
- A 1-lane ring admits about one car per `MERGE_GAP` s under load per entry; more ring lanes add a little (side-by-side entries, first-exit cars ignoring the inner lanes).
- A light with 3-lane arms and protected lefts moves 2-3 lanes at once.
- Rings win at medium, balanced flows. Lights win on big unbalanced crossings and in tight grids where a ring doesn't fit. Map 7 is built around that (section 4).

**Migration:** on load, every node with `control: 'roundabout'` (old saves) is rebuilt as `setControl` would: driveways joining inside the clear radius are taken up, the largest size from its saved `ring` down that `ringRoom` accepts is built (else a plain junction), and `connect()` lays the driveways again outside it. Its lane connections are dropped: a ring arm has one move. Saves keep `v: 1` and gain `rings` (with `spokes?`, one per ring node, null between arms, and `lanes?`, absent = 1) and `edges[].ring` (indexes).

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

### G1 as built (where it differs from the above)
Code: `src/core/Zones.ts` (lots, brush, demand, access, growth, abandon), `Game.bank()` / `repay()`, numbers in `TUNING` and `TIER_DEFS`.
- **Lot front edge** sits `DRIVE_GAP` (12 px) past the road's edge, not 2 px: the driveway length every building already uses.
- **Legacy** is `Building.tier = 0`, not `lots = []`. Every legacy building (an old save's, the starter town's) gets one lot of its zone under it, as wide as the building (`w = max(LOT_W, w + 4)`). It keeps its old footprint and capacity until it is cleared, then the lot grows a tier-1 building. `Lot` stores its geometry (front middle, angle, width), not an edge: the frontage road is looked up (`frontage()`), so splits and bends need no bookkeeping. Empty lots whose road went, or that a new road runs over, are dropped on the next spend.
- **Erase** starts only from a press on a lot of the held zone (a press on the road paints). Re-zoning or unzoning built lots needs no second click: the preview turns red and says `demolishes N buildings`, and Esc cancels.
- **Brush** cuts lots along the whole network path from the press to the cursor, centred on it (`cut()`), not per edge from the middle.
- **Demolish** of a building is free and its lot stays zoned. Move only works for buildings without lots (none in normal play); the place tool stays for G2's specials.
- **Upgrade** timers come with the tiers in G2. G1 only has tier 1.
- **Unconnected buildings** keep no countdown (their people move out by the happiness rule, as before). Homes move in faster with better access: the fill rate is `x (0.5 + A)`.
- **Causes:** `Drivers give up on the way`, `Trips take Nx longer than on empty roads`, `Jam on its street` (no street names yet), `No job within reach`, `No shop within reach`, `Not enough workers`, `Noise from a busy road`, `Pollution from factories nearby`. The pin's hover draws a dashed line to the longest stop of its recent trips, or to its street.
- **Bank:** no money panel exists yet, so a `Loan $N` chip in region A repays `LOAN_STEP` on click. `Frozen` uses the danger chip.
- **Levels** stay for unlocks and grants until G3 replaces them. Batches and the tray are gone. Saves no longer write `tray`.
- Not done: the Grid tool's `Zone blocks` toggle.

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

### G2 as built (where it differs from the above)
Code: `TIER_DEFS`, `LEGACY`, `SPECIALS` and the G2 numbers in `TUNING` (`config.ts`); upgrades in `Zones.ts` (`upgradeBlock`, `nextLots`, `upgrade`, `downgrade`); specials in `Game` (`specialWhy`, `specialLimit`, `specialsHour`, `tripsPerDay`); art in `src/rendering/TierArt.ts`.
- **Unlocks** are city levels until G3's maps: each `TierDef.level` / `SpecialDef.level` is the map number in the tables above (tier 1 of every zone is level 1). Locked buttons and the building card say the level.
- **Visitors:** corner shop 2/day and store 4/day (the table lists none), so small shops still trade with linked exits as they did in G1. Legacy buildings keep the old `VISITS`, `TRUCKS_PER_DAY`, `POLLUTION_R` (`LEGACY`).
- **Upgrade timer** reuses `upH` (hours good; while abandoned it still counts toward recovery). It stops at `UPGRADE_H`, so a building waiting for its neighbour lots upgrades the hour they free up. Demand is the one computed that hour. A frozen city does not upgrade.
- **Extra lots** must be in line: same angle (within ~3°), fronts within 2 px, sides touching. Lots round a curve never merge. The far side along the frontage is tried first. The new footprint must clear other buildings and roads (SAT). The door moves to the middle of the lots and the driveway is laid again (`Game.rehome`). Cars heading there re-path.
- **Downgrade** keeps the first lots in frontage order and the residents that fit; workers over the job slots lose the job. The feed says `Townhouses shrank to House: <cause>`. Only tier 1 is abandoned.
- **Noise:** a logistics park adds noise `0.5 x staffed` at homes within `NOISE_R`. A tower home multiplies its noise part by 1.5 (`noiseX`).
- **Specials** work as a zone (`kind`): plaza = shop, terminal = industry (no pollution, no imports of its own), stadium and hospital = office. They have no lots, are never abandoned or upgraded, and only get an access score. Setting one down (or moving it, or placing any building without lots) un-zones the empty lots under it or within 4 px of it (`pruneLots`, `blocked` in `Zones.ts`), and the brush paints none there; lots with a grown building refuse the placement (`Overlaps a building`). Demolishing it frees the ground but restores no lots. Placing one opens its card. Limits: plazas 2, stadium 1, hospital `max(1, floor(pop / 2,000))`, terminal one per linked exit and within 400 px of an exit. Demolish refunds 50% (nothing in Creative).
- **Terminal:** with one in reach, a factory's exports and imports (and a short shop's imports) go to or come from the terminal (paid as a delivery, `TAX_FREIGHT`). The terminal's own 30 trucks/day x staffed drive to the exit and pay exports x1.5. ponytail: its truck count does not follow the goods routed through it.
- **Stadium:** a basic match day already runs in G2 on even days. The feed warns at 12:00; fans `min(240, 60 + pop / 15)` set off half at 17:00 and half at 18:00 (40% from linked exits, the rest from homes, as `visit` trips); $25 for each arriving before 19:00; they leave 22:00-23:00. G5 adds the countdown ring and the $2,000 on-time bonus.
- **Hospital:** emergency calls (purpose `emergency`, red; vehicle kind `ambulance`, never random) at `pop / 200` a day shared among the hospitals, to a home picked by residents; it waits `CALL_STAY` 0.25 h and drives back. Calls pay nothing. Outbound within 1.3x its ideal = Fast: homes within 300 px get +3 happiness for a day (`Building.cheer`). Priority (`RoadGraph.update`): its lane goes first, a light switches to a phase that lets it go once it is within `AMB_R` 60 px, a yield treats it as the main road, a stop lets it roll.
- **Art:** `Building.art` picks the model: a special's own, `home2`..`home4`, `shop2`, `shop3`, `office2`, `industry3`, `workshop` (tier 1 industry), `industry2` (= the factory). Detail depends on the tier and lot count (units, bays, docks). Variants are still seeded by position, not building id. Neighbour-aware detail is not done.
- **Save:** `buildings[].special?` (null) and `cheer?` (0). No version bump.
- **HUD:** the Build menu has a Specials group (picture, name, price, lock). The building card shows `Tier n of m · next: <name> (<lots> lots)` and what blocks it, or the hours left. A special's card shows its effect, upkeep and trips a day. The ghost label is `<name> · +N trips/day · $cost · upkeep $u/day`.

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
| 1 | Meadowbrook | temperate small, `meadowbrook`, one gentle river, no mountains, no exits | dirt and street only | pop 300 | 80% | $9,000 | $20,000 | roads, Residential, Commercial and Office zones, Edit, Demolish (scripted tutorial, section 6) | start |
| 2 | Two Bridges | temperate small, a wide river across the middle; starter offices north, homes south | every crossing is a bridge (x4) | pop 600; 25 trips/h | 75% | $20,000 | $30,000 | avenue, bridges, townhouses, Grid tool, heat map | 1★ |
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

### G3 as built (where it differs from sections 4, 5 and 10)
Code: `src/core/Campaign.ts` (`MAPS`, `cfgFor`, objectives, `grade`, run counters), `src/core/Profile.ts`, `Game.run` / `runHour` / `count` /
`permanent`, the map select, Endless/Creative setup and profile page in `Menu.ts`, region O and the Map complete modal in `HUD.ts`.
- **Unlocks keep their `level` fields**, now read as the map number (`Game.unlockLevel`: the map's number in Campaign and Challenge,
  `cfg.unlock` in Endless, everything in Creative and in an Endless run without `cfg.unlock`, such as an old career save).
  Remapped: grid 2, roundabout and one-way 3, viaducts and tunnels 4, junction editor 5 (lane connections, phases and protected lefts
  stay one feature), boulevard 5. Office zone = Office tier level 2, Industrial zone = Workshop level 4 (the brush refuses a locked zone).
  `LEVELS` stays as Endless milestones (grants only); campaign maps have no level-ups.
- **Endless tools are not stored:** `toolLevel(profile)` = the highest map with a star. `GameConfig.unlock` carries it, and starting an
  Endless game raises it to the profile's current value.
- **Bridges and the heat map are not locked** on map 1 (not done; bridges are already x4).
- **Maps:** seed = map id; `terrain` fixes the river, mountain, lake and exit counts so the Challenge (Hard) map is the same. No
  hand-placed layout (map 2's river is wherever its seed puts it). Bonus maps B1/B2 and Daily: not done.
- **Counters:** rolling 24 h by hour of day (`run.h`, `run.cur`): finished trips and smooth ones (flow), arrivals (trips/h, trips at an
  hour), exports (freight reaching an exit), visitors (a visit from an exit). Match share is kept at `MATCH_END` (fans sent vs on time);
  ambulances are the last 10 outbound legs. Objectives are checked on the hour, not every frame.
- **Network spend** = every `spend()` except zoning, net of refunds (`run.spent`).
- **Through traffic** (map 6): `visit` trips between linked exits, `through / 24` an hour; exit-to-exit trips pay nothing.
- **Challenge:** permanent = demolishing a road or removing a control from an earlier day, or retyping a run to a cheaper type, is
  refused. Bends and specials are not covered. Gridlock needs at least 20 finished trips that day.
- **Profile:** `{ v, stars, best, challenge, achievements, tips, tipsOff, stats: { trips, seconds } }`. Daily, cosmetics, progress and
  roadsPx wait for G4. Trips are tallied at each autosave; seconds count while the game runs with the menu closed.
- **Tour:** runs only on Campaign map 1, until it has been seen once.
- **Region O** is a row inside the resources panel (it follows its wrap at every width), foldable. It shows the map's goals, the
  ★★/★★★ bars, `New here:` (the map's unlocks), and the Challenge deadline.
- **Save:** `run?` (defaults to `run0()`); `cfg.mode: 'career'` loads as `'endless'`; slot lines drop `Lv`.

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
- simcheck plays the steps through on the real Meadowbrook with a scripted newcomer, then on to 300 residents and a star.

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

### G6 as built (where it differs from the above)
Code: `src/ui/Tutorial.ts` (`tutorialSteps`, `stepDone`, the card), `src/ui/Tips.ts` (`dueTip`, the tip card), `Game.note` / `news` /
`newsN`, the bell and feed panel and region O's checklist in `HUD.ts`, `CanvasRenderer.centerOn` (eased) and its off-screen markers.
- **Office zone opens on map 1** (Office tier 1 level 2 -> 1). Without it map 1 stalled at about 240 residents: shops alone never give
  enough jobs, so R demand went negative below the 300 goal. Map 2 no longer teaches it.
- **Steps:** as the table, except step 6 asks for 2 Commercial *and* 2 Office lots plus 1 shop or office grown, and step 7 is "Check the
  traffic": the heat map on and every road's heat under 0.4 (no scripted 8:00 jam, no hour of calm: a forced jam can strand a newcomer).
  Step 4 has no dashed brush path, only the ring on the longest road. Steps with a goal move on 1.2 s after it is met; 1 and 8 take Next /
  Finish. Growth x4 (`TUT_GROWTH`) and the $20,000 top-ups run for the whole script, events, milestones and grading wait until it ends.
  Step 2 finds the starter homes and office by position on each check, so an undo (which replaces every Building) or a demolished home
  never strands it.
- **Region O** shows the 8 steps as a checklist (done, current with its bar, to come) while the script runs; the card (region F) holds the
  explanation, the step's `n / of` and Skip. A save made mid-script loads without it.
- **Seen once per profile:** `profile.tips` gets `'tutorial'` on Skip or Finish (`tm_tutorial_done` still counts). The help panel's button
  starts a new Meadowbrook with the script (after a confirm when the city is past day 1; that city is saved to the first empty slot first, as the tutorial's own midnight autosave replaces the autosave, and the confirm says so, or that every slot is full).
- **Tips:** checked twice a second, not while the script runs, a modal is up or the menu is open; a tip closes itself after 20 s and has
  Show me (jumps) when it has a spot. Thresholds simplified: jam = any road heat > 0.7 now; demand > 0.5 (not 0.8 for a day) with
  100+ residents; unhappy = under `GROW_LO`. Added: "Homes stopped growing: people need jobs" (R <= 0, O > 0.2). The milestone tip
  fires after the first pick. Tool tips for grid, light, roundabout, interchange, Edit and Demolish (road and zones are the tutorial's).
  The toggle and "Show seen tips again" are on the Profile page.
- **Feed:** `Game.note(text, at?)` says it and keeps the last 40 (not saved): bank loans and repayments, downgrades and abandons (at the
  cause, else the building), events (start at the road or target, rewards, call-offs), match day, exit linked, new best stars,
  milestone picks, achievements. The bell (N) shows an unread badge; a row with a spot eases the camera there.
- **Off-screen arrows:** accent discs at the screen edge for the tutorial's targets (objectives other than the script have no spot).

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

### G4 as built (where it differs from the above)
Code: `src/core/Achievements.ts` (`ACHIEVEMENTS`, `checkAch`, `owned`), milestones in `Campaign.ts` (`milestonePop`, `offersFor`,
`takeOffer`, `UPGRADES`), `Game.milestone/offers/spare/upgrades/tokens/feats`, the choice modal and achievement toast in `HUD.ts`, the
profile page's achievements grid and cosmetics picker in `Menu.ts`, paint sets in `VehicleArt.ts`, island decor in `CanvasRenderer.island`.
- **26 achievements:** Daily Driver is not in (no Daily mode); Pastel paint moved to Smooth Operator. Weather the Storm and Detour Master
  are listed but only G5 sets their counters (`feats.rain`, `feats.detour`).
- **Counters live in `Game.feats`** (saved with the city), not `profile.progress`: streak, paint, amb, clover, debtfree, loaned. So
  Smooth Operator's 1,000 trips are per city. `Game.fv` bumps on each; main.ts checks on every hour and every bump.
- **Simplified predicates:** Mall Rat = ≥ 50 of the last 200 trip reports to a Mall / plaza with mean stopped time under 20 in-game
  minutes (`TripReport.stopped`, absent in older saves). Quiet Streets = city noise part < 0.1. Lane Wizard = 3 junctions with an edited
  plan and mean junction `delay` < 5 s. Bridge Builder counts bridge runs by their ends.
- **Bonus maps** Lakeside Loop (B1) and Canyon Gate (B2) are in `MAPS` with `bonus: <achievement id>`; `mapOpen` checks the achievement.
- **Milestones:** Endless no longer pays level-up grants (city levels are counted only; the level-up modal is gone), the people bar
  shows the next milestone. None while the tutorial runs. An old save's milestone count = milestones at its population.
- **Upgrades: 4 of 8** — Road crew, Zoning office (erasing a lot refunds nothing with it), Bank deal, Sound walls. Smart lights,
  Wide rings and Express lanes need the car or junction to read the game's upgrades: not done. Tow trucks waits for G5.
- **Special tokens:** `Game.tokens`; the Build menu card shows Free. A token-built special still refunds on demolish (ponytail).
- **Save:** `ms?: { n, offers, spare, upgrades, tokens }`, `feats?` (an old save with a loan gets `loaned`).
- **Profile:** adds `cosmetics: { paint, island }` (defaults Classic / Grass); unknown values fall back.

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

### G5 as built (where it differs from the above)

- **Code:** `src/core/Events.ts` (`EVENTS` table, `eventsHour` on the hour, `eventsTick` every tick). The graph's `shut` / `slow` / `wet` are rebuilt from the live events each tick; `findPath` skips `shut` edges and divides cost by `slow`; `Car.top(e, graph)` multiplies by `graph.speedX(e)`. A car whose next edge gets shut re-routes unless its turn is already granted.
- **Kinds:** roadworks, accident, rain and VIP convoy are events. Match day keeps G2's schedule and adds the countdown ring on the stadium (noon to kickoff) and the $2,000 bonus at ≥ 85% fans on time. Emergency calls stay G2's hospital behaviour (no event wrapper). Requests are not built yet.
- **Roadworks:** the warning starts 08:00-15:00 (closed 09:00-16:00 at the latest start), only on an edge with a way round in every direction it is driven.
- **Accident:** ponytail: no lane is physically blocked; cars on the edge drive at x0.35 both ways and routes price it accordingly. The reward pays the moment the queue (stopped cars on the edge) drops under 3, from 15 min in. No Tow-truck shortening.
- **Rain:** ponytail: top speed x0.8 only (braking and headway unchanged). A dark wash fades in through the warning; streaks while live.
- **VIP convoy:** 3 `visit` trips flagged `trip.vip` (gold pennant on the roof) from a linked exit to an office tower or the stadium; it ends when all 3 arrive or after 3 h. All 3 within 1.5x ideal pay $3,000.
- **Smooth share** for roadworks and rain = new smooth trips / new arrivals since it went live (1 when none arrived).
- **HUD:** an orange chip next to the alarm lists the events with time left (or "in" while warning); its tip gives each quest and reward. Messages go through `say()` until G6's feed.
- **Gating:** `eventsOn` = not the tutorial, not `demandOff`, and in Creative only with `cfg.events: 'on'` (the Creative setup's Traffic events toggle, Off by default).
- **Save:** `ev?: { list, next, last }` with edge / building indices; an old save gets no events and `nextEventAt = time + 4 h`. An event whose edge or target is gone (split, demolished) is called off.

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
// G7: Game.edits, Game.fx (not saved); the undo stacks live in main.ts
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

### G7 as built (where it differs from the above)
- **Undo is a snapshot, not an inverse.** Every press (pointerdown) serializes the game; if a spend follows (`Game.edits`), that save becomes an undo step. Undo loads it back into the same `Game` object (`Save.restore`), keeping tool settings, the feed and the terrain. So it also rewinds the clock to that press, and cars go back to their doors, as on a load. Money comes back exactly because it is part of the save.
- **Limits:** 30 steps. A step older than 6 game hours is dropped instead of the midnight clear. Undo is off in Challenge, rather than limited to today. Lane-link edits and other changes without a spend are not undo steps.
- **No dock buttons:** keys only (`Ctrl+Z`, `Ctrl+Y` / `Ctrl+Shift+Z`), listed in the controls panel and README.
- **Cues built:** jam cleared (heat > 0.7, then < 0.35, checked once a game second; 10 sparkles in a ring, a three-note bell at most every 2 s), coin pop (`+$n` over the building, at most one per quarter game second), a stars fanfare when the grade modal opens (one phrase, not per star), and an achievement chime. Grow, upgrade, downgrade, paint ticks, milestone and event cues are left out.
- **Music:** two layers over the loop, following the share of on-screen cars that are moving. A shaker comes in above 40% moving, and an arpeggio when it is busy and above 65% moving. They fade over 3–4 s, so a jam thins the music. No bass threshold, rush-hour percussion or Am7 tension.

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
- **T1:** at an avenue / street T with auto signs, an avenue car at speed keeps at least 97% of it while a street car turning into its lane waits for it; a street right turn with only far-lane traffic, and a left with none, keep their speed; a stop sign brings the car to a standstill first. The final line prints the main city's and the rush hour's smooth-trip share.

---

## 14. Priority signs and right of way (T1)

TM:PE-style signs on the sign control (`yield`; the picker says **Signs**). Each approach carries one sign, stored in the junction plan as `signs[approach]` (`0` priority road, `1` yield, `2` stop; `null` or missing = auto). Auto: the main road (`mainEdges`, the highest tier, more lanes break ties, the straightest pair) has priority and the side roads yield. Old saves have no `signs`, so they load as auto. A plan reset (its roads changed) drops them with the rest. All-way stop stays its own control.

- **Editing:** the junction panel draws the arms with a sign beside each incoming lane; a click cycles priority road, yield, stop. **Auto signs** clears them. On the map (Edit tool, junction open) a click on a sign post does the same. Signs come with the control, so the junction editor's level lock (phases, lane connections) does not hold them.
- **Icons:** a yellow diamond (priority road), a red-rimmed give-way triangle, a red octagon, on posts past the kerb. They are drawn larger on top of the lane editor while the junction is open.
- **Rank:** lower goes first. Priority straight or right is 0, priority left (and U-turn) is 1, yield and stop are 2. An ambulance (or its lane) ranks as priority.
- **Grant rule (`RoadGraph.update`, sign junction):** a car is held only by a real conflict, never by a sign alone. It waits for:
  - a car in the box whose path crosses or merges with its own;
  - a better-ranked car crossing it that is queued at the junction, or that would reach the box before it could stop plus `CLEAR_S` (1.2 s) of travel. The gap is `CLEAR_M` (1.6) times that when merging into the same road out, since the merging car still has to get up to speed. This is `giveWay`, which looks back up to 300 px over plain bends;
  - an earlier same-ranked car that crosses it (first come, first served).

  A stop sign first needs a standstill at the line. A right turn into the near lane, parallel flows, and a merge with no traffic coming keep their speed. Priority traffic never brakes for a yielding car that is merely waiting.
- **Courtesy:** a worse-ranked car that has been at the front of its lane for `STARVE_S` (4 s) with room to go holds the crossing traffic that has not been granted yet, so a side road never waits until it gives up. While starving, it ignores priority cars that can still stop.
- **Early grant:** a car with right of way (a plain junction, or a priority approach) joins the queue where it can still stop (`RoadGraph.queueAt`: at least 70 px, up to its braking plus reaction distance). It does so only behind a car that is already queued. A clear junction then grants it before it has to slow down. Lights, stop signs, ring entries and driveways keep 70 px.
- Lights, all-way stops, roundabouts and driveway merges are unchanged.
- **Measured** (simcheck, seed `simcheck`): main city smooth trips 97.5% before and 97.5% after. Its junctions are a light, a ring and a plain T, so nothing there changed. Rush-hour town (one sign T) went from 83.4% to 83.7%.
