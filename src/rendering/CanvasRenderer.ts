import type { Vec } from '../util/geom.ts';
import { WORLD, inWater } from '../world/MapGenerator.ts';
import type { Mountain } from '../world/MapGenerator.ts';
import { ROAD_W, NODE_R, CAR_LEN, CAR_W, TILE, lightGroup } from '../network/RoadGraph.ts';
import type { Edge, Node } from '../network/RoadGraph.ts';
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
  }

  screenToWorld(sx: number, sy: number): Vec {
    const z = this.cam.zoom;
    return { x: (sx - innerWidth / 2) / z + this.cam.x, y: (sy - innerHeight / 2) / z + this.cam.y };
  }

  pan(dxScreen: number, dyScreen: number): void {
    this.cam.x -= dxScreen / this.cam.zoom;
    this.cam.y -= dyScreen / this.cam.zoom;
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    // Keeps the world point under the cursor fixed
    const before = this.screenToWorld(sx, sy);
    this.cam.zoom = Math.max(0.3, Math.min(3, this.cam.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
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
      if (!inner(e.a)) this.portal(e.a, e.b);
      if (!inner(e.b)) this.portal(e.b, e.a);
    }

    // Bridges: pillars, deck, cross ticks and railings (white fill comes later)
    for (const e of ground) if (e.bridge) this.bridge(e.a, e.b, terrain);

    // A single white ribbon: full outline pass, then fill pass
    const joints = nodes.filter((n) => !n.city && n.edges.some((e) => !e.tunnel && e.level === 0));
    const pass = (color: string, extra: number): void => {
      // Bridges keep their blue deck as the outline
      for (const e of ground) if (!(extra && e.bridge)) this.line(e, color, ROAD_W + extra);
      for (const n of joints) {
        if (n.control === 'roundabout') this.ring(n.x, n.y, NODE_R + 5, color, ROAD_W + extra);
        else this.circle(n.x, n.y, (ROAD_W + extra) / 2, color);
      }
    };
    pass(ROAD_OUT, 3);
    pass(ROAD_FILL, 0);

    // Continuous yellow center line
    for (const e of ground) this.line(e, YELLOW, 1.2);

    this.controls(levelNodes(0));
    carsAt(0);

    // Elevated layers, lowest first: each covers the roads and cars below it
    const top = edges.reduce((m, e) => Math.max(m, e.level), 0);
    for (let L = 1; L <= top; L++) {
      const layer = edges.filter((e) => e.level === L);
      if (!layer.length) continue;
      const nodesL = levelNodes(L);
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
      const draw = (g: PathSeg, color: string, width: number): void => this.seg(g.a, g.b, color, width);
      // Colored dashed outline: wider so it peeks out behind the gray outline
      ctx.setLineDash([8, 6]);
      for (const g of segs) draw(g, preview.ok ? GREEN : RED, ROAD_W + 7);
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      for (const g of segs) {
        if (g.tunnel) {
          ctx.setLineDash([6, 6]);
          draw(g, ROAD_OUT, ROAD_W + 3);
          ctx.setLineDash([]);
        } else if (g.level >= 1) {
          draw(g, BRIDGE, ROAD_W + 5);
        } else if (g.bridge) {
          this.bridge(g.a, g.b, terrain);
        } else {
          draw(g, ROAD_OUT, ROAD_W + 3);
        }
      }
      for (const g of segs) {
        if (g.tunnel) ctx.setLineDash([6, 6]);
        draw(g, ROAD_FILL, ROAD_W);
        ctx.setLineDash([]);
      }
      for (const g of segs) if (g.level >= 1) this.rails(g.a, g.b);
      ctx.globalAlpha = 1;

      let label = preview.reason;
      if (preview.ok) {
        label = `${preview.cost.asphalt} asphalt`;
        if (preview.cost.bridges) label += ` +${preview.cost.bridges} bridge${preview.cost.bridges > 1 ? 's' : ''}`;
        if (preview.cost.tunnels) label += ` +${preview.cost.tunnels} tunnel${preview.cost.tunnels > 1 ? 's' : ''}`;
      }
      if (label && game.level > 0) label += ' · L' + game.level;
      const last = preview.points[preview.points.length - 1] ?? segs[segs.length - 1].b;
      if (handle) {
        // Bend handle with dashed guides from the anchor and to the end point
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        const from = anchor ?? handle;
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
      this.line(e, RED, ROAD_W + 6);
      ctx.globalAlpha = 1;
      this.line(e, ROAD_FILL, ROAD_W);
      // floor, matching the refund in Game.demolishAt
      let s = `Demolish · +${Math.floor(e.length / TILE)} asphalt`;
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
    }
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
  private portal(p: Vec, q: Vec): void {
    const ctx = this.ctx;
    const W = ROAD_W + 6;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(q.y - p.y, q.x - p.x));
    ctx.beginPath();
    ctx.roundRect(NODE_R - 3, -W / 2, 6, W, 2);
    ctx.fillStyle = DARK;
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(NODE_R, -(ROAD_W - 2) / 2, 3, ROAD_W - 2, 1.5);
    ctx.fillStyle = '#6E6E6A';
    ctx.fill();
    ctx.restore();
  }

  // Bridge deck from a to b; the caller draws the white road fill on top
  private bridge(a: Vec, b: Vec, terrain: Game['terrain']): void {
    const ctx = this.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const at = (s: number, off: number): Vec => ({ x: a.x + ux * s - uy * off, y: a.y + uy * s + ux * off });
    const half = (ROAD_W + 6) / 2;

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

    this.seg(a, b, BRIDGE, ROAD_W + 6);
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
        const x = n.x + ux * d, y = n.y + uy * d, h = ROAD_W / 2;
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
    ctx.beginPath();
    for (const e of edges) {
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.14)';
    ctx.lineWidth = ROAD_W + 6;
    ctx.stroke();
    ctx.restore();

    const off = ROAD_W / 2 + 2;
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      for (let s = 20; s < len; s += 40) {
        const x = e.a.x + ux * s, y = e.a.y + uy * s;
        this.circle(x - uy * off, y + ux * off, 2.5, PILLAR);
        this.circle(x + uy * off, y - ux * off, 2.5, PILLAR);
      }
    }

    const joint = (color: string, width: number): void => {
      for (const n of joints) {
        if (n.control === 'roundabout') this.ring(n.x, n.y, NODE_R + 5, color, width);
        else this.circle(n.x, n.y, width / 2, color);
      }
    };
    for (const e of edges) this.line(e, BRIDGE, ROAD_W + 5);
    joint(BRIDGE, ROAD_W + 5);
    for (const e of edges) this.line(e, ROAD_FILL, ROAD_W);
    for (const e of edges) this.rails(e.a, e.b);
    // White joints after the railings keep junctions open
    joint(ROAD_FILL, ROAD_W);
    for (const e of edges) this.line(e, YELLOW, 1.2);
  }

  // Viaduct railings on both sides of a to b
  private rails(a: Vec, b: Vec): void {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const o = ROAD_W / 2 + 1;
    const px = (-dy / len) * o, py = (dx / len) * o;
    this.seg({ x: a.x + px, y: a.y + py }, { x: b.x + px, y: b.y + py }, RAIL, 1.2);
    this.seg({ x: a.x - px, y: a.y - py }, { x: b.x - px, y: b.y - py }, RAIL, 1.2);
  }

  private car(game: Game, car: Game['cars'][number]): void {
    const ctx = this.ctx;
    const p = game.graph.lanePos(car.lane, car.s);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.beginPath();
    ctx.roundRect(-CAR_LEN / 2, -CAR_W / 2, CAR_LEN, CAR_W, 2);
    ctx.fillStyle = car.color;
    ctx.fill();
    ctx.strokeStyle = CAR_OUT;
    ctx.lineWidth = 1;
    ctx.stroke();
    // Windshield near the front (+x)
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillRect(CAR_LEN / 2 - 4.5, -CAR_W / 2 + 1, 2.5, CAR_W - 2);
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
    const off = ROAD_W / 2 + 3;
    for (const e of n.edges) {
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
