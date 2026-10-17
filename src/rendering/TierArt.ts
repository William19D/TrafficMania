// Models for the higher tiers and the specials (game-v3 3), in BuildingArt's frame and kit: +x toward the door (depth, half H),
// y across the front (half W). Detail comes from the tier and the lot count (more units, bays, docks); the variant picks colours and
// small choices. ponytail: details do not look at the neighbours yet (Townscaper's joins); add when streets read too samey.
import type { Kit, Look } from './BuildingArt.ts';
import { shade } from './BuildingArt.ts';

type Rect = [number, number, number, number];
const L = (body: Rect, height: number): Look => ({ body, height, chimney: null });

const ROOFS = ['#D9774B', '#C9584F', '#6F86B5', '#A8744F', '#5E9C8A', '#7C7C90', '#E09A4F', '#B5655A'];
const LAWN = '#B5D98B', PAVE = '#E6E3DA', ASPHALT = '#9FA3A8', GLASS = '#BFD4EA', TREE = '#5FA35A';
const BRAND = ['#E5484D', '#2F6FED', '#2E9E5B', '#F08C2E', '#8E5CD9', '#E8608E', '#14A3A3'];
const CARS = ['#E5484D', '#2F6FED', '#F2F2F2', '#3A3A3A', '#F0B429', '#8FA3B8', '#2E9E5B'];
const CONTAINERS = ['#D9534F', '#3F7FBF', '#3D9970', '#E3A23B', '#7A5FB0', '#C0C4C8'];

// Body rect and height (the shadow's length) per model
export function extraLook(art: string, v: number, H: number, W: number): Look {
  switch (art) {
    case 'home2': return L([-H + 5, -W + 1, 2 * H - 11, 2 * W - 2], 5);
    case 'home3': return L([-H + 3, -W + 2, 2 * H - 11, 2 * W - 4], 9);
    case 'home4': return L([-H + 3, -W + 4, 2 * H - 11, 2 * W - 8], 16);
    case 'shop2': return L([-H + 1, -W + 1, 2 * H - 14, 2 * W - 2], 5);
    case 'shop3': return L([-H + 1, -W + 1, 2 * H - 14, 2 * W - 2], 7);
    case 'office2': return L([-H + 3, -W + 3, 2 * H - 7, 2 * W - 6], 16 + 2 * (v % 3));
    case 'workshop': return L([-H + 1, -W + 1, 2 * H - 10, 2 * W - 2], 4);
    case 'industry3': return L([-H + 1, -W + 1, 2 * H - 13, 2 * W - 2], 7);
    case 'plaza': return L([-H + 2, -W + 2, 2 * H - 32, 2 * W - 4], 7);
    case 'terminal': return L([-H + 14, -W + 6, 2 * H - 34, 2 * W - 12], 4);
    case 'stadium': return L([-H + 3, -W + 3, 2 * H - 6, 2 * W - 6], 6);
    default: return L([-H + 4, -W + 4, 2 * H - 18, 2 * W - 8], 8); // hospital
  }
}

