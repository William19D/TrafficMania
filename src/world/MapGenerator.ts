// Terrain generation: rivers, mountains, names and the starter town
import { dist, distToSegment } from '../util/geom.ts';
import type { Vec } from '../util/geom.ts';
import { mulberry32, hashSeed, random } from '../util/rng.ts';
import { BIOMES, DIFFICULTY, SIZES } from '../core/config.ts';
import type { Biome, GameConfig, Zone } from '../core/config.ts';
import { Building, buildingAt } from '../entities/Building.ts';

// Sized from SIZES by generateTerrain
export const WORLD = { w: 2000, h: 1200 };

export interface River { points: Vec[]; width: number }
export interface Mountain { x: number; y: number; r: number; poly: Vec[] }
export interface Patch { poly: Vec[]; kind: 'sand' | 'grass' }
export interface Terrain {
  rivers: River[];
  mountains: Mountain[];
  lakes: Vec[][];
  patches: Patch[];
  trees: Vec[];
  biome: Biome;
}

// Terrain rolls use their own seeded stream while generateTerrain runs, so the map depends on the seed alone
let rng = random;
const rand = (a: number, b: number): number => a + rng() * (b - a);
const int = ([a, b]: [number, number]): number => a + Math.floor(rng() * (b - a + 1));

function outside(p: Vec, m: number): boolean {
  return p.x < -m || p.y < -m || p.x > WORLD.w + m || p.y > WORLD.h + m;
}

// River that enters from the left or top edge and walks in 70px steps
function makeRiver(): River {
  const fromLeft = rng() < 0.5;
  const base = fromLeft ? 0 : Math.PI / 2;
  let p: Vec = fromLeft
    ? { x: -60, y: rand(WORLD.h * 0.2, WORLD.h * 0.8) }
    : { x: rand(WORLD.w * 0.2, WORLD.w * 0.8), y: -60 };
  let heading = base + rand(-0.4, 0.4);
  const points: Vec[] = [p];
  // ponytail: 200-step cap for safety; with a bounded heading it leaves the map much sooner
  for (let i = 0; i < 200; i++) {
    heading += rand(-0.35, 0.35);
    heading = Math.max(base - 0.8, Math.min(base + 0.8, heading));
    p = { x: p.x + Math.cos(heading) * 70, y: p.y + Math.sin(heading) * 70 };
    points.push(p);
    if (i > 1 && outside(p, 60)) break;
  }
  return { points, width: rand(34, 50) };
}

// Rounded blob: n vertices at radius r * [k, 1]
function blob(x: number, y: number, r: number, n: number, k: number): Vec[] {
  const poly: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * rand(k, 1);
    poly.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr });
  }
  return poly;
}

function inPoly(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function makeMountain(x: number, y: number, r: number): Mountain {
  return { x, y, r, poly: blob(x, y, r, 11, 0.72) };
}

export function generateTerrain(cfg: GameConfig): Terrain {
  Object.assign(WORLD, SIZES[cfg.size]);
  rng = mulberry32(hashSeed(cfg.seed));
  try { return terrain(cfg); } finally { rng = random; }
}

function terrain(cfg: GameConfig): Terrain {
  const b = BIOMES[cfg.biome], d = DIFFICULTY[cfg.difficulty];
  const t: Terrain = { rivers: [], mountains: [], lakes: [], patches: [], trees: [], biome: cfg.biome };
  for (let i = int(b.rivers ?? d.rivers); i > 0; i--) t.rivers.push(makeRiver());
  const count = Math.max(0, int(d.mountains) + b.mountains);
  for (let tries = 0; tries < 300 && t.mountains.length < count; tries++) {
    const r = rand(60, 120);
    const x = rand(r + 60, WORLD.w - r - 60), y = rand(r + 60, WORLD.h - r - 60);
    if (inWater(t, { x, y }, r + 10)) continue;
    if (t.mountains.some(m => dist(m, { x, y }) < m.r + r + 30)) continue;
    t.mountains.push(makeMountain(x, y, r));
  }

  // Lakes: blobs kept 60px away from rivers, mountains and other lakes
  const lakes = int(b.lakes);
  for (let tries = 0; tries < 200 && t.lakes.length < lakes; tries++) {
    const r = rand(...b.lakeR);
    const c = { x: rand(r + 80, WORLD.w - r - 80), y: rand(r + 80, WORLD.h - r - 80) };
    if (inWater(t, c, r + 60) || inMountain(t, c, r + 60)) continue;
    t.lakes.push(blob(c.x, c.y, r, 12, 0.8));
  }

  // Ground patches: purely decorative
  const patches = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < patches; i++) {
    const r = rand(150, 320);
    t.patches.push({
      poly: blob(rand(0, WORLD.w), rand(0, WORLD.h), r, 14, 0.75),
      kind: rng() < 0.4 ? 'sand' : 'grass',
    });
  }

  // Trees in clusters of 5-12, off water and mountains
  const trees = int(b.trees);
  for (let tries = 0; tries < 400 && t.trees.length < trees; tries++) {
    const c = { x: rand(40, WORLD.w - 40), y: rand(40, WORLD.h - 40) };
    const n = 5 + Math.floor(rng() * 8);
    for (let i = 0; i < n && t.trees.length < trees; i++) {
      const a = rand(0, Math.PI * 2), d = rand(0, 45);
      const p = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
      if (inWater(t, p, 12) || inMountain(t, p, 10)) continue;
      if (t.trees.some(q => dist(p, q) < 9)) continue;
      t.trees.push(p);
    }
  }
  return t;
}

