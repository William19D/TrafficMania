import type { Vec } from '../util/geom.ts';
import { WORLD, inMountain, inWater } from '../world/MapGenerator.ts';
import type { Biome } from '../core/config.ts';
import type { Mountain, Terrain } from '../world/MapGenerator.ts';
import { BIOMES } from '../core/config.ts';
import { mulberry32 } from '../util/rng.ts';
import { shade } from './BuildingArt.ts';

const WATER = '#A9C1EC', WATER_IN = '#BFD3F3', DEEP = '#B3CAF0', FOAM = '#F4F8FD';
const FLOWERS = ['#F28DB2', '#FFD45C', '#FFFFFF', '#B79CF2', '#FF8A65'];
type Species = 'round' | 'conifer' | 'snowy' | 'palm' | 'blossom' | 'autumn';
// Per biome: species weights, and ground detail per 10,000 px² (grass tufts, flower clusters, rocks)
const DECO: Record<Biome, { trees: [Species, number][]; tufts: number; flowers: number; rocks: number; bank: string }> = {
  temperate: { trees: [['round', 62], ['conifer', 22], ['blossom', 9], ['autumn', 7]], tufts: 4, flowers: 0.5, rocks: 0.06, bank: '#E8DDBE' },
  desert: { trees: [['palm', 65], ['round', 35]], tufts: 1.2, flowers: 0.05, rocks: 0.3, bank: '#E9D4A2' },
  alpine: { trees: [['conifer', 50], ['snowy', 40], ['round', 10]], tufts: 3, flowers: 0.25, rocks: 0.25, bank: '#DCD8CC' },
  archipelago: { trees: [['round', 55], ['palm', 35], ['blossom', 10]], tufts: 3.5, flowers: 0.4, rocks: 0.08, bank: '#EEE0B8' },
};

// Smooth closed path through the midpoints of a polygon (lakes and patches read as soft blobs, not 12-gons)
export function blobPath(ctx: CanvasRenderingContext2D, pts: Vec[]): void {
  const n = pts.length, mid = (i: number): Vec => ({ x: (pts[i % n].x + pts[(i + 1) % n].x) / 2, y: (pts[i % n].y + pts[(i + 1) % n].y) / 2 });
  ctx.beginPath();
  const m0 = mid(0);
  ctx.moveTo(m0.x, m0.y);
  for (let i = 1; i <= n; i++) { const p = pts[i % n], m = mid(i); ctx.quadraticCurveTo(p.x, p.y, m.x, m.y); }
  ctx.closePath();
}

const linePath = (ctx: CanvasRenderingContext2D, pts: Vec[]): void => {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
};

const centroid = (pts: Vec[]): Vec => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
const scaled = (pts: Vec[], c: Vec, k: number): Vec[] => pts.map(p => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));

