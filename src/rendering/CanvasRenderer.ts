import type { Vec } from '../util/geom.ts';
import { WORLD, inWater } from '../world/MapGenerator.ts';
import { BIOMES, PURPOSES, TIERS, ZONES } from '../core/config.ts';
import type { Mountain } from '../world/MapGenerator.ts';
import { ROAD_W, NODE_R, CAR_W, LANE_W, lightGroup, roadWidth } from '../network/RoadGraph.ts';
import type { Edge, Node, RoadType } from '../network/RoadGraph.ts';
import type { Building } from '../entities/Building.ts';
import type { Game, PathPlan, PathSeg } from '../core/Game.ts';
import { fmtMoney } from '../core/Game.ts';

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
const BRAKE_ON = '#FF2A2A';
const BRAKE_OFF = '#8C2A2A';
const AMBER = '#FFB020';

export class CanvasRenderer {
  cam: { x: number; y: number; zoom: number };
  private ctx: CanvasRenderingContext2D;
  // Land colour of the current biome, for the roundabout islands
  private land = BIOMES.temperate.land;

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
    // a page loaded hidden has a 0x0 viewport: Infinity - Infinity would turn the camera into NaN for good
    if (!innerWidth || !innerHeight) return;
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
    // the viewport can change without a resize event (a page loaded hidden at 0x0, then shown)
    if (this.canvas.width !== Math.round(innerWidth * dpr) || this.canvas.height !== Math.round(innerHeight * dpr)) this.resize();
    const z = this.cam.zoom;

