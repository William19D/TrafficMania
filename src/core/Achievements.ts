// Achievements (docs/design/game-v3.md 7): checked on the hour and on game events (Game.fv), never in Creative. Unlocks go to the profile
// with their time; a reward is a cosmetic or a bonus map. Event counters live in Game.feats (saved with the city).
import type { Game } from './Game.ts';
import { HOUR } from './Game.ts';
import type { Profile } from './Profile.ts';
import { totalStars as stars } from './Profile.ts';
import { MAPS, roll } from './Campaign.ts';
import { RINGS } from '../network/RoadGraph.ts';

export type Paint = 'classic' | 'pastel' | 'retro' | 'neon' | 'gold';
export type Island = 'grass' | 'flowers' | 'fountain' | 'statue';
export const PAINTS: Paint[] = ['classic', 'pastel', 'retro', 'neon', 'gold'];
export const ISLANDS: Island[] = ['grass', 'flowers', 'fountain', 'statue'];
export interface AchDef { id: string; name: string; text: string; reward?: { paint?: Paint; island?: Island; map?: string }; test: (g: Game, p: Profile) => boolean }

// a map's objectives met once (graded), Campaign or Challenge
const cleared = (g: Game): boolean => g.goals && g.run.done;
const lastHour = (g: Game, k: 'arrived' | 'trips' | 'smooth'): number => g.run.h[k][(Math.floor(g.hour) + 23) % 24];
// bridges over water: ground bridge edges whose ends meet a road that is not one (two ends a bridge)
function bridges(g: Game): number {
  let ends = 0;
  for (const e of g.graph.edges) if (e.bridge && !e.level) for (const v of [e.a, e.b]) if (!v.edges.some(o => o !== e && o.bridge && !o.level)) ends++;
  return Math.floor(ends / 2);
}
// a mall (tier or plaza) with ≥ 50 of the last trips to it and their mean stopped time under 20 in-game minutes
function mall(g: Game): boolean {
  const m = new Map<object, number[]>();
  for (const r of g.reports) if (r.to.label === 'Mall' || r.to.special === 'plaza') (m.get(r.to) ?? m.set(r.to, []).get(r.to)!).push(r.stopped ?? Infinity);
  return [...m.values()].some(s => s.length >= 50 && s.reduce((a, b) => a + b, 0) / s.length < HOUR / 3);
}
function laneWizard(g: Game): boolean {
  const j = g.graph.nodes.filter(n => !n.building && n.edges.length >= 3 && !n.ring);
  return j.filter(n => n.plan).length >= 3 && j.reduce((a, n) => a + n.delay, 0) / Math.max(1, j.length) < 5;
}