// A car parked across x0..x0+5 at y (top-down, nose toward +x when dir 1)
const car = (k: Kit, x: number, y: number, along = false): void => {
  const col = k.pick(CARS);
  if (along) { k.rect(x, y - 1.6, 5.4, 3.2, 1, col, shade(col, -0.35), 0.4); k.rect(x + 1.4, y - 1.2, 2.2, 2.4, 0.6, '#3A4756'); }
  else { k.rect(x - 1.6, y, 3.2, 5.4, 1, col, shade(col, -0.35), 0.4); k.rect(x - 1.2, y + 1.4, 2.4, 2.2, 0.6, '#3A4756'); }
};
// Parking strip from x0 to x1 (depth) across y0..y1: bays every 4.5px across, cars in most
const parking = (k: Kit, x0: number, x1: number, y0: number, y1: number): void => {
  k.rect(x0, y0, x1 - x0, y1 - y0, 1, ASPHALT);
  const bays: number[][] = [];
  for (let y = y0 + 1; y <= y1 - 1; y += 4.5) bays.push([x0 + 0.5, y, x0 + 6.5, y]);
  k.lines(bays, '#FFFFFF', 0.5);
  for (let y = y0 + 1; y + 4.5 <= y1; y += 4.5) if (k.r() < 0.65) car(k, x0 + 0.8, y + 2.25, true);
};
// Flat roof: a parapet, a membrane, AC units and a hatch
const flat = (k: Kit, [x, y, w, h]: Rect, col = '#D9DCDF'): void => {
  k.rect(x - 0.6, y - 0.6, w + 1.2, h + 1.2, 1.2, shade(col, -0.4));
  k.rect(x, y, w, h, 1, shade(col, -0.12));
  k.rect(x + 1.2, y + 1.2, w - 2.4, h - 2.4, 0.8, col);
};
const ac = (k: Kit, x: number, y: number): void => { k.rect(x, y, 4.5, 3.6, 0.6, '#D3D7DC', '#9AA1A8', 0.4); k.dot(x + 2.25, y + 1.8, 1.1, '#8E959C'); };
const trees = (k: Kit, pts: number[][], rad = 2.2): void => { for (const [x, y] of pts) k.bush(x, y, rad, TREE); };