    // Background: flat land (in screen coordinates)
    const biome = BIOMES[game.terrain.biome];
    this.land = biome.land;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = biome.land;
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
      const col = biome.patch[p.kind === 'sand' ? 0 : 1];
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
      for (const [s, col] of [[1, biome.bands[0]], [0.78, biome.bands[1]], [0.5, biome.bands[2]]] as const) {
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
      this.circle(t.x, t.y, r, biome.tree);
      ctx.strokeStyle = biome.treeOut;
      ctx.lineWidth = 1;
      ctx.stroke();
    });

    const edges = game.graph.edges;
    const nodes = game.graph.nodes;
    const ground = edges.filter((e) => !e.tunnel && e.level === 0);
    // A node belongs to the level of its edges (doors are ground: only they may mix levels)
    const levelNodes = (L: number): Node[] => nodes.filter((n) => (n.building ? 0 : n.edges[0]?.level ?? 0) === L);
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
    const joints = nodes.filter((n) => n.edges.some((e) => !e.tunnel && e.level === 0));
    // Colours per tier; a joint takes the tier of its widest road
    const pass = (key: 'out' | 'fill', extra: number): void => {
      // Bridges keep their blue deck as the outline
      for (const e of ground) if (!(extra && e.bridge)) this.line(e, TIERS[e.type.tier][key], e.width + extra);
      for (const n of joints) {
        const j = jointEdge(n, 0), color = TIERS[j?.type.tier ?? 'street'][key];
        if (n.control === 'roundabout') this.ring(n.x, n.y, NODE_R + 5, color, ROAD_W + extra);
        else this.circle(n.x, n.y, ((j?.width ?? ROAD_W) + extra) / 2, color);
      }
    };
    pass('out', 3);
    pass('fill', 0);

    // Lane markings: centre line / median, lane separators, shoulders, one-way chevrons; driveways stay plain
    for (const e of ground) if (!e.drive) this.markings(e.a, e.b, e.type);

    this.controls(levelNodes(0));
    // Buildings sit on the ground, under the viaducts; cars never enter a footprint (the door is outside it)
    for (const b of game.buildings) this.building(b, game.time);
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
      const W = roadWidth(preview.type), look = TIERS[preview.type.tier];
      const draw = (g: PathSeg, color: string, width: number): void => this.seg(g.a, g.b, color, width);
      // Colored dashed outline: wider so it peeks out behind the gray outline
      ctx.setLineDash([8, 6]);
      for (const g of segs) draw(g, preview.ok ? GREEN : RED, W + 7);
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      for (const g of segs) {
        if (g.tunnel) {
          ctx.setLineDash([6, 6]);
          draw(g, look.out, W + 3);
          ctx.setLineDash([]);
        } else if (g.level >= 1) {
          draw(g, BRIDGE, W + 5);
        } else if (g.bridge) {
          this.bridge(g.a, g.b, terrain, W);
        } else {
          draw(g, look.out, W + 3);
        }
      }
      for (const g of segs) {
        if (g.tunnel) ctx.setLineDash([6, 6]);
        draw(g, look.fill, W);
        ctx.setLineDash([]);
      }
      for (const g of segs) if (g.level >= 1) this.rails(g.a, g.b, W);
      for (const g of segs) if (!g.tunnel) this.markings(g.a, g.b, preview.type);
      ctx.globalAlpha = 1;

      let label = preview.reason;
      if (preview.ok && preview.net !== undefined) {
        // Bend: price of the new curve minus the old run's price
        const n = Math.round(preview.net);
        label = n > 0 ? fmtMoney(n) : n < 0 ? `+${fmtMoney(-n)} back` : 'free';
      } else if (preview.ok) {
        label = fmtMoney(preview.cost);
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

    // No road access: red badge on the roof, and a label while the cursor is over the building
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of game.buildings) {
      if (b.connected) continue;
      this.circle(b.x, b.y, 6, RED);
      ctx.font = 'bold 9px system-ui';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('!', b.x, b.y + 0.5);
      if (hover && b.contains(hover, 4)) this.text('No road access', b.x, b.y - Math.max(b.w, b.h) / 2 - 10, 'bold 11px system-ui', RED);
    }

    this.offscreenMarkers(game, dpr);
  }

  // Screen-edge markers for buildings without a road outside the view: zone-coloured square, red arrow toward it
  private offscreenMarkers(game: Game, dpr: number): void {
    const ctx = this.ctx;
    // ponytail: fixed insets for the HUD bars (top chips, bottom dock); measure the DOM if the layout changes
    const T = 70, B = 110, X = 24, R = 12;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const b of game.buildings) {
      if (b.connected) continue;
      const s = this.worldToScreen(b);
      if (s.x > X && s.x < innerWidth - X && s.y > T && s.y < innerHeight - B) continue;
      const x = Math.max(X + R, Math.min(innerWidth - X - R, s.x));
      const y = Math.max(T + R, Math.min(innerHeight - B - R, s.y));
      const z = ZONES[b.kind];
      ctx.save();
      ctx.translate(x, y);
      this.circle(0, 0, R + 1, '#FFFFFF');
      this.ring(0, 0, R + 1, RED, 2);
      ctx.beginPath();
      ctx.roundRect(-6, -6, 12, 12, 3);
      ctx.fillStyle = z.fill;
      ctx.fill();
      ctx.strokeStyle = z.out;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.rotate(Math.atan2(s.y - y, s.x - x));
      ctx.beginPath();
      ctx.moveTo(R + 10, 0);
      ctx.lineTo(R + 3, -5);
      ctx.lineTo(R + 3, 5);
      ctx.closePath();
      ctx.fillStyle = RED;
      ctx.fill();
      ctx.restore();
    }
  }

  // Flat rounded footprint with a soft shadow, a roof inset and a zone detail (home ridge, shop awning, office windows,
  // factory sawtooth and chimney); a white door notch on the front. Pending trips are dots on the roof in their purpose colour;
  // a building without a road gets a dashed red outline.
  private building(b: Building, time: number): void {
    const ctx = this.ctx, z = ZONES[b.kind], h = b.h / 2, w = b.w / 2;
    const rect = (x: number, y: number, rw: number, rh: number, r: number, fill: string | null, out: string | null = null, lw = 1) => {
      ctx.beginPath();
      ctx.roundRect(x, y, rw, rh, r);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (out) { ctx.strokeStyle = out; ctx.lineWidth = lw; ctx.stroke(); }
    };
    // local frame: +x toward the door (depth h), y across the front (width w)
    const frame = (dx: number, dy: number) => { ctx.save(); ctx.translate(b.x + dx, b.y + dy); ctx.rotate(b.angle); };
    frame(3, 4);
    rect(-h, -w, 2 * h, 2 * w, 4, 'rgba(0,0,0,.12)');
    ctx.restore();
    frame(0, 0);
    rect(-h, -w, 2 * h, 2 * w, 4, z.fill, z.out, 1.5);
    rect(-h + 3, -w + 3, 2 * h - 6, 2 * w - 6, 2.5, z.roof);
    ctx.strokeStyle = z.out;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (b.kind === 'home') {
      ctx.moveTo(-1, -w + 3); ctx.lineTo(-1, w - 3);
    } else if (b.kind === 'industry') {
      for (let y = -w + 10; y < w - 4; y += 9) { ctx.moveTo(-h + 5, y); ctx.lineTo(h - 5, y + 4); }
    }
    ctx.stroke();
    if (b.kind === 'shop') for (let y = -w + 1; y < w - 1; y += 6) rect(h - 6, y, 5, 3, 0, '#FFFFFF');
    if (b.kind === 'office') for (let x = -h + 7; x < h - 5; x += 7) for (let y = -w + 7; y < w - 5; y += 7) rect(x, y, 3, 3, 0.5, z.out);
    if (b.kind === 'industry') {
      // smoke drifts off the chimney only while the factory has a road (S5: while it has workers)
      if (b.connected) for (let i = 0; i < 3; i++) {
        const t = (time * 0.4 + i / 3) % 1;
        ctx.globalAlpha = 0.5 * (1 - t);
        this.circle(-h + 8 - t * 14, -w + 8 - t * 6, 3 + t * 4, '#D6D6D2');
      }
      ctx.globalAlpha = 1;
      this.circle(-h + 8, -w + 8, 4.5, '#8A8A86');
      ctx.strokeStyle = '#5E5E5A';
      ctx.stroke();
    }
    rect(h - 2, -3.5, 4, 7, 1, '#FFFFFF', z.out);
    b.pending.slice(0, Math.floor((2 * w - 6) / 6)).forEach((t, i) => rect(-h + 4, -w + 4 + i * 6, 4, 4, 1, PURPOSES[t.purpose].color, CAR_OUT, 0.75));
    if (!b.connected) {
      ctx.setLineDash([4, 3]);
      rect(-h - 3, -w - 3, 2 * h + 6, 2 * w + 6, 6, null, RED, 1.5);
      ctx.setLineDash([]);
    }
    ctx.restore();
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
        label(`Remove ${n.control} · +${fmtMoney(game.controlRefund(n))}`, n.x, n.y, RED);
        return;
      }
      const hit = g.nearestEdge(p, ROAD_W, game.level) ?? g.nearestEdge(p, ROAD_W);
      if (!hit) return;
      const e = hit.edge;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.6;
      this.line(e, RED, e.width + 6);
      ctx.globalAlpha = 1;
      this.line(e, TIERS[e.type.tier].fill, e.width);
      label(`Demolish · +${fmtMoney(game.refundOf(e))}`, hit.point.x, hit.point.y, RED);
    } else if (game.tool === 'light' || game.tool === 'roundabout') {
      const n = g.nearestNode(p, NODE_R + 6);
      if (!n) return;
      const kind = game.tool === 'light' ? 'light' : 'roundabout';
      const cost = game.controlPrice(kind) - game.controlRefund(n);
      const reason = n.building || n.edges.length < 3 ? 'Needs an intersection (3+ roads)'
        : n.control !== kind && cost > game.money ? 'Not enough money' : null;
      this.ring(n.x, n.y, NODE_R + 6, reason ? RED : GREEN, 3);
      const place = n.control === kind ? 'Already here' : `${kind === 'light' ? 'Place traffic light' : 'Place roundabout'} · ${fmtMoney(cost)}`;
      label(reason ? '⚠ ' + reason : place, n.x, n.y, reason ? RED : '#2E8B4A');
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

  // Tier centre (two-way: yellow line, green median or double gray line; dirt has none), dashed separators between
  // same-direction lanes, solid shoulder lines (highway), chevrons a->b (one-way)
  private markings(a: Vec, b: Vec, t: RoadType): void {
    const ctx = this.ctx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const tier = TIERS[t.tier], m = t.oneWay ? 0 : tier.median / 2;
    const at = (o: number, f: (p: Vec, q: Vec) => void) => f({ x: a.x - uy * o, y: a.y + ux * o }, { x: b.x - uy * o, y: b.y + ux * o });
    ctx.lineCap = 'butt';
    if (!t.oneWay && tier.line === 'yellow') this.seg(a, b, YELLOW, 1.2);
    else if (!t.oneWay && tier.line === 'median') this.seg(a, b, '#BFD8A0', tier.median - 2);
    else if (!t.oneWay && tier.line === 'double') for (const o of [1.2, -1.2]) at(o, (p, q) => this.seg(p, q, '#A3A39F', 1));
    if (tier.shoulder >= 3) {
      const o = roadWidth(t) / 2 - tier.shoulder;
      for (const s of [o, -o]) at(s, (p, q) => this.seg(p, q, '#C9C9C5', 1));
    }
    const offs: number[] = [];
    for (let k = 1; k < t.lanes; k++) {
      if (t.oneWay) offs.push((k - t.lanes / 2) * LANE_W);
      else offs.push(k * LANE_W + m, -k * LANE_W - m);
    }
    if (offs.length) {
      ctx.setLineDash([6, 6]);
      for (const o of offs) at(o, (p, q) => this.seg(p, q, '#C9C9C5', 1));
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'round';
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
        this.circle(n.x, n.y, NODE_R + 5 - ROAD_W / 2, this.land);
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

    // color null: the tier fill of the joint's widest road
    const joint = (color: string | null, extra: number): void => {
      for (const n of joints) {
        const j = jointEdge(n, level), c = color ?? TIERS[j?.type.tier ?? 'street'].fill;
        if (n.control === 'roundabout') this.ring(n.x, n.y, NODE_R + 5, c, ROAD_W + extra);
        else this.circle(n.x, n.y, ((j?.width ?? ROAD_W) + extra) / 2, c);
      }
    };
    for (const e of edges) this.line(e, BRIDGE, e.width + 5);
    joint(BRIDGE, 5);
    for (const e of edges) this.line(e, TIERS[e.type.tier].fill, e.width);
    for (const e of edges) this.rails(e.a, e.b, e.width);
    // Joints after the railings keep junctions open
    joint(null, 0);
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
      // Cargo box in the purpose colour, darker cab in front
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
        // Purpose stripe and a light bar flashing red / blue
        ctx.fillStyle = car.color;
        ctx.fillRect(-h + 1, -1.5, L - 7, 3);
        const on = (game.time * 4 | 0) % 2;
        ctx.fillStyle = on ? RED : ACCENT;
        ctx.fillRect(1, y + 0.5, 2, w / 2 - 0.5);
        ctx.fillStyle = on ? ACCENT : RED;
        ctx.fillRect(1, 0, 2, w / 2 - 0.5);
      }
    }
    // Tail lights (one on a moto), bright while braking; indicator blinks on game time so pause freezes it
    ctx.fillStyle = car.brake ? BRAKE_ON : BRAKE_OFF;
    if (k === 'moto') ctx.fillRect(-h - 0.5, -0.75, 1.5, 1.5);
    else { ctx.fillRect(-h - 0.5, y + 0.5, 1.5, 1.5); ctx.fillRect(-h - 0.5, -y - 2, 1.5, 1.5); }
    if (car.blink && (game.time * 3 | 0) % 2) {
      const sy = car.blink > 0 ? -y - 1.5 : y - 0.5;
      ctx.fillStyle = AMBER;
      ctx.fillRect(-h - 1, sy, 2, 2);
      ctx.fillRect(h - 1, sy, 2, 2);
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

// Joint disc: the widest non-tunnel road of that level meeting at the node sets its width and tier colour
function jointEdge(n: Node, level: number): Edge | null {
  return n.edges.reduce<Edge | null>((w, e) => (!e.tunnel && e.level === level && e.width > (w?.width ?? 0) ? e : w), null);
}

// Darkens a #RRGGBB color by the given factor
function darken(hex: string, k: number): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = (s: number): number => Math.round(((v >> s) & 255) * (1 - k));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
