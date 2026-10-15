// Headless simulation check: builds a fixed network, runs ~300 game seconds and asserts the car invariants.
// Run: npm run simcheck   (= node --experimental-transform-types --no-warnings scripts/simcheck.ts)
// Exits 1 on the first failure. Add one scenario/assertion per behaviour you want to lock in.
import { Game, HOUR, levelPop } from '../src/core/Game.ts';
import { RoadGraph, LIGHT_PERIOD, NODE_R, lightGroup, stopDist } from '../src/network/RoadGraph.ts';
import { LEFT, applyPreset, approachOf, moveOf, planOf, toggleBan } from '../src/network/Junction.ts';
import type { Lane, Node, RoadType } from '../src/network/RoadGraph.ts';
import { buildingAt } from '../src/entities/Building.ts';
import { makeTrip } from '../src/entities/Trip.ts';
import type { Trip } from '../src/entities/Trip.ts';
import { Car, KINDS, MAX_SPEED, TURN_SPEED, sep } from '../src/entities/Car.ts';
import { generateTerrain } from '../src/world/MapGenerator.ts';
import { findPath } from '../src/network/Pathfinder.ts';
import { BIOMES, DEFAULT_CONFIG, DIFFICULTY, LEVELS, TIERS, TUNING } from '../src/core/config.ts';
import type { Biome, GameConfig, Zone } from '../src/core/config.ts';
import { setSeed } from '../src/util/rng.ts';
import { deserialize, serialize } from '../src/core/Save.ts';

declare const process: { exit(code: number): never };

// Every model roll must go through the seeded stream (src/util/rng.ts)
Math.random = () => { throw new Error('Math.random used: route it through random() in src/util/rng.ts'); };

const fail = (msg: string): never => { console.log('SIMCHECK FAIL: ' + msg); process.exit(1); };

// Blank world: no terrain, no starter town, every level unlocked
const SIM: GameConfig = { ...DEFAULT_CONFIG, seed: 'simcheck', size: 'small' };
const blank = (): Game => {
  const w = new Game(SIM);
  setSeed(12345);
  w.terrain = { rivers: [], mountains: [], lakes: [], patches: [], trees: [], biome: 'temperate' };
  w.graph = new RoadGraph();
  w.buildings = [];
  w.tutorialActive = true;
  w.money = 1e6;
  w.cityLevel = LEVELS.length;
  return w;
};
// A building with its door at (x, y); its footprint lies below the door, or above it (up) when a road leaves the door downward
const town = (w: Game, x: number, y: number, kind: Zone = 'home', up = false): Node => w.addBuilding(buildingAt(kind, { x, y }, up ? Math.PI / 2 : -Math.PI / 2)).node;
const trip = (from: Node, to: Node): Trip => makeTrip('commute', from.building!, to.building!);
// Seeded maps: a seed replays its terrain in every biome, another seed changes it, and the biomes differ
{
  const maps = new Set<string>();
  for (const biome of Object.keys(BIOMES) as Biome[]) {
    const map = (seed: string): string => JSON.stringify(generateTerrain({ ...SIM, biome, seed }));
    const a = map('alpha');
    if (a !== map('alpha')) fail(`terrain: seed 'alpha' gave two different ${biome} maps`);
    if (a === map('beta')) fail(`terrain: seeds 'alpha' and 'beta' gave the same ${biome} map`);
    maps.add(a);
  }
  if (maps.size !== Object.keys(BIOMES).length) fail('terrain: two biomes gave the same map');
  const t = generateTerrain({ ...SIM, biome: 'archipelago', size: 'medium' });
  if (t.lakes.length < 4) fail(`terrain: archipelago has only ${t.lakes.length} lakes`);
  // Starter town: 4 homes and the 3 workplaces; on easy a starter street gives every home a driveway, on normal nothing has a road
  for (const difficulty of ['easy', 'normal'] as const) {
    const w = new Game({ ...SIM, difficulty }), homes = w.buildings.filter(b => b.kind === 'home');
    if (homes.length !== 4 || w.buildings.length !== 7) fail(`starter town: ${w.buildings.map(b => b.kind)}`);
    if (homes.some(b => b.connected !== (difficulty === 'easy'))) fail(`starter town: ${difficulty} homes connected ${homes.map(b => b.connected)}`);
  }
}
const game = blank();
const g = game.graph;
const city = (x: number, y: number, kind: Zone = 'home', up = false): Node => town(game, x, y, kind, up);

//   F         A=2-lane=J1(light)---B---J2(plain 3-way)---E
//             |                    |   |
//   C------R(roundabout)-----------+---D
// Homes A C D F, shop B, factory E (freight trucks to B). A busy town: 5x a home's capacity (no growth until S6).
const A = city(200, 300), B = city(1000, 300, 'shop', true), C = city(600, 800), D = city(1400, 800), E = city(1800, 300, 'industry');
const F = city(600, 60, 'home', true);
for (const n of [A, C, D, F]) n.building!.residents = 150;
const J1 = g.addNode(600, 300), R = g.addNode(1000, 800), J2 = g.addNode(1400, 300);
const one: RoadType = { tier: 'avenue', lanes: 1, oneWay: false }, two: RoadType = { tier: 'avenue', lanes: 2, oneWay: false };
const roads: [Node, Node, RoadType][] = [
  [A, J1, two], [J1, B, one], [J1, C, one], [J1, F, one],
  [C, R, one], [R, D, one], [B, R, one], [B, J2, one], [J2, E, one], [J2, D, one],
];
for (const [a, b, type] of roads) {
  const plan = game.planPath([a, b], 0, type);
  if (!plan.ok) fail(`plan ${a.id}->${b.id}: ${plan.reason}`);
  game.commitPath(plan);
}
game.placeControl(J1, 'light');
game.placeControl(R, 'roundabout');
if (J1.control !== 'light' || R.control !== 'roundabout') fail('controls not placed');

