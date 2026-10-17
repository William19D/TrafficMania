// Campaign maps (docs/design/game-v3.md 4): seeds plus terrain overrides on the generator, a constraint, objectives (★), the flow bar
// (★★) and the network budget (★★★). Map N teaches what has level N (TIERS, UNLOCKS, TIER_DEFS, SPECIALS). Run state lives in Game.run.
import type { Game } from './Game.ts';
import type { Biome, GameConfig, MapSize, Mode, Special } from './config.ts';
import { DIFFICULTY, SPECIALS, SPECIAL_KEYS } from './config.ts';
import { onRing } from '../network/RoadGraph.ts';

type Range = [number, number];
export type ObjKind = 'pop' | 'tripsHour' | 'tripsAt' | 'exports' | 'visitors' | 'special' | 'match' | 'ambulance';
// target: residents, trips, a count a day, a share (match, ambulance); at: tripsAt's hour; special: which one to build
export interface Objective { kind: ObjKind; target: number; at?: number; special?: Special }
// terrain: generator counts (rivers, mountains, lakes, exits); mods: commuteSd (rush hour), visitX (visitors x), through (exit-to-exit trips
// a day); unlock: total stars that open it; bonus: the achievement that opens it instead (bonus maps)
export interface MapDef {
  id: string; name: string; blurb: string; biome: Biome; size: MapSize; seed: string;
  terrain: { rivers: Range; mountains: Range; lakes?: Range; exits: Range };
  money: number; objectives: Objective[]; flow: number; budget: number; unlock: number;
  mods?: { commuteSd?: number; visitX?: number; through?: number }; bonus?: string;
}

// Challenge: start money x CHALLENGE_MONEY, objectives by day DEADLINE + map number, a day with GRIDLOCK of its trips given up (at least
// GRIDLOCK_MIN finished) ends it
export const CHALLENGE_MONEY = 0.7, DEADLINE = 6, GRIDLOCK = 0.4, GRIDLOCK_MIN = 20;

const map = (id: string, name: string, blurb: string, biome: Biome, size: MapSize, terrain: MapDef['terrain'], money: number,
  objectives: Objective[], flow: number, budget: number, unlock: number, mods?: MapDef['mods']): MapDef =>
  ({ id, name, blurb, biome, size, seed: id, terrain, money, objectives, flow, budget, unlock, mods });