const a = (id: string, name: string, text: string, test: AchDef['test'], reward?: AchDef['reward']): AchDef => ({ id, name, text, test, reward });
export const ACHIEVEMENTS: AchDef[] = [
  a('first', 'First Commute', 'A trip arrives', g => g.stats.arrived > 0),
  a('paint', 'Paint the Town', 'Zone 20 lots in one drag', g => (g.feats.paint ?? 0) >= 20),
  a('rings', 'Round and Round', 'A roundabout of each size in one city', g => RINGS.every((_, s) => g.graph.rings.some(r => r.hub.ring === s)), { island: 'flowers' }),
  a('nolights', 'No Lights Needed', 'Clear a map with no traffic lights', g => cleared(g) && !g.graph.nodes.some(n => n.control === 'light'), { island: 'fountain' }),
  a('halfoff', 'Half Off', 'Clear a map spending half its ★★★ budget or less', g => cleared(g) && g.run.spent <= g.map!.budget / 2, { paint: 'gold' }),
  a('streak', 'Smooth Operator', '1,000 trips in a row with nobody giving up', g => (g.feats.streak ?? 0) >= 1000, { paint: 'pastel' }),
  a('mall', 'Mall Rat', '50 trips to a mall stopping under 20 minutes on average', mall),
  a('tower', 'Skyline', 'Grow the first tower', g => g.buildings.some(b => /Tower/.test(b.label))),
  a('rush', 'Rush Hour Hero', '150 trips in an hour, 85% of them smooth', g => lastHour(g, 'arrived') >= 150 && lastHour(g, 'smooth') >= 0.85 * lastHour(g, 'trips')),
  a('bridges', 'Bridge Builder', '5 bridges in one city', g => bridges(g) >= 5),
  a('tunnel', 'Tunnel Vision', 'A tunnel through a mountain', g => g.graph.edges.some(e => e.tunnel)),
  a('flyover', 'Flyover', 'A viaduct at level 6 or higher', g => g.graph.edges.some(e => e.level >= 6)),
  a('clover', 'Cloverleaf', 'Build a cloverleaf interchange', g => !!g.feats.clover),
  a('exports', 'Export Economy', '100 exports in a day', g => roll(g, 'exports') >= 100),
  a('ambulance', 'Clear the Way', '20 fast ambulance calls', g => (g.feats.amb ?? 0) >= 20, { island: 'statue' }),
  a('fullhouse', 'Full House', 'A match with 90% of fans on time', g => g.run.match >= 0.9),
  a('rain', 'Weather the Storm', 'Keep 75% of trips smooth through a rain event', g => !!g.feats.rain),
  a('detour', 'Detour Master', '5 roadworks with no trip giving up', g => (g.feats.detour ?? 0) >= 5),
  a('debtfree', 'Debt Free', 'Repay a bank loan in full', g => !!g.feats.debtfree),
  a('nored', 'Never in the Red', 'Clear a map without a loan', g => cleared(g) && !g.feats.loaned),
  a('quiet', 'Quiet Streets', '500 residents with road noise under 10%', g => g.population >= 500 && g.cityParts.noise < 0.1),
  a('lanes', 'Lane Wizard', 'Edit 3 junctions and keep the mean junction delay under 5 s', laneWizard),
  a('stars12', 'Star Collector', 'Earn 12 stars', (_, p) => stars(p) >= 12, { map: 'lakeside-loop' }),
  a('stars24', 'Perfectionist', 'Earn 24 stars', (_, p) => stars(p) >= 24, { map: 'canyon-gate' }),
  a('challenger', 'Challenger', 'Clear any Challenge', (_, p) => Object.keys(p.challenge).length > 0, { paint: 'retro' }),
  a('metro', 'Metropolis', '5,000 residents in Endless', g => g.cfg.mode === 'endless' && g.population >= 5000, { paint: 'neon' }),
];

// Unlocks every achievement g now meets (none in Creative); the new ones, in list order
export function checkAch(g: Game, p: Profile, now = Date.now()): AchDef[] {
  if (g.creative) return [];
  const got = ACHIEVEMENTS.filter(d => !p.achievements[d.id] && d.test(g, p));
  for (const d of got) p.achievements[d.id] = now;
  return got;
}
const NAME: Record<string, string> = { classic: 'Classic', pastel: 'Pastel', retro: 'Retro', neon: 'Neon', gold: 'Gold', grass: 'Grass', flowers: 'Flowerbed', fountain: 'Fountain', statue: 'Statue' };
export const cosmeticName = (x: string): string => NAME[x] ?? x;
// 'Unlocks Gold car paint'
export function rewardText(d: AchDef): string {
  const r = d.reward;
  return !r ? '' : r.paint ? `Unlocks ${NAME[r.paint]} car paint` : r.island ? `Unlocks the ${NAME[r.island]} roundabout island` : `Unlocks the bonus map ${MAPS.find(m => m.id === r.map)?.name}`;
}
// The cosmetics p has: the default and every unlocked achievement's
export const owned = (p: Profile): { paints: Paint[]; islands: Island[] } => {
  const has = ACHIEVEMENTS.filter(d => p.achievements[d.id]).map(d => d.reward);
  return { paints: PAINTS.filter((x, i) => !i || has.some(r => r?.paint === x)), islands: ISLANDS.filter((x, i) => !i || has.some(r => r?.island === x)) };
};
