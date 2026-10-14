import type { Vec } from '../util/geom.ts';
import { WORLD, inWater } from '../world/MapGenerator.ts';
import type { Mountain } from '../world/MapGenerator.ts';
import { ROAD_W, NODE_R, CAR_W, TILE, LANE_W, lightGroup, roadWidth, laneFactor } from '../network/RoadGraph.ts';
import type { Edge, Node, RoadType } from '../network/RoadGraph.ts';
import { CITY_R } from '../entities/City.ts';
import type { Game, PathPlan, PathSeg } from '../core/Game.ts';

const LAND = '#ECEAE4';
const ROAD_OUT = '#9E9E9A';
const ROAD_FILL = '#FFFFFF';
const YELLOW = '#E6C84B';
const BRIDGE = '#6F7F93';
const DARK = '#3A3A3A';
const CAR_OUT = '#2B2B2B';
const GREEN = '#4CC26A';
const RED = '#E5484D';
const RAIL = '#55657A';
const PILLAR = '#8A99AD';
const ACCENT = '#2F6FED';

// Fixed house offsets around a city square (above and to the sides, away from the label below)
const HOUSES: [number, number][] = [
  [-34, -18], [-30, 2], [30, -22], [34, -2], [-14, -36], [14, -38], [-36, 18], [36, 16],
];

