import type { Vec } from '../util/geom.ts';
import { WORLD, inMountain, inWater } from '../world/MapGenerator.ts';
import type { Biome } from '../core/config.ts';
import type { Mountain, Terrain } from '../world/MapGenerator.ts';
import { BIOMES } from '../core/config.ts';
import { mulberry32 } from '../util/rng.ts';
import { shade } from './BuildingArt.ts';

const FOAM = '#F4F8FD', SHALLOW = '#C4D7F4', DEEP = '#90AFE5';
const FLOWERS = ['#F28DB2', '#FFD45C', '#FFFFFF', '#B79CF2', '#FF8A65'];
// Crops: ripe wheat, young shoots, ploughed soil, cabbage, lavender, sunflowers
const CROPS = ['#E9D58C', '#C4DE8E', '#C8A67A', '#A8CF86', '#C6B5E2', '#F0CB52'];
type Species = 'round' | 'conifer' | 'snowy' | 'palm' | 'blossom' | 'autumn' | 'cactus';
// Per biome: species weights, ground detail per 10,000 px² (grass tufts, flower clusters, rocks, bushes), farms and parks per map,
// the share of rocky shore, the sand bank colour, a bush tone and (optional) a darker forest floor under the groves (alpha)
const DECO: Record<Biome, {
  trees: [Species, number][]; tufts: number; flowers: number; rocks: number; bushes: number; farms: number; parks: number; rocky: number; bank: string; bush: string; floor?: number;
}> = {
  forest: { trees: [['round', 50], ['conifer', 44], ['autumn', 4], ['blossom', 2]], tufts: 14, flowers: 1.8, rocks: 0.08, bushes: 1, farms: 3, parks: 2, rocky: 0.3, bank: '#B9CF92', bush: '#4F9446', floor: 0.5 },
  temperate: { trees: [['round', 62], ['conifer', 22], ['blossom', 9], ['autumn', 7]], tufts: 10, flowers: 0.8, rocks: 0.06, bushes: 0.5, farms: 7, parks: 3, rocky: 0.2, bank: '#D8D9AE', bush: '#5E9C46' },
  desert: { trees: [['palm', 50], ['cactus', 30], ['round', 20]], tufts: 2, flowers: 0.05, rocks: 0.4, bushes: 0.35, farms: 2, parks: 1, rocky: 0.3, bank: '#E9D4A2', bush: '#A3A865' },
  alpine: { trees: [['conifer', 50], ['snowy', 40], ['round', 10]], tufts: 5, flowers: 0.35, rocks: 0.3, bushes: 0.4, farms: 4, parks: 2, rocky: 0.75, bank: '#DCD8CC', bush: '#5E8F5A' },
  archipelago: { trees: [['round', 55], ['palm', 35], ['blossom', 10]], tufts: 6, flowers: 0.5, rocks: 0.08, bushes: 0.5, farms: 3, parks: 2, rocky: 0.3, bank: '#EEE0B8', bush: '#6FAE58' },
};

