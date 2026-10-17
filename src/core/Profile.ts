// Cross-run profile in localStorage['tm_profile'] (docs/design/game-v3.md 10): stars and best grades per map, Challenge clears, tips
// seen, lifetime stats. Bad or missing data gives defaults; every storage access is wrapped; writes are debounced to 1 s.
// Endless tools are not stored: they follow the stars (toolLevel).
import { MAPS } from './Campaign.ts';
import type { Grade, MapDef } from './Campaign.ts';

export interface Profile {
  v: 1;
  stars: Record<string, number>;
  best: Record<string, { efficiency: number; smooth: number; spend: number; day: number }>;
  // best Challenge clear day per map, absent = none
  challenge: Record<string, number>;
  achievements: Record<string, number>;
  tips: string[]; tipsOff: boolean;
  // trips arrived and seconds played across runs
  stats: { trips: number; seconds: number };
}
const KEY = 'tm_profile';
export const profile0 = (): Profile => ({ v: 1, stars: {}, best: {}, challenge: {}, achievements: {}, tips: [], tipsOff: false, stats: { trips: 0, seconds: 0 } });

const obj = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const nums = (x: unknown): Record<string, number> => Object.fromEntries(Object.entries(obj(x)).filter(([, v]) => typeof v === 'number' && isFinite(v))) as Record<string, number>;
// Pure: any JSON (or none) to a valid profile, unknown fields dropped
export function parseProfile(s: string | null): Profile {
  let d: Record<string, unknown> = {};
  try { d = obj(s ? JSON.parse(s) : null); } catch { /* bad JSON: defaults */ }
  const p = profile0(), st = obj(d.stats);
  if (d.v !== 1) return p;
  p.stars = Object.fromEntries(Object.entries(nums(d.stars)).map(([k, v]) => [k, Math.max(0, Math.min(3, Math.round(v)))]));
  p.best = Object.fromEntries(Object.entries(obj(d.best)).map(([k, v]) => [k, { efficiency: 0, smooth: 0, spend: 0, day: 0, ...nums(v) }]));
  p.challenge = nums(d.challenge);
  p.achievements = nums(d.achievements);
  p.tips = Array.isArray(d.tips) ? d.tips.filter((t): t is string => typeof t === 'string') : [];
  p.tipsOff = d.tipsOff === true;
  p.stats = { ...p.stats, ...nums(st) };
  return p;
}

let cached: Profile | null = null, timer: ReturnType<typeof setTimeout> | undefined;
const get = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
export function profile(): Profile {
  if (cached) return cached;
  const s = get(KEY);
  cached = parseProfile(s);
  // first run of the profile: the old tutorial flag carries over
  if (!s && get('tm_tutorial_done') === '1') cached.tips.push('tutorial');
  return cached;
}
export function saveProfile(): void {
  clearTimeout(timer);
  timer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(profile())); } catch { /* storage full or blocked: kept in memory */ } }, 1000);
}

export const totalStars = (p: Profile): number => MAPS.reduce((n, m) => n + (p.stars[m.id] ?? 0), 0);
export const mapOpen = (p: Profile, m: MapDef): boolean => totalStars(p) >= m.unlock;
// The tools an Endless run has: those of every map with a star (map 1's at least)
export const toolLevel = (p: Profile): number => MAPS.reduce((n, m, i) => (p.stars[m.id] ?? 0) > 0 ? i + 1 : n, 1);

// A grade with stars on map m: keeps the best stars and, per field, the best of the rest; a Challenge clear keeps its earliest day.
// true when the stars went up
export function recordGrade(p: Profile, m: MapDef, g: Grade, challenge = false): boolean {
  if (!g.stars) return false;
  if (challenge) { p.challenge[m.id] = Math.min(p.challenge[m.id] ?? Infinity, g.day); return false; }
  const up = g.stars > (p.stars[m.id] ?? 0), b = p.best[m.id];
  if (up) p.stars[m.id] = g.stars;
  p.best[m.id] = b ? { efficiency: Math.max(b.efficiency, g.efficiency), smooth: Math.max(b.smooth, g.flow), spend: Math.min(b.spend, g.spend), day: Math.min(b.day, g.day) }
    : { efficiency: g.efficiency, smooth: g.flow, spend: g.spend, day: g.day };
  return up;
}
