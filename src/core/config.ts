// New-game settings and the gameplay numbers per difficulty / biome / map size
export type Mode = 'career' | 'creative';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Biome = 'temperate' | 'desert' | 'alpine' | 'archipelago';
export type MapSize = 'small' | 'medium' | 'large';
export interface GameConfig { seed: string; mode: Mode; difficulty: Difficulty; biome: Biome; size: MapSize }
export const DEFAULT_CONFIG: GameConfig = { seed: 'trafficmania', mode: 'career', difficulty: 'normal', biome: 'temperate', size: 'medium' };

export const SIZES: Record<MapSize, { w: number; h: number }> = {
  small: { w: 2000, h: 1200 }, medium: { w: 2600, h: 1560 }, large: { w: 3200, h: 1920 },
};

type Range = [number, number];
// money: starting budget; tax/upkeep/trips/growth: multipliers; failHappy, debtDays: career fail thresholds;
// starterRoad: the seed town starts with a street between its homes
export const DIFFICULTY: Record<Difficulty, {
  money: number; tax: number; upkeep: number; trips: number; growth: number;
  failHappy: number; debtDays: number; rivers: Range; mountains: Range; starterRoad: boolean;
}> = {
  easy: { money: 60000, tax: 1.25, upkeep: 0.75, trips: 0.8, growth: 1.25, failHappy: 15, debtDays: 5, rivers: [1, 1], mountains: [2, 3], starterRoad: true },
  normal: { money: 40000, tax: 1, upkeep: 1, trips: 1, growth: 1, failHappy: 25, debtDays: 3, rivers: [1, 2], mountains: [3, 5], starterRoad: false },
  hard: { money: 25000, tax: 0.8, upkeep: 1.25, trips: 1.2, growth: 0.8, failHappy: 35, debtDays: 2, rivers: [2, 2], mountains: [5, 7], starterRoad: false },
};

// Terrain mix and palette per biome. rivers: null = the difficulty's count. Water is the same everywhere.
// patch: [sand, grass] colours; bands: mountain contour fills, outer to inner, lighter toward the peak so it reads raised.
export const BIOMES: Record<Biome, {
  label: string; land: string; patch: [string, string]; tree: string; bands: [string, string, string];
  trees: Range; lakes: Range; lakeR: Range; rivers: Range | null; mountains: number;
}> = {
  temperate: {
    label: 'Temperate', land: '#E6ECD8', patch: ['#EEE1C0', '#CFE3A8'], tree: '#79B257',
    bands: ['#7D7F79', '#9C9E96', '#C9CBC2'], trees: [120, 200], lakes: [0, 2], lakeR: [70, 130], rivers: null, mountains: 0,
  },
  desert: {
    label: 'Desert', land: '#F2E6CB', patch: ['#EBD2A0', '#E0DDAE'], tree: '#A3B266',
    bands: ['#A8835F', '#C29E78', '#DABE96'], trees: [20, 40], lakes: [1, 2], lakeR: [45, 80], rivers: [0, 1], mountains: 0,
  },
  alpine: {
    label: 'Alpine', land: '#E3EBE1', patch: ['#F5F7F7', '#D3E3C8'], tree: '#5E8F5A',
    bands: ['#8E9296', '#6F7377', '#F4F5F6'], trees: [200, 280], lakes: [1, 3], lakeR: [60, 110], rivers: null, mountains: 3,
  },
  // ponytail: islands are the land left between many large lakes and wide channels; a real sea mask if coastlines matter
  archipelago: {
    label: 'Archipelago', land: '#E7EDD6', patch: ['#F0E2BC', '#CDE3A6'], tree: '#74B25A',
    bands: ['#7D7F79', '#9C9E96', '#C9CBC2'], trees: [90, 150], lakes: [6, 9], lakeR: [130, 230], rivers: [2, 3], mountains: -2,
  },
};