// a..b colour blend (hex in, rgb out)
const mix = (a: string, b: string, t: number): string => {
  const ch = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgb(${[0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t)).join(',')})`;
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

// The static ground of a map at s px per world px: land with tonal swells and grain, patches, farms, parks, shores, water deepening
// to the middle, rocky banks, mountains, rocks, tufts, flowers, bushes and trees. Drawn once per map and zoom bucket; the renderer
// blits it every frame.
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
  // Tonal swells: soft lighter and darker pools of grass so the land never reads as one flat fill
  for (let i = Math.round(WORLD.w * WORLD.h / 2.5e4); i > 0; i--) {
    const x = rng() * WORLD.w, y = rng() * WORLD.h, r = 40 + rng() * 110, col = rng() < 0.45 ? shade(b.land, 0.08 + rng() * 0.12) : b.patch[1];
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, col);
    g.addColorStop(1, b.land);
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Patches: soft blob with a lighter inner blob; desert sand gets dune ripples
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
    if (t.biome === 'desert' && p.kind === 'sand') {
      ctx.save();
      blobPath(ctx, p.poly);
      ctx.clip();
      ctx.strokeStyle = shade(col, -0.08);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < 40; i++) {
        const x = ctr.x + (rng() - 0.5) * 500, y = ctr.y + (rng() - 0.5) * 500, w = 14 + rng() * 26;
        ctx.moveTo(x - w, y);
        ctx.quadraticCurveTo(x, y - 5, x + w, y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // Grain: a noise tile at device pixels over the whole land (fine speckle, never blurred by the zoom)
  const tile = document.createElement('canvas');
  tile.width = tile.height = 96;
  const tc = tile.getContext('2d')!;
  for (let i = 0; i < 900; i++) {
    tc.fillStyle = rng() < 0.55 ? 'rgba(60,90,40,.09)' : 'rgba(240,255,225,.10)';
    tc.fillRect(Math.floor(rng() * 96), Math.floor(rng() * 96), rng() < 0.3 ? 2 : 1, 1);
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat')!;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();

  // Farms and parks on open dry land, clear of the map's groves. Decor only: roads and buildings draw over them.
  // ponytail: placed by rejection sampling (80 tries each); a free-space index if maps grow crowded
  const open = (x: number, y: number, r: number): boolean => dry({ x, y }, r) && !t.trees.some(p => Math.abs(p.x - x) < r && Math.abs(p.y - y) < r);
  const taken: { x: number; y: number; r: number }[] = [];
  const free = (x: number, y: number, r: number): boolean => open(x, y, r) && taken.every(q => Math.hypot(q.x - x, q.y - y) > q.r + r);
  for (let n = 0, tries = 0; n < deco.farms && tries < 80; tries++) {
    const x = 100 + rng() * (WORLD.w - 200), y = 100 + rng() * (WORLD.h - 200);
    if (!free(x, y, 85)) continue;
    n++;
    taken.push({ x, y, r: 85 });
    farm(ctx, x, y, rng() * Math.PI, rng, dry);
  }
  const parkTrees: Vec[] = [];
  for (let n = 0, tries = 0; n < deco.parks && tries < 80; tries++) {
    const x = 80 + rng() * (WORLD.w - 160), y = 80 + rng() * (WORLD.h - 160), r = 38 + rng() * 22;
    if (!free(x, y, r + 8)) continue;
    n++;
    taken.push({ x, y, r: r + 8 });
    parkTrees.push(...park(ctx, x, y, r, rng, b.patch[1]));
  }
  const inPlot = (x: number, y: number): boolean => taken.some(q => Math.hypot(q.x - x, q.y - y) < q.r - 4);

  // Ground detail: clumps of longer grass, tufts in two tones, flower clusters
  ctx.fillStyle = shade(b.patch[1], -0.1);
  ctx.globalAlpha = 0.35;
  scatter(deco.tufts * 0.4, (x, y) => {
    if (inPlot(x, y)) return;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) { const px = x + (rng() - 0.5) * 9, py = y + (rng() - 0.5) * 6, rx = 2 + rng() * 2.5; ctx.moveTo(px + rx, py); ctx.ellipse(px, py, rx, 1.4 + rng() * 1.5, 0, 0, Math.PI * 2); }
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  for (const [col, per] of [[shade(b.patch[1], -0.2), deco.tufts], [shade(b.patch[1], 0.18), deco.tufts * 0.5]] as const) {
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    scatter(per, (x, y) => { if (inPlot(x, y)) return; ctx.moveTo(x - 1.6, y - 1); ctx.lineTo(x - 0.4, y + 1); ctx.lineTo(x, y - 2); ctx.lineTo(x + 0.5, y + 1); ctx.lineTo(x + 1.7, y - 0.8); });
    ctx.stroke();
  }
  scatter(deco.flowers, (x, y) => {
    if (inPlot(x, y)) return;
    const col = FLOWERS[Math.floor(rng() * FLOWERS.length)];
    for (let i = 0; i < 4 + rng() * 4; i++) dot(x + (rng() - 0.5) * 10, y + (rng() - 0.5) * 8, 1, col);
  });

  // Shores, layer by layer over every lake and river (so a channel never paints its bank over a lake): a sandy beach, wet sand,
  // a line of foam, then the water in steps from a light shallow edge to a deep middle
  const shore: [string, number][] = [[deco.bank, 14], [shade(deco.bank, -0.08), 7], [FOAM, 3], [SHALLOW, 0]];
  for (const [col, extra] of shore) {
    for (const l of t.lakes) {
      blobPath(ctx, l);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 12 + extra;
      ctx.stroke();
    }
    for (const r of t.rivers) {
      linePath(ctx, r.points);
      ctx.strokeStyle = col;
      ctx.lineWidth = r.width + extra;
      ctx.stroke();
    }
  }
  for (let i = 1; i <= 5; i++) {
    const col = mix(SHALLOW, DEEP, i / 5);
    for (const l of t.lakes) {
      blobPath(ctx, scaled(l, centroid(l), 1 - i * 0.11));
      ctx.fillStyle = col;
      ctx.fill();
    }
    for (const r of t.rivers) {
      linePath(ctx, r.points);
      ctx.strokeStyle = col;
      ctx.lineWidth = r.width * (1 - i * 0.15);
      ctx.stroke();
    }
  }
  // still ripples: short light arcs over the open water
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  const ripple = (x: number, y: number): void => { const w = 3 + rng() * 4; ctx.moveTo(x - w, y); ctx.quadraticCurveTo(x, y - 1.6, x + w, y); };
  for (const l of t.lakes) {
    const ctr = centroid(l);
    for (let i = 0; i < l.length * 6; i++) {
      const j = Math.floor(rng() * l.length), u = rng(), k = 0.1 + rng() * 0.7, a = l[j], q = l[(j + 1) % l.length];
      ripple(ctr.x + ((a.x + (q.x - a.x) * u) - ctr.x) * k, ctr.y + ((a.y + (q.y - a.y) * u) - ctr.y) * k);
    }
  }
  for (const r of t.rivers) for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1], q = r.points[i], u = rng();
    ripple(a.x + (q.x - a.x) * u + (rng() - 0.5) * r.width * 0.5, a.y + (q.y - a.y) * u + (rng() - 0.5) * r.width * 0.5);
  }
  ctx.stroke();
  // rocky banks: boulders along part of the shore (most lakes in the mountains, a few elsewhere)
  for (const l of t.lakes) {
    if (rng() > deco.rocky) continue;
    const from = Math.floor(rng() * l.length), span = 3 + Math.floor(rng() * (l.length - 3));
    for (let i = from; i < from + span; i++) {
      const p = l[i % l.length], q = l[(i + 1) % l.length], ctr = centroid(l);
      for (let k = 0; k < 4; k++) {
        const u = rng(), m = { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u }, d = Math.hypot(m.x - ctr.x, m.y - ctr.y) || 1, o = -2 + rng() * 7;
        rock(ctx, m.x + (m.x - ctr.x) / d * o, m.y + (m.y - ctr.y) / d * o, 1.6 + rng() * 2.6, rng, b.bands[0]);
      }
    }
  }
  for (const r of t.rivers) for (let i = 1; i < r.points.length; i++) {
    if (rng() > deco.rocky * 0.5) continue;
    const a = r.points[i - 1], q = r.points[i], L = Math.hypot(q.x - a.x, q.y - a.y) || 1, side = rng() < 0.5 ? 1 : -1;
    for (let k = 0; k < 5; k++) {
      const u = rng(), o = (r.width / 2 + 1 + rng() * 4) * side;
      rock(ctx, a.x + (q.x - a.x) * u - (q.y - a.y) / L * o, a.y + (q.y - a.y) * u + (q.x - a.x) / L * o, 1.4 + rng() * 2.2, rng, b.bands[0]);
    }
  }

  // Mountains: soft shadow + contour-line bands with crag lines, scree at their foot
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
      // lit north-west rim of the band
      ctx.save();
      mountainPath(ctx, m, k);
      ctx.clip();
      ctx.translate(3, 3);
      mountainPath(ctx, m, k);
      ctx.strokeStyle = shade(col, 0.16);
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = shade(b.bands[1], -0.15);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2, d = m.r * (0.3 + rng() * 0.6), x = m.x + Math.cos(a) * d, y = m.y + Math.sin(a) * d;
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6 + 2);
    }
    ctx.stroke();
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2, d = m.r * (1.05 + rng() * 0.25), x = m.x + Math.cos(a) * d, y = m.y + Math.sin(a) * d;
      if (dry({ x, y }, 3)) rock(ctx, x, y, 1.5 + rng() * 2, rng, b.bands[0]);
    }
  }
  scatter(deco.rocks, (x, y) => { if (!inPlot(x, y)) rock(ctx, x, y, 1.8 + rng() * 2.5, rng, b.bands[0]); });

  // Trees, top to bottom so lower crowns overlap upper ones; shadows first so no shadow falls on a crown
  const total = deco.trees.reduce((n, [, w]) => n + w, 0);
  // each map tree gets one or two neighbours (decor only: roads and buildings draw over trees), so clusters read as groves
  const spots = t.trees.flatMap(p => {
    const out = [p];
    for (let i = rng() < 0.5 ? 1 : 2; i > 0; i--) { const a = rng() * Math.PI * 2, d = 8 + rng() * 6, q = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d }; if (dry(q, 10)) out.push(q); }
    return out;
  });
  // bushes: round the groves' edges and loose in the grass
  const bushes: Vec[] = [];
  for (const p of t.trees) if (rng() < 0.45) { const a = rng() * Math.PI * 2, d = 12 + rng() * 10, q = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d }; if (dry(q, 6)) bushes.push(q); }
  scatter(deco.bushes, (x, y) => { if (!inPlot(x, y)) bushes.push({ x, y }); });
  for (const q of bushes) bush(ctx, q.x, q.y, 2.2 + rng() * 1.8, shade(deco.bush, (rng() - 0.5) * 0.18), rng() < 0.15 ? FLOWERS[Math.floor(rng() * FLOWERS.length)] : null);
  const trees = [...spots, ...parkTrees].map(p => {
    let k = rng() * total, sp: Species = deco.trees[0][0];
    for (const [s, w] of deco.trees) if ((k -= w) < 0) { sp = s; break; }
    return { p, sp, r: 5 + rng() * 2.6, tone: (rng() - 0.5) * 0.16, a: rng() * Math.PI };
  }).sort((u, v) => u.p.y - v.p.y);
  if (deco.floor) {
    ctx.globalAlpha = deco.floor;
    ctx.fillStyle = shade(b.land, -0.16);
    ctx.beginPath();
    for (const p of t.trees) { ctx.moveTo(p.x + 12, p.y); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); }
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(40,60,30,.18)';
  for (const { p, r } of trees) { ctx.beginPath(); ctx.ellipse(p.x + r * 0.5, p.y + r * 0.65, r * 1.05, r * 0.85, 0, 0, Math.PI * 2); ctx.fill(); }
  for (const tr of trees) tree(ctx, tr.p, tr.r, tr.sp, b.tree, tr.tone, tr.a);
  return c;
}

// A farm at (x, y) turned by a: 2-3 x 2 plots of crops in rows, dirt tracks between them, hedges, a barn and a silo
function farm(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, rng: () => number, dry: (p: Vec, pad: number) => boolean): void {
  const cols = 2 + Math.floor(rng() * 2), fw = 44 + rng() * 14, fh = 34 + rng() * 12, gap = 6, W = cols * fw + (cols - 1) * gap, H = 2 * fh + gap;
  const cs = Math.cos(a), sn = Math.sin(a), at = (u: number, v: number): Vec => ({ x: x + u * cs - v * sn, y: y + u * sn + v * cs });
  const ok = (u: number, v: number, w: number, h: number): boolean => [[u, v], [u + w, v], [u, v + h], [u + w, v + h]].every(([p, q]) => dry(at(p, q), 6));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  for (let i = 0; i < cols; i++) for (let j = 0; j < 2; j++) {
    const u = -W / 2 + i * (fw + gap), v = -H / 2 + j * (fh + gap);
    if (!ok(u, v, fw, fh)) continue;
    const col = CROPS[Math.floor(rng() * CROPS.length)];
    ctx.fillStyle = '#DDCCA4';
    ctx.beginPath();
    ctx.roundRect(u - 3, v - 3, fw + 6, fh + 6, 3);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.fillRect(u, v, fw, fh);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = shade(col, 0.14);
    ctx.fillRect(u + rng() * fw * 0.6, v, fw * 0.25, fh);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = shade(col, -0.16);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    if (rng() < 0.5) for (let q = v + 2; q < v + fh - 1; q += 2.8) { ctx.moveTo(u + 1.5, q); ctx.lineTo(u + fw - 1.5, q); }
    else for (let p = u + 2; p < u + fw - 1; p += 2.8) { ctx.moveTo(p, v + 1.5); ctx.lineTo(p, v + fh - 1.5); }
    ctx.stroke();
    // a hedge along the plot's outer long side
    const hv = j ? v + fh + 2.5 : v - 2.5;
    for (let p = u; p <= u + fw; p += 2.4) { ctx.beginPath(); ctx.arc(p, hv, 1.4 + rng() * 0.6, 0, Math.PI * 2); ctx.fillStyle = shade('#5E9A4A', (rng() - 0.5) * 0.2); ctx.fill(); }
  }
  // farmyard: a red barn with a ridge and a round silo, beside the plots
  const bu = -W / 2 - 20, bv = -10;
  if (ok(bu - 2, bv - 2, 18, 22)) {
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(bu + 1.5, bv + 1.5, 13, 9);
    ctx.fillStyle = '#C45A4A';
    ctx.fillRect(bu, bv, 13, 9);
    ctx.fillStyle = '#D9705F';
    ctx.fillRect(bu, bv, 13, 4.5);
    ctx.strokeStyle = '#F2E6D8';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(bu, bv + 4.5);
    ctx.lineTo(bu + 13, bv + 4.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bu + 6, bv + 15, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#A7AEB4';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bu + 5.2, bv + 14.2, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = '#CBD1D6';
    ctx.fill();
  }
  ctx.restore();
}

// A park at (x, y) radius r: a striped lawn inside a hedge, a gravel loop and a cross path, a pond or a fountain, benches, lamps,
// flower beds. Returns spots for its trees (drawn with the rest).
function park(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rng: () => number, grass: string): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, d = r * (0.88 + rng() * 0.12); pts.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d }); }
  const lawn = shade(grass, -0.03), rot = rng() * Math.PI, rx = r * 0.6, ry = r * 0.46;
  blobPath(ctx, pts);
  ctx.strokeStyle = '#5E9A4A';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = lawn;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = shade(lawn, 0.1);
  for (let k = -r; k < r; k += 8) ctx.fillRect(x + k, y - r, 4, r * 2);
  ctx.restore();
  const on = (a: number, k = 1): Vec => {
    const u = Math.cos(a) * rx * k, v = Math.sin(a) * ry * k;
    return { x: x + u * Math.cos(rot) - v * Math.sin(rot), y: y + u * Math.sin(rot) + v * Math.cos(rot) };
  };
  // paths: gravel with a lighter crown
  for (const [col, w] of [['#D2C29C', 4.2], ['#E8DDC2', 2.6]] as const) {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    const e0 = on(rot * 2, 1.75), e1 = on(rot * 2 + Math.PI, 1.75);
    ctx.moveTo(e0.x, e0.y);
    ctx.lineTo(e1.x, e1.y);
    ctx.stroke();
  }
  if (rng() < 0.5) {
    const pond: Vec[] = [];
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, d = r * 0.24 * (0.8 + rng() * 0.2); pond.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d }); }
    for (const [col, k] of [[FOAM, 1.25], [SHALLOW, 1], [mix(SHALLOW, DEEP, 0.6), 0.6]] as const) { blobPath(ctx, scaled(pond, { x, y }, k)); ctx.fillStyle = col; ctx.fill(); }
  } else {
    for (const [col, rr] of [['#B8B3A8', 5.5], ['#E3DED3', 4.6], [SHALLOW, 3.6], ['#FFFFFF', 1]] as const) { ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
  }
  // benches facing the loop, lamp posts between them
  for (let i = 0; i < 5; i++) {
    const a = rng() * Math.PI * 2, p = on(a, 1.16), q = on(a + 0.01, 1.16), h = Math.atan2(q.y - p.y, q.x - p.x);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(h);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(-1.4, -0.3, 3.2, 1.6);
    ctx.fillStyle = '#8B6B42';
    ctx.fillRect(-1.6, -0.7, 3.2, 1.3);
    ctx.restore();
    const l = on(a + 0.6, 0.86);
    ctx.beginPath();
    ctx.arc(l.x, l.y, 0.7, 0, Math.PI * 2);
    ctx.fillStyle = '#4E5257';
    ctx.fill();
  }
  // flower beds on the lawn
  for (let i = 0; i < 3; i++) {
    const p = on(rng() * Math.PI * 2, 0.5 + rng() * 0.2);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#A9825C';
    ctx.fill();
    const col = FLOWERS[Math.floor(rng() * FLOWERS.length)];
    for (let k = 0; k < 7; k++) { ctx.beginPath(); ctx.arc(p.x + (rng() - 0.5) * 5, p.y + (rng() - 0.5) * 5, 0.9, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
  }
  const trees: Vec[] = [];
  for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2 + rng() * 0.4, d = r * (0.78 + rng() * 0.1); trees.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d }); }
  return trees;
}

// A shrub: a dark base, three lobes, a highlight; sometimes in flower
function bush(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, bloom: string | null): void {
  const dot = (px: number, py: number, rad: number, fill: string): void => { ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };
  dot(x + r * 0.4, y + r * 0.5, r * 1.05, 'rgba(40,60,30,.16)');
  dot(x, y, r, shade(col, -0.22));
  for (let i = 0; i < 3; i++) { const a = i * 2.1 + x; dot(x + Math.cos(a) * r * 0.35 - r * 0.1, y + Math.sin(a) * r * 0.35 - r * 0.1, r * 0.6, col); }
  dot(x - r * 0.35, y - r * 0.35, r * 0.32, shade(col, 0.25));
  if (bloom) for (let i = 0; i < 4; i++) dot(x + Math.cos(i * 1.7 + y) * r * 0.55, y + Math.sin(i * 1.7 + y) * r * 0.5, 0.55, bloom);
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

// One tree crown at p, lit from the top left: round (a dark base, a ring of outer lobes, inner lobes, highlights and leaf specks),
// conifer (four layered stars), snowy conifer, palm (fronds with midribs), blossom, autumn, cactus (ribbed with arms)
export function tree(ctx: CanvasRenderingContext2D, p: Vec, r: number, sp: Species, base: string, tone: number, a: number): void {
  const dot = (x: number, y: number, rad: number, fill: string): void => { ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };
  const star = (rad: number, inner: number, rot: number, fill: string, dx = 0): void => {
    ctx.beginPath();
    for (let i = 0; i < 16; i++) { const d = i % 2 ? rad * inner : rad, an = rot + (i / 16) * Math.PI * 2; ctx.lineTo(p.x + dx + Math.cos(an) * d, p.y + dx + Math.sin(an) * d); }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  if (sp === 'conifer' || sp === 'snowy') {
    const g = '#4E8A55';
    star(r * 1.05, 0.62, a, shade(g, -0.3 + tone));
    star(r * 0.82, 0.6, a + 0.2, shade(g, -0.1 + tone), -r * 0.04);
    star(r * 0.58, 0.58, a + 0.4, shade(g, 0.08 + tone), -r * 0.08);
    star(r * 0.34, 0.55, a + 0.6, sp === 'snowy' ? '#F7F9FA' : shade(g, 0.26 + tone), -r * 0.12);
    if (sp === 'snowy') star(r * 0.8, 0.35, a + 0.2, 'rgba(247,249,250,.55)', -r * 0.06);
    return;
  }
  if (sp === 'palm') {
    const g = '#7FB04F';
    for (let i = 0; i < 7; i++) {
      const an = a + (i / 7) * Math.PI * 2, x = p.x + Math.cos(an) * r * 0.55, y = p.y + Math.sin(an) * r * 0.55;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.64, r * 0.25, an, 0, Math.PI * 2);
      ctx.fillStyle = shade(g, (i % 2 ? 0 : -0.16) + (Math.sin(an + 2.4) * 0.1) + tone);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(an) * r * 1.1, p.y + Math.sin(an) * r * 1.1);
      ctx.strokeStyle = shade(g, -0.3 + tone);
      ctx.lineWidth = 0.35;
      ctx.stroke();
    }
    dot(p.x, p.y, r * 0.24, '#8B6B42');
    dot(p.x - r * 0.06, p.y - r * 0.06, r * 0.12, '#A8875A');
    return;
  }
  if (sp === 'cactus') {
    const g = shade('#7FA35A', tone);
    for (const [dx, dy, k] of [[0, 0, 0.5], [r * 0.55, -r * 0.1, 0.28], [-r * 0.5, r * 0.15, 0.25]] as const) {
      dot(p.x + dx, p.y + dy, r * k, shade(g, -0.22));
      dot(p.x + dx - r * k * 0.2, p.y + dy - r * k * 0.2, r * k * 0.7, g);
    }
    ctx.strokeStyle = shade(g, -0.3);
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) { const an = (i / 6) * Math.PI * 2; ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.cos(an) * r * 0.48, p.y + Math.sin(an) * r * 0.48); }
    ctx.stroke();
    dot(p.x, p.y - r * 0.05, r * 0.1, '#F28DB2');
    return;
  }
  const col = sp === 'blossom' ? '#F2A7C3' : sp === 'autumn' ? '#E3A23B' : base;
  dot(p.x, p.y, r, shade(col, -0.26 + tone));
  for (let i = 0; i < 6; i++) { const an = a + (i / 6) * Math.PI * 2; dot(p.x + Math.cos(an) * r * 0.5, p.y + Math.sin(an) * r * 0.5, r * 0.46, shade(col, -0.12 + tone + Math.sin(an + 2.4) * 0.06)); }
  for (let i = 0; i < 3; i++) { const an = a + (i / 3) * Math.PI * 2; dot(p.x - r * 0.1 + Math.cos(an) * r * 0.26, p.y - r * 0.1 + Math.sin(an) * r * 0.26, r * 0.5, shade(col, tone)); }
  dot(p.x - r * 0.3, p.y - r * 0.32, r * 0.34, shade(col, 0.2 + tone));
  dot(p.x - r * 0.4, p.y - r * 0.42, r * 0.14, shade(col, 0.38 + tone));
  if (r > 3.5) for (let i = 0; i < 5; i++) { const an = a * 2 + i * 1.3; dot(p.x + Math.cos(an) * r * 0.6, p.y + Math.sin(an) * r * 0.55, r * 0.07, shade(col, -0.32 + tone)); }
  if (sp === 'blossom') for (let i = 0; i < 5; i++) { const an = a * 3 + i * 1.7; dot(p.x + Math.cos(an) * r * 0.55, p.y + Math.sin(an) * r * 0.5, 0.8, '#FFFFFF'); }
}

// Moving glints on the water: dashed light lines drifting round each lake and down each river. Cheap: a few strokes a frame.
export function shimmer(ctx: CanvasRenderingContext2D, t: Terrain, now: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  // lapping lake shores: a pale band over the water's edge that swells and ebbs
  const lap = Math.sin(now * 1.3);
  ctx.strokeStyle = `rgba(255,255,255,${0.22 + 0.12 * lap})`;
  ctx.lineWidth = 12.5 + 2 * lap;
  for (const l of t.lakes) { blobPath(ctx, l); ctx.stroke(); }
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
