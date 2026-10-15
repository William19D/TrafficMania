import type { Vec } from '../util/geom.ts';
import { ZONES } from '../core/config.ts';
import type { Site } from '../core/config.ts';
import { mulberry32 } from '../util/rng.ts';

// Building models, flat top-down. Local frame of a footprint: +x toward the door (depth, half H = h / 2), y across the front
// (half W = w / 2). Each kind has VARIANTS looks picked by position, so a street is not copy-pasted.
export const VARIANTS = 32;

// Shades a #RRGGBB (or rgb(r,g,b), so a shade can be shaded again) colour: k > 0 toward white, k < 0 toward black
export function shade(hex: string, k: number): string {
  const v = hex[0] === '#' ? parseInt(hex.slice(1), 16) : hex.match(/\d+/g)!.reduce((a, n) => a * 256 + +n, 0), t = k < 0 ? 0 : 255, f = Math.abs(k);
  const ch = (s: number): number => Math.round(((v >> s) & 255) * (1 - f) + t * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// Look variant at a position (16px cells): a saved street reloads the same; a moved building takes the look of its new spot
export function variant(x: number, y: number): number {
  let h = Math.imul(Math.round(x / 16), 73856093) ^ Math.imul(Math.round(y / 16), 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) % VARIANTS;
}

type Rect = [number, number, number, number];
// body: the part that stands up (casts the shadow, height px); chimney: where a factory's smoke leaves
export interface Look { body: Rect; height: number; chimney: Vec | null }

// The variant's bits set the shape (home: offset, hip roof, chimney, solar panels; office: floors; factory: teeth); its rng the colours
export function look(kind: Site, v: number): Look {
  const H = ZONES[kind].h / 2, W = ZONES[kind].w / 2;
  if (kind === 'home') { const d = v & 1 ? 2 : 0; return { body: [-H + 2, -W + 3 + d, 2 * H - 10, 2 * W - 6 - d], height: 4, chimney: null }; }
  if (kind === 'shop') return { body: [-H + 1, -W + 1, 2 * H - 8, 2 * W - 2], height: 5, chimney: null };
  if (kind === 'office') return { body: [-H + 3, -W + 3, 2 * H - 6, 2 * W - 6], height: 3 + 2 * floors(v), chimney: null };
  if (kind === 'industry') return { body: [-H + 1, -W + 1, 2 * H - 12, 2 * W - 2], height: 6, chimney: { x: -H + 6, y: -W + 6 } };
  return { body: [-H, -W, 2 * H, 2 * W], height: 2, chimney: null };
}
const floors = (v: number): number => 2 + (v % 4);

// Cached models per kind, variant and pixel scale (sprites are drawn rotated, one drawImage each); night: the same frame with
// only its lit windows, which the renderer adds over the night tint
export const PAD = 1;
const sprites = new Map<string, HTMLCanvasElement>();
export function sprite(kind: Site, v: number, s: number, night = false): HTMLCanvasElement {
  const key = `${kind}${v}${night ? 'n' : ''}@${s}`;
  let c = sprites.get(key);
  if (c) return c;
  // ponytail: one scale bucket is in use at a time, so a full cache is from old zooms
  if (sprites.size > 4 * VARIANTS * 4) sprites.clear();
  const H = ZONES[kind].h / 2, W = ZONES[kind].w / 2;
  c = document.createElement('canvas');
  c.width = Math.ceil((2 * H + 2 * PAD) * s);
  c.height = Math.ceil((2 * W + 2 * PAD) * s);
  const ctx = c.getContext('2d')!;
  ctx.scale(s, s);
  ctx.translate(H + PAD, W + PAD);
  ctx.lineCap = ctx.lineJoin = 'round';
  if (night) paintNight(ctx, kind, v, H, W, s);
  else paint(ctx, kind, v, H, W);
  sprites.set(key, c);
  return c;
}

const ROOFS = ['#D9774B', '#C9584F', '#6F86B5', '#A8744F', '#5E9C8A', '#7C7C90', '#E09A4F', '#B5655A'];
const LAWNS = ['#B5D98B', '#A9D184', '#BEDD95', '#AFD58E'];
const AWNINGS = ['#E5484D', '#2F6FED', '#2E9E5B', '#F08C2E', '#8E5CD9', '#E8608E', '#14A3A3'];
const FLOWERS = ['#F28DB2', '#FFD45C', '#FFFFFF', '#B79CF2', '#FF8A65'];
const CONTAINERS = ['#D9534F', '#3F7FBF', '#3D9970', '#E3A23B', '#7A5FB0'];
const OFFICES = ['#ABA3CF', '#9FA9D6', '#B6A6CC', '#9DB2CC'];
const SHOPS = ['#8EC3EE', '#9BCBF0', '#86B9E3', '#A5D0EE'];
const FACTORIES = ['#E2B866', '#D9A85A', '#E6C27A', '#D4B06E'];

function paint(c: CanvasRenderingContext2D, kind: Site, v: number, H: number, W: number): void {
  const r = mulberry32(v * 7919 + ['home', 'shop', 'office', 'industry', 'gate'].indexOf(kind) * 104729);
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
  const rect = (x: number, y: number, w: number, h: number, rad: number, fill: string | null, out: string | null = null, lw = 1): void => {
    c.beginPath();
    c.roundRect(x, y, w, h, rad);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (out) { c.strokeStyle = out; c.lineWidth = lw; c.stroke(); }
  };
  const dot = (x: number, y: number, rad: number, fill: string): void => { c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); };
  const bush = (x: number, y: number, rad: number, col: string): void => { dot(x, y, rad, shade(col, -0.15)); dot(x - rad * 0.25, y - rad * 0.25, rad * 0.6, shade(col, 0.2)); };
  const lines = (pts: number[][], col: string, lw: number): void => {
    c.beginPath();
    for (const [x0, y0, x1, y1] of pts) { c.moveTo(x0, y0); c.lineTo(x1, y1); }
    c.strokeStyle = col;
    c.lineWidth = lw;
    c.stroke();
  };
  const [bx, by, bw, bh] = look(kind, v).body, fx = bx + bw;

  if (kind === 'home') {
    const roof = pick(ROOFS), lawn = pick(LAWNS);
    rect(-H, -W, 2 * H, 2 * W, 3, lawn);
    // hedge or white picket fence round the yard
    if (r() < 0.5) rect(-H + 1, -W + 1, 2 * H - 2, 2 * W - 2, 2.5, null, '#7FB062', 2);
    else { c.setLineDash([1.6, 1.2]); rect(-H + 0.8, -W + 0.8, 2 * H - 1.6, 2 * W - 1.6, 2.5, null, '#FFFFFF', 1); c.setLineDash([]); }
    // front path, and a bush or a flower bed each side of it
    rect(fx, -2, H - fx, 4, 0, '#EDE6D3');
    for (const k of [-1, 1]) {
      const gx = (fx + H) / 2, gy = k * (W - 4.5);
      if (r() < 0.55) bush(gx, gy, 2.3, '#6FA650');
      else { rect(gx - 2, gy - 2.5, 4, 5, 1, '#B78B5E'); for (let i = 0; i < 3; i++) dot(gx - 1 + r() * 2, gy - 1.6 + i * 1.6, 0.8, pick(FLOWERS)); }
    }
    // pitched roof: ridge across the front, back slope darker; a hip roof slopes at the ends too
    const mx = bx + bw / 2, dark = shade(roof, -0.15), light = shade(roof, 0.12), edge = shade(roof, -0.4);
    rect(bx - 0.6, by - 0.6, bw + 1.2, bh + 1.2, 1.2, edge);
    if (v & 2) {
      const i = bw / 2, y0 = by, y1 = by + bh;
      const poly = (pts: number[][], fill: string): void => {
        c.beginPath();
        pts.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.closePath();
        c.fillStyle = fill;
        c.fill();
      };
      poly([[bx, y0], [mx, y0 + i], [mx, y1 - i], [bx, y1]], dark);
      poly([[fx, y0], [mx, y0 + i], [mx, y1 - i], [fx, y1]], light);
      poly([[bx, y0], [mx, y0 + i], [fx, y0]], roof);
      poly([[bx, y1], [mx, y1 - i], [fx, y1]], shade(roof, -0.05));
      lines([[mx, y0 + i, mx, y1 - i], [bx, y0, mx, y0 + i], [fx, y0, mx, y0 + i], [bx, y1, mx, y1 - i], [fx, y1, mx, y1 - i]], edge, 0.6);
    } else {
      rect(bx, by, mx - bx, bh, 0, dark);
      rect(mx, by, fx - mx, bh, 0, light);
      const rows: number[][] = [];
      for (let x = bx + 2; x < fx - 1; x += 2.5) if (Math.abs(x - mx) > 0.8) rows.push([x, by + 0.5, x, by + bh - 0.5]);
      lines(rows, 'rgba(0,0,0,.09)', 0.5);
      lines([[mx, by, mx, by + bh]], edge, 0.8);
    }
    if (v & 8) {
      // solar panels on the back slope
      const sy = by + bh / 2 - 5;
      rect(bx + 1.2, sy, mx - bx - 2.4, 10, 0.5, '#3F5A80');
      lines([[bx + 1.2, sy + 3.3, mx - 1.2, sy + 3.3], [bx + 1.2, sy + 6.6, mx - 1.2, sy + 6.6]], '#8FA9CF', 0.4);
    }
    if (v & 4) { const cy = v & 8 ? by + 2.5 : by + bh - 5.5; rect(bx + 1.5, cy, 3, 3, 0.5, '#B0644A', '#7A3F2E', 0.5); }
  } else if (kind === 'shop') {
    const roof = pick(SHOPS), aw = pick(AWNINGS);
    rect(-H, -W, 2 * H, 2 * W, 3, '#E6E3DA');
    rect(fx + 5, -W + 1, H - fx - 6, 2 * W - 2, 1, '#F3F1EB');
    rect(bx, by, bw, bh, 2, shade(roof, -0.3));
    rect(bx + 1.5, by + 1.5, bw - 3, bh - 3, 1.5, roof);
    // rooftop: AC units and a skylight
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const ux = bx + 3 + r() * 6, uy = by + 3 + i * 9 + r() * 3;
      rect(ux, uy, 6, 5, 0.8, '#D3D7DC', '#9AA1A8', 0.5);
      dot(ux + 3, uy + 2.5, 1.5, '#8E959C');
    }
    rect(bx + 4, by + bh - 14, 8, 10, 0.8, '#D7EAF8', shade(roof, -0.3), 0.6);
    // sign block on the roof's front edge: coloured board with white lettering
    const sign = pick(AWNINGS);
    rect(fx - 6.5, -10, 4.5, 20, 1, sign, '#FFFFFF', 0.6);
    for (let y = -7.5; y < 7.5; y += 2.8) rect(fx - 4.9, y, 1.4, 1.9, 0.3, '#FFFFFF');
    // striped awning with a scalloped edge
    for (let y = by + 2, k = 0; y < by + bh - 2; y += 3, k++) rect(fx, y, 4.5, Math.min(3, by + bh - 2 - y), 0, k % 2 ? '#FFFFFF' : aw);
    for (let y = by + 3.5; y < by + bh - 2; y += 3) dot(fx + 4.5, y, 1.4, aw);
    lines([[fx, by + 2, fx, by + bh - 2]], shade(aw, -0.3), 0.6);
    for (const k of [-1, 1]) bush(H - 2, k * (W - 3), 1.7, '#5FA35A');
  } else if (kind === 'office') {
    const col = pick(OFFICES), F = floors(v);
    rect(-H, -W, 2 * H, 2 * W, 3, '#E3E1DB');
    const tiles: number[][] = [];
    for (let k = -H + 6; k < H; k += 6) tiles.push([k, -W + 1, k, W - 1]);
    for (let k = -W + 6; k < W; k += 6) tiles.push([-H + 1, k, H - 1, k]);
    lines(tiles, 'rgba(0,0,0,.05)', 0.5);
    for (const k of [-1, 1]) bush(H - 2.5, k * (W - 2.5), 2.2, '#5E9A4E');
    // glass curtain wall peeking out round the roof, mullions every 3px
    rect(bx, by, bw, bh, 2, shade(col, -0.35));
    rect(bx + 0.8, by + 0.8, bw - 1.6, bh - 1.6, 1.5, '#BFD4EA');
    const grid: number[][] = [];
    for (let k = bx + 3; k < fx; k += 3) grid.push([k, by + 1, k, by + bh - 1]);
    for (let k = by + 3; k < by + bh; k += 3) grid.push([bx + 1, k, fx - 1, k]);
    lines(grid, 'rgba(70,80,120,.35)', 0.5);
    const i = 2.6;
    rect(bx + i, by + i, bw - 2 * i, bh - 2 * i, 1.5, col, shade(col, -0.25), 0.8);
    // rooftop: a helipad on the tallest, else a water tank and AC units
    const cx = bx + bw / 2, cy = by + bh / 2;
    if (F === 5) {
      dot(cx, cy, 7, '#7E8A96');
      c.beginPath(); c.arc(cx, cy, 5.6, 0, Math.PI * 2); c.strokeStyle = '#FFFFFF'; c.lineWidth = 0.7; c.stroke();
      lines([[cx - 2, cy - 2.5, cx - 2, cy + 2.5], [cx + 2, cy - 2.5, cx + 2, cy + 2.5], [cx - 2, cy, cx + 2, cy]], '#FFFFFF', 0.9);
    } else {
      dot(cx - 5, cy - 4, 3.6, '#C9CDD2');
      dot(cx - 5, cy - 4, 2.4, '#DDE0E4');
      for (let k = 0; k < F; k++) rect(cx + 1, cy - 8 + k * 4.5, 6, 3.4, 0.6, '#D3D7DC', '#9AA1A8', 0.5);
      rect(cx - 8, cy + 3, 7, 5, 0.6, shade(col, -0.15));
    }
  } else if (kind === 'industry') {
    const col = pick(FACTORIES);
    rect(-H, -W, 2 * H, 2 * W, 3, '#DAD6CC');
    lines([[fx + 1, -W + 2, H - 1, -W + 2], [fx + 1, W - 2, H - 1, W - 2]], '#F2D04B', 0.8);
    // saw-tooth roof: strips across the hall, each a lit slope, a shaded slope and a glazed edge
    const n = 5 + (v & 1), sw = bw / n;
    rect(bx - 0.6, by - 0.6, bw + 1.2, bh + 1.2, 1.2, shade(col, -0.4));
    for (let k = 0; k < n; k++) {
      const x = bx + k * sw;
      rect(x, by, sw * 0.62, bh, 0, col);
      rect(x + sw * 0.62, by, sw * 0.38, bh, 0, shade(col, -0.2));
      lines([[x + sw - 0.4, by + 0.5, x + sw - 0.4, by + bh - 0.5]], '#BFD8EE', 0.8);
    }
    // chimney
    const ch = look(kind, v).chimney!;
    dot(ch.x, ch.y, 4, '#8F857D');
    dot(ch.x, ch.y, 3, '#A89E95');
    dot(ch.x, ch.y, 1.8, '#4A4541');
    // yard: a shipping container, a tank or crates, either side of the drive
    const box = (x: number, y: number): void => { rect(x, y, 3.2, 3.2, 0.4, '#B9844F', '#7F5A34', 0.4); lines([[x, y, x + 3.2, y + 3.2], [x + 3.2, y, x, y + 3.2]], '#7F5A34', 0.3); };
    for (const k of [-1, 1]) {
      const y0 = k > 0 ? 4 : -W + 2.5, yw = W - 6.5;
      const what = r();
      if (what < 0.45) {
        const cc = pick(CONTAINERS);
        rect(fx + 2, y0 + 1, 5, Math.min(14, yw - 1), 0.5, cc, shade(cc, -0.3), 0.5);
        const ribs: number[][] = [];
        for (let y = y0 + 3; y < y0 + Math.min(14, yw - 1); y += 2) ribs.push([fx + 2.5, y, fx + 6.5, y]);
        lines(ribs, shade(cc, -0.2), 0.4);
      } else if (what < 0.7) {
        dot(fx + 5, y0 + yw / 2, 4, '#B7BBBE');
        dot(fx + 5, y0 + yw / 2, 3, '#ECECE8');
      } else for (let i = 0; i < 4; i++) box(fx + 1.5 + (i % 2) * 4, y0 + 1 + Math.floor(i / 2) * 4 + r() * 2);
    }
  }
}