export class CanvasRenderer {
  cam: { x: number; y: number; zoom: number };
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not available');
    this.ctx = ctx;
    this.cam = {
      x: WORLD.w / 2,
      y: WORLD.h / 2,
      zoom: Math.min(innerWidth / WORLD.w, innerHeight / WORLD.h) * 0.95,
    };
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.canvas.style.width = innerWidth + 'px';
    this.canvas.style.height = innerHeight + 'px';
    this.clamp();
  }

  // Smallest zoom: the whole world fits on screen (a bit of margin)
  get minZoom(): number {
    return Math.min(innerWidth / WORLD.w, innerHeight / WORLD.h) * 0.9;
  }

  // Keeps the zoom in range and the world on screen (at most MARGIN of empty land past its border)
  private clamp(): void {
    const MARGIN = 120;
    this.cam.zoom = Math.max(this.minZoom, Math.min(3, this.cam.zoom));
    const hw = innerWidth / 2 / this.cam.zoom, hh = innerHeight / 2 / this.cam.zoom;
    const axis = (v: number, size: number, half: number): number =>
      half - MARGIN > size - half + MARGIN ? size / 2 : Math.max(half - MARGIN, Math.min(size - half + MARGIN, v));
    this.cam.x = axis(this.cam.x, WORLD.w, hw);
    this.cam.y = axis(this.cam.y, WORLD.h, hh);
  }

  centerOn(p: Vec): void {
    this.cam.x = p.x;
    this.cam.y = p.y;
    this.cam.zoom = Math.max(this.cam.zoom, 1);
    this.clamp();
  }

  worldToScreen(p: Vec): Vec {
    const z = this.cam.zoom;
    return { x: (p.x - this.cam.x) * z + innerWidth / 2, y: (p.y - this.cam.y) * z + innerHeight / 2 };
  }

  screenToWorld(sx: number, sy: number): Vec {
    const z = this.cam.zoom;
    return { x: (sx - innerWidth / 2) / z + this.cam.x, y: (sy - innerHeight / 2) / z + this.cam.y };
  }

  pan(dxScreen: number, dyScreen: number): void {
    this.cam.x -= dxScreen / this.cam.zoom;
    this.cam.y -= dyScreen / this.cam.zoom;
    this.clamp();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    // Keeps the world point under the cursor fixed
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.max(this.minZoom, Math.min(3, this.cam.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clamp();
  }

  render(game: Game, preview: PathPlan | null, anchor: Vec | null, handle: Vec | null, hover: Vec | null = null): void {
    const ctx = this.ctx;
    const dpr = devicePixelRatio || 1;
    const z = this.cam.zoom;

    // Background: flat land (in screen coordinates)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = LAND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (innerWidth / 2 - this.cam.x * z), dpr * (innerHeight / 2 - this.cam.y * z));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // World border, almost invisible
    ctx.strokeStyle = '#DDDBD4';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, WORLD.w, WORLD.h);

    const terrain = game.terrain;

    // Ground patches: soft, no outline
    for (const p of terrain.patches) {
      const col = p.kind === 'sand' ? '#E6DCC0' : '#D7E3B5';
      this.polyline(p.poly, true);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 24;
      ctx.stroke();
    }

    // Lakes: outer fill (stroked to round it off) + lighter inset
    for (const l of terrain.lakes) {
      this.polyline(l, true);
      ctx.fillStyle = '#A9C1EC';
      ctx.fill();
      ctx.strokeStyle = '#A9C1EC';
      ctx.lineWidth = 12;
      ctx.stroke();
      this.polyline(l, true);
      ctx.fillStyle = '#BFD3F3';
      ctx.fill();
    }

    // Mountains: soft shadow + contour-line bands
    for (const m of game.terrain.mountains) {
      ctx.save();
      ctx.translate(6, 7);
      this.mountainPoly(m, 1);
      ctx.fillStyle = 'rgba(0,0,0,.10)';
      ctx.fill();
      ctx.restore();
      for (const [s, col] of [[1, '#8C8C88'], [0.78, '#6E6E6A'], [0.5, '#5B5B58']] as const) {
        this.mountainPoly(m, s);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 10;
        ctx.stroke();
      }
    }

    // Rivers: two flat strokes, no hard outline
    for (const r of game.terrain.rivers) {
      this.polyline(r.points);
      ctx.strokeStyle = '#A9C1EC';
      ctx.lineWidth = r.width;
      ctx.stroke();
      ctx.strokeStyle = '#BFD3F3';
      ctx.lineWidth = Math.max(8, r.width - 12);
      ctx.stroke();
    }

    // Trees, under the roads; size varies by index
    terrain.trees.forEach((t, i) => {
      const r = 4 + (i % 3) * 0.5;
      this.circle(t.x + 1, t.y + 1, r, 'rgba(0,0,0,.08)');
      this.circle(t.x, t.y, r, '#7FAE5A');
      ctx.strokeStyle = '#5E8A42';
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    const edges = game.graph.edges;
    const nodes = game.graph.nodes;
    const ground = edges.filter((e) => !e.tunnel && e.level === 0);
    // A non-city node belongs to the level of its edges (only cities mix levels)
    const levelNodes = (L: number): Node[] => nodes.filter((n) => !n.city && (n.edges[0]?.level ?? 0) === L);
    const carsAt = (L: number): void => {
      for (const car of game.cars) if (car.lane.edge.level === L) this.car(game, car);
    };

    // Tunnels: body hidden under the mountain, faint dashed trace + big portals
    for (const e of edges) {
      if (!e.tunnel) continue;
      ctx.setLineDash([6, 6]);
      ctx.globalAlpha = 0.5;
      this.line(e, ROAD_FILL, 2);
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      // portals only where the tunnel run ends, not at the joints inside a curved tunnel
      const inner = (n: Node): boolean => n.edges.length === 2 && n.edges.every((x) => x.tunnel);
      if (!inner(e.a)) this.portal(e.a, e.b, e.width);
      if (!inner(e.b)) this.portal(e.b, e.a, e.width);
    }

    // Selected run (Edit tool): soft accent halo under the road of its level
    const halo = (L: number): void => {
      if (!game.selected) return;
      ctx.globalAlpha = 0.35;
      this.runPath(game.selected.filter(e => e.level === L), ACCENT);
      ctx.globalAlpha = 1;
    };
    halo(0);

    // Bridges: pillars, deck, cross ticks and railings (white fill comes later)
    for (const e of ground) if (e.bridge) this.bridge(e.a, e.b, terrain, e.width);

    // A single white ribbon: full outline pass, then fill pass
    const joints = nodes.filter((n) => !n.city && n.edges.some((e) => !e.tunnel && e.level === 0));
    const pass = (color: string, extra: number): void => {
      // Bridges keep their blue deck as the outline
      for (const e of ground) if (!(extra && e.bridge)) this.line(e, color, e.width + extra);
      for (const n of joints) {
        if (n.control === 'roundabout') this.ring(n.x, n.y, NODE_R + 5, color, ROAD_W + extra);
        else this.circle(n.x, n.y, (jointW(n, 0) + extra) / 2, color);
      }
    };
    pass(ROAD_OUT, 3);
    pass(ROAD_FILL, 0);

    // Lane markings: yellow centre line, lane separators, one-way chevrons
    for (const e of ground) this.markings(e.a, e.b, e.type);

    this.controls(levelNodes(0));
    carsAt(0);

    // Elevated layers, lowest first: each covers the roads and cars below it
    const top = edges.reduce((m, e) => Math.max(m, e.level), 0);
    for (let L = 1; L <= top; L++) {
      const layer = edges.filter((e) => e.level === L);
      if (!layer.length) continue;
      const nodesL = levelNodes(L);
      halo(L);
      this.viaduct(L, layer, nodesL);
      this.controls(nodesL);
      carsAt(L);
    }

    // Cities: small houses, then the flat rounded block
    game.cities.forEach((c, ci) => {
      const n = 3 + (ci % 3);
      for (let k = 0; k < n; k++) {
        const [ox, oy] = HOUSES[(ci * 3 + k) % HOUSES.length];
        ctx.beginPath();
        ctx.roundRect(c.x + ox - 5, c.y + oy - 4, 10, 8, 2);
        ctx.fillStyle = lighten(c.color, 0.45);
        ctx.fill();
        ctx.strokeStyle = darken(c.color, 0.25);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
    for (const c of game.cities) {
      const R = CITY_R;
      ctx.beginPath();
      ctx.roundRect(c.x - R + 4, c.y - R + 5, 2 * R, 2 * R, 7);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(c.x - R, c.y - R, 2 * R, 2 * R, 7);
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.strokeStyle = darken(c.color, 0.25);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(c.x - R + 5, c.y - R + 5, R - 7, R - 7, 3);
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fill();

      // Pending trips: small squares in the destination color
      c.pending.forEach((d, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 6;
        const px = c.x + Math.cos(a) * (R + 12);
        const py = c.y + Math.sin(a) * (R + 12);
        ctx.beginPath();
        ctx.roundRect(px - 3.5, py - 3.5, 7, 7, 2);
        ctx.fillStyle = d.color;
        ctx.fill();
        ctx.strokeStyle = CAR_OUT;
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      if (c.overcrowd > 0) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, R + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.overcrowd);
        ctx.strokeStyle = RED;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }

    // Tutorial targets: pulsing accent ring + static outer ring
    if (game.tutorialActive && game.tutorialTargets.length) {
      const r = 30 + 4 * Math.sin(performance.now() / 250);
      for (const t of game.tutorialTargets) {
        ctx.globalAlpha = 0.9;
        this.ring(t.x, t.y, r, ACCENT, 3);
        ctx.globalAlpha = 0.35;
        this.ring(t.x, t.y, 40, ACCENT, 1.5);
      }
      ctx.globalAlpha = 1;
    }

    // Build preview: polyline of segments
    if (preview && preview.segs.length) {
      const segs = preview.segs;
      const W = roadWidth(preview.type);
      const draw = (g: PathSeg, color: string, width: number): void => this.seg(g.a, g.b, color, width);
      // Colored dashed outline: wider so it peeks out behind the gray outline
      ctx.setLineDash([8, 6]);
      for (const g of segs) draw(g, preview.ok ? GREEN : RED, W + 7);
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      for (const g of segs) {
        if (g.tunnel) {
          ctx.setLineDash([6, 6]);
          draw(g, ROAD_OUT, W + 3);
          ctx.setLineDash([]);
        } else if (g.level >= 1) {
          draw(g, BRIDGE, W + 5);
        } else if (g.bridge) {
          this.bridge(g.a, g.b, terrain, W);
        } else {
          draw(g, ROAD_OUT, W + 3);
        }
      }
      for (const g of segs) {
        if (g.tunnel) ctx.setLineDash([6, 6]);
        draw(g, ROAD_FILL, W);
        ctx.setLineDash([]);
      }
      for (const g of segs) if (g.level >= 1) this.rails(g.a, g.b, W);
      for (const g of segs) if (!g.tunnel) this.markings(g.a, g.b, preview.type);
      ctx.globalAlpha = 1;

      let label = preview.reason;
      if (preview.ok && preview.net !== undefined) {
        // Bend: price of the new curve minus the refund of the old run
        const n = preview.net;
        label = n > 0 ? `${n} asphalt` : n < 0 ? `+${-n} asphalt back` : 'free';
      } else if (preview.ok) {
        label = `${preview.cost.asphalt} asphalt`;
        if (preview.cost.bridges) label += ` +${preview.cost.bridges} bridge${preview.cost.bridges > 1 ? 's' : ''}`;
        if (preview.cost.tunnels) label += ` +${preview.cost.tunnels} tunnel${preview.cost.tunnels > 1 ? 's' : ''}`;
      }
      if (label && preview.level > 0) label += ' · L' + preview.level;
      const last = preview.points[preview.points.length - 1] ?? segs[segs.length - 1].b;
      if (handle) {
        // Bend handle with dashed guides from the anchor (or the bent run's start) and to the end point
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        const from = anchor ?? preview.points[0] ?? handle;
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(handle.x, handle.y);
        ctx.lineTo(last.x, last.y);
        ctx.strokeStyle = DARK;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      if (label) this.text(label, last.x + 14, last.y - 10, 'bold 12px system-ui', preview.ok ? '#2E8B4A' : RED);
    }
    if (handle) this.circle(handle.x, handle.y, 5, DARK);
    if (anchor) {
      this.circle(anchor.x, anchor.y, 7, ROAD_FILL);
      ctx.strokeStyle = DARK;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (hover && !preview) this.hoverFx(game, hover);

    // City labels
    ctx.textAlign = 'center';
    for (const c of game.cities) {
      ctx.textBaseline = 'top';
      this.text(c.name, c.x, c.y + CITY_R + 20, 'bold 13px system-ui', DARK);
      if (c.overcrowd > 0) {
        ctx.textBaseline = 'bottom';
        this.text('Overcrowded!', c.x, c.y - CITY_R - 20, 'bold 12px system-ui', RED);
      }
    }

    this.offscreenMarkers(game, dpr);
  }

  // Screen-edge markers for overcrowded cities outside the view: arrow in the city colour, red progress ring, name
  private offscreenMarkers(game: Game, dpr: number): void {
    const ctx = this.ctx;
    // ponytail: fixed insets for the HUD bars (top chips, bottom dock); measure the DOM if the layout changes
    const T = 70, B = 110, X = 24, R = 16;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const c of game.cities) {
      if (c.overcrowd <= 0) continue;
      const s = this.worldToScreen(c);
      if (s.x > X && s.x < innerWidth - X && s.y > T && s.y < innerHeight - B) continue;
      const x = Math.max(X + R, Math.min(innerWidth - X - R, s.x));
      const y = Math.max(T + R, Math.min(innerHeight - B - R, s.y));
      const a = Math.atan2(s.y - y, s.x - x);
      ctx.save();
      ctx.translate(x, y);
      // pulsing red ring = overcrowding progress
      ctx.globalAlpha = 0.8 + 0.2 * Math.sin(performance.now() / 150);
      this.circle(0, 0, R + 1, '#FFFFFF');
      ctx.beginPath();
      ctx.arc(0, 0, R + 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * c.overcrowd);
      ctx.strokeStyle = RED;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.roundRect(-8, -8, 16, 16, 4);
      ctx.fillStyle = c.color;
      ctx.fill();
      ctx.strokeStyle = darken(c.color, 0.25);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // arrow head pointing at the city
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(R + 12, 0);
      ctx.lineTo(R + 3, -6);
      ctx.lineTo(R + 3, 6);
      ctx.closePath();
      ctx.fillStyle = RED;
      ctx.fill();
      ctx.restore();
      ctx.textAlign = 'center';
      ctx.textBaseline = y > innerHeight / 2 ? 'bottom' : 'top';
      this.text(c.name, x, y > innerHeight / 2 ? y - R - 4 : y + R + 4, 'bold 11px system-ui', RED);
    }
  }

  // On-map hint for what the current tool would affect under the cursor. Same lookups as Game.demolishAt / placeControl / snap.
  private hoverFx(game: Game, p: Vec): void {
    const ctx = this.ctx, g = game.graph;
    const label = (s: string, x: number, y: number, color: string) => {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      this.text(s, x + 14, y - 10, 'bold 12px system-ui', color);
    };
    if (game.tool === 'demolish') {
      const n = g.nearestNode(p, NODE_R + 4);
      if (n && n.control !== 'none') {
        this.ring(n.x, n.y, NODE_R + 6, RED, 3);
        label(n.control === 'light' ? 'Remove light · +1 light' : 'Remove roundabout · +1 roundabout', n.x, n.y, RED);
        return;
      }
      const hit = g.nearestEdge(p, ROAD_W, game.level) ?? g.nearestEdge(p, ROAD_W);
      if (!hit) return;
      const e = hit.edge;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.6;
      this.line(e, RED, e.width + 6);
      ctx.globalAlpha = 1;
      this.line(e, ROAD_FILL, e.width);
      // floor, matching the refund in Game.demolishAt
      let s = `Demolish · +${Math.floor((e.length / TILE) * laneFactor(e.type))} asphalt`;
      if (e.refund.bridges) s += ` +${e.refund.bridges} bridge`;
      if (e.refund.tunnels) s += ` +${e.refund.tunnels} tunnel`;
      label(s, hit.point.x, hit.point.y, RED);
    } else if (game.tool === 'light' || game.tool === 'roundabout') {
      const n = g.nearestNode(p, NODE_R + 6);
      if (!n) return;
      const kind = game.tool === 'light' ? 'light' : 'roundabout';
      const stock = game.inventory[kind === 'light' ? 'lights' : 'roundabouts'];
      const reason = n.city || n.edges.length < 3 ? 'Needs an intersection (3+ roads)'
        : stock <= 0 && n.control !== kind ? `No ${kind === 'light' ? 'traffic lights' : 'roundabouts'} left` : null;
      this.ring(n.x, n.y, NODE_R + 6, reason ? RED : GREEN, 3);
      label(reason ? '⚠ ' + reason : kind === 'light' ? 'Place traffic light' : 'Place roundabout', n.x, n.y, reason ? RED : '#2E8B4A');
    } else if (game.tool === 'road') {
      const n = g.nearestNode(p, NODE_R + 4, game.level);
      const pt = n ?? g.nearestEdge(p, ROAD_W, game.level)?.point;
      if (!pt) return;
      this.ring(pt.x, pt.y, NODE_R, ROAD_OUT, 2);
      label('Start here', pt.x, pt.y, DARK);
    } else if (game.tool === 'edit') {
      const run = game.runAt(p);
      if (!run) return;
      ctx.globalAlpha = 0.25;
      this.runPath(run, ACCENT);
      ctx.globalAlpha = 1;
      label('Click to edit · drag to bend', p.x, p.y, ACCENT);
    }
  }

  // Centre line (two-way), dashed separators between same-direction lanes, chevrons a->b (one-way)
  private markings(a: Vec, b: Vec, t: RoadType): void {
    const ctx = this.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    if (!t.oneWay) this.seg(a, b, YELLOW, 1.2);
    const offs: number[] = [];
    for (let k = 1; k < t.lanes; k++) {
      if (t.oneWay) offs.push((k - t.lanes / 2) * LANE_W);
      else offs.push(k * LANE_W, -k * LANE_W);
    }
    if (offs.length) {
      ctx.setLineDash([6, 6]);
      ctx.lineCap = 'butt';
      for (const o of offs) this.seg({ x: a.x - uy * o, y: a.y + ux * o }, { x: b.x - uy * o, y: b.y + ux * o }, '#C9C9C5', 1);
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
    }
    if (!t.oneWay) return;
    ctx.beginPath();
    for (let s = Math.min(20, len / 2); s < len; s += 40) {
      const x = a.x + ux * s, y = a.y + uy * s;
      ctx.moveTo(x - ux * 3 - uy * 3, y - uy * 3 + ux * 3);
      ctx.lineTo(x + ux * 2, y + uy * 2);
      ctx.lineTo(x - ux * 3 + uy * 3, y - uy * 3 - ux * 3);
    }
    ctx.strokeStyle = ROAD_OUT;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  private polyline(pts: Vec[], close = false): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
  }

  // Mountain polygon scaled around its center
  private mountainPoly(m: Mountain, s: number): void {
    this.polyline(m.poly.map((p) => ({ x: m.x + (p.x - m.x) * s, y: m.y + (p.y - m.y) * s })), true);
  }

  // Tunnel portal at p, facing q: dark rounded block with a lighter inner arch
  private portal(p: Vec, q: Vec, w: number): void {
    const ctx = this.ctx;
    const W = w + 6;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(q.y - p.y, q.x - p.x));
    ctx.beginPath();
    ctx.roundRect(NODE_R - 3, -W / 2, 6, W, 2);
    ctx.fillStyle = DARK;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(NODE_R, -(w - 2) / 2, 3, w - 2, 1.5);
    ctx.fillStyle = '#6E6E6A';
    ctx.fill();
    ctx.restore();
  }

  // Bridge deck from a to b; the caller draws the white road fill on top
  private bridge(a: Vec, b: Vec, terrain: Game['terrain'], w: number): void {
    const ctx = this.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const at = (s: number, off: number): Vec => ({ x: a.x + ux * s - uy * off, y: a.y + uy * s + ux * off });
    const half = (w + 6) / 2;

    // Pillars: 2-3 evenly spaced over the wet stretch, peeking out on both sides
    let s0 = -1, s1 = -1;
    for (let s = 0; s <= len; s += 4) {
      if (!inWater(terrain, at(s, 0))) continue;
      if (s0 < 0) s0 = s;
      s1 = s;
    }
    if (s0 >= 0) {
      const n = s1 - s0 > 60 ? 3 : 2;
      for (let i = 1; i <= n; i++) {
        const s = s0 + ((s1 - s0) * i) / (n + 1);
        for (const off of [half, -half]) {
          const p = at(s, off);
          this.circle(p.x, p.y, 3, PILLAR);
        }
      }
    }

    this.seg(a, b, BRIDGE, w + 6);
    ctx.beginPath();
    for (let s = 6; s < len; s += 12) {
      const p = at(s, half), q = at(s, -half);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.strokeStyle = RAIL;
    ctx.lineWidth = 1;
    ctx.stroke();
    const rail = half - 1.5;
    this.seg(at(0, rail), at(len, rail), RAIL, 1.5);
    this.seg(at(0, -rail), at(len, -rail), RAIL, 1.5);
  }

  // Intersection markings (stop lines), roundabout islands and traffic lights
  private controls(nodes: Node[]): void {
    const ctx = this.ctx;
    for (const n of nodes) {
      if (n.control === 'roundabout') {
        // Central island in the land color
        this.circle(n.x, n.y, NODE_R + 5 - ROAD_W / 2, LAND);
        ctx.strokeStyle = ROAD_OUT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (n.edges.length < 3) continue;
      // ponytail: on roundabouts the line goes outside the ring (at NODE_R+4 it would fall inside it)
      const d = n.control === 'roundabout' ? NODE_R + 5 + ROAD_W / 2 + 2 : NODE_R + 4;
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = '#B4B4B0';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (const e of n.edges) {
        const [ux, uy] = this.dir(n, e);
        const x = n.x + ux * d, y = n.y + uy * d, h = e.width / 2;
        ctx.moveTo(x - uy * h, y + ux * h);
        ctx.lineTo(x + uy * h, y - ux * h);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      if (n.control === 'light') this.drawLights(n);
    }
  }

  // One elevated layer: ground shadow, pillars, blue-grey deck, white body, railings, centre line
  private viaduct(level: number, edges: Edge[], joints: Node[]): void {
    const ctx = this.ctx;
    // One path so overlapping shadows do not darken each other
    ctx.save();
    ctx.translate(level * 1.2, level * 1.8);
    // ponytail: one path per width; shadows of different widths overlapping darken slightly
    for (const w of new Set(edges.map((e) => e.width))) {
      ctx.beginPath();
      for (const e of edges) {
        if (e.width !== w) continue;
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
      }
      ctx.strokeStyle = 'rgba(0,0,0,.14)';
      ctx.lineWidth = w + 6;
      ctx.stroke();
    }
    ctx.restore();

    for (const e of edges) {
      const off = e.width / 2 + 2;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      for (let s = 20; s < len; s += 40) {
        const x = e.a.x + ux * s, y = e.a.y + uy * s;
        this.circle(x - uy * off, y + ux * off, 2.5, PILLAR);
        this.circle(x + uy * off, y - ux * off, 2.5, PILLAR);
      }
    }

    const joint = (color: string, extra: number): void => {
      for (const n of joints) {
        if (n.control === 'roundabout') this.ring(n.x, n.y, NODE_R + 5, color, ROAD_W + extra);
        else this.circle(n.x, n.y, (jointW(n, level) + extra) / 2, color);
      }
    };
    for (const e of edges) this.line(e, BRIDGE, e.width + 5);
    joint(BRIDGE, 5);
    for (const e of edges) this.line(e, ROAD_FILL, e.width);
    for (const e of edges) this.rails(e.a, e.b, e.width);
    // White joints after the railings keep junctions open
    joint(ROAD_FILL, 0);
    for (const e of edges) this.markings(e.a, e.b, e.type);
  }

  // Viaduct railings on both sides of a to b
  private rails(a: Vec, b: Vec, w: number): void {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const o = w / 2 + 1;
    const px = (-dy / len) * o, py = (dx / len) * o;
    this.seg({ x: a.x + px, y: a.y + py }, { x: b.x + px, y: b.y + py }, RAIL, 1.2);
    this.seg({ x: a.x - px, y: a.y - py }, { x: b.x - px, y: b.y - py }, RAIL, 1.2);
  }

  private car(game: Game, car: Game['cars'][number]): void {
    const ctx = this.ctx;
    const p = game.graph.carPos(car);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    const L = car.len, h = L / 2, k = car.kind, w = k === 'moto' ? 4 : CAR_W, y = -w / 2;
    const body = (x: number, len: number, fill: string) => {
      ctx.beginPath();
      ctx.roundRect(x, y, len, w, k === 'moto' ? w / 2 : 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = CAR_OUT;
      ctx.lineWidth = 1;
      ctx.stroke();
    };
    const glass = 'rgba(255,255,255,.6)';
    if (k === 'truck') {
      // Cargo box in the destination colour, darker cab in front
      body(-h, L - 7, car.color);
      body(h - 6, 6, darken(car.color, 0.3));
      ctx.fillStyle = glass;
      ctx.fillRect(h - 2.5, y + 1, 1.5, w - 2);
    } else if (k === 'moto') {
      body(-h, L, car.color);
      // Rider
      ctx.fillStyle = CAR_OUT;
      ctx.beginPath();
      ctx.arc(-1, 0, 2.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      body(-h, L, k === 'ambulance' ? '#FFFFFF' : car.color);
      ctx.fillStyle = glass;
      ctx.fillRect(h - 4.5, y + 1, 2.5, w - 2);
      if (k === 'bus') for (let x = -h + 2; x < h - 7; x += 4) { ctx.fillRect(x, y + 0.5, 2.5, 1.5); ctx.fillRect(x, -y - 2, 2.5, 1.5); }
      if (k === 'ambulance') {
        // Destination stripe and a light bar flashing red / blue
        ctx.fillStyle = car.color;
        ctx.fillRect(-h + 1, -1.5, L - 7, 3);
        const on = (game.time * 4 | 0) % 2;
        ctx.fillStyle = on ? RED : ACCENT;
        ctx.fillRect(1, y + 0.5, 2, w / 2 - 0.5);
        ctx.fillStyle = on ? ACCENT : RED;
        ctx.fillRect(1, 0, 2, w / 2 - 0.5);
      }
    }
    ctx.restore();
  }

  private seg(a: Vec, b: Vec, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // One translucent stroke over a whole run (a per-edge stroke shows overlapping round caps on curves)
  private runPath(run: Edge[], color: string): void {
    if (!run.length) return;
    const ctx = this.ctx;
    ctx.beginPath();
    for (const e of run) { ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(...run.map(e => e.width)) + 8;
    ctx.stroke();
  }

  private line(e: Edge, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private ring(x: number, y: number, r: number, color: string, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // Text with a white halo
  private text(s: string, x: number, y: number, font: string, color: string): void {
    const ctx = this.ctx;
    ctx.font = font;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#FFFFFF';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  // Unit direction from the node toward the other end of the edge
  private dir(n: Node, e: Edge): [number, number] {
    const o = e.a === n ? e.b : e.a;
    const len = Math.hypot(o.x - n.x, o.y - n.y) || 1;
    return [(o.x - n.x) / len, (o.y - n.y) / len];
  }

  private circle(x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // One traffic light per approach, right of the incoming lane: green if its group has the active phase
  private drawLights(n: Node): void {
    const ctx = this.ctx;
    for (const e of n.edges) {
      const off = e.width / 2 + 3;
      const [ux, uy] = this.dir(n, e);
      // Traffic flows toward the node (-u); its right is (uy, -ux)
      const px = n.x + ux * (NODE_R + 6) + uy * off;
      const py = n.y + uy * (NODE_R + 6) - ux * off;
      ctx.beginPath();
      ctx.roundRect(px - 3.5, py - 3.5, 7, 7, 1.5);
      ctx.fillStyle = DARK;
      ctx.fill();
      this.circle(px, py, 1.2, lightGroup(n, e) === n.phase ? GREEN : RED);
    }
  }
}

// Joint disc width: the widest non-tunnel road of that level meeting at the node
function jointW(n: Node, level: number): number {
  return n.edges.reduce((w, e) => (!e.tunnel && e.level === level ? Math.max(w, e.width) : w), 0) || ROAD_W;
}

// Mixes a #RRGGBB color toward white by the given factor
function lighten(hex: string, k: number): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s: number): number => {
    const c = (v >> s) & 255;
    return Math.round(c + (255 - c) * k);
  };
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

// Darkens a #RRGGBB color by the given factor
function darken(hex: string, k: number): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s: number): number => Math.round(((v >> s) & 255) * (1 - k));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
