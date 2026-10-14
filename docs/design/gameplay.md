# TrafficMania gameplay design: the traffic-management pivot

Target: a traffic-management city game. The gameplay logic follows *Traffic Architect* (buildings generate trips, the player designs the network, every car is simulated and routes around traffic, analysis tools show the bottleneck). The presentation and city layer follow *Trafficity* (flat 2D top-down, a simple zoned economy, level-ups hand you a batch of buildings to place). The art stays our own flat style.
Out of scope: public transport and rail, map editor, Workshop, multiplayer, outside (map-edge) connections.
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
DAY_SECONDS: 120,          // game seconds per in-game day at 1x; 5 s per hour; the clock starts at Day 1 06:00
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
`hour = (time / DAY_SECONDS * 24 + 6) % 24` and `day = floor((time / DAY_SECONDS * 24 + 6) / 24) + 1`. The hourly tick (every 5 game seconds) runs happiness, growth, taxes, upkeep, demand accrual and the metrics sample. At 03:00 the daily commuter assignment runs. At 00:00 the game checks the fail conditions, rolls the ledger (`yesterday = today`) and resets `stats.today`.

### Trip generation
- **Commuters.** Each home has `floor(residents * EMPLOY_RATE / PEOPLE_PER_CAR)` commuters. Assignment (at 03:00 daily, and one in-game hour after any building or network change) gives each unassigned commuter a reachable workplace (shop/office/industry) that has free slots (`jobs / PEOPLE_PER_CAR`). The pick is gravity-weighted: `w = freeSlots * exp(-dist / GRAVITY_D)` (Euclidean). A commuter whose workplace became unreachable loses it. Its `depart` hour is drawn once from N(8:00, 0.75h), clamped to 6..10. At `depart` a `commute` trip is queued. When it arrives, the trip moves to `work.parked` and the commuter is `away`. At `depart + WORK_HOURS` a `return` trip is queued from work.
- **Shopping.** Per home per hour: `shopAcc += residents / PEOPLE_PER_CAR * SHOP_RATE * SHOP_CURVE[h] * tripsMult`. Each whole unit queues a `shop` trip to a gravity-chosen reachable shop (capacity = jobs). The car stays parked `SHOP_STAY` hours, then a `return` trip goes home. Each arrival is one customer: `stock -= 1` and the shop is paid.
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
- **Road price** = `ceil(len / TILE * laneFactor(type) * TIERS[tier].cost * m)`. `m` = 1 for ground, `BRIDGE_X` for ground over water, `VIADUCT_X + VIADUCT_LEVEL_X * level` for level >= 1, `TUNNEL_X` for a tunnel. The multiplier applies per segment, not per run.
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
- **Refund** = price x (`edge.day === today` ? `REFUND_SAME_DAY` : `REFUND_LATER`). The price is recomputed from the geometry, so splits need no bookkeeping. Retype and bend credit the old run at full price (editing is not punished). ponytail: a downgrade then refunds the full difference. Accept it.
- **Driveways** (`drive: true`): free, street tier, 1 lane, no refund.
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
- Clock: `Day 4 · 08:20` with a 24-cell bar. Cells 7-9 and 16-19 are tinted `--accent-soft` (rush hours), past cells are filled ink, and the current cell fills by minute. "Paused" replaces the text while paused.
- Trips: `[car] 312 · 86% smooth` (today's arrivals and smooth share).

**C:** Help `?` plus Menu `≡` (pause menu).

**D, dock**, left to right. Locked tools show a `lock` icon, are `aria-disabled`, and a click toasts `Unlocks at level N`:
- `Road [1]`, `Grid [6]`
- tier picker: 5 small swatch buttons (dirt beige, street, avenue, boulevard with a green median, highway gray), tooltip `Avenue · 50 km/h · 1-2 lanes · $90/tile`
- lanes 1/2/3 (disabled outside the tier's range) | One-way | Flip
- elevation stepper (as today)
- `Light [2]`, `Roundabout [3]`, `Interchange [7]`
- `Buildings [B]`, with a badge of unplaced count that pulses on level-up
- `Edit [4]`, `Demolish [5]`
- `Heat map [C]` (a toggle, `aria-pressed`)

Other keys: `R` rotates a building ghost, `M` metrics, `T` trip feed, `F` follows the selected car, `Esc` cancels, then closes the top panel, then opens the pause menu, `Space` pauses. The tool keys 1-5 keep today's meaning.

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

**H, batch tray** (bottom-left above the dock, vertical): one card per zone with a count (`[home] Home ×8`). A click enters `place` with a ghost footprint: green/red validity with a reason label, the door marker, and a dashed `POLLUTION_R` ring for industry. Placement rules:
- no overlap with water, mountains, roads or buildings (4px margin), and fully inside the map;
- the ghost auto-aligns to the nearest road within 80px, and `R` rotates it 90°;
- a non-highway ground road within `ACCESS_R` of the door gets an auto driveway, otherwise the building gets a "No road" badge.

The tool stays in `place` until the count hits 0 or Esc.

**Modals:**
- Level up: `Level 4!`, unlock list, batch rows, grant, Enter.
- Game over: `Bankrupt` / `The residents left`, with stats day, population, level, trips, smooth%, and buttons Play again / Main menu.
- Victory.
- Pause menu: Resume, Save, Load, Main menu, seed shown with a copy button.
- Main menu (S11).

**Canvas:**
- Buildings are flat rounded rects with a soft shadow, in zone colours: home `#F4A261`, shop `#4EA8DE`, office `#8E7CC3`, industry `#9E9E9A` with stripes and a chimney dot. A white door notch faces the road, and parked cars or pending trips show as dots by the door. An unconnected building has a dashed danger outline.
- Heat map: each edge stroked with `e.width + 4` at 0.75 alpha, coloured `#4CC26A -> #E0A100 -> #E5484D` by `heat`. Junction circles are sized by `delay`.
- Off-screen markers (today's code) now point at unconnected buildings.

---

## 5. Implementation plan

Every step leaves the game playable (engine, renderer, HUD, input and tutorial) and keeps simcheck's invariants (sorted lanes, no overlaps, clean occupants, trips complete), plus one new assertion. "Must keep working" lists what a reviewer clicks through.

**S1 Seeded RNG, biomes, difficulty, new-game config.**
- Files: `src/util/rng.ts` (new); `src/core/config.ts` (new: `GameConfig`, `DEFAULT_CONFIG`, `SIZES`, `DIFFICULTY`, `BIOMES`, and an empty `TUNING` that later steps fill); `MapGenerator.ts` (`generateTerrain(cfg)` uses its own rng, biome params, counts per difficulty, `WORLD` sized from `SIZES`); `Game.ts` (`new Game(cfg)`); `Car.ts` (drivers use `random()`); `CanvasRenderer.ts` (land, patch, tree and mountain colours from `BIOMES[terrain.biome]`); `main.ts` (cfg from URL `?seed=&biome=&difficulty=&size=&mode=` until S11); `scripts/simcheck.ts` (`setSeed`).
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
- Must keep working: building, bending, retyping and demolishing, with the week dots still running.

**S3 Road hierarchy tiers.**
- Files: `config.ts` (`TIERS`); `RoadGraph.ts` (`RoadType.tier`, `DEFAULT_TYPE`, `sameType`, `heat`); `Car.ts` (speed limit); `Pathfinder.ts` (time cost; a binary heap replaces the linear open list); `Game.ts` (price per tier, lane clamp); `CanvasRenderer.ts`:
  - dirt: fill `#E3D6B8`, outline `#C2B392`, no centre line;
  - boulevard: a 3px `#BFD8A0` median instead of the yellow line;
  - highway: fill `#F7F7F5`, outline `#8A99AD`, a double gray centre line;
- `HUD.ts`: the tier picker. No locks yet.
- `simcheck`: the default tier is `avenue` (limit = `MAX_SPEED`, so the existing speed checks hold).
- Assert: a car on dirt never exceeds `vmax * 60/110 + 1`, and A* takes a longer highway over a shorter dirt road.
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
- Must keep working: roads snap to doors, and cars spawn and arrive.

**S5 Trip generation and the day cycle.**
- Files: `config.ts` (`TUNING` trip and clock values); `Game.ts` (clock, hourly tick, commuters and assignment, shopping and freight accrual, parking and returns, outcome classification, `reports`, `stats`, `MAX_CARS`); `Trip.ts`; `Car.ts` (accumulates `driven`, `stopped`).
- `HUD.ts`: the clock and 24-cell bar replace the week dots, plus trips today.
- `Tutorial.ts`: the "watch the cars" step waits for the first commute.
- Assert: over one simulated day on a fixed town, at least 70% of commute departures fall between 6:00 and 10:00, and every arrived commuter's return trip is queued by `depart + WORK_HOURS`.
- Must keep working: the deadlock, lost, demolish and U-turn scenarios (trips requeue at the origin).

**S6 City growth, levels and building batches.**
- Files: `config.ts` (`ZONES` capacities, `LEVELS`); `Game.ts` (residents growth. Until S7 the "happy" input is `trips` x 100, so homes grow when their trips succeed. `level`, `pendingLevel`, grant, `tray`, `placing`, `placeBuilding(p, angle)` with an auto driveway, unlock checks on tools and tiers);
- `Input.ts`: the `place` tool, `B` and `R`.
- `HUD.ts`: population, level chip, tray (H), level-up modal, locks.
- `CanvasRenderer.ts`: ghost footprint, validity, door, ring.
- Creative: all unlocked, tray counts `Infinity` (shown `∞`).
- Assert: pushing the population over `LEVELS[1].pop` raises the level and adds the batch to the tray, and placing a home within `ACCESS_R` of a street builds a driveway that a queued trip can drive.
- Must keep working: Edit and Demolish on driveways (refund 0).

**S7 Happiness, taxes, fail conditions.**
- Files: `Game.ts` (pollution, noise, access, the happiness formula, growth bands, taxes and business replace the flat $15, upkeep, ledger, bankruptcy and happiness checks, victory; `gameOver` becomes a reason string).
- `HUD.ts`: happiness chip, ledger tooltip, danger countdowns, game over and victory modals.
- `CanvasRenderer.ts`: a tiny happiness dot on each home, shown only while it is inspected or under the heat map.
- Assert: an identical home 60px from a staffed industry scores at least 25 points lower than one 600px away, and career money below 0 for `DEBT_DAYS` midnights sets `gameOver = 'bankrupt'` while creative never does.
- Must keep working: tutorial (`tutorialActive` suppresses fails).

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

**S10 Analysis: heat map, follow car, trip reports, metrics charts.**
- Files: `RoadGraph.ts` (`heat`, `delay` EMAs); `src/core/Metrics.ts` (hourly samples); `Game.ts` (`overlay`, `follow`, `inspect`, `carAt(p)`); `Input.ts` (Edit click priority: car, then junction, then building, then road; keys `C`, `M`, `T`, `F`); `CanvasRenderer.ts` (heat overlay, follow camera, route line); `HUD.ts` (panels G: car, building, metrics with inline SVG sparklines, trip feed).
- Assert: after one simulated day there are exactly 24 metric samples, and a saturated edge has `heat` greater than an idle one.
- Must keep working: Edit road selection when nothing else is under the cursor.

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
- `topUp` keeps money at or above $20,000 during the tutorial.
- `HUD.ts` CONTROLS table, `style.css` responsive pass (section 5 of hud-design), `docs/hud-design.md` updated to this HUD, `README.md` rewritten for the new genre, `src/ui/icons.ts` (money, people, smile/neutral/frown, star, clock, chart, list, heat, home, shop, office, factory, grid, interchange, lock, menu, save, eye, dice).
- Assert: the tutorial's `done` predicates are pure reads (`simcheck` runs each against a scripted game).
- Must keep working: everything, verified by `tsc`, `build`, `simcheck`, and a manual run through the menu, one career day and the tutorial.