const pop = (target: number): Objective => ({ kind: 'pop', target });
export const MAPS: MapDef[] = [
  map('meadowbrook', 'Meadowbrook', 'A quiet valley with one gentle river. Dirt roads and streets only.', 'temperate', 'small',
    { rivers: [1, 1], mountains: [0, 0], lakes: [0, 1], exits: [0, 0] }, 20000, [pop(300)], 0.8, 9000, 0),
  map('two-bridges', 'Two Bridges', 'A wide river splits the town: every crossing is a bridge.', 'temperate', 'small',
    { rivers: [1, 1], mountains: [0, 1], exits: [1, 1] }, 30000, [pop(600), { kind: 'tripsHour', target: 25 }], 0.75, 20000, 1),
  map('cedar-crossing', 'Cedar Crossing', 'Rush hour: everyone leaves for work between 7 and 9.', 'temperate', 'medium',
    { rivers: [0, 0], mountains: [0, 1], exits: [2, 2] }, 40000, [pop(900), { kind: 'tripsAt', target: 55, at: 8 }], 0.8, 30000, 3, { commuteSd: 0.4 }),
  map('pine-pass', 'Pine Pass', 'Mountains everywhere and few flat lots. The highway waits beyond the pass.', 'alpine', 'medium',
    { rivers: [0, 1], mountains: [6, 7], exits: [1, 1] }, 60000, [pop(1000), { kind: 'exports', target: 20 }], 0.7, 55000, 5),
  map('harbor-isles', 'Harbor Isles', 'Small islands: lots are scarce, so density matters.', 'archipelago', 'medium',
    { rivers: [2, 3], mountains: [0, 0], exits: [1, 2] }, 60000, [pop(1200), { kind: 'exports', target: 60 }], 0.75, 50000, 7),
  map('sunvale-corridor', 'Sunvale Corridor', 'Three times the visitors, and through traffic from exit to exit.', 'desert', 'large',
    { rivers: [0, 0], mountains: [2, 3], exits: [2, 2] }, 90000,
    [pop(1500), { kind: 'visitors', target: 150 }, { kind: 'special', target: 1, special: 'plaza' }], 0.75, 90000, 9, { visitX: 3, through: 100 }),
  map('stadium-heights', 'Stadium Heights', 'Match days flood the hills with fans.', 'temperate', 'medium',
    { rivers: [0, 1], mountains: [2, 3], exits: [2, 2] }, 80000, [pop(1800), { kind: 'match', target: 0.85 }], 0.75, 70000, 12),
  map('riverside-metro', 'Riverside Metro', 'Two rivers, mountains and three exits: all of it at scale.', 'temperate', 'large',
    { rivers: [2, 2], mountains: [3, 4], exits: [3, 3] }, 120000, [pop(3000), { kind: 'ambulance', target: 0.9 }], 0.75, 140000, 15),
  // bonus maps: opened by an achievement (Achievements.ts), every tool
  { ...map('lakeside-loop', 'Lakeside Loop', 'One big lake ringed by land: a single ring road around it.', 'temperate', 'medium',
    { rivers: [0, 0], mountains: [0, 1], lakes: [1, 1], exits: [1, 1] }, 50000, [pop(1500)], 0.8, 40000, 0), bonus: 'stars12' },
  { ...map('canyon-gate', 'Canyon Gate', 'Canyon walls and two exits on a tight budget.', 'desert', 'medium',
    { rivers: [0, 0], mountains: [4, 5], exits: [2, 2] }, 60000, [pop(2000), { kind: 'exports', target: 60 }], 0.8, 60000, 0), bonus: 'stars24' },
];

export const mapById = (id?: string): MapDef | null => MAPS.find(m => m.id === id) ?? null;
// 'map 3, Cedar Crossing': where a level's tools come from
export const unlockAt = (level: number): string => `map ${level}${MAPS[level - 1] ? `, ${MAPS[level - 1].name}` : ''}`;
// Campaign and Challenge: Normal (Hard) on the map's own seed and terrain; Endless picks its difficulty and tools
export const cfgFor = (m: MapDef, mode: Mode, extra: Partial<GameConfig> = {}): GameConfig =>
  ({ seed: m.seed, biome: m.biome, size: m.size, difficulty: mode === 'challenge' ? 'hard' : 'normal', mode, map: m.id, ...extra });

const pct = (x: number): string => `${Math.round(x * 100)}%`;
export function objLabel(o: Objective): string {
  const n = o.target.toLocaleString('en-US');
  switch (o.kind) {
    case 'pop': return `Reach ${n} residents`;
    case 'tripsHour': return `${n} trips in an hour`;
    case 'tripsAt': return `${n} trips from ${o.at}:00 to ${o.at! + 1}:00`;
    case 'exports': return `${n} exports a day`;
    case 'visitors': return `${n} visitors a day`;
    case 'special': return `Build a ${SPECIALS[o.special!].name}`;
    case 'match': return `A match with ${pct(o.target)} of fans on time`;
    case 'ambulance': return `${pct(o.target)} of the last 10 ambulances fast`;
  }
}
// The value shown against the target ('182 / 300', '64%')
export const objText = (o: Objective, v: number): string => o.kind === 'match' || o.kind === 'ambulance' ? pct(v)
  : `${Math.floor(v).toLocaleString('en-US')} / ${o.target.toLocaleString('en-US')}`;