// The static ground of a map at s px per world px: land, patches, shores, water, mountains, rocks, tufts, flowers and trees.
// Drawn once per map and zoom bucket; the renderer blits it every frame.
export function paintTerrain(t: Terrain, s: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(WORLD.w * s);
  c.height = Math.ceil(WORLD.h * s);
  const ctx = c.getContext('2d')!;
  ctx.scale(s, s);
  ctx.lineCap = ctx.lineJoin = 'round';
  const b = BIOMES[t.biome], deco = DECO[t.biome], t0 = t.trees[0] ?? { x: 1, y: 7 };
  const rng = mulberry32(Math.round(t0.x * 977 + t0.y * 31 + t.trees.length));
  const dot = (x: number, y: number, r: number, fill: string): void => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };
  const dry = (p: Vec, pad: number): boolean => !inWater(t, p, pad) && !inMountain(t, p, pad);
  const scatter = (per10k: number, f: (x: number, y: number) => void): void => {
    for (let i = Math.round(WORLD.w * WORLD.h / 1e4 * per10k); i > 0; i--) { const x = rng() * WORLD.w, y = rng() * WORLD.h; if (dry({ x, y }, 6)) f(x, y); }
  };

  ctx.fillStyle = b.land;
  ctx.fillRect(0, 0, WORLD.w, WORLD.h);

  // Patches: soft blob with a lighter inner blob
  for (const p of t.patches) {
    const col = b.patch[p.kind === 'sand' ? 0 : 1], ctr = centroid(p.poly);
    blobPath(ctx, p.poly);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 24;
    ctx.stroke();
    blobPath(ctx, scaled(p.poly, ctr, 0.6));
    ctx.fillStyle = shade(col, p.kind === 'sand' ? 0.12 : -0.04);
    ctx.fill();
  }

  // Ground detail: grass tufts in a darker land tone, flower clusters, pebbles
  const tuft = shade(b.patch[1], -0.18);
  ctx.strokeStyle = tuft;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  scatter(deco.tufts, (x, y) => { ctx.moveTo(x - 1.6, y - 1); ctx.lineTo(x - 0.4, y + 1); ctx.lineTo(x, y - 2); ctx.lineTo(x + 0.5, y + 1); ctx.lineTo(x + 1.7, y - 0.8); });
  ctx.stroke();
  scatter(deco.flowers, (x, y) => {
    const col = FLOWERS[Math.floor(rng() * FLOWERS.length)];
    for (let i = 0; i < 4 + rng() * 4; i++) dot(x + (rng() - 0.5) * 10, y + (rng() - 0.5) * 8, 1, col);
  });

  // Shores, layer by layer over every lake and river (so a channel never paints its bank over a lake): a sandy bank, a line of
  // foam, the water, a lighter shallow band and a deeper middle
  const layers: [string, number, number][] = [[deco.bank, 24, 12], [FOAM, 15, 3], [WATER, 12, 0], [WATER_IN, 0, -12], [DEEP, -1, -26]];
  for (const [col, lw, dw] of layers) {
    for (const l of t.lakes) {
      blobPath(ctx, lw < 0 ? scaled(l, centroid(l), 0.55) : l);
      ctx.fillStyle = col;
      ctx.fill();
      if (lw > 0) { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); }
    }
    for (const r of t.rivers) {
      linePath(ctx, r.points);
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(dw < -12 ? 3 : 8, r.width + dw);
      ctx.stroke();
    }
  }

  // Mountains: soft shadow + contour-line bands, scree at their foot
  for (const m of t.mountains) {
    ctx.save();
    ctx.translate(6, 7);
    mountainPath(ctx, m, 1);
    ctx.fillStyle = 'rgba(0,0,0,.10)';
    ctx.fill();
    ctx.restore();
    for (const [k, col] of [[1, b.bands[0]], [0.78, b.bands[1]], [0.5, b.bands[2]]] as const) {
      mountainPath(ctx, m, k);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 10;
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const a = rng() * Math.PI * 2, d = m.r * (1.05 + rng() * 0.25), x = m.x + Math.cos(a) * d, y = m.y + Math.sin(a) * d;
      if (dry({ x, y }, 3)) rock(ctx, x, y, 1.5 + rng() * 2, rng, b.bands[0]);
    }
  }
  scatter(deco.rocks, (x, y) => rock(ctx, x, y, 1.8 + rng() * 2.5, rng, b.bands[0]));

  // Trees, top to bottom so lower crowns overlap upper ones; shadows first so no shadow falls on a crown
  const total = deco.trees.reduce((n, [, w]) => n + w, 0);
  // each map tree gets one or two neighbours (decor only: roads and buildings draw over trees), so clusters read as groves
  const spots = t.trees.flatMap(p => {
    const out = [p];
    for (let i = rng() < 0.5 ? 1 : 2; i > 0; i--) { const a = rng() * Math.PI * 2, d = 8 + rng() * 6, q = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d }; if (dry(q, 10)) out.push(q); }
    return out;
  });
  const trees = spots.map(p => {
    let k = rng() * total, sp: Species = deco.trees[0][0];
    for (const [s, w] of deco.trees) if ((k -= w) < 0) { sp = s; break; }
    return { p, sp, r: 5 + rng() * 2.6, tone: (rng() - 0.5) * 0.16, a: rng() * Math.PI };
  }).sort((u, v) => u.p.y - v.p.y);
  ctx.fillStyle = 'rgba(40,60,30,.16)';
  for (const { p, r } of trees) { ctx.beginPath(); ctx.ellipse(p.x + r * 0.45, p.y + r * 0.6, r * 1.05, r * 0.85, 0, 0, Math.PI * 2); ctx.fill(); }
  for (const tr of trees) tree(ctx, tr.p, tr.r, tr.sp, b.tree, tr.tone, tr.a);
  return c;
}