export const EXTRA: Record<string, (k: Kit, v: number, H: number, W: number, look: Look) => void> = {
  // Townhouses: a row of attached units, each its own roof colour and ridge, front gardens with a path, fenced back yards
  home2(k, v, H, W, { body: [bx, by, bw, bh] }) {
    const n = v & 1 ? 4 : 3, uw = bh / n, fx = bx + bw, mx = bx + bw / 2;
    k.rect(-H, -W, 2 * H, 2 * W, 3, LAWN);
    const fence: number[][] = [];
    for (let i = 1; i < n; i++) fence.push([-H + 0.5, by + i * uw, bx, by + i * uw]);
    k.lines(fence, '#FFFFFF', 0.7);
    for (let i = 0; i < n; i++) {
      const y = by + i * uw, roof = ROOFS[(v + i * 3) % ROOFS.length], edge = shade(roof, -0.4);
      k.rect(fx, y + uw / 2 - 1, H - fx, 2, 0, '#EDE6D3');
      k.rect(bx, y, mx - bx, uw, 0, shade(roof, -0.15));
      k.rect(mx, y, fx - mx, uw, 0, shade(roof, 0.12));
      k.lines([[mx, y, mx, y + uw]], edge, 0.7);
      if ((v >> 2) & 1 ? i % 2 : i % 2 === 0) k.rect(bx + 1.5, y + 1.5, 3, 3, 0.5, '#B0644A', '#7A3F2E', 0.5);
      if (k.r() < 0.5) k.bush(fx + 3, y + 3, 1.6, '#6FA650');
      if (k.r() < 0.4) k.dot(-H + 3, y + uw / 2, 1.6, k.r() < 0.5 ? '#7FB3D5' : '#E8D9B5');
    }
    k.lines(Array.from({ length: n + 1 }, (_, i) => [bx, by + i * uw, fx, by + i * uw]), shade(ROOFS[v % ROOFS.length], -0.5), 0.6);
  },
  // Apartment block: a flat roof with a parapet, a lift tower, AC units and a water tank, balconies along the front, a bike rack and hedges
  home3(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw;
    k.rect(-H, -W, 2 * H, 2 * W, 3, PAVE);
    k.rect(-H, -W, bx + H - 0.5, 2 * W, 3, LAWN);
    flat(k, body, ['#D9DCDF', '#E2D6C6', '#CFD8D2'][v % 3]);
    for (let y = by + 3; y < by + bh - 4; y += 7) k.rect(fx, y, 2.2, 5, 0.5, '#F4F4F2', '#9AA1A8', 0.4);
    k.rect(bx + bw * 0.35, by + bh / 2 - 4, 7, 8, 0.8, '#B9BEC4', '#8A9096', 0.5);
    for (let i = 0; i < 3; i++) ac(k, bx + 2.5, by + 3 + i * 5.5);
    k.dot(bx + bw * 0.7, by + bh - 6, 3, '#C9CDD2');
    k.dot(bx + bw * 0.7, by + bh - 6, 2, '#DDE0E4');
    if (v & 2) { k.rect(bx + bw * 0.62, by + 3, 7, 10, 0.4, '#3F5A80'); k.lines([[bx + bw * 0.62, by + 6.3, bx + bw * 0.62 + 7, by + 6.3], [bx + bw * 0.62, by + 9.6, bx + bw * 0.62 + 7, by + 9.6]], '#8FA9CF', 0.4); }
    trees(k, [[-H + 2.5, -W + 3], [-H + 2.5, W - 3]], 1.8);
    for (const y of [-W + 2.5, W - 2.5]) k.rect(fx + 3, y - 1.5, H - fx - 4, 3, 1, '#7FB062');
    k.lines([[fx + 3, -3, fx + 3, 3], [fx + 4.5, -3, fx + 4.5, 3]], '#8A9096', 0.5);
  },
  // Tower: a podium with a set-back tower over it, a roof garden or a helipad on top, a paved plaza with trees and a fountain in front
  home4(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw, col = ['#C9CDD8', '#D8CFC4', '#C4D2CC'][v % 3];
    k.rect(-H, -W, 2 * H, 2 * W, 3, PAVE);
    const tiles: number[][] = [];
    for (let y = -W + 6; y < W; y += 6) tiles.push([fx + 1, y, H - 1, y]);
    k.lines(tiles, 'rgba(0,0,0,.06)', 0.5);
    flat(k, body, shade(col, 0.1));
    const t: Rect = [bx + 4, by + 8, bw - 8, bh - 16];
    k.rect(t[0] - 1, t[1] - 1, t[2] + 2, t[3] + 2, 1.5, shade(col, -0.45));
    k.rect(...t, 1.2, col);
    const win: number[][] = [];
    for (let y = t[1] + 3; y < t[1] + t[3] - 1; y += 3) win.push([t[0] + 0.6, y, t[0] + 1.8, y], [t[0] + t[2] - 1.8, y, t[0] + t[2] - 0.6, y]);
    k.lines(win, '#8FA9CF', 0.9);
    const cx = t[0] + t[2] / 2, cy = t[1] + t[3] / 2;
    if (v & 1) {
      k.dot(cx, cy, 7.5, '#7E8A96');
      k.c.beginPath(); k.c.arc(cx, cy, 6, 0, Math.PI * 2); k.c.strokeStyle = '#FFFFFF'; k.c.lineWidth = 0.7; k.c.stroke();
      k.lines([[cx - 2, cy - 2.5, cx - 2, cy + 2.5], [cx + 2, cy - 2.5, cx + 2, cy + 2.5], [cx - 2, cy, cx + 2, cy]], '#FFFFFF', 0.9);
    } else {
      k.rect(t[0] + 3, t[1] + 3, t[2] - 6, t[3] - 6, 2, '#A9D184');
      trees(k, [[cx - 4, cy - 8], [cx + 3, cy - 2], [cx - 3, cy + 6], [cx + 4, cy + 10]], 2);
    }
    for (let i = 0; i < 4; i++) { ac(k, bx + 2 + i * 6, by + 2); ac(k, bx + 2 + i * 6, by + bh - 5.6); }
    trees(k, [[H - 3, -W + 4], [H - 3, W - 4], [H - 3, -W / 2], [H - 3, W / 2]]);
    k.dot(fx + (H - fx) / 2, 0, 3, '#9CC9E8');
    k.dot(fx + (H - fx) / 2, 0, 1.5, '#D7EAF8');
  },
  // Store: a bigger shop at the back with an awning and a sign, a parking lot in front
  shop2(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw, roof = ['#8EC3EE', '#9BCBF0', '#A5D0EE'][v % 3], aw = BRAND[v % BRAND.length];
    k.rect(-H, -W, 2 * H, 2 * W, 3, PAVE);
    parking(k, fx + 4, H - 1, -W + 2, W - 2);
    flat(k, body, roof);
    for (let i = 0; i < 2 + (v & 1); i++) ac(k, bx + 2.5, by + 3 + i * 8);
    k.rect(bx + bw - 10, by + 4, 6, 8, 0.6, '#D7EAF8', shade(roof, -0.3), 0.5);
    for (let y = by + 2, i = 0; y < by + bh - 2; y += 3, i++) k.rect(fx, y, 3.5, Math.min(3, by + bh - 2 - y), 0, i % 2 ? '#FFFFFF' : aw);
    k.rect(fx - 6, -9, 4, 18, 1, aw, '#FFFFFF', 0.6);
    for (let y = -6.5; y < 7; y += 2.6) k.rect(fx - 4.6, y, 1.2, 1.7, 0.3, '#FFFFFF');
    trees(k, [[fx + 2, -W + 2.5], [fx + 2, W - 2.5]], 1.6);
  },
  // Mall: a long flat roof with skylight rows and a glass atrium, an entrance canopy, AC banks, and a tree-lined parking lot in front
  shop3(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw, aw = BRAND[v % BRAND.length];
    k.rect(-H, -W, 2 * H, 2 * W, 3, PAVE);
    parking(k, fx + 3, H - 1, -W + 2, -6);
    parking(k, fx + 3, H - 1, 6, W - 2);
    flat(k, body, '#DCDFE2');
    const sky: number[][] = [];
    for (let y = by + 8; y < by + bh - 6; y += 10) if (Math.abs(y) > 10) sky.push([bx + 4, y, fx - 4, y]);
    k.lines(sky, '#A9C6DF', 2.2);
    k.dot(bx + bw / 2, 0, 8, shade(GLASS, -0.25));
    k.dot(bx + bw / 2, 0, 6.6, GLASS);
    k.lines([[bx + bw / 2 - 6.6, 0, bx + bw / 2 + 6.6, 0], [bx + bw / 2, -6.6, bx + bw / 2, 6.6]], '#8FA9CF', 0.5);
    for (const y of [by + 4, by + bh - 8]) for (let i = 0; i < 3; i++) ac(k, bx + 2 + i * 5.5, y);
    k.rect(fx - 1, -6, 5, 12, 1, aw, shade(aw, -0.3), 0.6);
    k.rect(fx - 8, -14, 4, 28, 1, '#FFFFFF', aw, 0.8);
    for (let y = -11.5; y < 12; y += 3) k.rect(fx - 6.8, y, 1.6, 2, 0.3, aw);
    trees(k, [[fx + 2, -W + 2.5], [fx + 2, W - 2.5], [H - 2, -4], [H - 2, 4]], 1.8);
  },
  // Office tower: a tall glass tower with set-back crowns, mullions, a helipad or a plant room on top, and a plaza with planters
  office2(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, col = ['#ABA3CF', '#9FA9D6', '#9DB2CC', '#8FB5C9'][v % 4];
    k.rect(-H, -W, 2 * H, 2 * W, 3, '#E3E1DB');
    k.rect(bx - 0.6, by - 0.6, bw + 1.2, bh + 1.2, 2, shade(col, -0.45));
    k.rect(bx, by, bw, bh, 1.8, GLASS);
    const grid: number[][] = [];
    for (let x = bx + 3; x < bx + bw; x += 3) grid.push([x, by + 0.6, x, by + bh - 0.6]);
    for (let y = by + 3; y < by + bh; y += 3) grid.push([bx + 0.6, y, bx + bw - 0.6, y]);
    k.lines(grid, 'rgba(70,80,120,.32)', 0.5);
    const i1 = 3, i2 = 7;
    k.rect(bx + i1, by + i1, bw - 2 * i1, bh - 2 * i1, 1.5, col, shade(col, -0.3), 0.8);
    k.rect(bx + i2, by + i2, bw - 2 * i2, bh - 2 * i2, 1.2, shade(col, 0.15), shade(col, -0.3), 0.6);
    const cx = bx + bw / 2, cy = by + bh / 2;
    if (v & 1) {
      k.dot(cx, cy, 6.5, '#7E8A96');
      k.c.beginPath(); k.c.arc(cx, cy, 5.2, 0, Math.PI * 2); k.c.strokeStyle = '#FFFFFF'; k.c.lineWidth = 0.6; k.c.stroke();
      k.lines([[cx - 1.8, cy - 2.2, cx - 1.8, cy + 2.2], [cx + 1.8, cy - 2.2, cx + 1.8, cy + 2.2], [cx - 1.8, cy, cx + 1.8, cy]], '#FFFFFF', 0.8);
    } else {
      k.rect(cx - 5, cy - 8, 10, 16, 0.8, '#B9BEC4', '#8A9096', 0.5);
      for (let j = 0; j < 3; j++) ac(k, cx - 2.2, cy - 7 + j * 5);
    }
    for (const y of [-W + 2.5, W - 2.5]) k.bush(H - 2.5, y, 2, '#5E9A4E');
  },
  // Workshop: a small shed with a single-pitch corrugated roof, a roller door, a van or pallets in the yard
  workshop(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw, col = ['#C9B28A', '#B7A37E', '#D2BC92', '#A8B0B8'][v % 4];
    k.rect(-H, -W, 2 * H, 2 * W, 3, '#DAD6CC');
    k.rect(bx - 0.6, by - 0.6, bw + 1.2, bh + 1.2, 1, shade(col, -0.45));
    k.rect(bx, by, bw, bh, 0.8, col);
    const ribs: number[][] = [];
    for (let y = by + 1.6; y < by + bh; y += 1.6) ribs.push([bx + 0.5, y, fx - 0.5, y]);
    k.lines(ribs, shade(col, -0.15), 0.4);
    k.rect(bx, by, 2, bh, 0, shade(col, -0.2));
    k.rect(fx - 0.5, -5, 1.6, 10, 0.3, '#8C9298');
    if (v & 1) { k.rect(fx + 2, -W + 2, 5, 8, 1, '#F2F2F2', '#9A9A96', 0.4); k.rect(fx + 5.2, -W + 2.6, 1.4, 6.8, 0.4, '#3A4756'); }
    else for (let i = 0; i < 3; i++) k.rect(fx + 2 + (i % 2) * 3.5, W - 7 + Math.floor(i / 2) * 3.5, 3, 3, 0.3, '#B9844F', '#7F5A34', 0.4);
    k.dot(fx + 3, W - 2.5, 1.2, '#3F7FBF');
    k.dot(fx + 5.4, W - 2.5, 1.2, '#D9534F');
  },
  // Logistics park: a long ribbed warehouse, loading docks along the front with trucks backed in, a yard with lines and containers
  industry3(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw, col = ['#C7CBD0', '#D2CBBE', '#BFC9C4'][v % 3];
    k.rect(-H, -W, 2 * H, 2 * W, 3, '#8E9297');
    k.rect(bx - 0.6, by - 0.6, bw + 1.2, bh + 1.2, 1, shade(col, -0.45));
    k.rect(bx, by, bw, bh, 0.8, col);
    const ribs: number[][] = [];
    for (let y = by + 2; y < by + bh; y += 2) ribs.push([bx + 0.5, y, fx - 0.5, y]);
    k.lines(ribs, shade(col, -0.1), 0.4);
    for (let y = by + 8; y < by + bh - 4; y += 16) k.rect(bx + bw / 2 - 3, y, 6, 3, 0.4, '#D7EAF8', shade(col, -0.3), 0.4);
    for (let y = by + 4, i = 0; y < by + bh - 4; y += 7, i++) {
      k.rect(fx, y, 1.4, 4.5, 0.3, '#4A4F55');
      if ((i + v) % 3 !== 1) {
        const t = k.pick(CONTAINERS);
        k.rect(fx + 1.6, y - 0.4, 8, 5.2, 0.6, t, shade(t, -0.35), 0.4);
        k.rect(fx + 9.6, y - 0.1, 3, 4.6, 0.8, '#E8E8E4', '#8A8A86', 0.4);
        k.rect(fx + 11.6, y + 0.3, 0.7, 3.8, 0.2, '#3A4756');
      }
    }
  },
  // Mall plaza: a big mall with a glass cross of skylights and two anchor stores, a paved plaza with a fountain and tree rows in front,
  // parking either side
  plaza(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw, aw = BRAND[v % BRAND.length], aw2 = BRAND[(v + 3) % BRAND.length];
    k.rect(-H, -W, 2 * H, 2 * W, 4, PAVE);
    parking(k, fx + 4, H - 2, -W + 2, -20);
    parking(k, fx + 4, H - 2, 20, W - 2);
    const tiles: number[][] = [];
    for (let x = fx + 4; x < H; x += 5) tiles.push([x, -18, x, 18]);
    k.lines(tiles, 'rgba(0,0,0,.06)', 0.5);
    flat(k, body, '#DCDFE2');
    flat(k, [bx + 2, by + 2, bw - 4, 18], shade(aw, 0.55));
    flat(k, [bx + 2, by + bh - 20, bw - 4, 18], shade(aw2, 0.55));
    const cx = bx + bw / 2;
    k.lines([[bx + 4, 0, fx - 4, 0], [cx, by + 22, cx, by + bh - 22]], '#A9C6DF', 4);
    k.lines([[bx + 4, 0, fx - 4, 0], [cx, by + 22, cx, by + bh - 22]], GLASS, 2.4);
    k.dot(cx, 0, 7, shade(GLASS, -0.25));
    k.dot(cx, 0, 5.6, GLASS);
    for (const y of [by + 6, by + bh - 14]) for (let i = 0; i < 4; i++) ac(k, bx + 4 + i * 6, y);
    k.rect(fx - 1, -8, 5, 16, 1, aw, shade(aw, -0.3), 0.6);
    const px = fx + (H - fx) / 2;
    k.dot(px, 0, 6, '#B8C2CA');
    k.dot(px, 0, 4.8, '#9CC9E8');
    k.dot(px, 0, 1.8, '#FFFFFF');
    trees(k, [[px - 8, -14], [px, -14], [px + 8, -14], [px - 8, 14], [px, 14], [px + 8, 14]], 2.2);
  },
  // Freight terminal: stacks of containers in coloured rows under a gantry crane, a rail siding at the back, a gate office and truck lanes
  terminal(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body;
    k.rect(-H, -W, 2 * H, 2 * W, 3, '#8E9297');
    const rail: number[][] = [];
    for (let y = -W + 2; y < W - 2; y += 2.5) rail.push([-H + 3, y, -H + 9, y]);
    k.lines(rail, '#7A5C3E', 0.9);
    k.lines([[-H + 4.5, -W + 1, -H + 4.5, W - 1], [-H + 7.5, -W + 1, -H + 7.5, W - 1]], '#5B6168', 0.7);
    for (let x = bx; x + 6 <= bx + bw; x += 7) for (let y = by; y + 12 <= by + bh; y += 13) {
      const t = k.pick(CONTAINERS), stack = 1 + Math.floor(k.r() * 3);
      k.rect(x, y, 6, 12, 0.5, shade(t, -0.1 * stack), shade(t, -0.4), 0.4);
      k.lines([[x + 1, y + 3, x + 5, y + 3], [x + 1, y + 6, x + 5, y + 6], [x + 1, y + 9, x + 5, y + 9]], shade(t, -0.25), 0.3);
    }
    const cy = by + bh * (0.3 + 0.4 * ((v % 5) / 4));
    k.rect(bx - 4, cy - 1.6, bw + 8, 3.2, 0.4, '#F0B429', '#9C7414', 0.5);
    k.rect(bx - 4, cy - 6, 2.4, 12, 0.4, '#E0A21C', '#9C7414', 0.5);
    k.rect(bx + bw + 1.6, cy - 6, 2.4, 12, 0.4, '#E0A21C', '#9C7414', 0.5);
    k.rect(bx + bw * 0.4, cy - 2.4, 5, 4.8, 0.6, '#5B6168');
    k.lines([[H - 14, -W + 2, H - 14, W - 2]], '#FFFFFF', 0.6);
    k.rect(H - 10, W - 14, 8, 10, 1, '#E8E4DA', '#9A958A', 0.6);
    k.rect(H - 9, W - 13, 6, 8, 0.6, '#6F86B5');
    for (let y = -W + 6; y < W - 20; y += 9) { const t = k.pick(CONTAINERS); k.rect(H - 11, y, 8, 4, 0.5, t, shade(t, -0.35), 0.4); k.rect(H - 3.4, y + 0.3, 2.4, 3.4, 0.5, '#E8E8E4'); }
  },
  // Stadium: an oval bowl of seats in team colours round a striped pitch with its lines, a roof ring, floodlight masts at the corners
  stadium(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, cx = bx + bw / 2, a = bw / 2, b = bh / 2, team = BRAND[v % BRAND.length], c = k.c;
    k.rect(-H, -W, 2 * H, 2 * W, 4, ASPHALT);
    const ell = (rx: number, ry: number, fill: string): void => { c.beginPath(); c.ellipse(cx, 0, rx, ry, 0, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); };
    ell(a, b, '#B8BCC2');
    ell(a - 2, b - 2, '#8E949B');
    const segs = 28;
    for (let i = 0; i < segs; i++) {
      c.beginPath();
      c.ellipse(cx, 0, a - 3, b - 3, 0, i / segs * Math.PI * 2, (i + 1) / segs * Math.PI * 2);
      c.ellipse(cx, 0, a - 13, b - 13, 0, (i + 1) / segs * Math.PI * 2, i / segs * Math.PI * 2, true);
      c.closePath();
      c.fillStyle = i % 2 ? team : shade(team, 0.35);
      c.fill();
    }
    ell(a - 13, b - 13, '#6FB04F');
    const pw = (a - 16) * 1.3, ph = (b - 16) * 1.3, px = cx - pw / 2, py = -ph / 2;
    for (let i = 0; i < 10; i++) if (i % 2) k.rect(px, py + i * ph / 10, pw, ph / 10, 0, '#7DBB5C');
    k.rect(px, py, pw, ph, 0, null, '#FFFFFF', 0.6);
    k.lines([[px, 0, px + pw, 0]], '#FFFFFF', 0.6);
    c.beginPath(); c.arc(cx, 0, pw * 0.18, 0, Math.PI * 2); c.strokeStyle = '#FFFFFF'; c.lineWidth = 0.6; c.stroke();
    for (const s of [-1, 1]) k.rect(cx - pw * 0.25, s < 0 ? py : py + ph - ph * 0.12, pw * 0.5, ph * 0.12, 0, null, '#FFFFFF', 0.5);
    for (const [x, y] of [[bx + 4, by + 4], [bx + bw - 4, by + 4], [bx + 4, by + bh - 4], [bx + bw - 4, by + bh - 4]]) {
      k.dot(x, y, 2.2, '#5B6168');
      k.rect(x - 1.6, y - 1.6, 3.2, 3.2, 0.5, '#F4F1E2', '#5B6168', 0.4);
    }
  },
  // Hospital: a white main block with two wings, a red cross on the roof, a helipad, an ambulance bay under a canopy, trees round the lawn
  hospital(k, v, H, W, { body }) {
    const [bx, by, bw, bh] = body, fx = bx + bw, col = '#F2F4F5';
    k.rect(-H, -W, 2 * H, 2 * W, 4, LAWN);
    k.rect(fx, -W + 4, H - fx - 1, 2 * W - 8, 1, PAVE);
    parking(k, fx + 3, H - 2, -W + 5, -10);
    const wing = bh * 0.3;
    flat(k, [bx, by, bw, wing], col);
    flat(k, [bx, by + bh - wing, bw, wing], col);
    flat(k, [bx + bw * 0.2, by + wing - 2, bw * 0.6, bh - 2 * wing + 4], shade(col, -0.04));
    const cx = bx + bw / 2;
    k.rect(cx - 2, -7, 4, 14, 0.4, '#E5484D');
    k.rect(cx - 7, -2, 14, 4, 0.4, '#E5484D');
    const hx = bx + bw / 2, hy = by + wing / 2;
    k.dot(hx, hy, Math.min(7, wing / 2 - 1), '#7E8A96');
    k.lines([[hx - 1.8, hy - 2.4, hx - 1.8, hy + 2.4], [hx + 1.8, hy - 2.4, hx + 1.8, hy + 2.4], [hx - 1.8, hy, hx + 1.8, hy]], '#FFFFFF', 0.9);
    for (let i = 0; i < 3; i++) ac(k, bx + 3 + i * 6, by + bh - wing + 3);
    k.rect(fx - 1, 6, 8, 14, 1, '#FFFFFF', '#E5484D', 0.8);
    k.rect(fx + 1.5, 9, 3.2, 7, 1, '#F7F7F5', '#9A9A96', 0.4);
    k.rect(fx + 2.6, 12, 1, 1.6, 0.2, '#E5484D');
    trees(k, [[-H + 3, -W + 3], [-H + 3, W - 3], [-H + 3, 0], [H - 3, W - 3], [H - 3, W - 9]], 2.2);
  },
};