// ---- run state: rolling 24 h counters by hour of day (h: the hours done, cur: this hour), the best match and the last ambulances ----
export type Count = 'trips' | 'smooth' | 'arrived' | 'exports' | 'visitors';
const COUNTS: Count[] = ['trips', 'smooth', 'arrived', 'exports', 'visitors'];
// spent: network spend (roads, controls, specials; zoning excluded), net of refunds; fans: this match's [sent, on time]; match: best share;
// amb: 1 fast / 0 slow, the last 10 calls; thru: through-trip accrual; done: objectives met once (graded); stars, efficiency: the best grade
export interface RunState {
  spent: number; h: Record<Count, number[]>; cur: Record<Count, number>; fans: [number, number]; match: number; amb: number[]; thru: number;
  done: boolean; stars: number; efficiency: number;
}
export const run0 = (): RunState => ({
  spent: 0, h: Object.fromEntries(COUNTS.map(k => [k, Array(24).fill(0)])) as RunState['h'], cur: Object.fromEntries(COUNTS.map(k => [k, 0])) as RunState['cur'],
  fans: [0, 0], match: 0, amb: [], thru: 0, done: false, stars: 0, efficiency: 0,
});
// The last 24 h of k: the hours done minus the slot this hour overwrites, plus this hour so far
export const roll = (g: Game, k: Count): number => g.run.h[k].reduce((n, x) => n + x, 0) - g.run.h[k][Math.floor(g.hour)] + g.run.cur[k];
// Hour h just ended: its counters go into their slot
export function closeHour(r: RunState, h: number): void {
  for (const k of COUNTS) { r.h[k][h] = r.cur[k]; r.cur[k] = 0; }
}

export function objValue(g: Game, o: Objective): number {
  const r = g.run;
  switch (o.kind) {
    case 'pop': return g.population;
    case 'tripsHour': return r.h.arrived[(Math.floor(g.hour) + 23) % 24];
    case 'tripsAt': return r.h.arrived[o.at!];
    case 'exports': return roll(g, 'exports');
    case 'visitors': return roll(g, 'visitors');
    case 'special': return g.buildings.filter(b => b.special === o.special).length;
    case 'match': return r.match;
    case 'ambulance': return r.amb.reduce((n, x) => n + x, 0) / 10;
  }
}

export interface Grade { stars: number; met: boolean[]; flow: number; spend: number; efficiency: number; day: number }
// ★ every objective holds, ★★ also the smooth share of the last 24 h at the flow bar, ★★★ also network spend within the budget.
// Efficiency (bragging): 1000 x smooth trips in 24 h / (1 + spend / 10,000) / (1 + junctions / 50)
export function grade(g: Game, m: MapDef): Grade {
  const met = m.objectives.map(o => objValue(g, o) >= o.target), trips = roll(g, 'trips'), smooth = roll(g, 'smooth');
  const flow = trips ? smooth / trips : 0, spend = g.run.spent;
  const junctions = g.graph.rings.length + g.graph.nodes.filter(n => !n.building && !onRing(n) && n.edges.filter(e => !e.drive).length >= 3).length;
  const stars = met.every(Boolean) ? 1 + +(flow >= m.flow) * (1 + +(spend <= m.budget)) : 0;
  return { stars, met, flow, spend, efficiency: Math.round(1000 * smooth / (1 + Math.max(0, spend) / 10000) / (1 + junctions / 50)), day: g.day };
}

// ---- milestone choices (docs 7): pick 1 of 2 at population milestones ----
export type Upgrade = 'crew' | 'zoning' | 'bank' | 'walls';
export const UPGRADES: Record<Upgrade, { name: string; text: string }> = {
  crew: { name: 'Road crew', text: 'Roads cost 20% less to build' },
  zoning: { name: 'Zoning office', text: 'Zoning is free and buildings grow 25% faster' },
  bank: { name: 'Bank deal', text: 'Loan interest halved, loan cap +$25,000' },
  walls: { name: 'Sound walls', text: 'Road noise at homes halved' },
};
export type Offer = { kind: 'money'; amount: number } | { kind: 'special'; special: Special } | { kind: 'upgrade'; up: Upgrade };
type Pool = Offer['kind'];
// ponytail: no luck, a fixed pool rotation; an offer not taken comes back first next time (Game.spare)
const ROT: Pool[][] = [['money', 'upgrade'], ['money', 'special'], ['special', 'upgrade']];