// Road hierarchy. limit: px/s (Car MAX_SPEED 110 = avenue), a driver's top speed scales by limit / MAX_SPEED; kmh: UI only;
// lanes: allowed per direction; cost: $/tile at laneFactor 1 (upkeep = price x UPKEEP_RATE per day); noise 0..1 (home happiness);
// access: buildings may connect (S4); level: city level that unlocks it (S6).
// Look: fill / outline, shoulder px per side, median px between the directions (two-way), centre line.
export type Tier = 'dirt' | 'street' | 'avenue' | 'boulevard' | 'highway';
export const TIERS: Record<Tier, {
  label: string; limit: number; kmh: number; lanes: (1 | 2 | 3)[]; oneWay: boolean; cost: number; noise: number; access: boolean; level: number;
  fill: string; out: string; shoulder: number; median: number; line: 'none' | 'yellow' | 'median' | 'double';
}> = {
  dirt: { label: 'Dirt road', limit: 60, kmh: 30, lanes: [1], oneWay: false, cost: 20, noise: 0.05, access: true, level: 1, fill: '#E3D6B8', out: '#C2B392', shoulder: 0, median: 0, line: 'none' },
  street: { label: 'Street', limit: 90, kmh: 40, lanes: [1], oneWay: true, cost: 60, noise: 0.15, access: true, level: 1, fill: '#FFFFFF', out: '#9E9E9A', shoulder: 0, median: 0, line: 'yellow' },
  avenue: { label: 'Avenue', limit: 110, kmh: 50, lanes: [1, 2], oneWay: true, cost: 90, noise: 0.35, access: true, level: 2, fill: '#FFFFFF', out: '#85857F', shoulder: 1.5, median: 0, line: 'yellow' },
  boulevard: { label: 'Boulevard', limit: 125, kmh: 60, lanes: [2, 3], oneWay: true, cost: 140, noise: 0.5, access: true, level: 4, fill: '#FFFFFF', out: '#85857F', shoulder: 1.5, median: 5, line: 'median' },
  highway: { label: 'Highway', limit: 150, kmh: 90, lanes: [2, 3], oneWay: true, cost: 220, noise: 0.9, access: false, level: 6, fill: '#F7F7F5', out: '#8A99AD', shoulder: 3, median: 0, line: 'double' },
};

// Building zones: footprint w (along the front) x h (depth) px; residents / jobs: capacity; look: fill, outline, roof inset.
// A Site is a zone or a highway exit ('gate': the map-edge end of an outside connection, never in the tray)
export type Zone = 'home' | 'shop' | 'office' | 'industry';
export type Site = Zone | 'gate';
export const ZONES: Record<Site, { label: string; w: number; h: number; residents: number; jobs: number; fill: string; out: string; roof: string }> = {
  home: { label: 'Home', w: 28, h: 24, residents: 30, jobs: 0, fill: '#FFFFFF', out: '#8DB17A', roof: '#BCDCA8' },
  shop: { label: 'Shop', w: 44, h: 30, residents: 0, jobs: 10, fill: '#8EC3EE', out: '#4F8CC6', roof: '#BBDAF5' },
  office: { label: 'Office', w: 38, h: 38, residents: 0, jobs: 30, fill: '#ABA3CF', out: '#7468A8', roof: '#CBC5E4' },
  industry: { label: 'Factory', w: 56, h: 40, residents: 0, jobs: 25, fill: '#E2B866', out: '#B08938', roof: '#EDD097' },
  gate: { label: 'Highway exit', w: 30, h: 16, residents: 0, jobs: 0, fill: '#2F8F5B', out: '#1F6B42', roof: '#3FA36B' },
};
// Trip purposes: car colour on the map and in the legend (a return trip keeps its purpose)
// visit: a visitor from outside the map to a shop or office
export type Purpose = 'commute' | 'shop' | 'freight' | 'visit';
export const PURPOSES: Record<Purpose, { label: string; color: string }> = {
  commute: { label: 'Commute', color: '#5A6FD8' },
  shop: { label: 'Shopping', color: '#E8608E' },
  freight: { label: 'Freight', color: '#E39B2D' },
  visit: { label: 'Visitors', color: '#1FA39A' },
};