export function inWater(t: Terrain, p: Vec, pad = 0): boolean {
  for (const r of t.rivers) {
    for (let i = 1; i < r.points.length; i++) {
      if (distToSegment(p, r.points[i - 1], r.points[i]).d < r.width / 2 + pad) return true;
    }
  }
  for (const l of t.lakes) {
    if (inPoly(p, l)) return true;
    if (pad > 0) {
      for (let i = 0; i < l.length; i++) {
        if (distToSegment(p, l[i], l[(i + 1) % l.length]).d < pad) return true;
      }
    }
  }
  return false;
}

export function inMountain(t: Terrain, p: Vec, pad = 0): boolean {
  return t.mountains.some(m => dist(m, p) < m.r * 0.85 + pad);
}

// Share (0..1) of the segment over water / through a mountain, sampled every ~6px
export function segmentCrosses(t: Terrain, a: Vec, b: Vec): { water: number; mountain: number } {
  const n = Math.max(1, Math.ceil(dist(a, b) / 6));
  let water = 0, mountain = 0;
  for (let i = 0; i <= n; i++) {
    const p = { x: a.x + (b.x - a.x) * (i / n), y: a.y + (b.y - a.y) * (i / n) };
    if (inWater(t, p)) water++;
    if (inMountain(t, p)) mountain++;
  }
  return { water: water / (n + 1), mountain: mountain / (n + 1) };
}

const SYLLABLES = [
  'ba', 'be', 'lo', 'ma', 'ri', 'to', 'sa', 'ne', 'vi', 'ra', 'den', 'mon',
  'tal', 'cor', 'pi', 'lu', 'ga', 'dor', 'ven', 'sol', 'mar', 'fe', 'qui', 'nor',
];

export function randomName(): string {
  const n = 2 + Math.floor(rng() * 2);
  let s = '';
  for (let i = 0; i < n; i++) s += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
  return s[0].toUpperCase() + s.slice(1);
}

// Starter town: 4 homes facing a street line (2 per side, doors 30px off it), then a shop and an office 400-700px away and a
// factory 500-800px away, each facing the town. road = the street line's ends (built on easy). Rolls on the sim stream.
// ponytail: a satellite with no dry spot in its band is left out; the town works with any subset
export function findStarterTown(t: Terrain): { buildings: Building[]; road: [Vec, Vec] } | null {
  const fits = (b: Building, taken: Building[]): boolean => {
    const c = Math.cos(b.angle), s = Math.sin(b.angle), pts = [b, b.door()];
    for (const [f, g] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = f * b.h / 2, y = g * b.w / 2;
      pts.push({ x: b.x + x * c - y * s, y: b.y + x * s + y * c });
    }
    return pts.every(p => !outside(p, -40) && !inWater(t, p, 12) && !inMountain(t, p, 12)) && taken.every(o => dist(o, b) > 120);
  };
  for (let i = 0; i < 300; i++) {
    const c = { x: rand(300, WORLD.w - 300), y: rand(300, WORLD.h - 300) }, ax = rng() < 0.5 ? 0 : Math.PI / 2;
    const u = { x: Math.cos(ax), y: Math.sin(ax) }, v = { x: -u.y, y: u.x };
    const road: [Vec, Vec] = [{ x: c.x - u.x * 110, y: c.y - u.y * 110 }, { x: c.x + u.x * 110, y: c.y + u.y * 110 }];
    const terr = segmentCrosses(t, ...road);
    if (terr.water || terr.mountain) continue;
    const homes: Building[] = [];
    for (const side of [1, -1]) for (const k of [-1, 1]) {
      homes.push(buildingAt('home', { x: c.x + u.x * 26 * k + v.x * 30 * side, y: c.y + u.y * 26 * k + v.y * 30 * side }, ax + Math.PI / 2 * (side > 0 ? -1 : 1)));
    }
    if (!homes.every(h => fits(h, []))) continue;
    const buildings = [...homes];
    for (const [kind, lo, hi] of [['shop', 400, 700], ['office', 400, 700], ['industry', 500, 800]] as [Zone, number, number][]) {
      for (let j = 0; j < 200; j++) {
        const a = rand(0, Math.PI * 2), d = rand(lo, hi), p = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
        const b = new Building(kind, p.x, p.y, Math.round(Math.atan2(c.y - p.y, c.x - p.x) / (Math.PI / 2)) * (Math.PI / 2));
        if (fits(b, buildings)) { buildings.push(b); break; }
      }
    }
    return { buildings, road };
  }
  return null;
}