// Population of milestone n (1-based): Campaign and Challenge at 25/50/75% of the population goal, Endless every 500 to 3,000 then
// every 1,000, none in Creative
export function milestonePop(g: Game, n: number): number {
  if (g.creative) return Infinity;
  if (g.goals) { const t = g.map!.objectives.find(o => o.kind === 'pop')?.target; return t && n <= 3 ? t * n / 4 : Infinity; }
  return n <= 6 ? 500 * n : 3000 + 1000 * (n - 6);
}
export function milestonesAt(g: Game, pop: number): number {
  let n = 0;
  while (milestonePop(g, n + 1) <= pop) n++;
  return n;
}

// One offer from a pool, by need: the special for the highest demand that may still stand, the upgrade for the worst metric;
// a pool with nothing left gives money
function offer(g: Game, pool: Pool, n: number): Offer {
  if (pool === 'special') {
    const s = SPECIAL_KEYS.filter(s => g.unlocked(SPECIALS[s].level) && g.buildings.filter(b => b.special === s).length + g.tokens.filter(t => t === s).length < g.specialLimit(s))
      .sort((a, b) => g.demand[SPECIALS[b].kind] - g.demand[SPECIALS[a].kind])[0];
    if (s) return { kind: 'special', special: s };
  }
  if (pool === 'upgrade') {
    const want: Upgrade[] = [...(g.loan ? ['bank' as const] : []), ...(g.cityParts.noise > 0.2 ? ['walls' as const] : []), 'crew', 'zoning', 'walls', 'bank'];
    const up = want.find(u => !g.upgrades.includes(u));
    if (up) return { kind: 'upgrade', up };
  }
  return { kind: 'money', amount: 5000 * n * DIFFICULTY[g.cfg.difficulty].tax };
}
// The cards for milestone n: the pair the rotation gives, the spare first; one card when nothing else is left
export function offersFor(g: Game, n: number): Offer[] {
  const rot = ROT[(n - 1) % 3], first = g.spare ?? offer(g, rot[0], n);
  for (const k of [...rot, 'upgrade', 'special'] as Pool[]) {
    if (k === first.kind) continue;
    const o = offer(g, k, n);
    if (o.kind !== first.kind) return [first, o];
  }
  return [first];
}
export function offerText(g: Game, o: Offer): { title: string; text: string } {
  if (o.kind === 'special') return { title: `Free ${SPECIALS[o.special].name}`, text: `Place one from the Build menu at no cost (upkeep still applies). ${SPECIALS[o.special].tip}` };
  if (o.kind === 'upgrade') return { title: UPGRADES[o.up].name, text: `${UPGRADES[o.up].text}, for the rest of this city.` };
  const m = `$${Math.round(o.amount).toLocaleString('en-US')}`;
  return { title: m, text: g.loan ? `Pays ${m} off the bank loan${o.amount > g.loan ? ', the rest to the treasury' : ''}.` : `${m} to spend on the network.` };
}
// Takes card i: the other one waits as the spare
export function takeOffer(g: Game, i: number): void {
  const os = g.offers, o = os?.[i];
  if (!os || !o) return;
  g.spare = os[1 - i] ?? null;
  g.offers = null;
  if (o.kind === 'special') g.tokens.push(o.special);
  else if (o.kind === 'upgrade') g.upgrades.push(o.up);
  else {
    const debt = Math.min(g.loan, o.amount);
    g.loan -= debt;
    g.money += o.amount - debt;
    g.ledger.today.grants += o.amount - debt;
  }
  g.note(`Milestone ${g.milestone}: ${offerText(g, o).title}`);
}