// City levels (career): population to reach each one and the batch of buildings it puts in the tray. LEVELS[0] is the start
// (the tray next to the starter town). Past the last level every ENDLESS_POP more residents grant ENDLESS_BATCH.
// Tiers unlock at TIERS[t].level, other features at UNLOCKS[f].level; creative has everything.
const batch = (home: number, shop: number, office: number, industry: number): Record<Zone, number> => ({ home, shop, office, industry });
export const LEVELS: { pop: number; batch: Record<Zone, number> }[] = [
  { pop: 0, batch: batch(6, 1, 3, 0) },
  { pop: 220, batch: batch(6, 1, 2, 0) },
  { pop: 400, batch: batch(7, 1, 1, 2) },
  { pop: 580, batch: batch(8, 2, 2, 1) },
  { pop: 800, batch: batch(9, 1, 3, 1) },
  { pop: 1000, batch: batch(10, 2, 3, 1) },
  { pop: 1250, batch: batch(10, 1, 3, 1) },
  { pop: 1500, batch: batch(12, 2, 4, 1) },
  { pop: 1800, batch: batch(12, 2, 4, 1) },
  { pop: 2100, batch: batch(6, 1, 2, 1) },
];
export const ENDLESS_POP = 300, ENDLESS_BATCH = batch(6, 1, 2, 1);
export type Feature = 'roundabout' | 'oneway' | 'viaduct' | 'tunnel' | 'high' | 'junction' | 'grid' | 'interchange';
export const UNLOCKS: Record<Feature, { level: number; label: string }> = {
  roundabout: { level: 2, label: 'Roundabouts' },
  oneway: { level: 2, label: 'One-way roads' },
  junction: { level: 4, label: 'Light phases, protected lefts and lane connections' },
  viaduct: { level: 3, label: 'Viaducts L1-L5 and ramps' },
  tunnel: { level: 5, label: 'Tunnels' },
  high: { level: 5, label: 'Viaducts L6-L10' },
  grid: { level: 5, label: 'Grid tool' },
  interchange: { level: 6, label: 'Interchanges' },
};