function mountainPath(ctx: CanvasRenderingContext2D, m: Mountain, k: number): void {
  linePath(ctx, scaled(m.poly, m, k));
  ctx.closePath();
}

function rock(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rng: () => number, base: string): void {
  const pts: Vec[] = [];
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2, d = r * (0.7 + rng() * 0.3); pts.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.8 }); }
  ctx.save();
  ctx.translate(0.8, 1);
  linePath(ctx, pts);
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  ctx.fill();
  ctx.restore();
  linePath(ctx, pts);
  ctx.closePath();
  ctx.fillStyle = shade(base, 0.25);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = shade(base, 0.5);
  ctx.fill();
}

// One tree crown at p: round (three lobes and a highlight), conifer (layered star), snowy conifer, palm (fronds), blossom, autumn
export function tree(ctx: CanvasRenderingContext2D, p: Vec, r: number, sp: Species, base: string, tone: number, a: number): void {
  const dot = (x: number, y: number, rad: number, fill: string): void => { ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };
  const star = (rad: number, inner: number, rot: number, fill: string): void => {
    ctx.beginPath();
    for (let i = 0; i < 16; i++) { const d = i % 2 ? rad * inner : rad, an = rot + (i / 16) * Math.PI * 2; ctx.lineTo(p.x + Math.cos(an) * d, p.y + Math.sin(an) * d); }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  if (sp === 'conifer' || sp === 'snowy') {
    const col = shade('#4E8A55', tone);
    star(r * 1.05, 0.62, a, shade('#4E8A55', -0.25 + tone));
    star(r * 0.75, 0.6, a + 0.2, col);
    star(r * 0.45, 0.55, a + 0.4, sp === 'snowy' ? '#F7F9FA' : shade('#4E8A55', 0.2 + tone));
    if (sp === 'snowy') { star(r * 0.8, 0.35, a + 0.2, 'rgba(247,249,250,.55)'); }
    return;
  }
  if (sp === 'palm') {
    const col = shade('#7FB04F', tone);
    for (let i = 0; i < 6; i++) {
      const an = a + (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(p.x + Math.cos(an) * r * 0.55, p.y + Math.sin(an) * r * 0.55, r * 0.62, r * 0.24, an, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? col : shade('#7FB04F', -0.15 + tone);
      ctx.fill();
    }
    dot(p.x, p.y, r * 0.22, '#8B6B42');
    return;
  }
  const col = sp === 'blossom' ? '#F2A7C3' : sp === 'autumn' ? '#E3A23B' : base;
  dot(p.x, p.y, r, shade(col, -0.18 + tone));
  for (let i = 0; i < 3; i++) { const an = a + (i / 3) * Math.PI * 2; dot(p.x + Math.cos(an) * r * 0.3, p.y + Math.sin(an) * r * 0.3, r * 0.62, shade(col, tone)); }
  dot(p.x - r * 0.3, p.y - r * 0.32, r * 0.38, shade(col, 0.22 + tone));
  if (sp === 'blossom') for (let i = 0; i < 4; i++) { const an = a * 3 + i * 1.7; dot(p.x + Math.cos(an) * r * 0.55, p.y + Math.sin(an) * r * 0.5, 0.8, '#FFFFFF'); }
}

// Moving glints on the water: dashed light lines drifting round each lake and down each river. Cheap: a few strokes a frame.
export function shimmer(ctx: CanvasRenderingContext2D, t: Terrain, now: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([5, 16]);
  ctx.lineDashOffset = -now * 6;
  for (const l of t.lakes) {
    const ctr = centroid(l);
    for (const k of [0.8, 0.45]) { blobPath(ctx, scaled(l, ctr, k)); ctx.stroke(); }
  }
  ctx.setLineDash([4, 22]);
  ctx.lineDashOffset = -now * 14;
  for (const r of t.rivers) { linePath(ctx, r.points); ctx.stroke(); }
  ctx.restore();
}