// Car invariants: every lane sorted with no overlaps or stale cars, every junction occupant on the graph
const invariants = (w: Game): void => {
  const live = new Set(w.cars), t = w.time.toFixed(2);
  for (const e of w.graph.edges) for (const l of e.lanes) {
    for (let k = 0; k < l.cars.length; k++) {
      const c = l.cars[k];
      if (!live.has(c) || c.lane !== l) fail(`stale car on lane ${e.id} at t=${t}`);
      const n = l.cars[k + 1];
      if (n && n.s < c.s) fail(`lane ${e.id} not sorted at t=${t}`);
      if (!n || n.s - c.s - sep(c, n) >= -1e-6) continue;
      fail(`overlap on lane ${e.id}: gap ${(n.s - c.s - sep(c, n)).toFixed(2)} at t=${t}`);
    }
  }
  for (const n of w.graph.nodes) for (const c of n.occupants) {
    if (!live.has(c) || !c.lane.cars.includes(c)) fail(`node ${n.id} holds a car off the graph at t=${t}`);
  }
};
const DT = 1 / 60, STEPS = 300 * 60;
let maxCars = 0, lo = Infinity, hi = 0;
const kinds = new Set<string>();
// Exit lane per car last tick: it must not switch once inside the turn arc (the drawn arc would jump sideways)
const exits = new Map<Car, [Lane, Lane | null]>();
// Day cycle: hour each commute left the door; when each commuter's car was first seen parked at work
const commutes: number[] = [], parkedAt = new Map<Trip, number>();
for (let i = 0; i < STEPS; i++) {
  try { game.update(DT); } catch (e) { fail(`exception at t=${game.time.toFixed(2)}: ${(e as Error).stack}`); }
  const live = new Set(game.cars);
  for (const c of live) if (c.trip.who && !c.trip.back && c.trip.departed === game.time) commutes.push(game.hour);
  // a commuter's return leg is queued once its shift is over (or at once, after a late arrival)
  for (const b of game.buildings) for (const t of b.parked) {
    if (!t.who) continue;
    if (!parkedAt.has(t)) parkedAt.set(t, game.time);
    if (game.time > Math.max(t.leave, parkedAt.get(t)!) + DT) fail(`day cycle: commuter still at work ${((game.time - t.leave) / HOUR).toFixed(2)}h after its shift`);
  }
  maxCars = Math.max(maxCars, live.size);
  for (const c of live) { const v = c.vmax / (MAX_SPEED * KINDS[c.kind].v); lo = Math.min(lo, v); hi = Math.max(hi, v); kinds.add(c.kind); }
  for (const c of live) {
    const [l, x] = exits.get(c) ?? [null, null];
    if (l === c.lane && x && c.exit && x !== c.exit && x.edge === c.exit.edge && l.edge.length - c.s < 2 * NODE_R) fail(`exit lane switched inside the turn arc at t=${game.time.toFixed(2)}`);
    exits.set(c, [c.lane, c.exit]);
  }
  invariants(game);
}
if (game.score <= 0) fail('no car arrived');
// Commuters leave home in the morning rush, and some reached work and drove home
const rush = commutes.filter(h => h >= TUNING.COMMUTE_MIN && h <= TUNING.COMMUTE_MAX).length;
if (commutes.length < 5 || rush < 0.7 * commutes.length) fail(`day cycle: ${rush} of ${commutes.length} commutes left between 6:00 and 10:00`);
if (!parkedAt.size || !game.reports.some(r => r.purpose === 'commute' && r.back)) fail('day cycle: no commuter reached work and came home');
// Drivers differ: top speeds spread within ±10% (the overlap check above covers their safety)
if (lo < 0.9 || hi > 1.1 || hi - lo < 0.1) fail(`driver top speeds ${lo.toFixed(2)}..${hi.toFixed(2)} x the kind's top speed`);
if (kinds.size !== Object.keys(KINDS).length) fail(`vehicle kinds seen: ${[...kinds]}`);