// Gameplay tuning ($); later steps add theirs
export const TUNING = {
  BRIDGE_X: 4, VIADUCT_X: 2.5, VIADUCT_LEVEL_X: 0.1, TUNNEL_X: 5, // price multipliers: water share, viaduct (+ per level), mountain share
  LIGHT_COST: 600, LIGHT_UPKEEP: 4, ROUNDABOUT_COST: 1200, ROUNDABOUT_UPKEEP: 2, SIGN_COST: 150, SIGN_UPKEEP: 0.5, // yield / stop signs
  UPKEEP_RATE: 0.02,         // of a road's build price, per day
  REFUND_SAME_DAY: 1, REFUND_LATER: 0.5,
  ACCESS_R: 60,              // px from a door to the road its free driveway joins
  DRIVE_SNAP: 30,            // px: a driveway joins a road node this close instead of splitting (a truck plus its gap fits between junctions)
  // Day clock: game seconds per in-game day (1x = 4 real minutes, 10 s per hour); Day 1 starts at 06:00
  DAY_SECONDS: 240, START_HOUR: 6,
  // Trips: one commuter (car) = PEOPLE_PER_CAR workers; homes start START_OCC full; departures ~ N(MEAN, SD) hours clamped to MIN..MAX
  PEOPLE_PER_CAR: 5, EMPLOY_RATE: 0.5, START_OCC: 0.6,
  COMMUTE_MEAN: 8, COMMUTE_SD: 0.75, COMMUTE_MIN: 6, COMMUTE_MAX: 10, WORK_HOURS: 9,
  SHOP_RATE: 0.35,           // shopping round trips per car-unit (5 residents) per day
  SHOP_CURVE: [0, 0, 0, 0, 0, 0, 0, .2, .4, .7, 1, 1.2, 1.2, 1, .9, .9, 1, 1.3, 1.3, 1, .6, .3, 0, 0], // per hour, normalised to sum 1
  SHOP_STAY: 1,              // in-game hours parked at the shop
  TRUCKS_PER_DAY: 8, TRUCK_HOURS: [6, 18], STOCK_PER_TRUCK: 10, STOCK_START: 20,
  GRAVITY_D: 900,            // px, destination weight = capacity x exp(-d / GRAVITY_D)
  SPAWN_FAIL: 3,             // in-game hours waiting at the door -> gave up
  MAX_RETRIES: 1, MAX_CARS: 450,
  SMOOTH_X: 1.5, WAIT_SHARE: 0.4, DETOUR_X: 1.3, // outcome: time vs free-flow ideal, share of the trip stopped, length vs ideal
  START_S: 0.6, JUNCTION_S: 0.4, // game s the free-flow ideal adds for leaving the door and for each junction on the way
  // Growth per day as a share of a home's capacity, by happiness band; below GROW_LO households move out until the home stands empty
  GROW_HI: 60, GROW_LO: 30, GROW_FAST: 0.25, GROW_SLOW: 0.1, SHRINK: 0.1,
  // Home happiness = 100 x (W_JOB job + W_SHOP shop + W_TRIPS trips - W_POLL pollution - W_NOISE noise), parts 0..1;
  // city happiness = the residents-weighted mean as an EMA over HAPPY_TAU hours
  W_JOB: 0.25, W_SHOP: 0.2, W_TRIPS: 0.55, W_POLL: 0.4, W_NOISE: 0.3, HAPPY_TAU: 24,
  // $ per resident per day x (0.5 + 0.5 x happiness), paid hourly; business $ per arrival at a workplace, shop (half with no stock) or of goods
  TAX_RES: 5, TAX_COMMUTE: 2, TAX_SHOP: 4, TAX_FREIGHT: 25,
  FAIL_DAYS: 2, FAIL_FROM_DAY: 4, // career: happiness under DIFFICULTY.failHappy at FAIL_DAYS midnights in a row, from day FAIL_FROM_DAY
  LEVEL_GRANT: 2000,         // $ x level x taxMult on each level-up
  PLACED_OCC: 0.4,           // a home placed from the tray moves in 40% full
  MOVE_COST: 300,            // $ to move a building (career), or to demolish one back into the tray
  SNAP_R: 80, DRIVE_GAP: 12, // the ghost snaps to an access road within SNAP_R px, its door DRIVE_GAP px past the road's edge
  POLLUTION_R: 260, NOISE_R: 100, NOISY: 0.35, // factory pollution reach, road noise reach, a tier the place tool warns about
  HEAT_TAU: 10,              // game seconds: congestion (edge heat, junction delay) EMA time constant
  // Outside connections (highway exits), only once linked to the town's roads: EXPORT_SHARE of a factory's trucks leave the map
  // (all of them with no shop to reach); a factory imports IMPORTS_PER_DAY trucks x staffed of raw materials; a shop at or under
  // IMPORT_STOCK goods orders IMPORT_SHOP trucks per hour from outside (TRUCK_HOURS); visitors per day along SHOP_CURVE;
  // OUTSIDE_JOBS of the job slots no resident holds fill with commuters from outside (arriving COMMUTE_MIN..MAX).
  // $ per export leaving, import arriving, visitor arriving (x taxMult): the ledger's trade
  EXIT_STUB: 160, EXPORT_SHARE: 0.4, IMPORTS_PER_DAY: 3, IMPORT_STOCK: 5, IMPORT_SHOP: 0.5, VISITS: { shop: 4, office: 2 }, OUTSIDE_JOBS: 0.5,
  TAX_EXPORT: 40, TAX_IMPORT: 15, TAX_VISIT: 8,
} as const;