// Lit windows at night for these models: patches of the body's edge, a mall's glowing atrium and front, floodlights on match nights
export function extraNight(art: string, warm: (x: number, y: number, w: number, h: number, a?: number) => void, r: () => number, H: number, W: number, look: Look): void {
  const [bx, by, bw, bh] = look.body, fx = bx + bw;
  if (art === 'stadium') {
    for (const [x, y] of [[bx + 4, by + 4], [bx + bw - 4, by + 4], [bx + 4, by + bh - 4], [bx + bw - 4, by + bh - 4]]) warm(x - 2.5, y - 2.5, 5, 5, 1);
    return;
  }
  if (art === 'terminal') { for (let y = -W + 8; y < W - 4; y += 18) warm(H - 13, y, 2, 2); return; }
  for (let x = bx + 1; x < fx - 2.5; x += 3) for (const y of [by + 0.6, by + bh - 2.4]) if (r() < 0.45) warm(x, y, 2.4, 1.8, 0.9);
  for (let y = by + 3; y < by + bh - 3; y += 3) for (const x of [bx + 0.6, fx - 2.4]) if (r() < 0.45) warm(x, y, 1.8, 2.4, 0.9);
  if (art === 'shop2' || art === 'shop3' || art === 'plaza') warm(fx, by + 2, 2.4, bh - 4, 0.7);
  if (art === 'hospital') warm(fx - 1, 6, 8, 14, 0.5);
}