// Lit windows at night, top-down: light spilling from a home's windows and its porch lamp, a shop's glowing front and sign, an
// office's curtain wall lit in patches, a factory's skylights and yard lamps. Warm, with a soft halo.
function paintNight(c: CanvasRenderingContext2D, kind: Site, v: number, H: number, W: number, s: number): void {
  const r = mulberry32(v * 4973 + 17), [bx, by, bw, bh] = look(kind, v).body, fx = bx + bw;
  const warm = (x: number, y: number, w: number, h: number, a = 1): void => { c.globalAlpha = a; c.fillStyle = '#FFD27A'; c.fillRect(x, y, w, h); };
  c.shadowColor = '#FFB347';
  c.shadowBlur = 3 * s;
  if (kind === 'home') {
    for (const y of [by + bh * 0.25, by + bh * 0.62]) if (r() < 0.8) warm(fx - 0.2, y, 1.2, 2.6);
    for (const k of [by - 0.9, by + bh - 0.3]) if (r() < 0.6) warm(bx + bw * (0.2 + r() * 0.5), k, 2.6, 1.2);
    c.beginPath();
    c.arc(fx + 1.6, 2.8, 1, 0, Math.PI * 2);
    c.fillStyle = '#FFE9B0';
    c.fill();
  } else if (kind === 'shop') {
    warm(fx + 4.5, by + 2, 2.2, bh - 4, 0.9);
    warm(fx - 6.5, -10, 4.5, 20, 0.45);
    for (const k of [-1, 1]) warm(H - 3, k * (W - 3) - 1, 2, 2, 0.8);
  } else if (kind === 'office') {
    // the mullion cells of the glass ring round the roof
    for (let x = bx + 0.8; x < fx - 2.5; x += 3) for (const y of [by + 0.8, by + bh - 2.6]) if (r() < 0.5) warm(x, y, 2.6, 1.8, 0.9);
    for (let y = by + 3.5; y < by + bh - 3; y += 3) for (const x of [bx + 0.8, fx - 2.6]) if (r() < 0.5) warm(x, y, 1.8, 2.6, 0.9);
  } else if (kind === 'industry') {
    const n = 5 + (v & 1), sw = bw / n;
    for (let k = 0; k < n; k++) warm(bx + (k + 1) * sw - 1, by + 1, 1.2, bh - 2, 0.55);
    for (const k of [-1, 1]) warm(H - 2.5, k * (W - 2.5) - 1, 2, 2);
  }
  c.globalAlpha = 1;
}
