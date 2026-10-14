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
// money: starting budget; tax/upkeep/trips/growth: multipliers; failHappy, debtDays: career fail thresholds
export const DIFFICULTY: Record<Difficulty, {
  money: number; tax: number; upkeep: number; trips: number; growth: number;
  failHappy: number; debtDays: number; rivers: Range; mountains: Range;
}> = {
  easy: { money: 60000, tax: 1.25, upkeep: 0.75, trips: 0.8, growth: 1.25, failHappy: 15, debtDays: 5, rivers: [1, 1], mountains: [2, 3] },
  normal: { money: 40000, tax: 1, upkeep: 1, trips: 1, growth: 1, failHappy: 25, debtDays: 3, rivers: [1, 2], mountains: [3, 5] },
  hard: { money: 25000, tax: 0.8, upkeep: 1.25, trips: 1.2, growth: 0.8, failHappy: 35, debtDays: 2, rivers: [2, 2], mountains: [5, 7] },
};

// Terrain mix and palette per biome. rivers: null = the difficulty's count. Water is the same everywhere.
// patch: [sand, grass] colours; bands: mountain contour fills, outer to inner.
export const BIOMES: Record<Biome, {
  label: string; land: string; patch: [string, string]; tree: string; treeOut: string; bands: [string, string, string];
  trees: Range; lakes: Range; lakeR: Range; rivers: Range | null; mountains: number;
}> = {
  temperate: {
    label: 'Temperate', land: '#ECEAE4', patch: ['#E6DCC0', '#D7E3B5'], tree: '#7FAE5A', treeOut: '#5E8A42',
    bands: ['#8C8C88', '#6E6E6A', '#5B5B58'], trees: [120, 200], lakes: [0, 2], lakeR: [70, 130], rivers: null, mountains: 0,
  },
  desert: {
    label: 'Desert', land: '#EFE6D2', patch: ['#E6D3A8', '#EADBB6'], tree: '#A7B36A', treeOut: '#7F8A4C',
    bands: ['#C9A882', '#B08D68', '#94735A'], trees: [20, 40], lakes: [1, 2], lakeR: [45, 80], rivers: [0, 1], mountains: 0,
  },
  alpine: {
    label: 'Alpine', land: '#E8EBE6', patch: ['#F2F3F1', '#DCE5D6'], tree: '#5E8F5A', treeOut: '#456D42',
    bands: ['#8E9296', '#6F7377', '#F4F5F6'], trees: [200, 280], lakes: [1, 3], lakeR: [60, 110], rivers: null, mountains: 3,
  },
  // ponytail: islands are the land left between many large lakes and wide channels; a real sea mask if coastlines matter
  archipelago: {
    label: 'Archipelago', land: '#EDEBE1', patch: ['#EFE3C4', '#D2E2B0'], tree: '#79AE5E', treeOut: '#58884A',
    bands: ['#8C8C88', '#6E6E6A', '#5B5B58'], trees: [90, 150], lakes: [6, 9], lakeR: [130, 230], rivers: [2, 3], mountains: -2,
  },
};

// Road hierarchy. limit: px/s (Car MAX_SPEED 110 = avenue), a driver's top speed scales by limit / MAX_SPEED; kmh: UI only;
// lanes: allowed per direction; cost: $/tile at laneFactor 1 (upkeep = price x UPKEEP_RATE per day); noise 0..1 (S7);
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

// Gameplay tuning ($); later steps add theirs
export const TUNING = {
  BRIDGE_X: 4, VIADUCT_X: 2.5, VIADUCT_LEVEL_X: 0.1, TUNNEL_X: 5, // price multipliers: water share, viaduct (+ per level), mountain share
  LIGHT_COST: 600, LIGHT_UPKEEP: 4, ROUNDABOUT_COST: 1200, ROUNDABOUT_UPKEEP: 2,
  UPKEEP_RATE: 0.02,         // of a road's build price, per day
  REFUND_SAME_DAY: 1, REFUND_LATER: 0.5,
  ARRIVAL_PAY: 15,           // placeholder income per arrived trip until S7's taxes
} as const;