// Money: a straight 10-tile avenue costs 10 x its tier rate, a same-day demolish gives it all back; built again and demolished
// the next day it refunds REFUND_LATER after day 1's upkeep (paid hourly from START_HOUR); no money, no road
{
  const w = blank(), m0 = w.money, a = { x: 100, y: 500 }, b = { x: 500, y: 500 }, mid = { x: 300, y: 500 };
  const plan = w.planPath([a, b], 0, { tier: 'avenue', lanes: 1, oneWay: false });
  if (!plan.ok || plan.cost !== 10 * TIERS.avenue.cost) fail(`money: 10-tile road priced ${plan.cost}`);
  w.commitPath(plan);
  if (w.money !== m0 - plan.cost) fail(`money: building left ${w.money}, expected ${m0 - plan.cost}`);
  w.demolishAt(mid);
  if (w.graph.edges.length || w.money !== m0) fail(`money: same-day demolish left ${w.money}, expected ${m0}`);
  w.commitPath(w.planPath([a, b], 0, { tier: 'avenue', lanes: 1, oneWay: false }));
  w.time = (24 - TUNING.START_HOUR) * HOUR - DT / 2; // just before the first midnight
  w.update(DT);
  const upkeep = plan.cost * TUNING.UPKEEP_RATE * (24 - TUNING.START_HOUR) / 24;
  if (Math.abs(w.ledger.yesterday.upkeep - upkeep) > 1e-6) fail(`money: upkeep ${w.ledger.yesterday.upkeep}, expected ${upkeep}`);
  w.demolishAt(mid);
  const left = m0 - plan.cost - upkeep + plan.cost * TUNING.REFUND_LATER;
  if (Math.abs(w.money - left) > 1e-6) fail(`money: next-day demolish left ${w.money}, expected ${left}`);
  w.money = plan.cost - 1;
  if (w.planPath([a, b], 0, { tier: 'avenue', lanes: 1, oneWay: false }).reason !== 'Not enough money') fail('money: built without the money');
}
// Deadlock: a parked car (not in game.cars, never moves) blocks the start of lane J->Y.
// 'a' waits at J, reroutes via K after REROUTE_S and arrives; 'c' is stuck behind it, gives up and goes home to Z.
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), Z = town(w, 100, 900);
  const J = wg.addNode(500, 500), K = wg.addNode(700, 200);
  for (const [a, b] of [[X, J], [J, Y], [J, K], [K, Y]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const lane = wg.lanesFrom(wg.edgeBetween(J, Y)!, J)[0]!;
  const parked = new Car(lane, trip(Z, Y)), c = new Car(lane, trip(Z, Y));
  parked.s = 40;
  lane.cars.push(c, parked);
  w.cars.push(c);
  w.queueTrip(X.building!, Y.building!, 'commute');
  for (let t = 0; t < 40 * 60; t++) w.update(DT);
  if (w.score !== 1) fail(`deadlock: rerouted car did not arrive (score ${w.score})`);
  if (w.cars.includes(c) || lane.cars.includes(c) || !Z.building!.pending.includes(c.trip)) fail('deadlock: stuck car not sent home');
}
// Lost: a car whose destination has no road at all goes back to its origin's queue instead of vanishing
{
  const w = blank(), flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), J = w.graph.addNode(500, 500);
  w.commitPath(w.planPath([X, J], 0, flat));
  w.demandOff = true;
  const c = new Car(w.graph.lanesFrom(w.graph.edgeBetween(X, J)!, X)[0]!, trip(X, Y));
  c.lane.cars.push(c);
  w.cars.push(c);
  w.update(DT);
  if (w.cars.includes(c) || c.lane.cars.includes(c) || !X.building!.pending.includes(c.trip) || w.score) fail('lost car not sent home');
}
// Demolish: a car on a demolished road goes back to its origin's queue instead of vanishing
{
  const w = blank(), flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500);
  w.commitPath(w.planPath([X, Y], 0, flat));
  w.demandOff = true;
  const e = w.graph.edgeBetween(X, Y)!, c = new Car(w.graph.lanesFrom(e, X)[0]!, trip(X, Y));
  c.s = e.length / 2;
  c.lane.cars.push(c);
  w.cars.push(c);
  w.demolishAt({ x: (X.x + Y.x) / 2, y: X.y });
  if (w.graph.edges.length || w.cars.includes(c) || !X.building!.pending.includes(c.trip)) fail('demolished car not sent home');
}
// U-turn: the road ahead turns one-way against the car, so it turns back at M along a smooth half circle and arrives via K
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), M = wg.addNode(500, 500), K = wg.addNode(500, 200);
  for (const [a, b] of [[X, M], [M, Y], [X, K], [K, Y]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const my = wg.edgeBetween(M, Y)!;
  wg.setEdgeType(my, { tier: 'avenue', lanes: 1, oneWay: true }, my.a === Y);
  const c = new Car(wg.lanesFrom(wg.edgeBetween(X, M)!, X)[0]!, trip(X, Y));
  c.lane.cars.push(c);
  w.cars.push(c);
  let back = false, jump = 0, p = wg.carPos(c);
  for (let t = 0; t < 30 * 60 && w.cars.includes(c); t++) {
    w.update(DT);
    if (c.lane.from === M) back = true;
    const q = wg.carPos(c);
    if (Math.hypot(q.x - M.x, q.y - M.y) < 30) jump = Math.max(jump, Math.hypot(q.x - p.x, q.y - p.y));
    p = q;
  }
  if (w.score !== 1 || !back) fail('u-turn: car did not turn back and arrive');
  if (jump > 3) fail(`u-turn: car jumped ${jump.toFixed(1)}px at the turn`);
}
// Lane by turn: on a 2-lane road (through the inner node M) a car turning right at J keeps right, one turning left keeps left
{
  const w = blank(), wg = w.graph, two: RoadType = { tier: 'avenue', lanes: 2, oneWay: false }, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 900), Z = town(w, 900, 100, 'home', true);
  const M = wg.addNode(300, 500), J = wg.addNode(500, 500);
  for (const [a, b, t] of [[X, M, two], [M, J, two], [J, Y, flat], [J, Z, flat]] as const) w.commitPath(w.planPath([a, b], 0, t));
  w.demandOff = true;
  for (const [dest, side] of [[Y, 1], [Z, 0]] as const) {
    w.queueTrip(X.building!, dest.building!, 'commute');
    const seen = new Set<number>();
    for (let t = 0; t < 10 * 60; t++) {
      w.update(DT);
      const c = w.cars.find(o => o.dest === dest.building);
      if (c && c.lane.to !== Y && c.lane.to !== Z) seen.add(wg.lanesFrom(c.lane.edge, c.lane.from).indexOf(c.lane));
    }
    if (seen.size !== 1 || !seen.has(side)) fail(`lane by turn: car to ${dest.id} used lanes ${[...seen]}`);
  }
}
// Lane change: a car spawned in the left lane of a long 2-lane road moves right mid-edge (clear of both nodes,
// sliding without a jump) before turning right at J, and arrives
{
  const w = blank(), wg = w.graph, two: RoadType = { tier: 'avenue', lanes: 2, oneWay: false }, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 900), Z = town(w, 900, 100, 'home', true), J = wg.addNode(700, 500);
  for (const [a, b, t] of [[X, J, two], [J, Y, flat], [J, Z, flat]] as const) w.commitPath(w.planPath([a, b], 0, t));
  w.demandOff = true;
  const ls = wg.lanesFrom(wg.edgeBetween(X, J)!, X), c = new Car(ls[0]!, trip(X, Y));
  c.lane.cars.push(c);
  w.cars.push(c);
  let at = -1, jump = 0, p = wg.carPos(c);
  for (let t = 0; t < 20 * 60 && w.cars.includes(c); t++) {
    w.update(DT);
    if (at < 0 && c.lane === ls[1]) at = c.s;
    // Lights: right indicator while sliding right and within 60px of the right turn at J, off elsewhere on the edge
    if (c.lane.edge === ls[0]!.edge && c.blink !== (c.lc || c.lane.edge.length - c.s < 60 ? 1 : 0) && Math.abs(c.lane.edge.length - c.s - 60) > 2) fail(`lights: blink ${c.blink} at s=${c.s.toFixed(0)}`);
    const q = wg.carPos(c);
    if (c.lane.edge === ls[0]!.edge) jump = Math.max(jump, Math.hypot(q.x - p.x, q.y - p.y), Math.abs(q.angle - p.angle) * 20);
    p = q;
  }
  if (w.score !== 1 || at < 0) fail(`lane change: car did not move right and arrive (s=${at.toFixed(0)}, score ${w.score})`);
  if (at > ls[0]!.edge.length - 100) fail(`lane change: changed too late, s=${at.toFixed(0)}`);
  if (jump > 3) fail(`lane change: car jumped ${jump.toFixed(1)}px`);
}
// Curve speed: through a plain inner node M a car takes a right-angle corner at TURN_SPEED and a gentle 10 degree joint near full speed,
// drawn along an arc across M (no jump in position or heading)
for (const [yx, yy, lo, hi] of [[500, 900, 0, TURN_SPEED + 1], [900, 570, MAX_SPEED * 0.95, MAX_SPEED]]) {
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), M = wg.addNode(500, 500), Y = town(w, yx!, yy!);
  for (const [a, b] of [[X, M], [M, Y]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const c = new Car(wg.lanesFrom(wg.edgeBetween(X, M)!, X)[0]!, trip(X, Y));
  c.vmax = MAX_SPEED;
  c.lane.cars.push(c);
  w.cars.push(c);
  let v = -1, jump = 0, p = wg.carPos(c);
  for (let t = 0; t < 20 * 60 && w.cars.includes(c); t++) {
    const l = c.lane;
    w.update(DT);
    if (l !== c.lane && l.to === M) v = c.speed;
    const q = wg.carPos(c), da = q.angle - p.angle;
    if (w.cars.includes(c)) jump = Math.max(jump, Math.hypot(q.x - p.x, q.y - p.y), Math.abs(Math.atan2(Math.sin(da), Math.cos(da))) * 20);
    p = q;
  }
  if (w.score !== 1 || v < lo! || v > hi!) fail(`curve speed: crossed a ${yx === 500 ? 'sharp' : 'gentle'} corner at ${v.toFixed(0)} (score ${w.score})`);
  if (jump > 3) fail(`turn arc: car jumped ${jump.toFixed(1)} (px or 20x rad) crossing M`);
}
// Short approach: a fast moto through inner node M onto a 45px edge stops before busy plain J instead of running it
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), Z = town(w, 500, 900);
  const M = wg.addNode(455, 500), J = wg.addNode(500, 500);
  for (const [a, b] of [[X, M], [M, J], [J, Y], [J, Z]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const e = wg.edgeBetween(X, M)!, c = new Car(wg.lanesFrom(e, X)[0]!, trip(X, Y), 'moto');
  c.vmax = c.speed = MAX_SPEED * 1.21;
  c.s = e.length - 150;
  c.lane.cars.push(c);
  w.cars.push(c);
  J.occupants.add(new Car(c.lane, trip(X, Y)));
  for (let t = 0; t < 3 * 60; t++) w.update(DT);
  if (c.lane.from === J || c.granted || c.lane.edge.length - c.s < stopDist(J) - 1) fail(`short approach: moto ran the busy junction (on ${c.lane.from.id}->${c.lane.to.id}, s=${c.s.toFixed(1)})`);
}
// Box release: a bus granted at plain J into an exit with just enough room (fits()) gets far enough to free J
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), Z = town(w, 500, 900), J = wg.addNode(500, 500);
  for (const [a, b] of [[X, J], [J, Y], [J, Z]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const out = wg.lanesFrom(wg.edgeBetween(J, Y)!, J)[0]!, parked = new Car(out, trip(X, Y));
  parked.s = 54 + parked.len / 2;
  out.cars.push(parked);
  const e = wg.edgeBetween(X, J)!, bus = new Car(wg.lanesFrom(e, X)[0]!, trip(X, Y), 'bus');
  bus.s = e.length - 80;
  bus.lane.cars.push(bus);
  w.cars.push(bus);
  for (let t = 0; t < 10 * 60; t++) w.update(DT);
  if (bus.lane !== out || J.occupants.size) fail(`box release: bus at s=${bus.s.toFixed(1)} on ${bus.lane === out ? 'the exit' : 'the approach'}, J holds ${J.occupants.size}`);
}
// Ambulance: runs a red light into an empty junction J; a plain car on the same red waits for green
for (const kind of ['ambulance', 'car'] as const) {
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), Z = town(w, 500, 900), J = wg.addNode(500, 500);
  for (const [a, b] of [[X, J], [J, Y], [J, Z]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  w.placeControl(J, 'light');
  const e = wg.edgeBetween(X, J)!, c = new Car(wg.lanesFrom(e, X)[0]!, trip(X, Y), kind);
  c.s = e.length - 80;
  c.lane.cars.push(c);
  w.cars.push(c);
  J.phase = lightGroup(J, e) ^ 1;
  for (let t = 0; t < (LIGHT_PERIOD - 1) * 60; t++) w.update(DT);
  if (kind === 'car' && !c.brake) fail('lights: brake lights off while held at the red');
  if ((c.lane.from === J) !== (kind === 'ambulance')) fail(`ambulance: ${kind} ${kind === 'ambulance' ? 'held at' : 'ran'} the red light`);
}
// Tiers: a car never beats its top speed x dirt's limit on dirt (it brakes before the avenue -> dirt joint M);
// A* takes a longer highway over a shorter dirt road; highways never connect to a building;
// retyping dirt to street clamps the lanes to the tier and charges the price difference
{
  const w = blank(), wg = w.graph, ave: RoadType = { tier: 'avenue', lanes: 1, oneWay: false }, dirt: RoadType = { tier: 'dirt', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), M = wg.addNode(500, 500), Y = town(w, 900, 500);
  w.commitPath(w.planPath([X, M], 0, ave));
  w.commitPath(w.planPath([M, Y], 0, dirt));
  w.demandOff = true;
  const md = wg.edgeBetween(M, Y)!, c = new Car(wg.lanesFrom(wg.edgeBetween(X, M)!, X)[0]!, trip(X, Y));
  c.vmax = MAX_SPEED * 1.1;
  c.lane.cars.push(c);
  w.cars.push(c);
  let over = -Infinity, fast = 0;
  for (let t = 0; t < 30 * 60 && w.cars.includes(c); t++) {
    w.update(DT);
    if (c.lane.edge === md) over = Math.max(over, c.speed - c.vmax * TIERS.dirt.limit / MAX_SPEED);
    else fast = Math.max(fast, c.speed);
  }
  if (w.score !== 1 || over > 1 || over < -5) fail(`tiers: car on dirt at ${over.toFixed(1)} over its limit (score ${w.score})`);
  if (fast < c.vmax * 0.95) fail(`tiers: car on the avenue only reached ${fast.toFixed(0)}`);

  const hw: RoadType = { tier: 'highway', lanes: 2, oneWay: false };
  const P = wg.addNode(100, 1000), Q = wg.addNode(900, 1000), K = wg.addNode(500, 700);
  w.commitPath(w.planPath([P, Q], 0, dirt));
  w.commitPath(w.planPath([P, K], 0, hw));
  w.commitPath(w.planPath([K, Q], 0, hw));
  const route = findPath(wg, P, Q);
  if (route?.length !== 3 || route[1] !== K) fail(`tiers: A* took ${route?.map(n => n.id)} instead of the highway via ${K.id}`);
  if (w.planPath([X, P], 0, hw).reason !== 'Highways give no building access') fail('tiers: a highway connected to a building');

  const pq = [wg.edgeBetween(P, Q)!], m0 = w.money, d = w.retypeDelta(pq, { tier: 'street', lanes: 3, oneWay: false });
  w.retype(pq, { tier: 'street', lanes: 3, oneWay: false });
  const t = pq[0].type;
  if (t.tier !== 'street' || t.lanes !== 1 || Math.abs(d - 20 * (TIERS.street.cost - TIERS.dirt.cost)) > 1e-6 || Math.abs(w.money - (m0 - d)) > 1e-6) {
    fail(`tiers: dirt -> street gave ${JSON.stringify(t)} for ${d}`);
  }
}
// Buildings: a road through a footprint is refused; a street 40px off a home's and an office's doors gives both a free driveway
// (no price, no upkeep) and a commute between them arrives
{
  const w = blank(), flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  w.demandOff = true;
  const H = town(w, 300, 460), O = town(w, 500, 380, 'office', true);
  const through = w.planPath([{ x: 300, y: 600 }, { x: 300, y: 400 }], 0, flat).reason;
  if (through !== 'Blocked by a building') fail(`buildings: a road through a home was '${through || 'ok'}'`);
  const m0 = w.money, plan = w.planPath([{ x: 100, y: 420 }, { x: 700, y: 420 }], 0, flat);
  w.commitPath(plan);
  const drives = w.graph.edges.filter(e => e.drive);
  if (!H.building!.connected || !O.building!.connected || drives.length !== 2) fail(`buildings: ${drives.length} driveways`);
  if (w.money !== m0 - plan.cost || Math.abs(w.upkeepDay - plan.cost * TUNING.UPKEEP_RATE) > 1e-6) fail(`buildings: driveways cost ${m0 - plan.cost - w.money}`);
  w.queueTrip(H.building!, O.building!, 'commute');
  for (let t = 0; t < 20 * 60; t++) w.update(DT);
  if (w.score !== 1) fail(`buildings: commute over the driveways did not arrive (score ${w.score})`);
}
// Levels: at level 1 an avenue and a roundabout are locked; a home and an office placed from the tray beside a street face it,
// get free driveways and a commute between them arrives; pushing the population past level 2's milestone adds its batch to the
// tray and pays the grant once
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.cityLevel = 1;
  w.tray = { ...LEVELS[0].batch };
  w.demandOff = true;
  if (w.planPath([{ x: 100, y: 500 }, { x: 900, y: 500 }], 0, { tier: 'avenue', lanes: 1, oneWay: false }).ok) fail('levels: avenue built at level 1');
  w.setTool('roundabout');
  if (w.tool === 'roundabout') fail('levels: roundabout tool at level 1');
  w.commitPath(w.planPath([{ x: 100, y: 500 }, { x: 900, y: 500 }], 0, street));
  w.startPlacing('home');
  if (!w.placeBuilding({ x: 300, y: 440 })) fail('levels: home not placed');
  w.startPlacing('office');
  if (!w.placeBuilding({ x: 600, y: 570 })) fail('levels: office not placed');
  const [H, O] = w.buildings;
  if (!H.connected || !O.connected || Math.abs(H.angle - Math.PI / 2) > 1e-9 || Math.abs(O.angle + Math.PI / 2) > 1e-9) fail(`levels: placed ${H.angle} ${O.angle} connected ${H.connected} ${O.connected}`);
  if (w.tray.home !== LEVELS[0].batch.home - 1 || w.tray.office !== LEVELS[0].batch.office - 1) fail(`levels: tray ${JSON.stringify(w.tray)}`);
  if (w.placeBuilding({ x: 300, y: 440 })) fail('levels: placed a building on top of another');
  w.queueTrip(H, O, 'commute');
  for (let t = 0; t < 20 * 60; t++) w.update(DT);
  if (w.score !== 1) fail(`levels: commute from a placed home did not arrive (score ${w.score})`);
  const m0 = w.money;
  H.residents = levelPop(2);
  w.update(DT);
  w.update(DT);
  if (w.cityLevel !== 2 || w.pendingLevel !== 2 || w.tray.home !== LEVELS[0].batch.home - 1 + LEVELS[1].batch.home) fail(`levels: level ${w.cityLevel}, tray ${JSON.stringify(w.tray)}`);
  if (w.money !== m0 + w.levelGrant(2) || !w.tierUnlocked('avenue')) fail(`levels: grant ${w.money - m0}`);
}
// Happiness: an identical home 60px from a staffed factory scores 25+ points under one 600px away.
// Fails: career money below 0 at DEBT_DAYS midnights in a row is bankrupt (the countdown says 1 day before it), city happiness
// under failHappy from day FAIL_FROM_DAY at FAIL_DAYS midnights is 'unhappy'; creative and the tutorial never fail
{
  const w = blank(), F = town(w, 1000, 300, 'industry').building!;
  F.staffed = 1;
  const near = w.addBuilding(buildingAt('home', { x: F.x + 60, y: F.y }, 0)), far = w.addBuilding(buildingAt('home', { x: F.x + 600, y: F.y }, 0));
  const hn = w.rateHome(near), hf = w.rateHome(far);
  if (hf - hn < 25) fail(`happiness: home by the factory ${hn.toFixed(0)}, far one ${hf.toFixed(0)}`);
  const midnight = (g: Game) => { g.time = ((g.today + 1) * 24 - TUNING.START_HOUR) * HOUR - DT / 2; g.update(DT); };
  const d = DIFFICULTY[SIM.difficulty];
  for (const [mode, tut] of [['career', false], ['creative', false], ['career', true]] as const) {
    const g = blank();
    g.cfg = { ...SIM, mode };
    g.tutorialActive = tut;
    g.money = -1;
    for (let i = 1; i < d.debtDays; i++) midnight(g);
    if (!tut && mode === 'career' && (g.gameOver || g.alarm?.kind !== 'bankrupt' || g.alarm.days !== 1)) fail(`fail: alarm ${JSON.stringify(g.alarm)} before bankruptcy`);
    for (let i = 0; i < 3; i++) midnight(g);
    if (g.gameOver !== (mode === 'career' && !tut ? 'bankrupt' : '')) fail(`fail: ${mode}${tut ? ' tutorial' : ''} in debt gave '${g.gameOver}'`);
  }
  const g = blank();
  g.tutorialActive = false;
  g.happiness = d.failHappy - 1;
  if (g.alarm?.kind !== 'unhappy' || g.alarm.days !== TUNING.FAIL_FROM_DAY + TUNING.FAIL_DAYS - 2) fail(`fail: unhappy alarm ${JSON.stringify(g.alarm)} on day 1`);
  while (!g.gameOver && g.day < 10) midnight(g);
  if (g.gameOver !== 'unhappy' || g.day !== TUNING.FAIL_FROM_DAY + TUNING.FAIL_DAYS - 1) fail(`fail: unhappy city gave '${g.gameOver}' on day ${g.day}`);
}
// Junctions. Turn ban: with the left X->J->P banned the Z trip never takes it and arrives round the block via K and Q.
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Z = town(w, 500, 60, 'home', true);
  const J = wg.addNode(500, 500), K = wg.addNode(900, 500), Q = wg.addNode(900, 200), P = wg.addNode(500, 200);
  for (const [a, b] of [[X, J], [J, K], [K, Q], [Q, P], [P, J], [P, Z]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const xj = wg.edgeBetween(X, J)!;
  w.editPlan(J, p => toggleBan(p, approachOf(p, J, xj), LEFT));
  const route = findPath(wg, X, Z);
  if (route?.[1] !== J || route[2] !== K) fail(`turn ban: route ${route?.map(n => n.id)} still turns left at J`);
  w.queueTrip(X.building!, Z.building!, 'commute');
  for (let t = 0; t < 40 * 60 && !w.score; t++) {
    w.update(DT);
    for (const c of w.cars) if (c.prev === X && c.lane.from === J && c.lane.to === P) fail('turn ban: a car took the banned left');
  }
  if (w.score !== 1) fail(`turn ban: the trip did not arrive via the detour (score ${w.score})`);
}
// Protected lefts: under the preset a left-turner at the light is only granted in a phase that protects its left, and arrives
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), N = town(w, 500, 60, 'home', true), S = town(w, 500, 940);
  const J = wg.addNode(500, 500);
  for (const n of [X, Y, N, S]) w.commitPath(w.planPath([n, J], 0, flat));
  w.demandOff = true;
  w.placeControl(J, 'light');
  w.editPlan(J, p => applyPreset(p, 'lefts'));
  for (const [a, b] of [[X, N], [Y, S], [N, Y], [X, Y], [Y, X], [S, N], [X, N], [S, X]]) w.queueTrip(a!.building!, b!.building!, 'commute');
  let lefts = 0;
  const seen = new Set<Car>();
  for (let t = 0; t < 60 * 60; t++) {
    w.update(DT);
    for (const c of w.cars) {
      if (c.granted !== J || seen.has(c) || c.kind === 'ambulance') continue; // ambulances run reds
      seen.add(c);
      const p = planOf(J), m = moveOf(J, c.lane.edge, c.exit!.edge), sig = p.phases[J.phase].sig[approachOf(p, J, c.lane.edge)][m];
      if (m === LEFT) lefts++;
      if (sig === 0 || (m === LEFT && sig !== 2)) fail(`protected lefts: move ${m} granted on signal ${sig} in phase ${J.phase}`);
    }
  }
  if (lefts < 3 || w.score !== 8) fail(`protected lefts: ${lefts} lefts granted, ${w.score} of 8 trips arrived`);
}
// Yield: at a junction of an avenue (main road) and a street, a street car at the line waits while an avenue car is queued;
// at a stop junction a car is only granted from a standstill
for (const kind of ['yield', 'stop'] as const) {
  const w = blank(), wg = w.graph, ave: RoadType = { tier: 'avenue', lanes: 1, oneWay: false }, street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), Z = town(w, 500, 940), J = wg.addNode(500, 500);
  w.commitPath(w.planPath([X, J], 0, ave));
  w.commitPath(w.planPath([J, Y], 0, ave));
  w.commitPath(w.planPath([Z, J], 0, street));
  w.demandOff = true;
  w.placeControl(J, kind);
  const zj = wg.edgeBetween(Z, J)!, xj = wg.edgeBetween(X, J)!;
  const side = new Car(wg.lanesFrom(zj, Z)[0]!, trip(Z, Y)), main = new Car(wg.lanesFrom(xj, X)[0]!, trip(X, Y));
  side.s = zj.length - stopDist(J) - 6;
  main.s = xj.length - 65;
  main.speed = side.speed = kind === 'stop' ? TURN_SPEED : 0;
  for (const c of [main, side]) { c.lane.cars.push(c); w.cars.push(c); } // cars update last first: the side car queues first
  let first: Car | null = null;
  for (let t = 0; t < 20 * 60; t++) {
    const v = [side.speed, main.speed], was = [side.granted, main.granted];
    w.update(DT);
    [side, main].forEach((c, i) => {
      if (c.granted !== J || was[i] === J) return;
      first ??= c;
      if (kind === 'stop' && v[i] >= 1) fail(`stop: car granted at ${v[i].toFixed(0)} px/s`);
    });
  }
  if (kind === 'yield' && first !== main) fail('yield: the side road went before the main road');
  if (w.score !== 2) fail(`${kind}: ${w.score} of 2 cars arrived`);
}
// Ramps: a road at L2 from a ground road's dead end climbs a level per segment (L0, L1, then L2); a 2-tile one is too steep; a viaduct
// ending at a door comes down to the ground first (doors take ground roads only); a commute over it arrives
{
  const w = blank(), flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  w.demandOff = true;
  const X = town(w, 100, 500), Y = town(w, 900, 500), P = { x: 300, y: 500 }, Q = { x: 600, y: 500 };
  w.commitPath(w.planPath([X, P], 0, flat));
  const up = w.planPath([P, Q], 2, flat), ul = up.segs.map(g => g.level);
  if (!up.ok || ul[0] !== 0 || ul[1] !== 1 || ul.slice(2).some(l => l !== 2)) fail(`ramps: up ${ul} (${up.reason})`);
  if (w.planPath([P, { x: 380, y: 500 }], 2, flat).reason !== 'Too steep: make the ramp longer') fail('ramps: a 2-tile ramp to L2 passed');
  w.commitPath(up);
  const down = w.planPath([Q, Y], 2, flat), dl = down.segs.map(g => g.level);
  if (!down.ok || dl[0] !== 2 || dl[dl.length - 1] !== 0) fail(`ramps: down to the door ${dl} (${down.reason})`);
  w.commitPath(down);
  w.queueTrip(X.building!, Y.building!, 'commute');
  for (let t = 0; t < 30 * 60; t++) w.update(DT);
  if (w.score !== 1) fail(`ramps: the commute over the viaduct did not arrive (score ${w.score})`);
}
// Grid: 480 x 320 in 4-tile blocks is 3 x 2 blocks: 2 crossings inside, 6 T-junctions on the border, 4 corners, at the previewed price
{
  const w = blank(), a = { x: 200, y: 200 }, b = { x: 680, y: 200 }, c = { x: 300, y: 520 };
  w.demandOff = true;
  w.roadType = { tier: 'street', lanes: 1, oneWay: false };
  const plan = w.planGrid(a, b, c), m0 = w.money;
  if (!plan.ok || !w.commitGrid(a, b, c)) fail(`grid: ${plan.reason}`);
  const deg = (k: number) => w.graph.nodes.filter(n => n.edges.length === k).length;
  if (deg(4) !== 2 || deg(3) !== 6 || deg(2) !== 4 || w.graph.nodes.length !== 12 || Math.abs(m0 - plan.cost - w.money) > 1e-6) {
    fail(`grid: ${deg(4)} crossings, ${deg(3)} T-junctions, ${deg(2)} corners of ${w.graph.nodes.length}, paid ${m0 - w.money} for ${plan.cost}`);
  }
}
// Interchanges on a boulevard (main road) crossing an avenue: no node joins the two roads at one level any more, and a trip between
// every pair of arms arrives (the trumpet on a T)
for (const kind of ['diamond', 'clover', 'trumpet'] as const) {
  const w = blank(), wg = w.graph, main: RoadType = { tier: 'boulevard', lanes: 2, oneWay: false }, side: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  w.demandOff = true;
  const cx = 1000, cy = 600, r = 500;
  const arms = [town(w, cx - r, cy), town(w, cx + r, cy), town(w, cx, cy + r)];
  if (kind !== 'trumpet') arms.push(town(w, cx, cy - r, 'home', true));
  w.commitPath(w.planPath([arms[0], arms[1]], 0, main));
  w.commitPath(w.planPath([arms[2], arms[3] ?? { x: cx, y: cy }], 0, side));
  const J = wg.nearestNode({ x: cx, y: cy }, 2)!;
  w.ichg = { node: J, kind };
  const plan = w.planInterchange(J, kind), m0 = w.money;
  if (!plan.ok || !w.buildInterchange()) fail(`interchange ${kind}: ${plan.reason}`);
  if (Math.abs(m0 - w.money - plan.net!) > 1e-6) fail(`interchange ${kind}: paid ${m0 - w.money}, previewed ${plan.net}`);
  const onMain = (e: typeof wg.edges[number]) => Math.abs(e.a.y - cy) < 1 && Math.abs(e.b.y - cy) < 1;
  const onSide = (e: typeof wg.edges[number]) => Math.abs(e.a.x - cx) < 1 && Math.abs(e.b.x - cx) < 1;
  for (const n of wg.nodes) {
    const lm = new Set(n.edges.filter(onMain).map(e => e.level));
    if (n.edges.some(e => onSide(e) && lm.has(e.level))) fail(`interchange ${kind}: node ${n.id} joins both roads at L${n.edges.find(onSide)!.level}`);
  }
  let pairs = 0;
  for (const a of arms) for (const b of arms) if (a !== b) { w.queueTrip(a.building!, b.building!, 'commute'); pairs++; }
  for (let t = 0; t < 150 * 60 && w.score < pairs; t++) w.update(DT);
  if (w.score !== pairs) fail(`interchange ${kind}: ${w.score} of ${pairs} trips arrived`);
}
// Analysis: one metric sample per in-game hour (24 over one day, and one per hour of the main run); a lane of stopped cars heats its
// road while an idle road stays cold, the junction they wait at builds up delay, and an Edit click on a car follows it
{
  const w = blank();
  w.update(TUNING.DAY_SECONDS);
  if (w.metrics.samples.length !== 24) fail(`metrics: ${w.metrics.samples.length} samples after one day`);
  const ms = game.metrics.samples, hours = Math.floor(game.clock) - TUNING.START_HOUR;
  if (ms.length !== hours || ms.some(s => !Object.values(s).every(Number.isFinite))) fail(`metrics: ${ms.length} samples in ${hours} hours of the main run`);
  if (!ms.some(s => s.through > 0) || !ms.some(s => s.trip > 0)) fail('metrics: no throughput or trip time sampled');
  const flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), P = town(w, 100, 900), Q = town(w, 900, 900);
  w.commitPath(w.planPath([X, Y], 0, flat));
  w.commitPath(w.planPath([P, Q], 0, flat));
  const xy = w.graph.edgeBetween(X, Y)!, pq = w.graph.edgeBetween(P, Q)!, lane = w.graph.lanesFrom(xy, X)[0]!;
  for (let k = 0; k < 12; k++) {
    const c = new Car(lane, trip(X, Y));
    c.s = xy.length - stopDist(Y) - k * (c.len + 5) - 10;
    c.wait = 5;
    lane.cars.unshift(c);
    w.cars.push(c);
    Y.queue.push(c);
  }
  for (let t = 0; t < 20 * 60; t++) w.graph.update(DT);
  if (xy.heat < 0.5 || pq.heat !== 0 || Y.delay < 1) fail(`heat: jammed road ${xy.heat.toFixed(2)}, idle road ${pq.heat.toFixed(2)}, delay ${Y.delay.toFixed(1)}`);
  w.tool = 'edit';
  const c = lane.cars[3]!;
  w.select(w.graph.carPos(c));
  if (w.follow !== c || w.selected) fail('follow: an Edit click on a car did not follow it');
}
// Save: the main run (cars on the road, light plans, a roundabout) round-trips to the same JSON; its cars' trips wait at their doors
// again, and the loaded game runs 60s within the car invariants and gets trips through
{
  const json = serialize(game), w = deserialize(json);
  if (serialize(w) !== json) fail('save: a loaded game saves differently');
  const pending = (x: Game): number => x.buildings.reduce((n, b) => n + b.pending.length, 0);
  if (w.cars.length || pending(w) !== pending(game) + game.cars.length) fail(`save: ${pending(w)} trips waiting, expected ${pending(game) + game.cars.length}`);
  if (w.graph.edges.length !== g.edges.length || w.graph.nodes.filter(n => n.control !== 'none').length !== g.nodes.filter(n => n.control !== 'none').length) fail('save: the network changed');
  const score = w.score;
  for (let t = 0; t < 60 * 60; t++) {
    try { w.update(DT); } catch (e) { fail(`save: exception in the loaded game: ${(e as Error).stack}`); }
    invariants(w);
  }
  if (w.score <= score) fail('save: no trip arrived in the loaded game');
}
const out = game.reports.reduce<Record<string, number>>((o, r) => (o[r.outcome] = (o[r.outcome] ?? 0) + 1, o), {});
console.log(`SIMCHECK OK: t=${game.time.toFixed(0)}s day=${game.day} score=${game.score} cars=${game.cars.length} maxCars=${maxCars} `
  + `pending=${game.buildings.reduce((n, b) => n + b.pending.length, 0)} commutes=${commutes.length} outcomes=${JSON.stringify(out)}`);
process.exit(0);
