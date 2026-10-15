# TrafficMania gameplay design: the traffic-management pivot

Target: a traffic-management city game. The gameplay logic follows *Traffic Architect* (buildings generate trips, the player designs the network, every car is simulated and routes around traffic, analysis tools show the bottleneck). The presentation and city layer follow *Trafficity* (flat 2D top-down, a simple zoned economy, level-ups hand you a batch of buildings to place). The art stays our own flat style.
Out of scope: public transport and rail, map editor, Workshop, multiplayer. Outside (map-edge) connections came in with P6.
Rule for later steps: where this spec and the code disagree, the code wins for what exists and the spec wins for what is new. Deviations are written back into this file by the step that makes them.

Kept as-is: the pen-tool road placement (auto tangents, bend by drag), elevation 0..10 (viaducts, tunnels, L6+ clears mountains), lanes 1/2/3 per direction plus one-way, the Edit tool (select a run, retype, flip, bend), and all the car physics in `Car.ts`/`RoadGraph.ts` (lane by turn, lane changes, don't block the box, deadlock breaker, vehicle kinds, turn arcs, brake lights, roundabout ring). The flat look also stays: white roads with a gray outline and a thin yellow centre line, periwinkle water, layered gray mountains, soft shadows, small outlined cars.

Removed (Mini Motorways): coloured cities that spawn cars to cities of the same colour, the asphalt/bridge/tunnel/light/roundabout inventory, weekly reward cards, the overcrowding ring and its game over, random city spawning, week dots.

---

## 1. Core loop, modes, fail conditions, progression

Loop: buildings generate trips (commute home->work and back, shopping home->shop and back, freight industry->shop and back). Cars drive them through the player's network. The player watches the congestion map, the trip feed and the metrics, then finds the bottleneck and fixes it (tier, lanes, one-way, light phases, protected lefts, turn bans, roundabouts, overpasses, interchanges). Good trips raise happiness and taxes, which pay for more roads. Population milestones level the city up, and each level grants a batch of buildings to place plus new tools.

| Mode | Money | Upkeep | Fail | Unlocks | Buildings |
|---|---|---|---|---|---|
| Career | starts per difficulty | yes | bankruptcy, happiness collapse | by level | starter town, then level batches |
| Creative | `Infinity`, shown as `∞` | no | none | all from the start | starter town, plus an unlimited tray of every zone |

Career fail conditions, checked at midnight (00:00) only, and never while `tutorialActive`:
- **Bankrupt**: `money < 0` at `DEBT_DAYS` consecutive midnights. Building is blocked whenever the cost exceeds the money (`Not enough money`), so only upkeep can push the balance below zero.
- **Residents left**: city happiness below `FAIL_HAPPY` at 2 consecutive midnights, from day 4 on.
- The danger chip counts down: `Debt: 2 days to bankruptcy` / `Unhappy: 1 day left`.

Victory: reaching level 10 opens a "City complete" modal with the stats. Continue = endless mode, where each further +300 population grants the endless batch.

### Difficulty (starting numbers)

| | Easy | Normal | Hard |
|---|---|---|---|
| Starting money | $60,000 | $40,000 | $25,000 |
| Tax multiplier | 1.25 | 1.0 | 0.8 |
| Upkeep multiplier | 0.75 | 1.0 | 1.25 |
| Trip-rate multiplier (shopping, freight) | 0.8 | 1.0 | 1.2 |
| Growth multiplier (occupancy fill rate) | 1.25 | 1.0 | 0.8 |
| `FAIL_HAPPY` | 15 | 25 | 35 |
| `DEBT_DAYS` | 5 | 3 | 2 |
| Rivers | 1 | 1-2 | 2 |
| Mountains (before the biome bonus) | 2-3 | 3-5 | 5-7 |

### Progression (career)

Zone capacities: home 30 residents, shop 10 jobs, office 30 jobs, industry 25 jobs. Workers are 50% of residents. The cumulative home capacity after each batch is about 1.35x the next milestone, so a city needs happy homes (high occupancy) to level up.

| Level | Population to reach | Unlocks | Batch (homes / shops / offices / industry) | Cumulative h/s/o/i |
|---|---|---|---|---|
| 1 | start | dirt, street, ground bridges, light, Edit, Demolish | pre-placed 4/1/1/0 + tray 6/1/3/0 | 10/2/4/0 |
| 2 | 220 | avenue, one-way, roundabout | 6/1/2/0 | 16/3/6/0 |
| 3 | 400 | viaducts L1-5, ramps | 7/1/1/2 | 23/4/7/2 |
| 4 | 580 | boulevard, light phase editor, protected lefts, turn bans | 8/2/2/1 | 31/6/9/3 |
| 5 | 800 | Grid tool, L6-10, tunnels | 9/1/3/1 | 40/7/12/4 |
| 6 | 1000 | highway, Interchange tool | 10/2/3/1 | 50/9/15/5 |
| 7 | 1250 | none | 10/1/3/1 | 60/10/18/6 |
| 8 | 1500 | none | 12/2/4/1 | 72/12/22/7 |
| 9 | 1800 | none | 12/2/4/1 | 84/14/26/8 |
| 10 | 2100 | victory | endless: 6/1/2/1 per +300 | |

- A level-up grants `LEVEL_GRANT x level x taxMult` of money ($2,000 x level on Normal).
- Pre-placed homes start at 60% occupancy (start population 72). Placed homes start at 40%.
- A level-up opens a modal (it pauses the game like the old reward modal) that lists the unlocks and the batch. Enter continues.
- The batch goes into the tray. Unplaced buildings cost nothing, but you cannot reach the next milestone without them.

---

## 2. Data model

New file `src/core/config.ts` holds `GameConfig`, `DIFFICULTY`, `BIOMES`, `SIZES`, `TIERS`, `ZONES`, `LEVELS` and `TUNING`. No other file defines a gameplay number.

```ts
// src/core/config.ts
export type Mode = 'career' | 'creative';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Biome = 'temperate' | 'desert' | 'alpine' | 'archipelago';
export type MapSize = 'small' | 'medium' | 'large';
export interface GameConfig { seed: string; mode: Mode; difficulty: Difficulty; biome: Biome; size: MapSize }
export const DEFAULT_CONFIG: GameConfig = { seed: 'trafficmania', mode: 'career', difficulty: 'normal', biome: 'temperate', size: 'medium' };
export const SIZES: Record<MapSize, { w: number; h: number }> = { small: { w: 2000, h: 1200 }, medium: { w: 2600, h: 1560 }, large: { w: 3200, h: 1920 } };
export const DIFFICULTY: Record<Difficulty, { money: number; tax: number; upkeep: number; trips: number; growth: number; failHappy: number; debtDays: number; rivers: [number, number]; mountains: [number, number] }>;
export type Tier = 'dirt' | 'street' | 'avenue' | 'boulevard' | 'highway';
export const TIERS: Record<Tier, { label: string; limit: number; kmh: number; lanes: (1 | 2 | 3)[]; oneWay: boolean; cost: number; noise: number; access: boolean; level: number }>;
export type Zone = 'home' | 'shop' | 'office' | 'industry';
export const ZONES: Record<Zone, { label: string; w: number; h: number; residents: number; jobs: number; color: string; level: number }>;
export const LEVELS: { pop: number; unlock: string[]; batch: Record<Zone, number> }[];
export const TUNING = { /* section 3 */ } as const;
```

| Type | Lives in | Change |
|---|---|---|
| `rng` | `src/util/rng.ts` (new) | `mulberry32(n)`, `hashSeed(s)` (FNV-1a), and a module stream `random()` with `setSeed(n)`. Every model `Math.random` (MapGenerator, Car drivers, trips) goes through `random()`. Terrain uses its own `mulberry32(hashSeed(seed))`, so placing buildings never changes the map. `simcheck` calls `setSeed(12345)` instead of patching `Math.random`. |
| `WORLD` | `MapGenerator.ts` | stays a `const` object. `w`/`h` are assigned from `SIZES` in `new Game(cfg)`. |
| `Terrain` | `MapGenerator.ts` | adds `biome: Biome`. `generateTerrain(cfg)` is deterministic per seed. |
| `RoadType` | `RoadGraph.ts` | `{ tier: Tier; lanes: 1\|2\|3; oneWay: boolean }`. Lanes are clamped to `TIERS[tier].lanes`. `DEFAULT_TYPE = { tier: 'street', lanes: 1, oneWay: false }`. |
| `Edge` | `RoadGraph.ts` | `refund` is removed. Adds `day: number` (the build day, for the refund rule), `drive: boolean` (an auto driveway: free, no refund), `heat: number` (congestion EMA 0..1). The level is still per edge. |
| `Node` | `RoadGraph.ts` | `city` -> `building: Building \| null`. Adds `junction: JunctionPlan \| null` (null = default: no bans, default phases) and `delay: number` (wait EMA, seconds). |
| `Building` | `src/entities/Building.ts` (replaces `City.ts`) | `{ id; kind: Zone; x; y; angle; node: Node /* door */; residents; pending: Trip[]; parked: Trip[]; happy; parts: {job, shop, trips, pollution, noise}; stock /* shop goods */; staffed /* 0..1 */; shopAcc; truckAcc; retryTimer }`. The door node sits at the front centre, 10px outside the footprint. `DOOR_R = 14` replaces `CITY_R` for snapping. |
| `Commuter` | `Building.ts` | `{ home: Building; work: Building \| null; depart: number /* hour */; at: 'home' \| 'driving' \| 'away' }`. One commuter = `PEOPLE_PER_CAR` workers. |
| `Trip` | `src/entities/Trip.ts` (new) | `{ purpose: 'commute' \| 'return' \| 'shop' \| 'freight'; from: Building; to: Building; who: Commuter \| null; kind: Kind; queued; departed; ideal /* free-flow s */; idealLen; driven; stopped; retries }` |
| `TripReport` | `Trip.ts` | `{ purpose; from: number; to: number; outcome: 'smooth' \| 'wait' \| 'detour' \| 'gaveup' \| 'noroute'; seconds; day; hour }` |
| `Car` | `Car.ts` | adds `trip: Trip`. `dest`/`origin` become getters onto `trip.to`/`trip.from` (the physics code is unchanged). `color` is picked at spawn from `CAR_COLORS` (8 muted colours), and trucks get a cargo box in `#F4F3EF`. |
| `JunctionPlan` | `src/network/Junction.ts` (new) | see S8 below |
| `Economy` | `Game.ts` | `money: number`, `ledger: { today: Ledger; yesterday: Ledger }`, `Ledger = { taxes; business; upkeep; build; grants }` |
| `Metrics` | `src/core/Metrics.ts` (new) | a ring of hourly `Sample { day; hour; queued; avgTrip; throughput; money; population; happiness }`, max 168 (7 days) |
| `Game` | `Game.ts` | `new Game(cfg = DEFAULT_CONFIG)`. Adds `cfg, money, ledger, level, tray: Record<Zone, number>, placing: Zone \| null, placeAngle, buildings, commuters, reports (last 200), metrics, stats {arrived, failed, today: Record<Outcome, number>}, happiness, overlay: 'none' \| 'heat', follow: Car \| null, inspect: Node \| Building \| null, pendingLevel, gameOver: '' \| 'bankrupt' \| 'unhappy', victory`. `score` stays (= trips arrived). `Tool` adds `'grid' \| 'interchange' \| 'place'`. |
| `SaveData` | `src/core/Save.ts` (new) | see S11 below |

Removed: `City`, `CITY_COLORS`, `MAX_PENDING`, `OVERCROWD_SECONDS`, `City.overcrowd/overTimer/demandTimer`, `Inventory`, `Reward`, `REWARDS`, `pendingReward`, `applyReward`, `afford(cost: Inventory)`, `Edge.refund`, `spawnCity`, `cityTimer`, `MAX_CITIES`, `CITY_SPAWN_SECONDS`, `week`, `lastWeek`, `randomKind`'s truck share (trucks come from freight only). `randomName` stays for the map name.

---

## 3. Simulation

### Constants (`TUNING`, all in `config.ts`)

```ts
DAY_SECONDS: 240,          // game seconds per in-game day at 1x; 10 s per hour; the clock starts at Day 1 06:00 (S5: was 120)
PEOPLE_PER_CAR: 5, EMPLOY_RATE: 0.5,
COMMUTE_MEAN: 8, COMMUTE_SD: 0.75, COMMUTE_MIN: 6, COMMUTE_MAX: 10, WORK_HOURS: 9,
SHOP_RATE: 0.35,           // shopping round trips per car-unit (5 residents) per day
SHOP_CURVE: [0,0,0,0,0,0,0,.2,.4,.7,1,1.2,1.2,1,.9,.9,1,1.3,1.3,1,.6,.3,0,0], // per hour, normalised at load
SHOP_STAY: 1,              // in-game hours parked at the shop
TRUCKS_PER_DAY: 8, TRUCK_HOURS: [6, 18], STOCK_PER_TRUCK: 10,
GRAVITY_D: 900,            // px, destination weight = capacity * exp(-d / GRAVITY_D)
SPAWN_FAIL: 3,             // in-game hours waiting at the door -> 'gaveup'
MAX_RETRIES: 1, MAX_CARS: 450,
SMOOTH_X: 1.5, WAIT_SHARE: 0.4, DETOUR_X: 1.3,
POLLUTION_R: 260, NOISE_R: 100,
W_JOB: .25, W_SHOP: .20, W_TRIPS: .55, W_POLL: .40, W_NOISE: .30,
GROW_HI: 60, GROW_LO: 30, GROW_FAST: .25, GROW_SLOW: .10, SHRINK: .10, // happiness bands, share of capacity per day
TAX_RES: 5, TAX_COMMUTE: 2, TAX_SHOP: 4, TAX_FREIGHT: 25, LEVEL_GRANT: 2000,
UPKEEP_RATE: 0.02,         // of build price per day
REFUND_SAME_DAY: 1, REFUND_LATER: 0.5,
LIGHT_COST: 600, LIGHT_UPKEEP: 4, ROUNDABOUT_COST: 1200, ROUNDABOUT_UPKEEP: 2,
BRIDGE_X: 4, VIADUCT_X: 2.5, VIADUCT_LEVEL_X: 0.1, TUNNEL_X: 5,
HEAT_TAU: 10, ACCESS_R: 60,
```

### Day clock
`hour = (time / DAY_SECONDS * 24 + 6) % 24` and `day = floor((time / DAY_SECONDS * 24 + 6) / 24) + 1`. The hourly tick (every 10 game seconds) runs happiness, growth, taxes, upkeep, demand accrual and the metrics sample. At 03:00 the daily commuter assignment runs. At 00:00 the game checks the fail conditions, rolls the ledger (`yesterday = today`) and resets `stats.today`.

### Trip generation
- **Commuters.** Each home has `floor(residents * EMPLOY_RATE / PEOPLE_PER_CAR)` commuters. Assignment (at 03:00 daily, and one in-game hour after any building or network change) gives each unassigned commuter a reachable workplace (shop/office/industry) that has free slots (`jobs / PEOPLE_PER_CAR`). The pick is gravity-weighted: `w = freeSlots * exp(-dist / GRAVITY_D)` (Euclidean). A commuter whose workplace became unreachable loses it. Its `depart` hour is drawn once from N(8:00, 0.75h), clamped to 6..10. At `depart` a `commute` trip is queued. When it arrives, the trip moves to `work.parked` and the commuter is `away`. At `depart + WORK_HOURS` a `return` trip is queued from work.
- **Shopping.** Per home per hour: `shopAcc += residents / PEOPLE_PER_CAR * SHOP_RATE * SHOP_CURVE[h] * tripsMult`. Each whole unit queues a `shop` trip to a gravity-chosen reachable shop (capacity = jobs). The car stays parked `SHOP_STAY` hours, then a `return` trip goes home. Each arrival is one customer: `stock -= 1` and the shop is paid.
- **Outside connections (P6).** See section 5, P6: once a highway exit is linked, factories export and import, short shops import goods, visitors come to shops and offices, and commuters from outside fill free job slots.
- **Freight.** Per industry per hour within `TRUCK_HOURS`: `truckAcc += TRUCKS_PER_DAY * staffed * tripsMult / 12`. Each unit queues a `freight` truck to a reachable shop. The pick is gravity-weighted by `(1 + max(0, 20 - stock))`, so empty shops pull goods. Arrival: `stock += STOCK_PER_TRUCK`, then an immediate empty `return` truck. `staffed = commuters parked at it now * PEOPLE_PER_CAR / jobs`. No workers means no trucks and no pollution, so a factory only pollutes during work hours.
- **Spawning** reuses `trySpawnCar`: the first pending trip whose route exists and whose first lane has room goes out. Above `MAX_CARS`, trips wait.
- **Reachability**: undirected component ids, recomputed on graph change. `findPath` returning null at departure is the final judge. A trip with no route is reported `noroute` and no car spawns.

ponytail: Euclidean gravity and undirected components. Use network distance and directed reachability only if one-way traps show up in reports.

### Trip outcome
`ideal` = free-flow time of the time-weighted shortest path at departure (`findPath(..., {free: true})`), and `idealLen` is its length. On arrival:
- `gaveup`: the car hit `GIVE_UP_S` more than `MAX_RETRIES` times, or the trip waited at the door for more than `SPAWN_FAIL` hours.
- `wait`: the car was stopped for more than `WAIT_SHARE` of the trip, or the trip waited at the door for more than 1 hour.
- `detour`: `driven > DETOUR_X * idealLen`.
- `smooth`: otherwise, provided `seconds <= SMOOTH_X * ideal`. A slower trip with none of the above counts as `wait`.
- Score per outcome: smooth 1, detour 0.6, wait 0.4, gaveup 0, noroute 0.
- Stuck/lost cars keep today's behaviour: the trip goes back to the origin's pending queue with `retries++`. Demolish and retype keep requeuing for free (no retry counted), so demolishing is never a free way to clear traffic.

### Happiness (per home, recomputed hourly)
- `job` = assigned commuters / commuters (0 when the home has none).
- `shop` = share of the last 24h shopping trips that arrived. When none were made: 1 if a shop is reachable, else 0.
- `trips` = mean outcome score of the last 24h trips from or to the home (0.6 when there were none).
- `pollution` = `min(1, Σ_industry staffed * max(0, 1 - d / POLLUTION_R))`
- `noise` = `max` over edges within `NOISE_R` of `TIERS[tier].noise * (1 - d / NOISE_R) * (0.5 + 0.5 * min(1, 3 * density))`, where density is the `Pathfinder` load
- `happy = 100 * clamp01(W_JOB*job + W_SHOP*shop + W_TRIPS*trips - W_POLL*pollution - W_NOISE*noise)`
- City happiness = residents-weighted mean, smoothed as an EMA over one day. A home with no door edge scores `job = shop = 0`, `trips = 0.6`, which gives 33.
- **Growth**, per hour, as 1/24 of the daily rate: `happy >= GROW_HI`: +`GROW_FAST` of capacity. `GROW_LO..GROW_HI`: +`GROW_SLOW`, but only with a door edge. `< GROW_LO`: -`SHRINK`. Residents are clamped to 0..capacity. Population = Σ residents.

### Economy
- **Road price** = `len / TILE * laneFactor(type) * TIERS[tier].cost * m` (no rounding: money is a float and the HUD rounds, so splits and same-day refunds add up exactly). `m` = `VIADUCT_X + VIADUCT_LEVEL_X * level` for level >= 1; on the ground `m = 1 + (BRIDGE_X - 1) * water + (TUNNEL_X - 1) * mountain`, where `water`/`mountain` are the shares of the edge over water / through a mountain (`segmentCrosses` samples every 6px). So a long road over a narrow river only pays the bridge rate for the wet stretch.
- **Tiers** (cost is $/tile at `laneFactor` 1; `limit` is in px/s, and `MAX_SPEED` = 110 = avenue):

| Tier | Lvl | Limit | km/h (UI) | Lanes | One-way | Cost | Upkeep/tile/day | Noise | Building access |
|---|---|---|---|---|---|---|---|---|---|
| dirt | 1 | 60 | 30 | 1 | no | 20 | 0.4 | 0.05 | yes |
| street | 1 | 90 | 40 | 1 | yes | 60 | 1.2 | 0.15 | yes |
| avenue | 2 | 110 | 50 | 1-2 | yes | 90 | 1.8 | 0.35 | yes |
| boulevard | 4 | 125 | 60 | 2-3 | yes | 140 | 2.8 | 0.5 | yes |
| highway | 6 | 150 | 90 | 2-3 | yes | 220 | 4.4 | 0.9 | no (no doors, no driveways) |

- **Speed limit in `Car.update`**: `target = min(target, vmax * limit / MAX_SPEED)`. Before a node into a slower tier, the car brakes to the next limit the same way it brakes for corners. The driver's `vmax` keeps its ±10% spread, so simcheck's spread check holds.
- **Routing cost** = `length / limit * (1 + 3 * load)`, with heuristic `dist / 150`. This makes highways attract traffic. `{free: true}` drops the load term.
- **Controls**: light `LIGHT_COST` + `LIGHT_UPKEEP`/day, roundabout `ROUNDABOUT_COST` + `ROUNDABOUT_UPKEEP`/day. Demolishing a control refunds it under the road rule.
- **Refund** = price x (`edge.day === today` ? `REFUND_SAME_DAY` : `REFUND_LATER`). The price is recomputed from the geometry, so splits need no bookkeeping. Retype and bend: a price rise is paid in full, a drop (a downgrade, a shorter bend) comes back under the old road's refund rule, so editing never refunds more than demolishing.
- **Driveways** (`drive: true`): free, street tier, 1 lane, no refund.
- **Buildings**: placing one is free. Demolishing one is free and puts it back in the tray (career), so it can go somewhere better; there is no refund because it cost nothing. Moving one costs `MOVE_COST` ($300) in career (free in creative): cheap enough to fix a bad spot, dear enough that shuffling buildings is not a free way to steer traffic.
- **Upkeep**, accrued hourly: `Σ price * UPKEEP_RATE / 24 * upkeepMult` plus control upkeep.
- **Taxes**, accrued hourly: `TAX_RES / 24 * residents * (0.5 + 0.5 * Q_city) * taxMult`. `Q_city` = mean outcome score of today's trips (0.6 before any trip).
- **Business**, paid on arrival x `taxMult`: commute `TAX_COMMUTE`; shopping `TAX_SHOP` (x0.5 when the shop has `stock <= 0`); freight `TAX_FREIGHT`.
- Creative: money stays `Infinity`, the ledger still records, and no fail checks run.

Sanity check, Normal L1: 300 pop gives about $1,100/day in taxes plus about $150 business, against about $100/day upkeep for a $5k network. At L6: 1,000 pop gives about $5,000/day, against a $25k 2-lane highway costing $500/day upkeep.

### Congestion
On `graph.update`: `edge.heat += (sample - heat) * dt / HEAT_TAU`, where `sample = max(density, 1 - meanSpeed / limit)` over its cars (0 when empty). `node.delay` is an EMA of the queue's `wait` values. These feed the heat map and the "worst junctions" list.

---

## 4. UI (consistent with `docs/hud-design.md`: same tokens, panels, chips, tooltip, toast and modal rules)

```
+--------------------------------------------------------------------------------+
| [A $ · pop · happy · Lv · danger]   [B speed | Day 4 · 08:20 ▮▮▮ | trips]  [C ? ≡] |
|                                                                   [G panels]   |
| [H tray]                                                                       |
|                               [E toasts]                     [F tutorial card] |
|   [D Road Grid | tier lanes 1way | elev | Light Rbt Ichg | Bldg | Edit Demo | Heat] |
+--------------------------------------------------------------------------------+
```

**A, city chips** (top-left):
- `[money] $24,310`: `toLocaleString('en-US')`, with `$1.2M` from 1e6. Below zero it reads `−$1,200` in danger colour with the label "Debt". The tooltip has today's and yesterday's ledger (taxes, business, upkeep, build, net/day). The 200ms flash for gains and spends stays from the inventory chips, for spends of $1 or more.
- `[people] 1,240 / 1,400`: population and the next milestone, with a thin progress bar under the number.
- `[smile] 72%`: the icon is a smile at 60+, neutral at 30-60, frown under 30 (shape is the second cue, colour success/ink/danger). The tooltip has the weighted parts (jobs, shops, trips, pollution, noise).
- `[star] Lv 5`
- Danger chip (as today's): `Debt: 2 days to bankruptcy`, `Unhappy: 1 day left`, or `3 buildings without a road` (a click jumps there and cycles through them).

**B, status:**
- The speed segmented control as today.
- Clock: `Day 4 · 08:20` with one day bar (P1: was 24 cells, too wide for the panel). Rush hours 7-10 and 16-20 are tinted bands on the track, the elapsed day fills in ink, and an accent tick marks now. "Paused" replaces the text while paused.
- Trips: `[car] 312 · 86% smooth` (today's arrivals and smooth share).

**C:** Help `?` plus Menu `≡` (pause menu).

**D, dock**, left to right. Locked tools show a `lock` icon, are `aria-disabled`, and a click toasts `Unlocks at level N`:
- `Road [1]`, `Grid [2]`
- road shape (Road tool only, where Grid shows its block size): one toggle whose icon is the active mode, `V` switches. **Curve** (default, `Game.roadCurve`): a new road bends to meet the roads at its ends (`tangentAt`). **Straight**: always one straight segment. Holding `Shift` while placing makes the road straight in Curve mode; holding `Ctrl` or `Alt` turns its end around the start in 15° steps (`snapAngle`). Pressing on the end point and dragging bends the road in both modes. The preview label leads with `Curve`, `Straight` or `Bend` (P4: the player could not choose between a curve and a straight road). A two-button segment did not fit the dock at 1280px, hence the single toggle.
- tier picker: 5 small swatch buttons (dirt beige, street, avenue, boulevard with a green median, highway gray), tooltip `Avenue · 50 km/h · 1-2 lanes · $90/tile`
- lanes 1/2/3 (disabled outside the tier's range) | One-way | Flip
- elevation stepper (as today)
- `Light [3]`, `Roundabout [4]`, `Interchange [5]`
- `Buildings [B]`, with a badge of unplaced count that pulses on level-up
- `Edit [6]`, `Demolish [7]`
- `Heat map [C]` (a toggle, `aria-pressed`)

Other keys: `V` straight / curved roads, `Shift` one straight road, `Ctrl`/`Alt` 15° steps, `R` rotates a building ghost, `M` metrics, `Shift+M` mutes or unmutes the sound, `T` trip feed, `F` follows the selected car, `Esc` cancels, then closes the top panel, then opens the pause menu, `Space` pauses. The number keys follow the dock order (S12).

**E toasts** and **F tutorial** as today. New error texts go into `FRIENDLY`:
- `Not enough money` -> "Not enough money: wait for taxes or demolish a road built today for a full refund"
- `Unlocks at level N`
- `Highways give no building access`
- `Blocked by a building`
- `Too steep: make the ramp longer`
- `Needs a 4-way junction`

**G, right panel column** (below C, width `min(22em, 100vw - 24px)`, at most 2 open, newest on top, each with a close `×`):
- **Inspector**: one at a time, opened by clicking with Edit.
  - Junction: SVG diagram with arms and turn arrows (S8).
  - Building: zone, residents/capacity or staffed%, happiness parts as 5 bars, stock (shop), last 5 trip reports.
  - Car: kind, purpose, from -> to, elapsed vs ideal, speed in km/h, stops. "Follow" toggles camera follow, and the route draws as a dashed accent line.
- **Metrics** `[M]`: 6 small-multiple SVG sparklines (queued cars, average trip time, throughput/h, money, population, happiness) over the last 7 days, each with the current value. Redrawn once per hourly sample only.
- **Trip feed** `[T]`: the last 30 reports as one-liners in the resident's voice ("Smooth ride to work, 2 min", "Waited ages on the way to the shop", "Took a long detour to work", "Gave up driving to the factory", "No road to work"), each with an outcome icon. Above the list, today's counts per outcome. A click centres the camera on the origin.

**H, batch tray** (bottom-left above the dock, vertical, headed "Pick a building [B]"): the building picker, one card per zone with buildings left, each with a small front-view picture in the zone's map colours and its count (`[home] Home ×8`; `∞` in creative). The held zone's card is highlighted. B picks the first zone with buildings left; B again steps to the next one, and past the last it puts the tool away. When the held zone runs out, the tool takes the next zone left (in tray order, wrapping) with a toast, or goes back to Road when the tray is empty. While the tray holds buildings, the dock's Buildings button shows the count as a badge and its icon turns accent. A click on a card enters `place` with a ghost footprint: green/red validity with a reason label, the door marker, and a dashed `POLLUTION_R` ring for industry. Placement rules:
- no overlap with water, mountains, roads or buildings (4px margin), and fully inside the map;
- the ghost auto-aligns to the nearest road within 80px, and `R` rotates it 90°;
- a non-highway ground road within `ACCESS_R` of the door gets an auto driveway, otherwise the building gets a "No road" badge.

The tool stays in `place` until the count hits 0 or Esc.

**Moving and demolishing buildings.**
- **Demolish** `[7]` takes buildings too: hovering one outlines it red with `Demolish home · back to the tray`. An empty building goes on the click. An occupied one (residents, or commuters working there) takes two clicks: the first arms it (red outline, toast `Click again to demolish: 18 residents move out` / `N workers lose their jobs`), the second removes it; clicking anything else disarms it. The building card has the same `Demolish` button.
- **Move**: drag a building with **Edit** `[6]` (hover: `Home: click for details · drag to move`), or press `Move · $300` on its card. The place tool then holds that building: the ghost follows the cursor with the usual rules (no tray needed, `Not enough money` below `MOVE_COST`, its own footprint and driveway do not block it), its old spot keeps a dashed accent outline, and the label reads `Move here · $300`. Letting go of the drag, or a click, sets it down; a refused spot keeps it held. Esc puts it back and returns to Edit. After a move, Edit opens its card.
- What a demolish does (`Game.demolishBuilding`): the driveways go (cars on them back to their origin's door), and the door node stays as a plain joint only if a road runs through it. Its commuters move out, and workers there lose the job (reassigned within the hour). A car on its way to it (not a return leg) heads to another place of its purpose (gravity pick: any workplace for a commute, a shop for shopping and freight); with none, and for every other trip from or to it (waiting, parked, or a return leg), the trip ends without a report and its commuter is home again. Its trip reports go too, so nothing (cars, trips, commuters, reports, nodes, saves) points at a removed building.
- What a move does: the building keeps its object, so residents, jobs, commuters, waiting and parked trips stay. Its driveways go, it gets a new door node and `connect()` lays the new driveway; cars on their way to it reroute to the new door.

**Modals:**
- Level up: `Level 4!`, unlock list, batch rows, grant, Enter.
- Game over: `Bankrupt` / `The residents left`, with stats day, population, level, trips, smooth%, and buttons Play again / Main menu.
- Victory.
- Pause menu: Resume, Save, Load, Sound, Main menu, seed shown with a copy button.
- Main menu (S11), with the same Sound entry.

**Sound** (`src/ui/Sound.ts`, P7: the game had no audio at all). Everything is synthesized with Web Audio, no files. The AudioContext is created on the first pointer or key press (autoplay policy) and suspended while muted or while the tab is hidden, so a muted game spends no CPU on audio.
- Effects: a click on any button and a faint tick when the mouse comes onto one. The sim raises cues in `Game.sfx` (a set, so one per kind per frame): `build` on any spend (roads, controls, retypes, interchanges), `demolish` on a refund or a demolished building, `place` on a placed or moved building. The HUD plays an error buzz for every `say()` whose text matches `ERROR_RE` (`Game.said` counts repeats of the same text). It also plays an income blip at most every 1.5 s while business or trade income comes in, a fanfare on a level-up, and an alarm whenever the fail countdown (`Game.alarm`) starts or ticks down, and on game over.
- City hum: looped brown noise through a lowpass. Its volume and brightness follow the cars on screen (up to 50) and the zoom, and it ducks to a quarter while paused, in a menu or behind a modal. A car on screen that has stood still for 8 game seconds may honk once, at most one horn every 5 s, panned to its side of the screen.
- Music: a calm generative loop at 100 bpm. Triangle pads on Fmaj7, Em7, Dm7 and Cmaj9 change every two bars, with a sine bass on each bar and a sparse C-pentatonic melody into a feedback echo. A 250 ms timer schedules it 1 s ahead.
- The Sound menu has Sound on/off, Master volume, Effects and city volume, Music on/off and Music volume. The mix is saved in `localStorage` (`tm_audio`), and the effects slider plays a sample when you let go of it. `M` was already Metrics, so mute is `Shift+M`.

**Canvas:**
- Buildings are flat rounded rects with a soft shadow, in zone colours: home `#F4A261`, shop `#4EA8DE`, office `#8E7CC3`, industry `#9E9E9A` with stripes and a chimney dot. A white door notch faces the road, and parked cars or pending trips show as dots by the door. An unconnected building has a dashed danger outline.
- Heat map: each edge stroked with `e.width + 4` at 0.75 alpha, coloured `#4CC26A -> #E0A100 -> #E5484D` by `heat`. Junction circles are sized by `delay`.
- Off-screen markers (today's code) now point at unconnected buildings.

---

## 5. Implementation plan

Every step leaves the game playable (engine, renderer, HUD, input and tutorial) and keeps simcheck's invariants (sorted lanes, no overlaps, clean occupants, trips complete), plus one new assertion. "Must keep working" lists what a reviewer clicks through.

**S1 Seeded RNG, biomes, difficulty, new-game config.**
- Files: `src/util/rng.ts` (new); `src/core/config.ts` (new: `GameConfig`, `DEFAULT_CONFIG`, `SIZES`, `DIFFICULTY`, `BIOMES`, and an empty `TUNING` that later steps fill); `MapGenerator.ts` (`generateTerrain(cfg)` uses its own rng, biome params, counts per difficulty, `WORLD` sized from `SIZES`); `Game.ts` (`new Game(cfg)`); `Car.ts` (drivers use `random()`); `CanvasRenderer.ts` (land, patch, tree and mountain colours from `BIOMES[terrain.biome]`); `main.ts` (cfg from URL `?seed=&biome=&difficulty=&size=&mode=`; since S11 they skip the menu); `scripts/simcheck.ts` (`setSeed`).
- Biomes:
  - temperate: today's palette, trees 120-200, lakes 0-2.
  - desert: land `#EFE6D2`, dune patches `#E6D3A8`, 20-40 shrubs `#A7B36A`, rivers 0-1, lakes 1-2, mesa bands `#C9A882/#B08D68/#94735A`.
  - alpine: land `#E8EBE6`, snow patches `#F2F3F1`, 200-280 conifers `#5E8F5A`, mountains +3, bands `#8E9296/#6F7377/#F4F5F6`.
  - archipelago (added in S1): land `#EDEBE1`, 6-9 large lakes (r 130-230) and 2-3 river channels, so the land reads as islands joined by bridges; mountains -2, trees 90-150.
  - Water stays `#A9C1EC/#BFD3F3` in every biome.
- Assert: the same seed gives `JSON.stringify` equal terrain twice, and a different seed gives a different one.
- As built: `generateTerrain(cfg)` sizes `WORLD` itself. The sim stream is seeded from `hashSeed('sim:' + seed)` in `new Game(cfg)`, so terrain and trips never mirror each other. Until S2/S7 replace the old loop, `trips` divides the demand interval, `growth` divides the city spawn interval, and creative mode disables the overcrowding game over. simcheck makes `Math.random` throw, so any unseeded model roll fails the check.
- Must keep working: the whole current game, unchanged in play.

**S2 Money economy replaces the tile inventory.**
- Files: `Game.ts` (`money`, `ledger`, `price(seg)`, `afford`, refund rule, control prices, removes `Inventory/Reward/REWARDS/pendingReward/applyReward`). Until S7, each arrival pays a flat $15.
- `RoadGraph.ts`: `Edge.refund` becomes `Edge.day`.
- `HUD.ts`: the money chip replaces the asphalt, bridge and tunnel chips. Stock badges and the reward modal go. Cost and refund tooltips are in $.
- `CanvasRenderer.ts`: preview, bend and demolish labels in $. Lights and roundabouts read `$600`.
- `Tutorial.ts`: `topUp` sets money. `simcheck`.
- Assert: a straight street of N tiles costs exactly `price`, and demolishing it the same day restores the money.
- As built: `Game.money` (Infinity in creative), `ledger {today, yesterday}`, `upkeepDay` (refreshed by every `spend` and at midnight), `price(a, b, flags)`, `refundOf(e)`, `controlPrice`, `controlRefund`, `upkeepPerDay()`, and `fmtMoney`/`income` helpers; prices live in `TUNING` (`ROAD_COST` = 60 stood in for the tier cost until S3 replaced it with `TIERS[tier].cost`). `Edge.refund` became `Edge.day` (a split keeps it) and `Node` gained `controlDay`. Until S5 a day is still `DAY_SECONDS` = 15 and upkeep is paid in one lump at each midnight; each arrival pays `ARRIVAL_PAY` ($15) x `taxMult` as business income. A bend credits the old run at full price for affordability (a net refund follows the refund rule, one payment after the rebuild so junction plans see the finished graph) and the rebuilt edges keep the run's oldest build day, so bending never buys a same-day refund. Switching a control (light <-> roundabout) sells the old one under the refund rule. The money chip shows the net per day as income (yesterday's, or today's on the first day) minus `upkeepDay`. The unused `planBuild`/`commitBuild` went with the inventory.
- Must keep working: building, bending, retyping and demolishing, with the week dots still running.

**S3 Road hierarchy tiers.**
- Files: `config.ts` (`TIERS`); `RoadGraph.ts` (`RoadType.tier`, `DEFAULT_TYPE`, `sameType`, `heat`); `Car.ts` (speed limit); `Pathfinder.ts` (time cost; a binary heap replaces the linear open list); `Game.ts` (price per tier, lane clamp); `CanvasRenderer.ts`:
  - dirt: fill `#E3D6B8`, outline `#C2B392`, no centre line;
  - boulevard: a 3px `#BFD8A0` median instead of the yellow line;
  - highway: fill `#F7F7F5`, outline `#8A99AD`, a double gray centre line;
- `HUD.ts`: the tier picker. No locks yet.
- `simcheck`: the default tier is `avenue` (limit = `MAX_SPEED`, so the existing speed checks hold).
- Assert: a car on dirt never exceeds `vmax * 60/110 + 1`, and A* takes a longer highway over a shorter dirt road.
- As built: `TIERS` also carries each tier's look (`fill`, `out`, `shoulder` px per side, `median` px between the directions of a two-way road, `line`: none / yellow / median / double), next to `BIOMES`' colours. `roadWidth` adds shoulders and the median, and two-way lanes sit half a median further out. Avenue = the street look with a darker outline and 1.5px shoulders; boulevard adds a 5px median drawn as a 3px green line; highway has 3px shoulders with solid edge lines. Upkeep stays `price * UPKEEP_RATE`, which is the table's per-tile column. `fitType` (RoadGraph) clamps lanes and one-way to the tier; `setRoadType`, `retype` and `retypeDelta` all go through it, so switching tier in the dock (new roads, or the Edit selection with its cost delta in the tooltip) never makes an invalid road. `Car.top(edge)` = `vmax * limit / MAX_SPEED`; the corner speed uses the slower of the two edges' tops, which is also the brake-before-a-slower-tier rule. `findPath` costs time with a binary heap; the `{free}` option waits for S7. Unlock hook: `Game.tierUnlocked(tier)` (always true until S6); a locked tier is refused with `Unlocks at level N`. Highway access is enforced already: `planPath` and `retype` refuse a highway that touches a city node (`Highways give no building access`), and S4 moves the check to doors. HUD: 5 swatch buttons before the lanes; the old road picture went (the swatch, the tier name and its km/h replace it), and the elevation hint hides below 1340px so the wider dock fits at 1280.
- Must keep working: Edit retype across tiers, and one-way (not offered on dirt).

**S4 Buildings and zones replace coloured cities.**
- Files: `src/entities/Building.ts` (replaces `City.ts`); `src/entities/Trip.ts` (types only); `RoadGraph.ts` (`city` -> `building` in `nodeLevelOk`, `dropIfOrphan`, `runOf`, `turn`, `nearestNode`; the door still accepts any level until S9); `Game.ts` (`buildings`, starter town, `queueTrip(from, to, purpose)`, `demandOff` flag; `planPath` refuses segments through footprints and highway-to-door connections);
- `MapGenerator.ts`: `findStarterTown`, which places 4 homes within 150-400px of a dry centre, and 1 shop plus 1 office 400-700px away, 120px spacing.
- `Car.ts`: `trip`, colour palette.
- `CanvasRenderer.ts`: buildings drawn. The overcrowding ring and labels go, and off-screen markers point at unconnected buildings.
- `HUD.ts`: the danger chip becomes "buildings without a road". The overcrowding game over goes.
- `Tutorial.ts`: texts say buildings.
- Placeholder demand until S5: each home queues a trip to a random workplace every 6-10 s, and the car returns on arrival.
- `simcheck`: `town()` places a home, `X.city!.pending.push(Y.city!)` becomes `w.queueTrip(X, Y, 'commute')`, and `demandTimer = Infinity` becomes `w.demandOff = true`.
- Assert: a road segment through a building footprint is refused.
- As built: `ZONES` (config) holds each zone's footprint and look, which replaces the canvas colours in section 4: home white with a green roof inset and ridge, shop blue with an awning, office purple with a window grid, factory ochre with sawtooth roof, chimney and smoke. A `Building` is `{kind, x, y, angle}` (angle = facing, toward the door) plus `node` (the door, `DOOR_D` = 10px out from the front), `pending`, `demandTimer`, `retryTimer`; `buildingAt(kind, door, angle)` places one by its door. `Trip` is `{purpose: 'commute' | 'shop' | 'freight', from, to, back}` for now (a return keeps its purpose, `back` marks it); S5 adds the rest. Cars are coloured by purpose from `PURPOSES` (config), not `CAR_COLORS`, with a legend panel bottom-left; trucks only carry freight (`KINDS.truck.w` = 0). Access: a road can end on a door (snap radius `DOOR_R`), a road drawn within `DOOR_R` of an unconnected door passes through it, and after every build or bend each building still without a road gets a free driveway (`Edge.drive`: street, no price, upkeep or refund; retyping it makes it a paid road) to the nearest ground, non-bridge, access-tier road within `ACCESS_R` whose straight stub crosses no road, water, mountain or footprint. `planPath` refuses footprints (`Blocked by a building`, sampled every 4px with a pad of min(half road width, `DOOR_D` - 2) so a road along a front still reaches its door), checked at every level. `findStarterTown` (MapGenerator, sim stream) lays 4 homes facing a 220px street line (doors 30px off it), then a shop and an office 400-700px away and a factory 500-800px away, each facing the town; `DIFFICULTY.starterRoad` (easy only) builds that street for free, so the homes start connected. Placeholder demand: a connected home queues a commute (70%, to any workplace) or a shopping trip every `HOME_TRIP_S`, a connected factory a freight run to a shop every `FACTORY_TRIP_S`, at most `MAX_PENDING` waiting; each arrival queues the return leg, and a trip without a route is dropped at departure. Waiting trips show as dots on the roof. The danger chip counts buildings without a road and cycles the camera through them; a red badge and dashed outline mark them on the map (a label on hover) and off-screen markers point at them. Nothing ends the game until S7 (the modal stays for it). `demandOff` (simcheck) also stops return trips, so a scenario's score counts only its own trips.
- Must keep working: roads snap to doors, and cars spawn and arrive.

**S5 Trip generation and the day cycle.**
- Files: `config.ts` (`TUNING` trip and clock values); `Game.ts` (clock, hourly tick, commuters and assignment, shopping and freight accrual, parking and returns, outcome classification, `reports`, `stats`, `MAX_CARS`); `Trip.ts`; `Car.ts` (accumulates `driven`, `stopped`).
- `HUD.ts`: the clock and 24-cell bar replace the week dots, plus trips today.
- `Tutorial.ts`: the "watch the cars" step waits for the first commute.
- Assert: over one simulated day on a fixed town, at least 70% of commute departures fall between 6:00 and 10:00, and every arrived commuter's return trip is queued by `depart + WORK_HOURS`.
- Must keep working: the deadlock, lost, demolish and U-turn scenarios (trips requeue at the origin).
- As built: `DAY_SECONDS` is 240 (4 real minutes at 1x, 10 s per hour), not 120: at 5 s per hour a typical 1,000px commute took 2 in-game hours of a 9-hour shift. `HOUR` (Game) is game seconds per hour; `clock`/`hour`/`day`/`today` are derived from `time` + `START_HOUR`, and `week` is gone. Homes get `residents` = `START_OCC` (60%) of `ZONES.home.residents` in `addBuilding` (`ZONES` now carries `residents`/`jobs`, which S6 was to add). `Trip` keeps S4's `back` flag instead of a `'return'` purpose (a return keeps its purpose and colour) and adds `who`, `queued`, `departed`, `leave` (game time the return leg goes once parked; set at departure for a commute, at arrival for shopping, 0 for freight), `ideal`, `idealLen`, `driven`, `stopped`, `retries`; `makeTrip` builds one. `TripReport` holds the `Building`s (not ids) plus `back`. A `Commuter` also stores `next` (game time of its next departure); a commuter still out at that time skips the day. `assign()` runs at the first update, at 03:00, and an hour after any `spend` or `addBuilding`; it also removes commuters at home when residents drop. `staffed` counts parked commuters at the hourly tick. Factory smoke shows only while staffed. Placeholder demand (`HOME_TRIP_S`, `FACTORY_TRIP_S`, `MAX_PENDING`, `demandTimer`) and the tutorial's demand slowdown are gone. HUD: the trips chip shows today's arrivals and smooth share (tooltip: every outcome, plus all-time arrivals); the clock reads `Day 4 · 08:20` in 10-minute steps. Tutorial: `start()` pauses the clock and the "Watch the commute" step resumes it, so the first morning is still ahead after the first road (Finish/Skip resume a paused clock); the step is done on the first commute arrival. simcheck: the main town runs at 150 residents per home (so every vehicle kind shows up); the new checks are that at least 70% of commute departures fall within 6:00-10:00 (actual spawn hour), that no commuter stays parked at work past `max(leave, arrival)` + 1 tick, and that at least one commuter got home.

**S6 City growth, levels and building batches.**
- Files: `config.ts` (`ZONES` capacities, `LEVELS`); `Game.ts` (residents growth. Until S7 the "happy" input is `trips` x 100, so homes grow when their trips succeed. `level`, `pendingLevel`, grant, `tray`, `placing`, `placeBuilding(p, angle)` with an auto driveway, unlock checks on tools and tiers);
- `Input.ts`: the `place` tool, `B` and `R`.
- `HUD.ts`: population, level chip, tray (H), level-up modal, locks.
- `CanvasRenderer.ts`: ghost footprint, validity, door, ring.
- Creative: all unlocked, tray counts `Infinity` (shown `∞`).
- Assert: pushing the population over `LEVELS[1].pop` raises the level and adds the batch to the tray, and placing a home within `ACCESS_R` of a street builds a driveway that a queued trip can drive.
- Must keep working: Edit and Demolish on driveways (refund 0).
- As built: `Game.level` stays the road elevation, so the city level is `Game.cityLevel` (and `pendingLevel`, `tray`, `placing`, `placeAngle`). `LEVELS` (config) holds only `{pop, batch}`; a level's unlock list is derived from `TIERS[t].level` plus the new `UNLOCKS` table (`roundabout` and `oneway` L2, `viaduct` L1-5 L3, `tunnel` and `high` (L6-10) L5), shown by `levelUnlocks(n)`. Phase editor, protected lefts, turn bans, ramps, Grid and Interchange are not in `UNLOCKS` yet: S8/S9 add their entries when the tools exist. Locks are enforced in one place each: `setTool` (roundabout), `setLevel` (viaducts), `lockedMsg` for `setRoadType`/`retype`/`planPath` (tier and one-way), `planPath` (a new tunnel segment); every refusal toasts `Unlocks at level N: <label>`. `levelPop(n)`/`levelBatch(n)` continue past level 10 with `ENDLESS_POP` (+300) and `ENDLESS_BATCH`; victory stays with S7. `checkLevel` runs every update and can pass several milestones at once; the grant goes to `ledger.grants` (the money chip's net/day leaves grants out). Creative counts levels silently: no modal, no batch, tray `Infinity`. The level-up modal is the HUD's: it pauses (speed 0) and Continue/Enter restores the previous speed, so `Game.running` and the headless sim never stall; levels reached together merge into one modal. Growth (`grow()`, hourly, skipped under `demandOff`): `happy` = 100 x the mean `SCORE` of the home's trips in the last 24h (`Building.recent`), 0.6 with none, 33 without a road; the growth multiplier scales only the positive rates, and a home above capacity (simcheck's busy town) can only shrink. Place tool (`B`, the Buildings dock button with a count badge, or a tray card): `planPlace(p)` snaps to the nearest access road within `SNAP_R` (80px), turns the door toward it and puts the door `DRIVE_GAP` (12px) past the road's edge, so `connect()` lays the driveway; with no road in reach the ghost stands free and `R` turns it (a snapped ghost ignores `R`). Refusals: `None left in the tray`, `Outside the map`, `Blocked by water or a mountain`, `Overlaps a road` (any level, road half width + 4px), `Overlaps a building` (sampled outlines both ways, 4px). Warnings (S7 scores them): `Factory nearby` (`POLLUTION_R`), `Noisy road` (a tier with noise >= `NOISY` within `NOISE_R`), `Pollutes N homes nearby` for a factory, `No road yet`. The ghost draws faded with a green/red outline, its door, a dashed driveway to the road and a dashed pollution ring for a factory. The tray (H) shares a bottom-left column with the car legend; the people chip shows population / next milestone with a bar, the star chip the level (its tooltip lists the next unlocks); locked dock tools and the one-way and raise buttons are `aria-disabled` with a lock. The resources row wraps instead of running into the status bar. Tutorial: the viaduct step (locked at level 1) became "Grow the city": place a home from the tray (the step tops the tray up to one home).

**S7 Happiness, taxes, fail conditions.**
- Files: `Game.ts` (pollution, noise, access, the happiness formula, growth bands, taxes and business replace the flat $15, upkeep, ledger, bankruptcy and happiness checks, victory; `gameOver` becomes a reason string).
- `HUD.ts`: happiness chip, ledger tooltip, danger countdowns, game over and victory modals.
- `CanvasRenderer.ts`: a tiny happiness dot on each home, shown only while it is inspected or under the heat map.
- Assert: an identical home 60px from a staffed industry scores at least 25 points lower than one 600px away, and career money below 0 for `DEBT_DAYS` midnights sets `gameOver = 'bankrupt'` while creative never does.
- Must keep working: tutorial (`tutorialActive` suppresses fails).
- As built: `Game.rateHome(b)` computes the five parts into `Building.parts` and returns the score; `grow()` runs it hourly for every home, and `happiness` (starts at 60) moves toward the residents-weighted mean by 1/`HAPPY_TAU` (24) per hour, with `cityParts` for the chip tooltip. Shopping share comes from `Building.recent`, whose entries now carry `shop` (an outbound shopping trip; arrived = score > 0). Noise skips driveways and tunnels; density is the cars on the edge's lanes x (`CAR_LEN` + `GAP`) / (length x lanes), as in `findPath`. Deviation: residential taxes scale with city happiness (`TAX_RES` x residents x (0.5 + 0.5 x happiness / 100)), not with `Q_city`, since the trip score is already 55% of happiness. Business pays only outbound arrivals (worker at work, customer at a shop, goods at a shop), so return legs earn nothing. Taxes and upkeep are paid every in-game hour; `update` runs every hour a time step passed (a time jump runs each one), then that hour's pay, then `midnight()` (ledger roll, fail checks). `ARRIVAL_PAY` and the `income()` helper are gone; the money chip's net/day is `taxPerDay()` + the business of yesterday (today's on day 1) - upkeep, and its tooltip lists taxes, business, upkeep, building and grants for yesterday and today. Fail counters `debtDays`/`sadDays`; `gameOver` is `'' | 'bankrupt' | 'unhappy'`; `Game.alarm` gives the nearest fail and the midnights left, shown in a second danger chip (`Debt: 2 days to bankruptcy` / `Unhappy: 1 day left`) next to the buildings-without-a-road chip, which keeps its off-screen markers. Abandonment: under `GROW_LO` a home loses `SHRINK` of capacity per day down to 0 and then draws faded; it refills when its happiness recovers. Canvas deviation (no inspector or heat map until S10): a home under `GROW_LO` shows a small red dot, and hovering any connected home labels its residents and happiness (`Abandoned` when empty). Victory has no modal of its own: the level-up modal that reaches level `LEVELS.length` reads `City complete!` with the run's day and trips, and Continue is the endless mode. The game-over modal shows the reason, days, level, population, trips, smooth share (new `stats.smooth`, all time) and money; Play again reloads (no main menu until S11). Happiness chip icons `smile` / `neutral` / `frown` are in `icons.ts`. simcheck: the money test expects day 1's 18 hours of upkeep; new checks for the factory penalty (60px vs 600px, at least 25 points), bankruptcy after `debtDays` midnights with a 1-day alarm before it, none in creative or the tutorial, and the unhappy fail on day `FAIL_FROM_DAY + FAIL_DAYS - 1`.

**S8 Junction control: phases, protected lefts, turn restrictions.**
- File: `src/network/Junction.ts`:
  ```ts
  type Signal = 0 | 1 | 2;                 // red, go but yield (permissive), protected
  interface Phase { seconds: number; sig: Signal[][] }   // sig[approach][0 left | 1 straight | 2 right]; U-turns follow left
  interface JunctionPlan { approaches: number[]; phases: Phase[]; banned: [number, number][] }
  ```
- Approaches are angles of the edges leaving the node, sorted. `syncPlan(n)` matches current edges to approaches by the nearest angle within 15°. A split further out keeps the direction, so plans survive it. On a mismatch the plan resets to the default and toasts `Light plan reset`.
- Default plan: two phases from `lightGroup`, `LIGHT_PERIOD` seconds each, with green approaches `[1, 2, 2]`. Phase 0 = group 0, so simcheck's `J.phase = lightGroup ^ 1` still means red.
- `RoadGraph.update`: phases advance by `phases[i].seconds`. A permissive left is granted only if the most-opposite approach (more than 150° away) has no straight or right car queued or in the box. Turn class comes from the same angle test as `turn()`. Banned moves are never granted.
- `Pathfinder.ts`: A* state = (node, incoming edge), which skips banned moves. Setting a ban nulls every car's `path`.
- Presets: `2 phases`, `2 phases + protected lefts` (4 phases), `One approach at a time`. Phase seconds run 3..30; add/remove a phase, max 6.
- `HUD.ts`: the Junction inspector. The control picker is None/Light/Roundabout with prices. The SVG arms take clicks: an arrow toggles banned, and per phase an arrow cycles red -> yield -> protected. The current phase is highlighted. Locked below level 4, except None/Light/Roundabout.
- `CanvasRenderer.ts`: per-approach lights read the plan, amber shows for the last 1s (cosmetic only; ponytail: no amber in the sim), and banned turns get a small red no-turn glyph on the arm.
- Assert: with left J->Z banned, no car's path takes that move and the Z trip arrives via the detour; under the protected-left preset a left-turner is never granted while its phase is red.
- Must keep working: default lights behave as today.
- As built: `Junction.ts` holds the plan types and pure edits (`toggleBan`, `cycleSig`, `setSeconds`, `addPhase`, `removePhase`, `applyPreset`), `turnAt` (the angle test `RoadGraph.turn` now uses), `moveOf`, `approachOf`, `oppositeOf`, `mainEdges`, `banned`, and `lightGroup`/`LIGHT_PERIOD` (re-exported from `RoadGraph`). Deviation: bans are `ban: boolean[][]` shaped like `sig` (not `[number, number][]`), and the node field is `plan` (null = default). The default plan is never stored: `planOf(n)` rebuilds it, so only an edited junction carries a plan. Controls (the task adds two): `none` (one car at a time, arrival order), `yield` (the main road, `mainEdges`: the highest tier with lanes as tiebreak, the straightest pair when more than two arms share it, goes like a green light with lefts yielding; a side-road car needs an empty box and no main-road car queued), `stop` (all-way stop: one at a time, granted only from a standstill within `GAP` + 3px of the line), `light`, `roundabout`. Yield/stop signs cost `SIGN_COST` $150, `SIGN_UPKEEP` $0.5/day and are not locked; the phase editor, protected lefts and bans are `UNLOCKS.junction` (level 4): below it the panel shows the plan and the control picker and `editPlan` toasts the lock. Plans sync in `Game.spend` and at the end of `connect` (every build, demolish, bend, retype and driveway passes one of them): a plan whose roads no longer match goes back to the default and toasts `Junction plan reset: its roads changed`. `Game.setControl(n, kind)` replaces placeControl's body (placeControl and demolish call it); `Game.editPlan(n, fn)` edits a copy and, when the bans changed, nulls the path of every car not already granted through that junction. `Game.inspect` is the junction open in the panel (Edit click within `NODE_R` + 6 of a 3+ road node; `junctionAt`); `select` sets either `inspect` or `selected`. A*: no U-turns past the start (the old node-closed search never made one), `via` = the edge the start was entered by, and `Car` passes its lane's edge. Presets are `two`, `lefts` (per axis a 3s protected-left phase `[2, 0, 2]`, then a 5s through phase `[0, 2, 2]`) and `each`. Panel (`HUD.updateJunction`, top right like the help pop): control picker with price or refund in the tooltip, Signals / Turn bans toggle for lights, the arm diagram (turn buttons L/S/R beside each incoming lane, keyboard reachable; yield's main arms drawn thick), phase rows (select, -/+ seconds, remove, the running one marked green), Add phase and the presets; focus survives the re-render on every phase change. Renderer: lights green while any movement of that approach may go, amber in the last second before all of them turn red; give-way triangles on yield side roads, stop octagons on every stop approach, a no-turn glyph on arms with a ban, an accent ring on the inspected junction. simcheck: the turn-ban detour (route and drive), protected lefts never granted on red or yield (ambulances excepted, they run reds), and the yield (main first) and stop (granted from a standstill) checks.

**S9 Grid tool and one-click interchanges.**
- Ramps first. A path whose start node is on level `La` and whose end is on `Lb` (dock level, or the snapped node's level) steps by 1 level per group of segments: segment i gets `round(La + (Lb - La) * i / (n - 1))`, which needs at least `|Lb - La| + 1` segments of at least 1 tile (`Too steep: make the ramp longer`). `nodeLevelOk` accepts inner ramp joints (2 edges, levels differ by 1). Doors become ground-only (`Buildings need a ground road`), and the renderer draws a ramp joint in its upper layer.
- Grid tool: drag a rectangle, choose block size 3/4/6 tiles in the dock context, and it builds the street lines with the current type through `planPath`. Preview and cost come first, and it commits all or nothing.
- Interchange tool: click a junction node with exactly 4 approaches whose axes are within 20° of perpendicular, and whose approaches stay straight for at least `R` = 200px.
  - Diamond: the secondary axis is rebuilt at L2 over a 2R span, with ramps L0<->L2, plus 4 one-way ramps.
  - Cloverleaf: the overpass plus 4 loop ramps (radius 70px) and 4 outer ramps.
  - Trumpet: for a 3-way junction.
  - All of it is planned as `planPath` polylines, previewed with the total price and committed atomically. Cars on removed edges requeue.
- Files: `Game.ts`, `RoadGraph.ts` (`nodeLevelOk`), `Input.ts`, `HUD.ts`, `CanvasRenderer.ts`, new `src/core/Templates.ts` (geometry only).
- Assert: a diamond on a 4-way node leaves no node joining both axes at one level, and trips across both axes complete.
- Must keep working: viaducts, tunnels, bend on ramps.
- As built: **Ramps.** Deviation: the profile is a clamp, not the linear `round(La + (Lb - La) i / (n - 1))`: segment i of n sits at the dock level clamped to within i levels of the start and n-1-i of the end, so a road between two ground points drawn at L2 is an overpass (up, across, down) and one from a ground end to a free point at L2 climbs once. A ramp is resampled to a joint per tile and needs `|Lb - La| + 1` segments (`Too steep: make the ramp longer`). The ends snap on the dock level first, else (`Game.snapEnd`) onto a node or road of another level, which sets La/Lb; mid anchors snap on the dock level only. `nodeLevelOk` now means every road of the node is on that level (doors: ground only, `Buildings need a ground road`), so a ramp joint (`RoadGraph.levelOf` = NaN) takes no third road; it renders in its upper layer. Bend keeps the run's top level. Hover says `Ramp from the ground` / `from L2`; the preview label shows `L0-L2`. **Grid** (`6`, `UNLOCKS.grid` level 5): three clicks, corner, end of the first side (any angle), then the depth; block size 3/4/6 tiles in the dock (it takes the elevation stepper's place, the grid is ground only). Both sides are split evenly into blocks of about that size, so the corners stay where clicked. `planGrid` plans every line on the current graph as one plan (lines that already exist are skipped; the money is checked on the total) and `commitGrid` re-plans and builds them in order: lines along the side first, then across, each through every crossing point so the later ones snap onto the earlier ones' nodes. **Interchange** (`7`, `UNLOCKS.interchange` level 6): `src/core/Templates.ts` holds the three templates as local (u, v) polylines with fixed end levels, plus the controls; u is the main road (highest tier x 4 + lanes; a trumpet's through road), v the crossing road or stem, picked so the frame turns like the screen and right-hand traffic holds. Each quadrant maps onto its own pair of arms, so roads up to 20 degrees off square line up. Checks with a reason: 3 or 4 roads, square within 20 degrees, ground and two-way, no dirt, a cloverleaf needs a boulevard or highway main road, and the arms straight with no other junction out to `reach` (main) and `cut` (crossing). Diamond: the crossing road is cut 5 tiles out and rebuilt at L2, four straight one-way ramps join the main road 4 tiles out (yield) to two lit terminals 2 tiles out on the deck. Cloverleaf: deck cut 7.5 tiles out, four 270-degree loops of radius 60px (not 70: so they join the deck at its nodes) and four outer ramps at 7.5 tiles, 8 yields, no lights. Trumpet: the stem rises over the through road and ends past it; two direct ramps on the near side, a loop (westbound to the stem) and a semi-direct ramp round it on the far side, 6 yields. Ramps are one-lane one-way at the lower of avenue and both roads' tiers, so the roads keep the right of way where ramps join. The preview hides the cut span and plans every path on the graph as it stands (`planPath(..., ends, snapMid = false)`, since ramps run alongside the road they join); any crossing with an existing road is `Nearby roads are in the way`, and terrain, buildings and money give their usual reasons. `net` = roads + controls - the refunds of the span and of the junction's control; it is cached against a graph version. Clicking a junction opens the Interchange panel (type buttons with their tips, the reason or the net price, Build / Cancel) and the ghost stays on the map; `buildInterchange` sells the junction's control, cuts the span (refund, cars sent home), builds each path live in order and places the controls. ponytail: the preview validated everything; a live re-plan failing would leave a partial build. Dock: Road Grid | type | elevation | Light Roundabout Interchange | Buildings | Edit Demolish; below 1440px the tier caption hides and the tools pack tighter so it still fits at 1280. simcheck: ramp levels, too steep, down to a door and a commute over it; a 3 x 2 grid (2 crossings, 6 T-junctions, 4 corners, previewed price); and each template on a boulevard x avenue crossing (a T for the trumpet): the price matches the preview, no node joins the two roads at one level, and a trip between every pair of arms arrives.

**S10 Analysis: heat map, follow car, trip reports, metrics charts.**
- Files: `RoadGraph.ts` (`heat`, `delay` EMAs); `src/core/Metrics.ts` (hourly samples); `Game.ts` (`overlay`, `follow`, `inspect`, `carAt(p)`); `Input.ts` (Edit click priority: car, then junction, then building, then road; keys `C`, `M`, `T`, `F`); `CanvasRenderer.ts` (heat overlay, follow camera, route line); `HUD.ts` (panels G: car, building, metrics with inline SVG sparklines, trip feed).
- Assert: after one simulated day there are exactly 24 metric samples, and a saturated edge has `heat` greater than an idle one.
- Must keep working: Edit road selection when nothing else is under the cursor.
- As built: **Congestion.** `RoadGraph.update` keeps `Edge.heat` (EMA over `HEAT_TAU` = 10 game s of max(density, mean slowness), slowness = 1 - speed / the car's top speed on that edge; a split copies it) and `Node.delay` (EMA of the mean `wait` of its queue). **Trips** track their longest stop (`Trip.jam` = the node ahead, `jamS`); a `TripReport` adds `ratio` (time / free-flow time), `stretch` (driven / free-flow length), `door` (wait before leaving), `jam` (a point copy), `jamAt` (`Game.jamAt`: the node's control, `none` for a plain junction, `road` for a queue between junctions) and `jamS`. **Metrics** (`src/core/Metrics.ts`): deviation, the whole run instead of a 7-day ring: one `Sample` per in-game hour (waiting = stopped cars + trips at doors, trip = mean in-game minutes of the hour's arrivals, carried over an empty hour, through and failed per hour, money, population, happiness), and past 240 samples every other one goes and the stride doubles. **Game**: `overlay: 'none' | 'heat' | 'noise'`, `follow: Car | null`, `picked: Building | null` (the spec's `inspect` stays the junction), `carAt(p)`; an Edit click picks a car, then a junction, then a building, then a road run; switching tool, Esc and dragging the map stop a follow, and an arrival toasts `Arrived: smooth run, 14 min`. **Renderer**: the follow camera (zooms to at least 1.2 when it starts) with the route ahead as a dashed accent line; the heat overlay per level (roads stroked green -> amber -> red, junction discs sized and coloured by delay); the noise overlay under the roads (a purple band `NOISE_R` each side by tier noise, one path per tier, and a brown haze to `POLLUTION_R` round staffed factories), and under either overlay every home's happiness dot; an accent outline on the picked building; Edit hover names the car or building it would pick. **HUD**: deviation, the overlay and panel buttons sit left of Help (heat, noise, trip reports, metrics; `C` cycles the overlay, `T`, `M`) instead of in the dock, which is full at 1280px. The panels stack in a right column (`.rcol`) with the junction and interchange panels: the car card (trip, from -> to, kind, time so far vs on empty roads, speed in km/h, stopped and the longest stop), the building card (residents, happiness and its five parts as bars, commuters with a job; jobs, staffed share, goods; its last 5 trips), the trip feed (today's outcomes, the last 30 reports in the resident's voice, redrawn at most twice a second) and the metrics (inline SVG sparklines with now and the range; money hidden in creative). A report line jumps the camera to its longest stop, else its origin. The legend panel shows the overlay's key. No "at most 2 panels" rule: the column scrolls. simcheck: 24 samples after a day and one per hour of the main run (all finite, some throughput), a lane of stopped cars heats its road past 0.5 while an idle road stays at 0 and the junction builds delay, and an Edit click on a car follows it.

**S11 Main menu, modes, save/load.**
- `src/core/Save.ts`:
  ```ts
  interface SaveData { v: 1; cfg: GameConfig; time: number; money: number; level: number; ledger; stats; happiness; tray;
    buildings: { id; kind; x; y; angle; residents; stock; node: number }[];
    commuters: { home: number; work: number | null; depart: number; at: 'home' | 'away' }[];
    nodes: { id; x; y; control; junction: JunctionPlan | null }[];
    edges: { a: number; b: number; tier; lanes; oneWay; level; bridge; tunnel; day; drive }[];
    metrics: Sample[] }
  ```
  Terrain is not saved: it is regenerated from `cfg.seed`. Cars in flight are not saved: their trips come back as pending at the origin, and commuters `driving` are restored `home`. `serialize(game)` and `deserialize(data)` are pure functions.
- localStorage keys: `tm_save_auto` (autosave every midnight) and `tm_save_1..3`, each in try/catch.
- `HUD.ts`/new `src/ui/Menu.ts`:
  - Main menu: Continue (if an autosave exists), New game (mode, difficulty, biome, size, seed with a dice button), Load (3 slots with day, population and level).
  - Pause menu.
- `main.ts`: the game starts behind the menu, with a new `Game` per start (no `location.reload`).
- Assert: `deserialize(serialize(g))` re-serialises to an identical string, and the loaded game runs 60s without breaking invariants.
- Must keep working: the URL params still skip the menu (dev and tests).
- As built: `serialize(g): string` / `deserialize(json): Game` (throws on another version) in `src/core/Save.ts`, plus `store(key, g)` (false when storage is full or blocked), `load(key)` and `peek(key)` (day, population, level, cfg; `'bad'` for an unreadable save or an unknown cfg). Buildings, commuters and nodes are referenced by index; `deserialize` builds `new Game(cfg)` (terrain from the seed) and swaps in a fresh `RoadGraph`. Infinity (creative money and tray, an idle `assignAt`) is written as the string `"Infinity"` (a seed is exempt). Saved beyond the spec's list: commuter `next`, each building's pending and parked trips, stock, staffed, accumulators, happiness, parts and recent trips, node phase timers and delay, edge heat, the last 200 reports, the whole `Metrics` object, `lastHour`/`assignAt` (now public on `Game`), `upkeepDay`, `score`, `roadType`, fail counters. Deviation: a car on the road is saved as a trip pending at its origin (queued at the save time), like a demolished road, and its commuter stays `driving` (that is what the model uses for a trip waiting to leave), not `home`. Not saved: cars, the elevation tool level, `pendingLevel` (the pause menu cannot open over a modal), the tutorial; the trip/driver RNG restarts from the seed on load, so a loaded run is not bit-identical to an unbroken one. Keys `tm_save_auto` and `tm_save_1..3`; the autosave is written when `game.day` changes (checked by `main.ts` after each frame's updates) and on Quit to menu (the tutorial too), never after a game over. **Menu** (`src/ui/Menu.ts`, its own `#menu` root above `#hud`, which goes `inert` while it is open; `#hud` button primitives are shared via `:is(#hud, #menu)`): main menu Continue (the autosave, with its day, residents and level), New game (mode, difficulty with its money/tax/upkeep line, biome, size, seed field with a dice button for a random 6-character seed; Enter in the field starts), Load (autosave + 3 slots), Controls (the HUD's `CONTROLS` table, now exported). Pause menu: Resume (Esc; restores the speed it had), Save (3 slots, a status line confirms), Load, Controls, Quit to menu; the seed with a copy button. The menu's capture-phase keydown runs before any HUD's: while open no key reaches the HUD or the tools; closed, Esc opens the pause menu only when nothing else takes it (no game over or level modal, help closed, no road/bend/grid in progress, Place tool off, nothing selected, inspected, followed or picked, no interchange picked). Deviation: the Menu button sits at the end of the analysis buttons (`.views`) rather than beside Help. **main.ts**: `start(game)` aborts the previous HUD's and input's listeners (an `AbortSignal` passed to `HUD` and `attachInput`), builds HUD, Tutorial and input on the new game and resets the camera (`renderer.reset()`); the page opens the main menu over the autosave (or a default map); a new game starts the tutorial unless `tm_tutorial_done`. Game over: Play again (Enter) starts the same config afresh, Main menu opens the menu over it. simcheck: the main run round-trips to an identical string, its in-flight cars come back as pending trips, the network and controls match, and the loaded game runs 60s under the car invariants (now one `invariants(w)` helper) with trips arriving.

**S12 Tutorial, HUD polish, docs.**
- `Tutorial.ts`, 9 steps:
  1. Welcome
  2. connect the homes to the office
  3. watch the morning commute (4x)
  4. place a home from the tray
  5. connect the shop and read the trip feed
  6. make a junction and add a light
  7. open the junction panel and give a phase more seconds
  8. turn on the heat map
  9. money, upkeep and the next level
- `topUp` keeps money at or above $20,000 during the tutorial. Only on the tutorial's own game (creative, or day 1 with nothing built): there `tutorialActive` is set (top-ups, the tray home, no fail checks, the junction editor unlocked); a replay on a city in progress shows the cards only.
- `HUD.ts` CONTROLS table, `style.css` responsive pass (section 5 of hud-design), `docs/hud-design.md` updated to this HUD, `README.md` rewritten for the new genre, `src/ui/icons.ts` (money, people, smile/neutral/frown, star, clock, chart, list, heat, home, shop, office, factory, grid, interchange, lock, menu, save, eye, dice).
- Assert: the tutorial's `done` predicates are pure reads (`simcheck` runs each against a scripted game).
- Must keep working: everything, verified by `tsc`, `build`, `simcheck`, and a manual run through the menu, one career day and the tutorial.
- As built:
  - **Tutorial.** `tutorialSteps(g)` (exported for simcheck) has the 9 steps in the order above: welcome, homes to the office, the first commute, place a home, the shop on a road's middle (trip reports `T`), a light (`3`), Edit (`6`) the light and give a phase more seconds, the heat map (`C`), then money and levels.
    - `hint` is now a selector list that pulses several controls, for example the Buildings button and the tray, or the money and people chips.
    - The map targets point at the middle of the longest road.
    - Deviation: `Game.lockOf('junction')` is lifted while `tutorialActive`, so step 7 works at level 1. It is the only lock the tutorial lifts.
    - The bend step went, and the bend is explained in step 2. With it went `Game.lastBuild`.
  - **Keys.** Deviation: the number keys follow the dock order (`Input.KEY_TOOLS`): Road 1, Grid 2, Light 3, Roundabout 4, Interchange 5, Edit 6, Demolish 7, Buildings `B`. The dock badges, tooltips and the `CONTROLS` table derive from it.
  - **HUD.** `TOOLS` is a record keyed by tool. Locked tier swatches and One-way show the lock icon like the tools.
  - **Responsive.** Below 1280px the resources row and the status bar stack in one `.topl` column (a wrapped row used to run under the status bar). With a right-column panel open, the tutorial card steps left of it. On phones the card hides the left column and caps the panel column above itself.
  - **Fixes.**
    - The junction panel rendered into the car card's body (`.jbody` matched the first panel), so it showed empty.
    - A driveway now joins a road node within `DRIVE_SNAP` (30px) instead of splitting the road beside it. Homes placed facing each other made a 13px stretch between two junctions, and don't-block-the-box locked every car on it until they gave up.
  - **Icons.** The `week` icon is `calendar`. The remaining items of the spec's icon list already existed.
  - **Docs.** The README and `docs/hud-design.md` are rewritten for this game. The old screenshots went, and new ones are in `docs/screenshots` (overview, junction, analysis, tutorial).
  - **simcheck.** It checks that every `done` predicate leaves `serialize(game)` unchanged and plays the tasks through on a scripted level-1 town. It also checks facing homes: no road stretch under `DRIVE_SNAP`, and both commutes arrive.
  - **Known gap.** Short trips on empty roads often grade `wait`: the free-flow `ideal` leaves out pulling away from the door and the turns, so `SMOOTH_X` 1.5 is tight under about 10 s.

**S13 Playtest and balance.**
- Browser pass (Vite dev server, career normal and creative): menu, new game, every road tier, Grid, Light, Roundabout, the junction panel (control picker, phase seconds, presets, turn bans), Interchange (a blocked pick with its reason, then a diamond built), Edit (retype, lanes, bend), Demolish, place a batch, the level-up modal, heat map, follow a car, trip reports, metrics, save and load through the pause menu, the tutorial replay and the game-over modal. No console errors.
- Balance bot (a scratch script outside the repo): builds the starter town's street, links every workplace, places each batch beside a road, extends the network when there is no room, widens hot roads and lights busy junctions. Seeds over temperate, alpine and archipelago, on every difficulty, 10 to 20 days.
  - Normal reaches level 3 on day 3 and level 10 around day 10, with no bankruptcy. Hard and easy are the same, but slower or faster.
  - A player who builds nothing loses the residents on day 5 on every difficulty.
  - Cars peak at about 400 with 3,200 residents on day 18, under `MAX_CARS` (450).
- As built (fixes the bot found):
  - **Short links.** A car granted onto a link too short to clear the box before the next junction's line kept both junctions locked. It now lets go of the box behind it once it waits at the next line (`Car.update`), and its rear may overhang that box by a few pixels.
  - **Granted cars keep their speed.** The `TURN_SPEED` approach cap now applies only until the grant (roundabouts always). The corner speed still applies. A street lined with driveways no longer crawls.
  - **Free-flow time.** `Trip.ideal` adds `START_S` (0.6 s) for leaving the door and `JUNCTION_S` (0.4 s) for each junction on the free-flow route. Short trips on empty roads now grade `smooth`, which closes S12's known gap.
  - **Zero-length driveways.** `connect()` could split a road at a door that road ends on. That made a 0px edge, whose noise density was NaN, and then money and happiness turned NaN. A road point within `NODE_R` of a door now only takes the snap node.
  - **Balance: nowhere to go.** A home's `trips` part defaults to 0.6 only when the home has a job or a reachable shop, and to 0 otherwise. A home without a road scores 0 in every part, so a do-nothing city fails. Before this, a home without a road scored 33, which is above every `failHappy`.
- simcheck: the short-link gridlock (24 crossing trips arrive), free flow along a home-lined street (smooth, under 0.9 of the ideal), the no-roads career game fails by day `FAIL_FROM_DAY + FAIL_DAYS`, and no edge under 1px in the car invariants. The factory-penalty homes now reach a shop.
- Known gaps:
  - Trip times read long in game time (`HOUR` = 10 game s), so a smooth cross-map commute shows as "3.1 h". Shrinking it means a longer `DAY_SECONDS` or a time scale for display only.
  - The economy stays generous on normal: taxes outrun upkeep by about 3x through level 10.
  - A permissive left at a light can starve behind steady oncoming traffic until it gives up (`GIVE_UP_S`). Protected lefts are the player's fix.

**P5 Cars stuck without a way out.**
- Report: cars stuck for good in a city of homes lining streets, with driveways close to junctions and a ramp landing near a 4-way junction (41% smooth trips at rush hour).
- Reproduced headlessly: generated street grids with a home every ~40px on both sides, plain 4- and 5-way junctions, lights, a roundabout, a yield, a stop, a one-way piece and a viaduct whose ramps land on two junctions, soaked 3 days with growth on, logging every car stopped over 10 s and the wait-for chain behind it (scratch script, not in the repo).
- Root causes and fixes:
  - **U-turn reroutes deadlock.** After `REROUTE_S` a car could reroute into a U-turn at the junction ahead. Two of them on a short link waited for room in each other's lane forever, and the jam behind them gave up. The reroute now never takes a U-turn (`Car.update`). A U-turn is still taken when it is the only route (dead ends, a one-way ahead).
  - **Driveway junctions were full junctions.** A node where driveways meet one road (two road arms, `RoadGraph.drivewayJunction`) queued every car one at a time with don't-block-the-box, so a home-lined street was a stop line every 40px. Now the road's traffic passes it like a bend (`needsControl(n, via)`, `turn` skips it). A driveway car merges into a gap of `MERGE_GAP` (1 s) in the traffic it meets (a right turn meets only the traffic heading into its lane), and needs only room past the node. After `MERGE_S` (1 s) at its line the road keeps clear for it (`held`): road cars that can still stop wait at the line, and the merge waits only for cars in the box or too close to stop. The oncoming traffic a left turn crosses is held only once the left turn's lane has room.
  - **Plain junctions took one car at a time.** A plain junction (control None, not a driveway junction) now grants every car whose path across the box crosses none in it (`crosses`: the ends of two paths interleave around the node; same exit road or a U-turn always conflict), first come first served: a car never passes an earlier car it crosses that only waits for the box. Opposite straights, rights, and opposite lefts go together.
  - **Starved side roads and lefts.** A yield side road and a permissive left (yield's main road, or a light showing it yield) that have been at the front of their lane for `MERGE_S` with room to go stop the traffic they give way to, so they never wait until they give up. This closes S13's known gap.
  - **Box held from a queue.** A car clearing a junction let go of the box only when it waited at the next line; at a driveway junction it never queues, so a queue backed up through the box held it and gridlocked the block. It now lets go once it stops past the box.
- Before / after (3 days, seed 2, about 180 homes, 12 residents each at the start; after on the right):
  - Plain junctions only: 55% / 85% smooth, 148 / 6 stops over 10 s, 8 / 0 failed trips, 13 / 0 deadlock samples.
  - Lights on the grid crossings: 60% / 86% smooth, 308 / 0 stops over 10 s (longest 20 s / 9.7 s), 19 / 0 failed, 25 / 0 deadlock samples.
  - Twice the homes (overloaded): 20% / 49% smooth, 3,363 / 153 stops over 10 s, 1,230 / 432 failed. The failures left are trips waiting at a door while the city is at `MAX_CARS`; 560 / 1 gave up on the road.
- simcheck: a driveway merge (a stream both ways down a street never queues at a driveway junction, and a car out of a driveway on each side waits at most `MERGE_S` + 1 s) and a rush-hour town (about 100 homes on a street grid with lights, a roundabout, a yield, a one-way piece and a viaduct ramping onto two junctions, through two rush hours: no car stopped over `GIVE_UP_S` - 2 s, no failed trip, at least 75% smooth; the old sim fails it at 20 s, 1 failed, 70%).
- Known gaps:
  - Lane changes need `LC_M` (110px) clear of both nodes, so on a road lined with driveway junctions (40px links) a car never changes lane mid-edge; it picks its lane for the next real junction at the node instead.
  - A car turning left into a driveway does not yield to oncoming traffic.
  - The smooth grade still counts `JUNCTION_S` for every driveway junction on the free-flow route, though the road no longer slows down there.

**P6 Outside connections: export, import, visitors.**
- Report: no roads leave the city; factories should export and import, and visitors should arrive.
- Map: `generateTerrain` rolls 2-4 exits last (`Terrain.exits`, so the rest of a seed's map is unchanged). Each is an `EXIT_STUB` (160px) stub square to an edge, from the middle 60% of it, over dry land, at least (w + h) / 6 from the others. A map with wet edges (archipelago) can get fewer than 2. The starter town keeps 90px clear of the stubs.
- Model: an exit is a `Building` of kind `'gate'` (`Site = Zone | 'gate'`; `ZONES.gate` is labelled "Highway exit", has no residents or jobs and is never in the tray or `ZONE_KEYS`). Its door is on the map edge and its footprint lies off the map. `Game.addExits()` (constructor) adds each gate with a free two-way 2-lane highway stub (`exitEdge`: no price, upkeep or refund; Demolish refuses it with a toast and a red hover label). Retype and bend still work on it: a gate is not a doorway, so its stub may stay a highway. `buildingUnder` skips gates, so they cannot be picked, moved or demolished. Trips use the gate like any door: they spawn at it, and a trip to it never parks (the car leaves the map).
- Flows (hourly, only for buildings whose road component holds a gate; `linkedExits()` is the set of gates a town building reaches). Each trip uses a gravity-picked linked gate.
  - **Exports**: `EXPORT_SHARE` (0.4) of a factory's trucks go to the exit instead of a shop. All of them go when no shop is reachable.
  - **Imports**: a factory imports `IMPORTS_PER_DAY` (3) x staffed trucks of raw materials in `TRUCK_HOURS`. They unload and go back empty. A shop at or under `IMPORT_STOCK` (5) goods orders `IMPORT_SHOP` (0.5) trucks per hour from outside.
  - **Visitors**: new purpose `visit` (teal, "Visitors" in the legend). `VISITS` per day, shop 4 and office 2, along `SHOP_CURVE`. They stay `SHOP_STAY` and buy one good at a shop.
  - **Commuters from outside**: in hours `COMMUTE_MIN`..`COMMUTE_MAX`, `OUTSIDE_JOBS` (0.5) of a workplace's job slots that no resident holds get a commute from the exit. It stays `WORK_HOURS` and drives back. These commuters count toward `staffed`, which now counts parked commute trips instead of parked commuters.
  - New building accumulators `importAcc` and `visitAcc`.
- Money: an export reaching the exit pays `TAX_EXPORT` $40, an import arriving pays `TAX_IMPORT` $15 and a visitor arriving pays `TAX_VISIT` $8, each x taxMult. They go to the new `Ledger.trade`, which is in the money chip's net/day and in its tooltip. A commuter from outside pays `TAX_COMMUTE` as business. Balance: a town of 330 residents with a staffed factory, a shop and an office earns about $280/day in trade against about $1,500 in taxes. That is about 10 trade trips a day per factory, well under `MAX_CARS`.
- Metrics: `Sample.trade` counts exports, imports and visitors per hour, shown as the "Trade and visitors per hour" chart (older samples read 0).
- HUD and map: past the gate, the highway runs on off the map under a fade, with an arrow in and an arrow out and a green "WEST EXIT" style sign. An unlinked exit pulses a dashed ring at its stub's end with "Connect a road here: exports, imports and visitors". The money tooltip says when no exit is linked. Linking one toasts "Highway exit linked". Trip names: Export, Import, Visitor, Commute from outside, Leaving town; a report going out reads "to the highway".
- Save: building accumulators are saved. A save from before P6 (its buildings have no `importAcc`) gets its exits added on load, and its ledger gets `trade: 0`.
- simcheck: the starter town has 2-4 exits, each with a free stub, none linked. Exit scenario: an unlinked exit trades nothing and its stub survives Demolish while the factory runs. A street then links it, and over 2 days at least 2 exports leave and 2 imports arrive at the factory, and trade is paid.
- Known gaps:
  - An exit added to an older save is laid over whatever the player built there.
  - If a road crossing splits the stub, the inner piece becomes an ordinary road with upkeep and refund. Only the piece at the gate stays free.
  - Imports do not change a factory's output, and visitors do not count toward a shop's customers for happiness. They only bring money and traffic.
  - `linkedExits()` walks the graph every frame (renderer) and on every spend.
