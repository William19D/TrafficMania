// Headless simulation check: builds a fixed network, runs ~300 game seconds and asserts the car invariants.
// Run: npm run simcheck   (= node --experimental-transform-types --no-warnings scripts/simcheck.ts)
// Exits 1 on the first failure. Add one scenario/assertion per behaviour you want to lock in.
import { Game, HOUR, levelPop } from '../src/core/Game.ts';
import { RoadGraph, BRAKE, CAR_LEN, DEFAULT_TYPE, LIGHT_PERIOD, MERGE_S, NODE_R, RINGS, clearR, lightGroup, ringOut, stopDist } from '../src/network/RoadGraph.ts';
import { LEFT, RIGHT, STRAIGHT, applyPreset, approachOf, clonePlan, links, moveOf, planOf, setLink, setSeconds } from '../src/network/Junction.ts';
import { stepDone, tutorialSteps } from '../src/ui/Tutorial.ts';
import { dueTip } from '../src/ui/Tips.ts';
import type { Edge, Lane, Node, RoadType } from '../src/network/RoadGraph.ts';
import { buildingAt } from '../src/entities/Building.ts';
import { makeTrip } from '../src/entities/Trip.ts';
import type { Trip } from '../src/entities/Trip.ts';
import { Car, GIVE_UP_S, KINDS, MAX_SPEED, TURN_SPEED, sep } from '../src/entities/Car.ts';
import { generateTerrain } from '../src/world/MapGenerator.ts';
import { findPath } from '../src/network/Pathfinder.ts';
import { BIOMES, DEFAULT_CONFIG, DIFFICULTY, SPECIALS, SPECIAL_KEYS, TIERS, TIER_DEFS, TUNING, ZONES } from '../src/core/config.ts';
import type { Biome, GameConfig, Special, Zone } from '../src/core/config.ts';
import { setSeed } from '../src/util/rng.ts';
import { dist, snapAngle } from '../src/util/geom.ts';
import type { Vec } from '../src/util/geom.ts';
import { deserialize, restore, serialize } from '../src/core/Save.ts';
import { ZONE_LIST, commitZone, grow, lotAt, planZone, zoneHour } from '../src/core/Zones.ts';
import { CHALLENGE_MONEY, MAPS, cfgFor, grade, milestonePop, milestonesAt, takeOffer } from '../src/core/Campaign.ts';
import { checkAch, owned } from '../src/core/Achievements.ts';
import { RAIN_V, WRECK_V, eventsOn, startEvent } from '../src/core/Events.ts';
import { mapOpen, parseProfile, profile0, recordGrade, toolLevel, totalStars } from '../src/core/Profile.ts';
import { VARIANTS, look, shade, variant } from '../src/rendering/BuildingArt.ts';
import { CAR_PAINT, pick } from '../src/rendering/VehicleArt.ts';
import { daylight } from '../src/rendering/Lighting.ts';
import { netKey } from '../src/rendering/RoadArt.ts';

declare const process: { exit(code: number): never };

// Every model roll must go through the seeded stream (src/util/rng.ts)
Math.random = () => { throw new Error('Math.random used: route it through random() in src/util/rng.ts'); };

const fail = (msg: string): never => { console.log('SIMCHECK FAIL: ' + msg); process.exit(1); };

// Blank world: no terrain, no starter town, every level unlocked
const SIM: GameConfig = { ...DEFAULT_CONFIG, seed: 'simcheck', size: 'small' };
const blank = (): Game => {
  const w = new Game(SIM);
  setSeed(12345);
  w.terrain = { rivers: [], mountains: [], lakes: [], patches: [], trees: [], exits: [], biome: 'temperate' };
  w.graph = new RoadGraph();
  w.buildings = [];
  w.lots = [];
  w.tutorialActive = true;
  w.money = 1e6;
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
    const w = new Game({ ...SIM, difficulty }), homes = w.buildings.filter(b => b.kind === 'home'), gates = w.buildings.filter(b => b.kind === 'gate');
    if (homes.length !== 4 || w.buildings.length - gates.length !== 7) fail(`starter town: ${w.buildings.map(b => b.kind)}`);
    // 2-4 highway exits, each a gate with its free stub and no town road to it yet
    if (gates.length < 2 || gates.length > 4 || gates.some(b => b.node.edges.length !== 1) || w.linkedExits().length || w.upkeepPerDay() !== (difficulty === 'easy' ? w.upkeepDay : 0)) fail(`exits: ${gates.length} gates`);
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
if (J1.control !== 'light' || g.rings.length !== 1 || g.rings[0]!.hub.ring !== 0 || g.nodes.includes(R)) fail('controls not placed');

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
  for (const e of w.graph.edges) if (e.length < 1) fail(`edge ${e.id} is ${e.length.toFixed(2)}px long at t=${t}`);
  for (const n of w.graph.nodes) for (const c of n.occupants) {
    if (!live.has(c) || !c.lane.cars.includes(c)) fail(`node ${n.id} holds a car off the graph at t=${t}`);
  }
};
// Overlaps the lane check misses. Across a node: a car never closer than touching to the first car on its exit lane that came the same
// way. On screen: two cars on one edge or on consecutive lanes (a junction or ring hand-off) heading the same way (within 30 degrees)
// are never drawn closer than 0.8 x touching along their heading while less than a car width apart across it.
// ponytail: cars entering one lane from two approaches are measured on screen only (their path gap is no distance); O(n^2), so not
// in the rush hour
const overlaps = (w: Game, what: string, drawn = true): void => {
  const t = w.time.toFixed(2), g = w.graph;
  for (const c of w.cars) {
    const f = c.exit?.cars[0];
    if (!f || f === c || c.lane.to !== c.exit!.from || f.prev !== c.lane.from) continue;
    const gap = c.lane.edge.length - c.s + f.s - sep(c, f);
    if (gap < -0.5) fail(`${what}: cars overlap across node ${c.lane.to.id} by ${(-gap).toFixed(1)}px at t=${t}`);
  }
  if (!drawn) return;
  const pos = w.cars.map(c => g.carPos(c));
  for (let i = 0; i < w.cars.length; i++) for (let j = i + 1; j < w.cars.length; j++) {
    const a = w.cars[i], b = w.cars[j], la = a.lane, lb = b.lane;
    if (la.edge !== lb.edge && la.to !== lb.from && lb.to !== la.from) continue;
    // ponytail: a car pulling in at its door vanishes there; a car leaving that door may already show beside it
    if ([a, b].some(c => c.lane.to === c.dest.node && c.lane.edge.length - c.s < CAR_LEN)) continue;
    const p = pos[i], q = pos[j], dx = q.x - p.x, dy = q.y - p.y;
    if (Math.abs(Math.atan2(Math.sin(p.angle - q.angle), Math.cos(p.angle - q.angle))) > Math.PI / 6) continue;
    const lon = Math.abs(dx * Math.cos(p.angle) + dy * Math.sin(p.angle)), lat = Math.abs(dy * Math.cos(p.angle) - dx * Math.sin(p.angle));
    if (lat < 6 && lon < 0.8 * sep(a, b)) fail(`${what}: cars drawn on top of each other (${lon.toFixed(1)}px apart) at t=${t} [${[a, b].map(c => `${c.kind} ${c.lane.from.id}>${c.lane.to.id} s=${c.s.toFixed(1)}/${c.lane.edge.length.toFixed(0)} v=${c.speed.toFixed(0)} lc=${c.lc.toFixed(2)} g=${c.granted?.id} cl=${c.clearing?.id} drive=${c.lane.edge.drive}`).join(" | ")}]`);
  }
};
const DT = 1 / 60, STEPS = 300 * 60, T_UP = TUNING.UPGRADE_H;
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
  for (const c of live) if ((c.kind === 'truck') !== (c.trip.purpose === 'freight')) fail(`kinds: a ${c.kind} on a ${c.trip.purpose} trip`);
  for (const c of live) {
    const [l, x] = exits.get(c) ?? [null, null];
    if (l === c.lane && x && c.exit && x !== c.exit && x.edge === c.exit.edge && l.edge.length - c.s < 2 * NODE_R) fail(`exit lane switched inside the turn arc at t=${game.time.toFixed(2)}`);
    exits.set(c, [c.lane, c.exit]);
  }
  invariants(game);
  overlaps(game, 'main run');
}
if (game.score <= 0) fail('no car arrived');
// Commuters leave home in the morning rush, and some reached work and drove home
const rush = commutes.filter(h => h >= TUNING.COMMUTE_MIN && h <= TUNING.COMMUTE_MAX).length;
if (commutes.length < 5 || rush < 0.7 * commutes.length) fail(`day cycle: ${rush} of ${commutes.length} commutes left between 6:00 and 10:00`);
if (!parkedAt.size || !game.reports.some(r => r.purpose === 'commute' && r.back)) fail('day cycle: no commuter reached work and came home');
// Drivers differ: top speeds spread within ±10% (the overlap check above covers their safety)
if (lo < 0.9 || hi > 1.1 || hi - lo < 0.1) fail(`driver top speeds ${lo.toFixed(2)}..${hi.toFixed(2)} x the kind's top speed`);
// every kind but the ambulance (hospital calls only) drives in the main run
if (kinds.size !== Object.keys(KINDS).length - 1 || kinds.has('ambulance')) fail(`vehicle kinds seen: ${[...kinds]}`);

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
// Joint before a junction: a lone car through plain joint M onto a 15px link to plain J (a road crossing a curve next to its joint)
// rolls onto the link to queue at J and arrives, instead of stopping short of M until it gives up
{
  const w = blank(), wg = w.graph, flat = { bridge: false, tunnel: false, level: 0, type: { tier: 'avenue', lanes: 1, oneWay: false } as RoadType };
  const X = town(w, 100, 500), Y = town(w, 900, 500), Z = town(w, 500, 900), M = wg.addNode(485, 500), J = wg.addNode(500, 500);
  for (const [a, b] of [[X, M], [M, J], [J, Y], [J, Z]]) wg.addEdge(a!, b!, { ...flat }, 0);
  w.demandOff = true;
  const e = wg.edgeBetween(X, M)!, c = new Car(wg.lanesFrom(e, X)[0]!, trip(X, Y));
  c.s = 50;
  c.lane.cars.push(c);
  w.cars.push(c);
  for (let t = 0; t < 15 * 60 && w.cars.includes(c); t++) w.update(DT);
  if (w.score !== 1) fail(`joint before a junction: car stopped at ${c.lane.from.id}->${c.lane.to.id} s=${c.s.toFixed(1)}, waited ${c.wait.toFixed(1)}s`);
}
// Box release: a truck granted at plain J into an exit with just enough room (fits()) gets far enough to free J
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), Z = town(w, 500, 900), J = wg.addNode(500, 500);
  for (const [a, b] of [[X, J], [J, Y], [J, Z]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const out = wg.lanesFrom(wg.edgeBetween(J, Y)!, J)[0]!, parked = new Car(out, trip(X, Y));
  parked.s = 54 + parked.len / 2;
  out.cars.push(parked);
  const e = wg.edgeBetween(X, J)!, bus = new Car(wg.lanesFrom(e, X)[0]!, trip(X, Y), 'truck');
  bus.s = e.length - 80;
  bus.lane.cars.push(bus);
  w.cars.push(bus);
  for (let t = 0; t < 10 * 60; t++) w.update(DT);
  if (bus.lane !== out || J.occupants.size) fail(`box release: truck at s=${bus.s.toFixed(1)} on ${bus.lane === out ? 'the exit' : 'the approach'}, J holds ${J.occupants.size}`);
}
// Lights: a car on the red waits for green with its brake lights on; an ambulance turns the light green as it comes and goes through
for (const kind of ['car', 'ambulance'] as const) {
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
  if ((c.lane.from === J) !== (kind === 'ambulance')) fail(`lights: ${kind === 'car' ? 'a car ran the red light' : 'an ambulance was held at the red'}`);
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
  // highways give no access through a driveway either: no retype of the street, no highway across a driveway
  const hw: RoadType = { tier: 'highway', lanes: 2, oneWay: false }, run = w.graph.runOf(w.graph.edges.find(e => !e.drive)!).edges;
  if (w.retype(run, hw)) fail('buildings: a street with driveways became a highway');
  const across = w.planPath([{ x: 150, y: 445 }, { x: 650, y: 445 }], 0, hw).reason;
  if (across !== 'Highways give no building access') fail(`buildings: a highway across the driveways was '${across || 'ok'}'`);
}
// Edits: a day-old avenue downgraded to dirt refunds REFUND_LATER of the drop, like a demolish; bending an arm of a junction with a
// turn ban keeps the ban when the arm still leaves at about the same angle, and charges the plan's net
{
  const w = blank(), wg = w.graph, ave: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const J = wg.addNode(500, 500), W = wg.addNode(100, 500), E = wg.addNode(900, 500), N = wg.addNode(500, 100), S = wg.addNode(500, 900);
  for (const n of [W, E, N, S]) w.commitPath(w.planPath([J, n], 0, ave));
  for (const e of wg.edges) e.day = -1;
  const wj = wg.edgeBetween(W, J)!;
  w.editPlan(J, p => setLink(p, J, wj, 0, LEFT, false));
  const m0 = w.money, drop = 10 * (TIERS.dirt.cost - TIERS.avenue.cost) * TUNING.REFUND_LATER;
  if (!w.retype([wg.edgeBetween(J, N)!], { tier: 'dirt', lanes: 1, oneWay: false }) || Math.abs(w.money - m0 + drop) > 1e-6) {
    fail(`edits: downgrade refunded ${w.money - m0}, expected ${-drop}`);
  }
  const m1 = w.money, bend = w.planBend([wg.edgeBetween(J, E)!], { x: 700, y: 510 });
  if (!bend.ok || !w.commitBend([wg.edgeBetween(J, E)!], bend)) fail(`edits: bend refused (${bend.reason})`);
  if (!J.plan) fail('edits: a slight bend reset the junction plan');
  if (Math.abs(w.money - (m1 - bend.net!)) > 1e-6) fail(`edits: bend cost ${m1 - w.money}, expected ${bend.net}`);
}
// Road shape: from a street's end, Curve bends the new road to leave along the street, Straight lays one segment; Ctrl's 15° steps
{
  const w = blank(), A = w.graph.addNode(500, 500), B = w.graph.addNode(100, 500), to = { x: 800, y: 900 };
  w.commitPath(w.planPath([B, A], 0));
  const c = w.planRoad(A, to, true), s = w.planRoad(A, to, false);
  if (!c.ok || c.points.length < 3 || c.note !== 'Curve') fail(`road shape: curve gave ${c.points.length} points (${c.reason})`);
  if (!s.ok || s.points.length !== 2 || s.note !== 'Straight') fail(`road shape: straight gave ${s.points.length} points (${s.reason})`);
  const q = snapAngle(A, { x: 600, y: 530 }, Math.PI / 12), deg = Math.atan2(q.y - A.y, q.x - A.x) * 180 / Math.PI;
  if (Math.abs(deg - 15) > 1e-9 || Math.abs(dist(A, q) - Math.hypot(100, 30)) > 1e-9) fail(`road shape: snapped to ${deg}°`);
  // a straight road over a river is a bridge only over the water: the land either side stays a street a building can join
  w.terrain.rivers = [{ points: [{ x: 1200, y: 0 }, { x: 1200, y: 1200 }], width: 60 }];
  const r = w.planRoad({ x: 900, y: 100 }, { x: 1500, y: 100 }, false), kinds = r.segs.map(s => s.bridge).join();
  if (!r.ok || kinds !== 'false,true,false') fail(`road shape: a straight road over a river built as bridges ${kinds} (${r.reason})`);
  w.commitPath(r);
  w.startPlacing('home');
  if (!w.planPlace({ x: 1000, y: 150 })?.road) fail('road shape: no building snaps to the land part of a road over a river');
}
// Levels: with map 1's tools an avenue and a roundabout are locked; a home and an office placed beside a street face it,
// get free driveways and a commute between them arrives; pushing the population past level 2's milestone pays the grant once
// (Endless milestones unlock nothing: map 2's tools do)
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.cfg = { ...w.cfg, unlock: 1 };
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
  if (w.placeBuilding({ x: 300, y: 440 })) fail('levels: placed a building on top of another');
  w.queueTrip(H, O, 'commute');
  for (let t = 0; t < 20 * 60; t++) w.update(DT);
  if (w.score !== 1) fail(`levels: commute from a placed home did not arrive (score ${w.score})`);
  // achievements: the arrival unlocks First Commute (once), nothing else on this town; none in Creative
  const p = profile0(), got = checkAch(w, p, 1).map(d => d.id);
  if (got.join() !== 'first' || p.achievements.first !== 1 || checkAch(w, p, 2).length) fail(`achievements: ${got}`);
  w.feat('paint', 20);
  if (checkAch(w, p).map(d => d.id).join() !== 'paint') fail('achievements: a 20-lot drag did not give Paint the Town');
  if (checkAch(new Game({ ...SIM, mode: 'creative' }), profile0()).length) fail('achievements: unlocked in Creative');
  if (!owned({ ...profile0(), achievements: { halfoff: 1 } }).paints.includes('gold')) fail('achievements: Half Off did not unlock gold paint');
  // milestones: city levels count without a modal; 500 residents offers Money + Upgrade (rotation), the card passed over comes back first
  const m0 = w.money;
  H.residents = levelPop(2);
  w.update(DT);
  if (w.cityLevel !== 2 || w.modal || w.money !== m0 || w.tierUnlocked('avenue')) fail(`levels: level ${w.cityLevel}`);
  w.tutorialActive = false; // the tutorial holds milestones back
  H.residents = 500;
  w.update(DT);
  const o1 = w.offers?.map(o => o.kind).join();
  if (w.milestone !== 1 || o1 !== 'money,upgrade' || !w.modal) fail(`milestones: first offers ${o1}`);
  const cash = (w.offers![0] as { amount: number }).amount;
  takeOffer(w, 0);
  if (w.money !== m0 + cash || w.offers || w.spare?.kind !== 'upgrade') fail(`milestones: money card ${w.money - m0}`);
  H.residents = 1000;
  w.update(DT);
  const o2 = w.offers?.map(o => o.kind === 'upgrade' ? o.up : o.kind).join();
  if (w.milestone !== 2 || o2 !== 'crew,money') fail(`milestones: second offers ${o2}`);
  const before = w.price({ x: 0, y: 0 }, { x: 100, y: 0 }, { bridge: false, tunnel: false, level: 0, type: street });
  takeOffer(w, 0);
  if (Math.abs(w.price({ x: 0, y: 0 }, { x: 100, y: 0 }, { bridge: false, tunnel: false, level: 0, type: street }) - 0.8 * before) > 1e-9) fail('milestones: Road crew did not cut road prices');
  if (milestonesAt(w, 4000) !== 7 || milestonePop(new Game({ ...SIM, mode: 'creative' }), 1) !== Infinity) fail('milestones: schedule');
  w.offers = null;
  H.residents = 100;
  w.tutorialActive = true;
  w.cfg = { ...w.cfg, unlock: 2 };
  if (!w.tierUnlocked('avenue')) fail('levels: map 2 tools did not unlock the avenue');
}
// Driveways: homes placed facing each other across a street, doors 13px apart along it, share one junction instead of leaving a
// stretch of road shorter than a truck between two (which locked both), and both commutes arrive
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.demandOff = true;
  w.commitPath(w.planPath([{ x: 100, y: 500 }, { x: 900, y: 500 }], 0, street));
  for (const [k, x, y] of [['home', 400, 470], ['home', 413, 530], ['office', 700, 530]] as const) { w.startPlacing(k); if (!w.placeBuilding({ x, y })) fail(`driveways: ${k} not placed`); }
  const short = w.graph.edges.filter(e => !e.drive && e.length < TUNING.DRIVE_SNAP);
  if (short.length || !w.buildings.every(b => b.connected)) fail(`driveways: ${short.length} road stretches under ${TUNING.DRIVE_SNAP}px`);
  const [H1, H2, O] = w.buildings;
  w.queueTrip(H1, O, 'commute');
  w.queueTrip(H2, O, 'commute');
  for (let t = 0; t < 30 * 60; t++) w.update(DT);
  if (w.score !== 2) fail(`driveways: ${w.score} of 2 commutes from facing homes arrived`);
}
// Happiness: an identical home 60px from a staffed factory scores 25+ points under one 600px away.
// Fails (Challenge only): money below 0 at DEBT_DAYS midnights in a row is bankrupt (the countdown says 1 day before it), city
// happiness under failHappy from day FAIL_FROM_DAY at FAIL_DAYS midnights is 'unhappy'; career, creative and the tutorial never fail
{
  const w = blank(), F = town(w, 1000, 300, 'industry').building!;
  F.staffed = 1;
  const near = w.addBuilding(buildingAt('home', { x: F.x + 60, y: F.y }, 0)), far = w.addBuilding(buildingAt('home', { x: F.x + 600, y: F.y }, 0));
  // both reach a shop (a home with nowhere to go scores 0 either way)
  const S = town(w, F.x + 300, F.y + 300, 'shop');
  for (const h of [near, far]) w.graph.addEdge(h.node, S, { bridge: false, tunnel: false, level: 0, type: DEFAULT_TYPE });
  const hn = w.rateHome(near), hf = w.rateHome(far);
  if (hf - hn < 25) fail(`happiness: home by the factory ${hn.toFixed(0)}, far one ${hf.toFixed(0)}`);
  const midnight = (g: Game) => { g.time = ((g.today + 1) * 24 - TUNING.START_HOUR) * HOUR - DT / 2; g.update(DT); };
  const d = DIFFICULTY[SIM.difficulty];
  const CH = 'challenge';
  for (const [mode, tut] of [[CH, false], ['endless', false], ['creative', false], [CH, true]] as const) {
    const g = blank();
    g.cfg = { ...SIM, mode };
    g.tutorialActive = tut;
    g.money = -1;
    for (let i = 1; i < d.debtDays; i++) { midnight(g); if (mode === CH) g.money = -1; }
    if (!tut && mode === CH && (g.gameOver || g.alarm?.kind !== 'bankrupt' || g.alarm.days !== 1)) fail(`fail: alarm ${JSON.stringify(g.alarm)} before bankruptcy`);
    for (let i = 0; i < 3; i++) midnight(g);
    if (g.gameOver !== (mode === CH && !tut ? 'bankrupt' : '')) fail(`fail: ${mode}${tut ? ' tutorial' : ''} in debt gave '${g.gameOver}'`);
    if ((g.loan > 0) !== (mode === 'endless')) fail(`fail: ${mode} in debt took a loan of ${g.loan}`);
  }
  const g = blank();
  g.cfg = { ...SIM, mode: CH };
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
  w.editPlan(J, p => setLink(p, J, xj, 0, LEFT, false));
  const route = findPath(wg, X, Z);
  if (route?.[1] !== J || route[2] !== K) fail(`turn ban: route ${route?.map(n => n.id)} still turns left at J`);
  // a legacy turn ban (old saves) shows as the missing connection, and the next connection edit folds it into the lanes
  const legacy = clonePlan(planOf(J));
  legacy.lanes = undefined;
  legacy.ban[approachOf(legacy, J, xj)][LEFT] = true;
  if (links(legacy, J, xj)[0] !== (1 << STRAIGHT | 1 << RIGHT)) fail(`turn ban: legacy ban shows as ${links(legacy, J, xj)}`);
  setLink(legacy, J, xj, 0, STRAIGHT, true);
  if (legacy.ban.flat().some(Boolean) || legacy.lanes?.[approachOf(legacy, J, xj)]?.[0] !== (1 << STRAIGHT | 1 << RIGHT)) fail(`turn ban: legacy ban not folded ${JSON.stringify(legacy)}`);
  w.queueTrip(X.building!, Z.building!, 'commute');
  for (let t = 0; t < 40 * 60 && !w.score; t++) {
    w.update(DT);
    for (const c of w.cars) if (c.prev === X && c.lane.from === J && c.lane.to === P) fail('turn ban: a car took the banned left');
  }
  if (w.score !== 1) fail(`turn ban: the trip did not arrive via the detour (score ${w.score})`);
  // connecting the lane to the left again lifts the ban: the route turns left at J
  w.editPlan(J, p => setLink(p, J, xj, 0, LEFT, true));
  const back = findPath(wg, X, Z);
  if (back?.[1] !== J || back[2] !== P) fail(`turn ban: route ${back?.map(n => n.id)} does not turn left at J once reconnected`);
}
// Lane arrows: X's two lanes into J set to left+straight and right only; no car leaves the right lane but to the right, and every
// trip arrives. Then no lane allows the left: the Z trip reroutes round the block via K and Q.
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Z = town(w, 500, 60, 'home', true), S = town(w, 500, 940), E = town(w, 1000, 500);
  const J = wg.addNode(500, 500), K = wg.addNode(800, 500), Q = wg.addNode(800, 200), P = wg.addNode(500, 200);
  w.commitPath(w.planPath([X, J], 0, { ...flat, lanes: 2 }));
  for (const [a, b] of [[J, K], [K, Q], [Q, P], [P, J], [P, Z], [J, S], [K, E]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const xj = wg.edgeBetween(X, J)!, right = wg.lanesFrom(xj, X)[1]!;
  w.editPlan(J, p => setLink(p, J, xj, 1, STRAIGHT, false));
  if (wg.arrows(right) !== 1 << RIGHT) fail(`lane arrows: right lane allows ${wg.arrows(right)}`);
  for (let i = 0; i < 3; i++) for (const to of [Z, S, E]) w.queueTrip(X.building!, to.building!, 'commute');
  const last = new Map<Car, Lane>();
  for (let t = 0; t < 90 * 60 && w.score < 9; t++) {
    w.update(DT);
    for (const c of w.cars) {
      if (c.lane.edge === xj) last.set(c, c.lane);
      else if (c.lane.from === J && last.get(c) === right && c.lane.to !== S.building!.node && c.lane.to !== S) fail(`lane arrows: a car left the right-only lane toward ${c.lane.to.id}`);
      if (c.lane.from === J) last.delete(c);
    }
  }
  if (w.score !== 9) fail(`lane arrows: ${w.score} of 9 trips arrived`);
  w.editPlan(J, p => setLink(p, J, xj, 0, LEFT, false));
  const route = findPath(wg, X, Z);
  if (route?.[1] !== J || route[2] !== K) fail(`lane arrows: route ${route?.map(n => n.id)} still turns left at J with no lane for it`);
  const back = deserialize(serialize(w)).graph.nodes[wg.nodes.indexOf(J)]?.plan?.lanes;
  if (JSON.stringify(back) !== JSON.stringify(J.plan!.lanes)) fail(`lane arrows: saved as ${JSON.stringify(back)}`);
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
      if (c.granted !== J || seen.has(c)) continue;
      seen.add(c);
      const p = planOf(J), m = moveOf(J, c.lane.edge, c.exit!.edge), sig = p.phases[J.phase].sig[approachOf(p, J, c.lane.edge)][m];
      if (m === LEFT) lefts++;
      if (sig === 0 || (m === LEFT && sig !== 2)) fail(`protected lefts: move ${m} granted on signal ${sig} in phase ${J.phase}`);
    }
  }
  if (lefts < 3 || w.score !== 8) fail(`protected lefts: ${lefts} lefts granted, ${w.score} of 8 trips arrived`);
}
// Mountains read raised, not as pits: every biome's peak band is lighter than its foot
for (const [k, b] of Object.entries(BIOMES)) {
  const lum = (c: string): number => [1, 3, 5].reduce((n, i) => n + parseInt(c.slice(i, i + 2), 16), 0);
  if (lum(b.bands[2]) <= lum(b.bands[0])) fail(`mountains: ${k} peak ${b.bands[2]} is darker than its foot ${b.bands[0]}`);
}
// Roundabout sizes: a 4-arm cross flooded from every arm (each car to another exit) through a ring of every size. Every car gets
// through, a large ring holds more cars at once than a small one, nothing overlaps (lanes, across nodes, on screen), and on and around
// the ring a car never turns more than 35 degrees in 0.1 s nor sheds speed faster than it brakes (no stop-then-jump at the entry).
// A large ring is refused where a road leaves it after 70px, a small one fits there; a resize keeps the arms joined and a removal
// leaves one junction joining them, refunded under the control rule.
{
  const most: number[] = [];
  for (const size of [0, 1, 2] as const) {
    const w = blank(), wg = w.graph, J = wg.addNode(1000, 1000), arms = [[1000, 550], [1450, 1000], [1000, 1450], [550, 1000]] as const;
    const H = arms.map(([x, y], i) => town(w, x, y, 'home', i === 0));
    for (const h of H) w.commitPath(w.planPath([h, J], 0, DEFAULT_TYPE));
    w.demandOff = true;
    w.ringSize = size;
    w.placeControl(J, 'roundabout');
    const ring = wg.rings[0]!;
    if (!ring || ring.hub.ring !== size || wg.nodes.includes(J)) fail(`ring sizes: size ${size} not placed (${w.message})`);
    H.forEach((h, i) => {
      const e = h.edges[0]!, lane = wg.lanesFrom(e, h)[0]!;
      for (let k = 0; k < 6; k++) {
        const c = new Car(lane, trip(h, H[(i + 1 + k % 3) % 4]));
        c.s = 330 - k * 24;
        lane.cars.unshift(c);
        w.cars.push(c);
      }
    });
    let max = 0;
    const seen = new Map<Car, { a: number[]; v: number }>();
    for (let t = 0; t < 90 * 60 && w.cars.length; t++) {
      w.update(DT);
      invariants(w);
      overlaps(w, `ring sizes ${size}`);
      max = Math.max(max, ring.nodes.reduce((n, v) => n + v.edges.filter(e => e.ring && e.a === v)[0]!.lanes[0]!.cars.length, 0));
      for (const c of w.cars) {
        const p = wg.carPos(c), h = seen.get(c) ?? { a: [], v: c.speed };
        h.a.push(p.angle);
        if (h.a.length > 7) h.a.shift();
        if (dist(p, ring.hub) < ringOut(size) + 12) {
          const turn = Math.abs(Math.atan2(Math.sin(p.angle - h.a[0]!), Math.cos(p.angle - h.a[0]!))) * 180 / Math.PI;
          if (turn > 35) fail(`ring sizes: a car turned ${turn.toFixed(0)} degrees in 0.1s on a size ${size} ring`);
          if (h.v - c.speed > BRAKE * DT + 1e-6) fail(`ring sizes: a car stopped dead on a size ${size} ring (${h.v.toFixed(1)} -> ${c.speed.toFixed(1)}px/s)`);
        }
        h.v = c.speed;
        seen.set(c, h);
      }
    }
    if (w.score !== 24) fail(`ring sizes: ${w.score} of 24 cars through a size ${size} ring`);
    most.push(max);
    if (size) continue;
    const K = wg.addNode(1300, 1300);
    for (const [x, y] of [[1370, 1300], [1300, 1100], [1100, 1300]]) w.commitPath(w.planPath([K, { x, y }], 0, DEFAULT_TYPE));
    if (w.setControl(K, 'roundabout', 2) || !w.setControl(K, 'roundabout', 0)) fail(`ring sizes: room check on a 70px arm (${w.ringRoom(K, 2)})`);
    const joined = (): boolean => H.every(a => H.every(b => a === b || !!findPath(wg, a, b, null, true)));
    const cash = w.money, price = w.controlPrice('roundabout', 1);
    if (!w.setControl(ring.hub, 'roundabout', 1) || wg.rings.length !== 2 || wg.rings.some(r => r.hub === ring.hub) || !joined()) fail('ring sizes: resize');
    if (Math.abs(w.money - (cash - price + w.controlPrice('roundabout', 0))) > 1e-6) fail(`ring sizes: resize cost ${cash - w.money}`);
    w.demolishAt({ x: 1000, y: 1000 });
    const c = wg.nearestNode({ x: 1000, y: 1000 }, 1);
    if (wg.rings.length !== 1 || !c || c.edges.length !== 4 || !joined() || Math.abs(w.money - (cash + w.controlPrice('roundabout', 0))) > 1e-6) fail('ring sizes: removal');
  }
  if (most[2]! <= most[0]!) fail(`ring sizes: large ring held ${most[2]} cars at once, small ${most[0]}`);
}
// Ring value: a ring built and taken out puts back the arm pieces it took (type, oldest day), so a street stub by an avenue never comes
// back as a free avenue spoke, and a road joined to the ring later pays for its spoke: the cash plus every road's and control's refund
// never rises over build / remove cycles of each size
{
  const w = blank(), wg = w.graph, J = wg.addNode(800, 800), av: RoadType = { tier: 'avenue', lanes: 2, oneWay: false };
  w.commitPath(w.planPath([J, { x: 500, y: 800 }], 0, DEFAULT_TYPE));
  w.commitPath(w.planPath([J, { x: 834, y: 800 }], 0, DEFAULT_TYPE));
  w.commitPath(w.planPath([{ x: 834, y: 800 }, { x: 1100, y: 800 }], 0, av));
  const worth = (): number => w.money + wg.edges.reduce((n, e) => n + w.refundOf(e), 0) + wg.rings.reduce((n, r) => n + w.controlRefund(r.hub), 0);
  const start = worth(), hub = () => (wg.rings[0] ?? { hub: wg.nearestNode({ x: 800, y: 800 }, 1)! }).hub;
  for (const size of [0, 1, 2, 2, 1, 0] as const) {
    if (!w.setControl(hub(), 'roundabout', size)) fail(`ring value: size ${size} refused (${w.message})`);
    if (!w.setControl(hub(), 'none')) fail('ring value: removal refused');
    if (worth() > start + 1e-6) fail(`ring value: a size ${size} cycle gained $${(worth() - start).toFixed(1)}`);
  }
  const spoke = wg.nearestNode({ x: 800, y: 800 }, 1)!.edges.find(e => e.length < 40);
  if (spoke?.type.tier !== 'street') fail(`ring value: the east spoke came back as ${spoke?.type.tier}`);
  w.setControl(hub(), 'roundabout', 1);
  const top = wg.rings[0]!.nodes.reduce((p, q) => q.y < p.y ? q : p), pl = w.planPath([top, { x: top.x, y: 500 }], 0, av);
  if (!pl.ok) fail(`ring value: road to the ring refused (${pl.reason})`);
  w.commitPath(pl);
  w.setControl(hub(), 'none');
  if (worth() > start + 1e-6) fail(`ring value: a road joined to the ring gained $${(worth() - start).toFixed(1)} on removal`);
}
// Short links by a ring: a large ring on a street lined with homes lays their driveways again outside its clear radius (no junction,
// split or driveway join inside it, so no link there a queued car overhangs), a road may not join an arm inside it but may join the
// ring itself from outside, a small ring is refused with a junction inside its own clear radius, and trips through keep every
// overlap check
{
  const w = blank(), wg = w.graph, J = wg.addNode(800, 800), R = clearR(2);
  const ends = [[300, 800], [1300, 800], [800, 300]].map(([x, y], i) => town(w, x, y, 'home', i === 2));
  for (const e of ends) w.commitPath(w.planPath([J, e], 0, DEFAULT_TYPE));
  for (const x of [645, 725, 875, 955]) { w.startPlacing('home'); w.placeBuilding({ x, y: 760 }); }
  w.demandOff = true;
  w.ringSize = 2;
  w.placeControl(J, 'roundabout');
  const r = wg.rings[0]!;
  if (!r) fail(`short links: large ring refused (${w.message})`);
  const inner = wg.nodes.filter(n => !n.building && !r.nodes.includes(n) && dist(n, r.hub) < R && n.edges.length !== 2);
  if (inner.length) fail(`short links: a junction inside the clear radius ${inner.map(n => [n.x, n.y, n.edges.length, n.edges.map(e => e.drive)])}`);
  if (w.buildings.some(b => !b.connected)) fail('short links: a home lost its road');
  if (w.planPath([{ x: 800 + R - 12, y: 700 }, { x: 800 + R - 12, y: 800 }]).reason !== 'Too close to the roundabout') fail('short links: a road split an arm by the ring');
  const into = w.planPath([{ x: 800, y: 970 }, { x: 800, y: 850 }]);
  if (!into.ok) fail(`short links: a road onto the ring refused (${into.reason})`);
  w.commitPath(into);
  if (r.nodes.filter(v => v.edges.some(e => !e.ring)).length !== 4) fail('short links: the new road did not join the ring');
  const homes = w.buildings.filter(b => b.kind === 'home');
  for (const a of homes) for (const b of homes) if (a !== b) w.queueTrip(a, b, 'commute');
  const n = homes.length * (homes.length - 1);
  for (let t = 0; t < 400 * 60 && w.score < n; t++) { w.update(DT); invariants(w); overlaps(w, 'short links'); }
  if (w.score !== n) fail(`short links: ${w.score} of ${n} trips through the large ring`);
  const K = wg.addNode(300, 300);
  for (const [x, y] of [[300, 345], [300, 100], [100, 300], [500, 300]]) w.commitPath(w.planPath([K, { x, y }], 0, DEFAULT_TYPE));
  for (const x of [180, 420]) w.commitPath(w.planPath([{ x: 300, y: 345 }, { x, y: 345 }], 0, DEFAULT_TYPE));
  if (w.setControl(K, 'roundabout', 0) || !w.message.startsWith('Too close')) fail(`short links: a small ring placed with a junction 45px out (${w.message})`);
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
// Tutorial (G6): on the real Meadowbrook a scripted newcomer plays the eight steps in order (each progress a pure read: the save JSON is the
// same after checking them all), with growth x4, no events and no milestones while it runs; then plays on to the map's 300 residents and
// its first star. Tips: dueTip is pure, follows the game and skips the seen ones. The feed: note() keeps the last 40 with their spot.
{
  const w = new Game(cfgFor(MAPS[0], 'campaign')), st: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.tutorialActive = true;
  w.money = Math.max(w.money, 20000);
  const steps = tutorialSteps(w);
  let at = 0;
  const prog = (): [number, number][] => {
    const json = serialize(w), d = steps.map(s => s.progress?.(w) ?? [1, 1] as [number, number]);
    if (serialize(w) !== json) fail('tutorial: a progress check changed the game');
    return d;
  };
  // step i is entered (as the card does) and must not be done yet; then act() until it is, within days of game time
  const step = (i: number, act: () => void, days = 1): void => {
    steps[i].enter?.(w);
    if (stepDone(steps[i], w)) fail(`tutorial: step ${i + 1} done on entry ${JSON.stringify(prog()[i])}`);
    act();
    for (const end = w.time + days * TUNING.DAY_SECONDS; !stepDone(steps[i], w) && w.time < end;) for (let k = 0; k < 60; k++) w.update(DT);
    if (!stepDone(steps[i], w)) fail(`tutorial: step ${i + 1} (${steps[i].goal}) stuck at ${JSON.stringify(prog()[i])} on day ${w.day} (lots ${JSON.stringify(ZONE_LIST.map(z => w.lots.filter(l => l.zone === z).length))}, pop ${Math.round(w.population)}, demand ${JSON.stringify(w.demand)})`);
    at = i;
  };
  const kind = (k: Zone) => w.buildings.find(b => b.kind === k)!;
  const road = (pts: Vec[]): void => { const pl = w.planPath(pts, 0, st); if (!pl.ok) fail(`tutorial: road refused (${pl.reason})`); w.commitPath(pl); };
  const zone = (a: Vec, b: Vec, z: Zone): void => { const pl = planZone(w, a, b, z); if (!pl || !commitZone(w, pl)) fail(`tutorial: ${z} zoning refused (${w.message})`); };
  if (prog().slice(1, 3).some(([n, of]) => n >= of)) fail(`tutorial: steps done before anything was built: ${JSON.stringify(prog())}`);
  if (dueTip(w, [])?.id !== 'noroad' || !dueTip(w, [])?.at || dueTip(w, ['noroad'])?.id === 'noroad') fail(`tutorial: tips ${JSON.stringify(dueTip(w, []))}`);
  w.speed = 0;
  step(1, () => {
    road([{ x: 450, y: 435 }, { x: 1000, y: 435 }]);
    road([kind('office').node, { x: 450, y: 652 }, { x: 450, y: 435 }]);
    road([kind('shop').node, { x: 450, y: 691 }]);
    road([kind('industry').node, { x: 450, y: 1000 }, { x: 450, y: 691 }]);
  });
  step(2, () => {});
  step(3, () => { zone({ x: 460, y: 435 }, { x: 640, y: 435 }, 'home'); zone({ x: 850, y: 435 }, { x: 990, y: 435 }, 'home'); });
  step(4, () => {}, 0.5);
  step(5, () => { zone({ x: 450, y: 700 }, { x: 450, y: 840 }, 'shop'); zone({ x: 450, y: 850 }, { x: 450, y: 990 }, 'office'); });
  step(6, () => { w.overlay = 'heat'; });
  if (at !== 6 || w.events.length || w.offers || w.milestone || w.pendingGrade || w.money < 0) fail(`tutorial: during the script events ${w.events.length}, milestone ${w.milestone}, money ${w.money}`);
  // Finish: the map plays on; a newcomer keeps zoning homes along a new road and reaches the goal
  w.tutorialActive = false;
  road([{ x: 1000, y: 435 }, { x: 1000, y: 800 }, { x: 450, y: 800 }]);
  zone({ x: 460, y: 800 }, { x: 990, y: 800 }, 'home');
  let star = 0;
  for (let d = 0; d < 8 && !star; d++) for (let k = 0; k < TUNING.DAY_SECONDS * 60 && !star; k++) {
    w.update(DT);
    if (w.offers) takeOffer(w, 0);
    if (w.pendingGrade) { star = w.pendingGrade.stars; w.pendingGrade = null; }
  }
  if (!star || w.population < 300) fail(`tutorial: map 1 not finished after the script (pop ${Math.round(w.population)}, day ${w.day}, demand ${JSON.stringify(w.demand)})`);
  if (!w.news.some(n => n.text.startsWith('Milestone'))) fail('tutorial: milestones missing from the feed');
  const n = w.newsN;
  for (let i = 0; i < 45; i++) w.note(`n${i}`, { x: i, y: 0 }, true);
  if (w.news.length !== 40 || w.newsN !== n + 45 || w.news[39].text !== 'n44' || w.news[39].at?.x !== 44) fail('tutorial: the feed does not keep the last 40');
}
// Short link: plain junctions J1 and J2 only 32px apart (shorter than a car needs to clear J1 before J2's line) with traffic both
// ways and from both side roads: a car waiting at the next line lets go of the box behind it, so no gridlock and every trip arrives
{
  const w = blank(), flat: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), P = town(w, 500, 900), Q = town(w, 532, 100, 'home', true);
  const J1 = w.graph.addNode(500, 500), J2 = w.graph.addNode(532, 500);
  for (const [a, b] of [[X, J1], [J1, J2], [J2, Y], [J1, P], [J2, Q]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  let n = 0;
  for (let k = 0; k < 4; k++) for (const [a, b] of [[X, Y], [Y, X], [P, Q], [Q, P], [P, Y], [Q, X]]) { w.queueTrip(a!.building!, b!.building!, 'commute'); n++; }
  for (let t = 0; t < 90 * 60 && w.score < n; t++) { w.update(DT); invariants(w); }
  if (w.score !== n) fail(`short link: ${w.score} of ${n} trips arrived (${w.stats.failed} gave up)`);
}
// Free flow: a lone car down a street lined with homes (a driveway junction every ~40px) is a smooth run, not a long wait;
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.demandOff = true;
  w.commitPath(w.planPath([{ x: 60, y: 500 }, { x: 900, y: 500 }], 0, street));
  for (let x = 150; x < 820; x += 40) { w.startPlacing('home'); w.placeBuilding({ x, y: 460 }); }
  for (const x of [60, 880]) { w.startPlacing('office'); w.placeBuilding({ x, y: 540 }); }
  const [o1, o2] = w.buildings.filter(b => b.kind === 'office');
  if (w.graph.nodes.filter(n => n.edges.length >= 3).length < 12 || !o1?.connected || !o2?.connected) fail('free flow: homes or offices not placed');
  w.queueTrip(o1, o2, 'commute');
  for (let t = 0; t < 30 * 60 && !w.reports.length; t++) w.update(DT);
  // granted through each driveway junction it keeps its speed: well under the free-flow time's per-junction allowance
  if (w.reports[0]?.outcome !== 'smooth' || w.reports[0].ratio > 0.9) fail(`free flow: ${w.reports[0]?.outcome} at ${w.reports[0]?.ratio.toFixed(2)}x the free-flow time`);
}
// Driveway merge: with a steady stream both ways down a street, the road never queues at a driveway junction, and a car leaving a
// driveway on each side gets in within MERGE_S plus a little (the road keeps clear for it once it has waited MERGE_S)
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.demandOff = true;
  w.commitPath(w.planPath([{ x: 60, y: 500 }, { x: 1500, y: 500 }], 0, street));
  for (const x of [60, 1480]) { w.startPlacing('office'); w.placeBuilding({ x, y: 540 }); }
  for (const x of [740, 780]) { w.startPlacing('home'); w.placeBuilding({ x, y: 460 }); }
  const [o1, o2] = w.buildings.filter(b => b.kind === 'office'), [h1, h2] = w.buildings.filter(b => b.kind === 'home');
  for (let i = 0; i < 30; i++) { w.queueTrip(o1, o2, 'commute'); w.queueTrip(o2, o1, 'commute'); }
  let t = 0;
  for (; t < 8 * 60; t++) w.update(DT);
  const out = [w.queueTrip(h1, o2, 'commute'), w.queueTrip(h2, o1, 'commute')];
  for (; t < 120 * 60 && w.score < 62; t++) {
    w.update(DT);
    invariants(w);
    if (w.graph.nodes.some(n => w.graph.drivewayJunction(n) && n.queue.some(c => !c.lane.edge.drive))) fail('merge: a road car queued at a driveway junction');
  }
  if (w.score !== 62 || out.some(r => r.jamS > MERGE_S + 1)) fail(`merge: ${w.score} of 62 arrived, driveway waits ${out.map(r => r.jamS.toFixed(1))}s`);
}
// Rush hour: a city of ~100 homes lining a street grid (a driveway junction every ~80px, plain 4-way junctions, three lights on the
// avenue, a roundabout, a yield T, a one-way piece and a viaduct whose ramps land on two junctions) through two rush hours. Nothing
// deadlocks (driveway merges, U-turn reroutes, plain junctions taking non-crossing cars together, starved side roads and lefts):
// no car comes near giving up, no trip fails, and most trips run smooth.
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  const road = (a: number[], b: number[], type = street, level = 0): void => w.commitPath(w.planPath([{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }], level, type));
  const xs = [200, 520, 840, 1160, 1480], ys = [200, 450, 700, 950];
  for (const x of xs) road([x, 200], [x, 950], x === 840 ? { tier: 'avenue', lanes: 1, oneWay: false } : street);
  for (const y of ys) {
    if (y === 950) { road([200, y], [520, y]); road([520, y], [840, y], { tier: 'street', lanes: 1, oneWay: true }); road([840, y], [1480, y]); }
    else road([200, y], [1480, y], y === 450 ? { tier: 'avenue', lanes: 2, oneWay: false } : street);
  }
  road([200, 700], [1160, 450], { tier: 'avenue', lanes: 1, oneWay: false }, 2);
  let k = 0;
  const place = (p: Vec): void => { k++; w.startPlacing(k % 11 === 0 ? 'shop' : k % 5 === 0 ? 'office' : k % 37 === 0 ? 'industry' : 'home'); w.placeBuilding(p); };
  for (const y of ys) for (let x = 220; x < 1470; x += 40) for (const d of [-40, 40]) if ((x + y + d) % 120 < 60) place({ x, y: y + d });
  for (const x of xs) for (let y = 220; y < 940; y += 40) for (const d of [-40, 40]) if ((x + y + d) % 120 < 60) place({ x: x + d, y });
  w.setTool('road');
  for (const b of w.buildings) if (b.kind === 'home') b.residents = 15;
  for (const [x, y, c] of [[520, 450, 'light'], [840, 450, 'light'], [1160, 450, 'light'], [520, 700, 'roundabout'], [1480, 450, 'yield']] as const) w.placeControl({ x, y }, c);
  if (w.graph.rings.length !== 1) fail(`rush hour: roundabout refused (${w.message})`);
  if (w.buildings.filter(b => b.kind === 'home').length < 90 || w.buildings.some(b => !b.connected)) fail(`rush hour: town not built ${w.buildings.filter(b => !b.connected).map(b => [b.x, b.y])}`);
  let maxWait = 0;
  while (w.clock < 34) {
    w.update(DT);
    overlaps(w, 'rush hour', false);
    for (const c of w.cars) maxWait = Math.max(maxWait, c.wait);
  }
  const smooth = w.stats.smooth / w.stats.arrived;
  if (maxWait > GIVE_UP_S - 2 || w.stats.failed || smooth < 0.75) fail(`rush hour: longest stop ${maxWait.toFixed(1)}s, ${w.stats.failed} failed, ${(smooth * 100).toFixed(0)}% smooth of ${w.stats.arrived}`);
}
// Demolish and move: an office demolished while cars head to it (an occupied one takes a second click) leaves nothing pointing at it
// (cars, trips, commuters, reports, nodes), its cars on the way head to another workplace, it is free, saves and loads, and the sim runs on; a home moved down the street
// keeps its residents and commuters, costs MOVE_COST, and its commuters get home to the new door
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.commitPath(w.planPath([{ x: 60, y: 500 }, { x: 1500, y: 500 }], 0, street));
  for (let x = 150; x < 700; x += 40) { w.startPlacing('home'); w.placeBuilding({ x, y: 460 }); }
  for (const [k, x] of [['office', 300], ['shop', 700], ['office', 1100]] as const) { w.startPlacing(k); w.placeBuilding({ x, y: 540 }); }
  const refs = (what: string): void => {
    const B = new Set(w.buildings), N = new Set(w.graph.nodes), C = new Set(w.commuters);
    const bad = (t: Trip): boolean => !B.has(t.from) || !B.has(t.to) || (!!t.who && !C.has(t.who));
    if (w.cars.some(c => bad(c.trip)) || w.buildings.some(b => [...b.pending, ...b.parked].some(bad))) fail(`${what}: a trip points at a removed building`);
    if (w.commuters.some(c => !B.has(c.home) || (c.work && !B.has(c.work)))) fail(`${what}: a commuter points at a removed building`);
    if (w.reports.some(r => !B.has(r.from) || !B.has(r.to))) fail(`${what}: a report points at a removed building`);
    if (w.graph.nodes.some(n => n.building && !B.has(n.building)) || w.buildings.some(b => !N.has(b.node) || b.node.building !== b)) fail(`${what}: door nodes out of sync`);
  };
  const O1 = w.buildings.find(b => b.kind === 'office')!;
  for (let t = 0; t < 6 * HOUR * 60 && (w.cars.filter(c => c.trip.to === O1).length < 2 || !w.reports.some(r => r.to === O1)); t++) w.update(DT);
  const enRoute = w.cars.filter(c => c.trip.to === O1 && !c.trip.back);
  if (enRoute.length < 2) fail(`demolish: only ${enRoute.length} cars headed to the office`);
  if (w.tryDemolish(O1) || !w.buildings.includes(O1)) fail('demolish: an occupied office went on the first click');
  const cash = w.money;
  if (!w.tryDemolish(O1) || w.buildings.includes(O1)) fail('demolish: the second click did not remove it');
  if (w.money !== cash) fail(`demolish: cost $${cash - w.money}`);
  refs('demolish');
  if (!enRoute.some(c => w.cars.includes(c) && c.trip.to !== O1 && c.trip.to.jobs > 0)) fail('demolish: no car on its way was sent to another workplace');
  const json = serialize(w);
  if (serialize(deserialize(json)) !== json) fail('demolish: the save does not round-trip');
  const score = w.score;
  for (let t = 0; t < HOUR * 60; t++) { w.update(DT); invariants(w); }
  refs('demolish, an hour on');
  if (w.score <= score) fail('demolish: nothing arrived after it');
  const H = w.buildings.find(b => b.kind === 'home' && w.commuters.some(c => c.home === b && c.at === 'away'))!;
  if (!H) fail('move: no home with a commuter at work');
  const res = H.residents, mine = w.commuters.filter(c => c.home === H).length, money = w.money, before = new Set(w.reports);
  w.startMove(H);
  if (!w.placeBuilding({ x: 1300, y: 460 })) fail(`move: refused, ${w.message}`);
  refs('move');
  if (H.x < 1200 || !H.connected || H.residents !== res || w.commuters.filter(c => c.home === H).length !== mine) fail('move: the home did not keep its place, residents or commuters');
  if (w.money !== money - TUNING.MOVE_COST || w.moving) fail(`move: cost $${money - w.money}`);
  const home = (): boolean => w.reports.some(r => !before.has(r) && r.to === H && r.back && r.purpose === 'commute' && r.outcome !== 'gaveup' && r.outcome !== 'noroute');
  for (let t = 0; t < 12 * HOUR * 60 && !home(); t++) { w.update(DT); invariants(w); }
  if (!home()) fail('move: no commuter got home to the moved door');
  refs('move, hours on');
}
// Sound cues: a road raises 'build', a building 'place', a demolish 'demolish'; a refused build raises none but still counts a message
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false }, cues = (): string => { const c = [...w.sfx].join(); w.sfx.clear(); return c; };
  w.commitPath(w.planPath([{ x: 300, y: 500 }, { x: 900, y: 500 }], 0, street));
  const built = cues();
  w.startPlacing('home'); w.placeBuilding({ x: 400, y: 460 });
  const placed = cues();
  w.demolishAt({ x: 800, y: 500 });
  const gone = cues(), said = w.said;
  w.money = 0;
  w.commitPath(w.planPath([{ x: 300, y: 700 }, { x: 900, y: 700 }], 0, street));
  if (built !== 'build' || placed !== 'place' || gone !== 'demolish' || cues() || w.said !== said + 1) fail(`sound cues: '${built}' '${placed}' '${gone}'`);
}
// Outside connections: an exit no town road reaches trades nothing and its stub cannot be demolished; once a street links it,
// factory trucks export through it (and leave the map), import trucks arrive at the factory from it, and trade is paid
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.terrain.exits = [{ door: { x: 0, y: 500 }, end: { x: 160, y: 500 }, angle: 0 }];
  w.addExits();
  const gate = w.buildings.find(b => b.kind === 'gate')!, edges = w.graph.edges.length;
  w.demolishAt({ x: 80, y: 500 });
  if (w.graph.edges.length !== edges || !gate.connected) fail('exits: the stub was demolished');
  // a road onto the stub's middle splits it: both halves stay free and cannot be demolished
  w.commitPath(w.planPath([{ x: 80, y: 640 }, { x: 80, y: 500 }], 0, street));
  const stub = w.graph.edges.filter(e => e.type.tier === 'highway'), up = w.upkeepPerDay(), cash = w.money;
  for (const x of [40, 120]) w.demolishAt({ x, y: 500 });
  if (stub.length !== 2 || stub.some(e => !e.exit || !w.graph.edges.includes(e)) || w.money !== cash || w.upkeepPerDay() !== up) fail('exits: a split stub piece lost its exit flag');
  w.commitPath(w.planPath([{ x: 300, y: 500 }, { x: 1500, y: 500 }], 0, street));
  for (let x = 340; x < 760; x += 40) { w.startPlacing('home'); w.placeBuilding({ x, y: 460 }); }
  w.startPlacing('industry'); w.placeBuilding({ x: 1000, y: 540 });
  w.startPlacing('shop'); w.placeBuilding({ x: 1300, y: 540 });
  const F = w.buildings.find(b => b.kind === 'industry')!, traded = () => w.ledger.today.trade + w.ledger.yesterday.trade;
  const via = (out: boolean) => w.reports.filter(r => r.purpose === 'freight' && !r.back && (out ? r.from === F && r.to === gate : r.from === gate && r.to === F)
    && r.outcome !== 'gaveup' && r.outcome !== 'noroute').length;
  while (w.clock < 30) { w.update(DT); invariants(w); }
  if (w.reports.some(r => r.from === gate || r.to === gate) || gate.pending.length || traded() || !w.reports.some(r => r.from === F && r.purpose === 'freight')) fail('exits: an unlinked exit traded, or the factory sent no trucks');
  w.commitPath(w.planPath([{ x: 160, y: 500 }, { x: 300, y: 500 }], 0, street));
  if (w.linkedExits()[0] !== gate) fail('exits: the street did not link the exit');
  while (w.clock < 78) { w.update(DT); invariants(w); }
  if (via(true) < 2 || via(false) < 2 || traded() <= 0) fail(`exits: ${via(true)} exports left, ${via(false)} imports arrived, $${traded()} trade`);
}
// No roads: a career player who builds nothing loses the residents within days (a home with nowhere to go scores 0), but the game
// goes on (soft fail); nothing grows on the starter lots without a road
{
  const w = new Game({ ...SIM, difficulty: 'normal' }), n = w.buildings.length;
  while (!w.gameOver && w.day < 8) w.update(0.5);
  if (w.gameOver || w.population >= 1 || w.buildings.length !== n || w.lots.length !== n - w.buildings.filter(b => b.kind === 'gate').length) fail(`no roads: '${w.gameOver}' on day ${w.day}, ${w.population} residents, ${w.buildings.length - n} grown`);
}
// Building art: every variant's body and chimney of every model (legacy kinds, each tier, each special) stand inside its footprint,
// each tier and special has a model of its own, offices come in several heights, and a street of ten buildings 50px apart shows at
// least five looks
{
  const all = [...(['home', 'shop', 'office', 'industry'] as const).map(k => buildingAt(k, { x: 0, y: 0 }, 0)),
    ...(Object.entries(TIER_DEFS) as [Zone, unknown[]][]).flatMap(([z, ts]) => ts.map((_, i) => buildingAt(z, { x: 0, y: 0 }, 0, i + 1))),
    ...SPECIAL_KEYS.map(s => buildingAt(s, { x: 0, y: 0 }, 0))];
  for (const b of all) for (let v = 0; v < VARIANTS; v++) {
    const H = b.h / 2, W = b.w / 2, { body: [x, y, w, h], chimney: c } = look(b.art, v, H, W);
    if (x < -H || y < -W || x + w > H || y + h > W || (c && (Math.abs(c.x) > H || Math.abs(c.y) > W))) fail(`art: ${b.art} variant ${v} spills out of its footprint`);
  }
  if (new Set(all.slice(4).map(b => b.art)).size !== all.length - 4) fail(`art: models shared: ${all.map(b => b.art)}`);
  if (new Set(Array.from({ length: VARIANTS }, (_, v) => look('office', v, ZONES.office.h / 2, ZONES.office.w / 2).height)).size < 3) fail('art: offices all one height');
  const street = new Set(Array.from({ length: 10 }, (_, i) => variant(300 + i * 50, 640)));
  if (street.size < 5 || variant(321.5, 77) !== variant(321.5, 77)) fail(`art: a street shows ${street.size} looks`);
}
// Day/night: no tint at noon, a full blue night at midnight, a warm dusk part way to night, and the tint never jumps between two
// clock readings 3 in-game minutes apart; a shade of a shade still parses (vehicle tones are shaded again for roofs and outlines)
{
  const noon = daylight(12), mid = daylight(0), dusk = daylight(18.6);
  if (noon.r + noon.g + noon.b !== 765 || noon.night) fail('light: noon is tinted');
  if (mid.night !== 1 || mid.b <= mid.r) fail('light: midnight is not a blue night');
  if (dusk.r <= dusk.b || dusk.night <= 0 || dusk.night >= 1) fail('light: dusk is not warm');
  for (let h = 0; h < 24; h += 0.05) {
    const a = daylight(h), b = daylight(h + 0.05);
    if (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > 12 || Math.abs(a.night - b.night) > 0.05) fail(`light: the tint jumps at ${h.toFixed(2)}h`);
  }
  if (shade(shade('#5A6FD8', -0.2), 0) !== shade('#5A6FD8', -0.2)) fail('art: a shade does not shade again');
  // paint: 500 spawns wear every car colour, white the most, and the roll stays off the sim's rng
  const n = CAR_PAINT.map(() => 0);
  for (let i = 0; i < 500; i++) n[pick(CAR_PAINT, new Car(g.edges[0]!.lanes[0]!, makeTrip('commute', game.buildings[0]!, game.buildings[1]!)).paint)]!++;
  if (n.some(x => !x) || Math.max(...n) !== n[0]) fail(`art: paint spread ${n.join(',')}`);
  // road layer cache: its key holds still on an unchanged network and moves with a control or a retype (a ring resize rebuilds its edges)
  const key = (): number => netKey(g.edges, g.nodes), k0 = key(), was = J2.control, t0 = g.edges[0]!.type;
  if (key() !== k0) fail('art: road key unstable');
  J2.control = 'stop';
  const k1 = key();
  J2.control = was;
  g.edges[0]!.type = { ...t0, tier: 'boulevard' };
  const k3 = key();
  g.edges[0]!.type = t0;
  if (new Set([k0, k1, k3]).size !== 3 || key() !== k0) fail('art: road key misses a change');
}
// Save: the main run (cars on the road, light plans, a roundabout) round-trips to the same JSON; its cars' trips wait at their doors
// again, and the loaded game runs 60s within the car invariants and gets trips through
{
  const json = serialize(game), w = deserialize(json);
  if (serialize(w) !== json) fail('save: a loaded game saves differently');
  const pending = (x: Game): number => x.buildings.reduce((n, b) => n + b.pending.length, 0);
  if (w.cars.length || pending(w) !== pending(game) + game.cars.length) fail(`save: ${pending(w)} trips waiting, expected ${pending(game) + game.cars.length}`);
  if (w.graph.edges.length !== g.edges.length || w.graph.nodes.filter(n => n.control !== 'none').length !== g.nodes.filter(n => n.control !== 'none').length
    || w.graph.rings.length !== 1 || w.graph.edges.filter(e => e.ring === w.graph.rings[0]).length !== g.edges.filter(e => e.ring).length) fail('save: the network changed');
  const score = w.score;
  for (let t = 0; t < 60 * 60; t++) {
    try { w.update(DT); } catch (e) { fail(`save: exception in the loaded game: ${(e as Error).stack}`); }
    invariants(w);
  }
  if (w.score <= score) fail('save: no trip arrived in the loaded game');
}
// Re-spacing: a 2-lane road packed in both lanes and retyped to one lane, then a packed curve bent straight (shorter), leave no car on
// top of another; the cars that no longer fit go back to their origin's queue
{
  const w = blank(), wg = w.graph, two: RoadType = { tier: 'avenue', lanes: 2, oneWay: false }, one: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 100, 500), Y = town(w, 900, 500), M = wg.addNode(300, 500), N = wg.addNode(700, 500);
  for (const [a, b, t] of [[X, M, one], [M, N, two], [N, Y, one]] as const) w.commitPath(w.planPath([a, b], 0, t));
  w.demandOff = true;
  const pack = (run: Edge[], gap: number): number => {
    let k = 0;
    for (const e of run) for (const l of e.lanes) for (let s = 10; s < e.length - 10; s += gap) { const c = new Car(l, trip(X, Y)); c.s = s; l.cars.push(c); w.cars.push(c); k++; }
    return k;
  };
  const sent = (): number => X.building!.pending.length;
  let n = pack([wg.edgeBetween(M, N)!], 16);
  w.retype([wg.edgeBetween(M, N)!], one);
  invariants(w);
  if (!sent() || sent() + w.cars.length !== n) fail(`re-spacing: retype kept ${w.cars.length} of ${n} cars, sent back ${sent()}`);
  for (const c of [...w.cars]) { wg.detachCar(c); w.cars.splice(w.cars.indexOf(c), 1); }
  X.building!.pending.length = 0;
  w.commitBend(w.runAt({ x: 500, y: 500 })!, w.planBend(w.runAt({ x: 500, y: 500 })!, { x: 500, y: 380 }));
  const curve = w.selected!;
  if (!curve) fail(`re-spacing: bend refused (${w.message})`);
  // one direction packed end to end along the whole curve, 15.05px apart (touching is 15): the straight road is shorter
  const run = wg.runOf(curve[0]!);
  n = 0;
  for (let i = 0, at = 0, d = 10; i < run.edges.length; at += run.edges[i]!.length, i++) {
    const e = run.edges[i]!, l = wg.lanesFrom(e, run.nodes[i]!)[0]!;
    for (; d - at < e.length - 1; d += 15.05) { const c = new Car(l, trip(X, Y)); c.s = d - at; l.cars.push(c); w.cars.push(c); n++; }
  }
  if (!w.commitBend(curve, w.planBend(curve, { x: 500, y: 500 }))) fail(`re-spacing: straightening refused (${w.message})`);
  invariants(w);
  if (sent() + w.cars.length !== n) fail(`re-spacing: bend kept ${w.cars.length} of ${n} cars, sent back ${sent()}`);
}
// Opposite lefts: two cars turning left from opposite arms of a crossroads, both at the node, are drawn a car width apart, not on top
// of each other
{
  const wg = new RoadGraph(), J = wg.addNode(500, 500), [Nn, E, S, W] = [[500, 300], [700, 500], [500, 700], [300, 500]].map(([x, y]) => wg.addNode(x!, y!));
  for (const o of [Nn, E, S, W]) wg.addEdge(J, o!, { bridge: false, tunnel: false, level: 0, type: DEFAULT_TYPE });
  const at = (from: Node, to: Node): Vec => {
    const c = new Car(wg.lanesFrom(wg.edgeBetween(from, J)!, from)[0]!, makeTrip('commute', game.buildings[0]!, game.buildings[1]!));
    c.s = c.lane.edge.length;
    c.path = [J, to];
    c.exit = wg.lanesFrom(wg.edgeBetween(J, to)!, J)[0]!;
    return wg.carPos(c);
  };
  const d = dist(at(S!, W!), at(Nn!, E!));
  if (d < 8) fail(`opposite lefts: drawn ${d.toFixed(1)}px apart at the node`);
}
// Old saves: a roundabout was one node with a size; it loads as a ring of that size, a smaller one where an arm is too short for it,
// with its arms joined and no 'roundabout' node left
{
  const w = blank(), wg = w.graph, J = wg.addNode(800, 800), K = wg.addNode(300, 300);
  const H = [[800, 500], [1100, 800], [800, 1100], [500, 800]].map(([x, y], i) => town(w, x, y, 'home', i === 0));
  for (const h of H) w.commitPath(w.planPath([h, J], 0, DEFAULT_TYPE));
  for (const [x, y] of [[330, 300], [300, 100], [100, 300]]) w.commitPath(w.planPath([K, { x, y }], 0, DEFAULT_TYPE));
  const d = JSON.parse(serialize(w)) as { nodes: { control: string; ring: number }[]; edges: { ring?: number }[]; rings?: unknown };
  delete d.rings;
  for (const e of d.edges) delete e.ring;
  Object.assign(d.nodes[wg.nodes.indexOf(J)]!, { control: 'roundabout', ring: 1 });
  Object.assign(d.nodes[wg.nodes.indexOf(K)]!, { control: 'roundabout', ring: 2 });
  const v = deserialize(JSON.stringify(d)), sizes = v.graph.rings.map(r => r.hub.ring).sort();
  const homes = v.buildings.filter(b => b.kind === 'home').map(b => b.node);
  if (sizes.join() !== '0,1' || v.graph.nodes.some(n => n.control === 'roundabout') || homes.some(a => homes.some(b => a !== b && !findPath(v.graph, a, b, null, true))))
    fail(`old save: roundabouts loaded as rings of sizes ${sizes}`);
  for (let t = 0; t < 10 * 60; t++) { v.update(DT); invariants(v); }
}
// Zones: a street painted both ways pays ZONE_COST a lot; at Residential demand (a fresh town: R >= 0.5) homes grow on the lots of the
// street the town reaches, none on an unconnected street (no access); with a job shortage (R <= 0) none grow; erasing empty lots
// refunds them. Gridlock (every street at heat 1, trips giving up) abandons a home after DOWN_H hours with a cause, good traffic for
// RECOVER_H brings it back, another DOWN_H of gridlock while abandoned clears it and leaves its lot zoned. Lots and growth save and load.
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.demandOff = true;
  w.tutorialActive = false;
  w.commitPath(w.planPath([{ x: 100, y: 500 }, { x: 1100, y: 500 }], 0, street));
  w.commitPath(w.planPath([{ x: 100, y: 900 }, { x: 1100, y: 900 }], 0, street));
  w.startPlacing('office');
  w.placeBuilding({ x: 1050, y: 540 });
  const O = w.buildings[0], m0 = w.money, p = planZone(w, { x: 150, y: 500 }, { x: 850, y: 500 }, 'home')!;
  if (!O.connected || !p?.ok || p.add.length < 36 || p.cost !== p.add.length * TUNING.ZONE_COST.home) fail(`zones: ${p?.add.length} lots for $${p?.cost} (${p?.reason})`);
  commitZone(w, p);
  if (w.money !== m0 - p.cost || w.lots.length !== p.add.length) fail(`zones: paid $${m0 - w.money} for ${w.lots.length} lots`);
  if (planZone(w, { x: 150, y: 500 }, { x: 850, y: 500 }, 'shop')!.rezone.length !== p.add.length) fail('zones: painting another zone over the lots does not re-zone them');
  commitZone(w, planZone(w, { x: 150, y: 900 }, { x: 850, y: 900 }, 'home')!);
  const f = w.lots.filter(l => l.y > 700).sort((p, q) => p.x - q.x)[0], inLot = { x: f.x - Math.cos(f.angle) * 5, y: f.y - Math.sin(f.angle) * 5 };
  const m1 = w.money, e = planZone(w, inLot, { x: 300, y: 900 }, 'home')!;
  if (lotAt(w, inLot) !== f || !e.erase.length || e.add.length) fail('zones: a drag from a lot of the held zone does not erase');
  commitZone(w, e);
  if (w.money !== m1 + e.erase.length * TUNING.ZONE_COST.home || w.lots.some(l => e.erase.includes(l))) fail(`zones: erasing ${e.erase.length} lots refunded $${w.money - m1}`);
  const hours = (n: number, each = (): void => {}): void => { for (let i = 0; i < n; i++) { each(); zoneHour(w, w.components()); } };
  hours(8);
  const homes = (): typeof w.buildings => w.buildings.filter(b => b.kind === 'home');
  const grown = homes();
  if (grown.length < 4 || grown.some(b => b.y > 700 || !b.lots.length || b.tier !== 1 || !b.connected)) fail(`zones: ${grown.length} homes grew, ${grown.filter(b => b.y > 700).length} off the town's roads`);
  if (grown.some(b => Math.abs(b.residents - b.cap * TUNING.PLACED_OCC) > 1e-9)) fail('zones: a grown home did not move in PLACED_OCC full');
  // a job shortage: R falls to 0 or below and nothing more grows
  grown[0].residents = 400;
  hours(1);
  const n0 = homes().length;
  hours(8);
  if (w.demand.home > 0 || homes().length !== n0) fail(`zones: R ${w.demand.home.toFixed(2)} grew ${homes().length - n0} homes`);
  grown[0].residents = grown[0].cap * TUNING.PLACED_OCC;
  // gridlock: every street at heat 1 and every recent trip given up
  const H = grown[1], lot = H.lots[0];
  const jam = (): void => { for (const x of w.graph.edges) x.heat = 1; for (const b of w.buildings) b.recent = [{ at: w.time, score: 0, shop: false }]; };
  const flow = (): void => { for (const x of w.graph.edges) x.heat = 0; for (const b of w.buildings) b.recent = [{ at: w.time, score: 1, shop: false }]; };
  hours(TUNING.DOWN_H - 1, jam);
  if (H.abandoned || H.downH !== TUNING.DOWN_H - 1 || !H.cause) fail(`gridlock: after ${TUNING.DOWN_H - 1} h abandoned ${H.abandoned}, countdown ${H.downH}, cause ${H.cause?.text}`);
  hours(1, jam);
  if (!H.abandoned || H.residents || H.jobs || w.commuters.some(c => c.home === H && c.at === 'home') || !w.message.includes('abandoned')) fail(`gridlock: not abandoned after DOWN_H (${w.message})`);
  hours(TUNING.RECOVER_H, flow);
  if (H.abandoned || H.residents !== H.cap * TUNING.PLACED_OCC) fail('gridlock: no recovery after RECOVER_H of good traffic');
  hours(2 * TUNING.DOWN_H, jam);
  if (w.buildings.includes(H) || !w.lots.includes(lot) || lot.building || lot.zone !== 'home') fail('gridlock: an abandoned home was not cleared back to a zoned lot');
  const json = serialize(w), v = deserialize(json);
  if (serialize(v) !== json || v.lots.length !== w.lots.length || v.lots.some(l => l.building && !l.building.lots.includes(l))) fail('zones: lots do not round-trip');
  // an older save has no lots: each building gets one of its zone under it
  const d = JSON.parse(json) as { lots?: unknown; buildings: { tier?: number }[] };
  delete d.lots;
  for (const b of d.buildings) delete b.tier;
  const old = deserialize(JSON.stringify(d));
  if (old.buildings.some(b => b.kind !== 'gate' && (b.tier || b.lots.length !== 1 || b.lots[0].zone !== b.kind)) || old.lots.length !== old.buildings.length) fail('zones: an old save did not get its lots');
}
// Tiers: houses on adjacent lots of a street; one with good access, full and happy for UPGRADE_H hours grows into townhouses onto the
// lot beside it, the house there merging in (its residents move in), its door at the middle of the two lots and its driveway laid again;
// with the tier locked it never counts. DOWN_H hours of gridlock shrink it back to a house on one lot, the other lot left empty and zoned.
// The tiers and specials save and load.
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.demandOff = true;
  w.tutorialActive = false;
  w.commitPath(w.planPath([{ x: 100, y: 500 }, { x: 900, y: 500 }], 0, street));
  commitZone(w, planZone(w, { x: 400, y: 500 }, { x: 600, y: 500 }, 'home')!);
  const row = w.lots.filter(l => l.y < 500).sort((p, q) => p.x - q.x), H = grow(w, row[2]), N = grow(w, row[3]);
  w.lots = [row[2], row[3]];
  w.connect();
  const good = (): void => {
    for (const x of w.graph.edges) x.heat = 0;
    for (const b of w.buildings) { b.recent = [{ at: w.time, score: 1, shop: false }]; b.happy = 80; b.residents = b.cap; }
    w.spawnAcc.home = -1e9;
  };
  const hours = (n: number, each: () => void): void => { for (let i = 0; i < n; i++) { each(); zoneHour(w, w.components()); } };
  w.cfg = { ...w.cfg, unlock: 1 };
  hours(T_UP + 2, good);
  if (H.tier !== 1 || H.upH) fail(`tiers: a locked tier counted (${H.upH} h, tier ${H.tier})`);
  w.cfg = { ...w.cfg, unlock: undefined };
  hours(T_UP - 1, good);
  if (H.tier !== 1 || H.upH !== T_UP - 1) fail(`tiers: upgraded early or did not count (${H.upH} h)`);
  const door0 = { ...H.node };
  hours(1, good);
  const mid = { x: (row[2].x + row[3].x) / 2, y: (row[2].y + row[3].y) / 2 };
  if (H.tier !== 2 || H.label !== 'Townhouses' || H.lots.length !== 2 || w.buildings.includes(N) || row[3].building !== H) fail(`tiers: no merge (tier ${H.tier}, ${H.lots.length} lots)`);
  if (H.residents !== 2 * TIER_DEFS.home[0].residents || !H.connected || dist(H.door(), mid) > 0.5 || dist(H.node, door0) < 5) fail(`tiers: merged ${H.residents} residents, door ${dist(H.door(), mid).toFixed(1)}px off the lots' middle`);
  const json = serialize(w), v = deserialize(json);
  if (serialize(v) !== json || v.buildings.find(b => b.tier === 2)?.lots.length !== 2) fail('tiers: a tier-2 building does not round-trip');
  const jam = (): void => { for (const x of w.graph.edges) x.heat = 1; for (const b of w.buildings) b.recent = [{ at: w.time, score: 0, shop: false }]; };
  hours(TUNING.DOWN_H, jam);
  if (H.tier !== 1 || H.lots.length !== 1 || H.residents > H.cap || [row[2], row[3]].filter(l => l.building).length !== 1 || w.lots.length !== 2 || !H.connected || !w.message.includes('shrank')) fail(`tiers: no downgrade (tier ${H.tier}, ${H.lots.length} lots)`);
}
// Trips a day per tier (both legs, counted on day 2 of a street town): each home tier within ±30% of the spec table (game-v3 3), and a
// factory sends more than a workshop, a logistics park more than a factory
{
  const day2 = (kind: Zone, tier: number): number => {
    const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
    w.tutorialActive = false;
    w.commitPath(w.planPath([{ x: 100, y: 500 }, { x: 1500, y: 500 }], 0, street));
    const at = (k: Zone, x: number, t: number, up = false) => w.addBuilding(buildingAt(k, { x, y: up ? 480 : 520 }, up ? Math.PI / 2 : -Math.PI / 2, t));
    const B = at(kind, 700, tier);
    if (kind === 'home') { at('office', 250, 2, true); at('office', 1150, 2, true); at('shop', 1400, 1, true); }
    else { at('home', 300, 4, true).residents = 320; at('home', 1100, 4, true).residents = 320; at('shop', 1400, 2, true); }
    w.connect();
    let n = 0;
    const q = w.queueTrip.bind(w);
    w.queueTrip = (f, t, p, back, who) => { if (w.day === 2 && (f === B || t === B) && (kind === 'home' || p === 'freight')) n++; return q(f, t, p, back, who); };
    while (w.day < 3) { if (kind === 'home') B.residents = B.cap; w.update(DT * 2); }
    return n;
  };
  const table = [10, 24, 54, 108];
  table.forEach((x, i) => { const n = day2('home', i + 1); if (Math.abs(n - x) > 0.3 * x) fail(`trips: ${TIER_DEFS.home[i].name} made ${n} trips a day, the table says ~${x}`); });
  const trucks = [1, 2, 3].map(t => day2('industry', t));
  if (!(trucks[1] > trucks[0] && trucks[2] > trucks[1])) fail(`trips: trucks a day by industrial tier ${trucks}`);
}
// Specials: set down beside a street with the place tool, each paid for and adding its upkeep. A second stadium, a third plaza, a second
// hospital under 4,000 residents and a terminal with no linked exit are refused, a terminal far from the exit too, one near it goes;
// demolishing refunds SPECIAL_REFUND. A hospital's call drives an ambulance to the home and back; on a match day fans set off for the
// stadium before kickoff and pay for arriving on time.
{
  const w = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  w.tutorialActive = false;
  w.demandOff = true;
  w.terrain.exits = [{ door: { x: 0, y: 500 }, end: { x: 160, y: 500 }, angle: 0 }];
  w.addExits();
  w.commitPath(w.planPath([{ x: 300, y: 500 }, { x: 1900, y: 500 }], 0, street));
  const place = (s: Special, x: number, y: number): string => {
    w.startPlacing(s);
    const p = w.planPlace({ x, y })!;
    if (p.ok) w.placeBuilding({ x, y });
    return p.reason;
  };
  const m0 = w.money, u0 = w.upkeepPerDay();
  for (const [s, x, y] of [['stadium', 500, 560], ['plaza', 800, 440], ['plaza', 1000, 440], ['hospital', 1300, 440]] as const) {
    const why = place(s, x, y);
    if (why) fail(`specials: ${s} refused: ${why}`);
  }
  const cost = SPECIALS.stadium.cost + 2 * SPECIALS.plaza.cost + SPECIALS.hospital.cost, up = SPECIALS.stadium.upkeep + 2 * SPECIALS.plaza.upkeep + SPECIALS.hospital.upkeep;
  if (w.money !== m0 - cost || Math.abs(w.upkeepPerDay() - u0 - up) > 1e-9 || w.buildings.filter(b => b.special).some(b => !b.connected)) fail(`specials: paid $${m0 - w.money}, upkeep +${w.upkeepPerDay() - u0}`);
  for (const [s, x, y, want] of [['stadium', 1700, 560, 'One stadium'], ['plaza', 1600, 440, 'At most 2'], ['hospital', 1500, 560, 'One hospital'], ['terminal', 400, 440, 'Link a highway']] as const) {
    const why = place(s, x, y);
    if (!why.startsWith(want)) fail(`specials: a ${s} was ${why ? `refused for '${why}'` : 'placed'}`);
  }
  w.commitPath(w.planPath([{ x: 160, y: 500 }, { x: 300, y: 500 }], 0, street));
  if (!place('terminal', 1500, 560).startsWith('Build it within') || place('terminal', 330, 560)) fail('specials: the terminal ignored the exit distance');
  const P = w.buildings.find(b => b.special === 'plaza')!, m1 = w.money;
  w.tryDemolish(P);
  if (w.buildings.includes(P) || w.money !== m1 + SPECIALS.plaza.cost * TUNING.SPECIAL_REFUND) fail(`specials: demolish refunded $${w.money - m1}`);
  // an emergency call: the ambulance drives out and back, fast enough on empty roads to cheer the street
  const home = w.addBuilding(buildingAt('home', { x: 1600, y: 480 }, Math.PI / 2, 1)), hosp = w.buildings.find(b => b.special === 'hospital')!;
  w.connect();
  w.demandOff = false;
  w.queueTrip(hosp, home, 'emergency');
  let amb = false;
  for (let t = 0; t < 60 * 60 && !w.reports.some(r => r.purpose === 'emergency' && r.back); t++) { w.update(DT); amb ||= w.cars.some(c => c.kind === 'ambulance'); }
  if (!amb || !w.reports.some(r => r.purpose === 'emergency' && r.back) || home.cheer <= w.time) fail(`specials: emergency call (ambulance ${amb}, cheer ${home.cheer.toFixed(0)})`);
  // match day: day 2 at 17:00 the first half of the fans set off; one arriving before kickoff pays FAN_PAY
  home.residents = home.cap;
  const st = w.buildings.find(b => b.special === 'stadium')!, fans = Math.round(Math.min(TUNING.FANS_MAX, TUNING.FANS + w.population / TUNING.FANS_POP));
  w.time = (24 + TUNING.KICKOFF - 2 - TUNING.START_HOUR) * HOUR + DT;
  w.lastHour = 24 + TUNING.KICKOFF - 3;
  w.update(DT);
  const going = w.buildings.reduce((n, b) => n + b.pending.filter(t => t.to === st && t.purpose === 'visit').length, 0) + w.cars.filter(c => c.trip.to === st).length;
  if (w.day !== 2 || Math.abs(going - fans / 2) > 1) fail(`specials: ${going} fans set off, expected ${fans / 2}`);
  const b0 = w.ledger.today.business + w.ledger.today.trade;
  for (let t = 0; t < 30 * 60; t++) w.update(DT);
  if (!w.reports.some(r => r.to === st && r.purpose === 'visit') || w.ledger.today.business + w.ledger.today.trade - b0 < TUNING.FAN_PAY) fail('specials: no fan arrived or paid');
}
// Bank: below $0 on the hour a career city borrows LOAN_STEP at a time up to the cap, then it is frozen (zoning refused); interest is
// charged hourly; Repay pays LOAN_STEP back. Creative never borrows.
{
  const hour = (g: Game): void => { g.time = (Math.floor(g.clock) + 1 - TUNING.START_HOUR) * HOUR - DT / 2; g.update(DT); };
  const w = blank(), cap = TUNING.LOAN_CAP * DIFFICULTY[SIM.difficulty].money / 40000;
  w.tutorialActive = false;
  w.demandOff = true;
  w.money = -1;
  hour(w);
  if (w.loan !== TUNING.LOAN_STEP || w.money < TUNING.LOAN_STEP - 2) fail(`bank: loan ${w.loan}, money ${w.money}`);
  for (let i = 0; i < 10; i++) { w.money = -1; hour(w); }
  if (w.loan !== cap || !w.frozen) fail(`bank: loan ${w.loan} of ${cap}, frozen ${w.frozen}`);
  w.commitPath(w.planPath([{ x: 100, y: 500 }, { x: 600, y: 500 }], 0, { tier: 'street', lanes: 1, oneWay: false }), true, 0);
  if (planZone(w, { x: 150, y: 500 }, { x: 500, y: 500 }, 'home')?.ok) fail('bank: zoning while frozen');
  w.money = 20000;
  const i0 = w.ledger.today.interest;
  hour(w);
  if (Math.abs(w.ledger.today.interest - i0 - cap * TUNING.LOAN_RATE / 24) > 1e-6) fail(`bank: interest ${w.ledger.today.interest - i0}`);
  const m = w.money;
  if (!w.repay() || w.loan !== cap - TUNING.LOAN_STEP || w.money !== m - TUNING.LOAN_STEP || w.frozen) fail(`bank: repay left ${w.loan}`);
  const c = blank();
  c.cfg = { ...SIM, mode: 'creative' };
  c.money = -1;
  hour(c);
  if (c.loan) fail('bank: creative borrowed');
}
// Campaign (G3): every map builds on its own seed with a starter town, the same terrain in Challenge, its start money (x0.7 in
// Challenge) and its map's tools; a scripted city grades ★ / ★★ / ★★★ by objectives, flow and spend; the first time the goals hold the
// hour's check raises Map complete once and reports the grade, a better one at midnight reports again; profile stars open maps and
// Endless tools, and the profile round-trips and survives junk; Challenge roads are permanent after their day, and a missed deadline
// or a gridlocked day ends it; a v1 'career' save loads as Endless and the run state round-trips
{
  for (const [i, m] of MAPS.entries()) {
    const c = new Game(cfgFor(m, 'campaign')), h = new Game(cfgFor(m, 'challenge'));
    if (JSON.stringify(c.terrain) !== JSON.stringify(h.terrain)) fail(`campaign: ${m.name} Challenge terrain differs`);
    if (c.buildings.filter(b => b.kind === 'home').length < 4) fail(`campaign: ${m.name} has no starter town`);
    const exits = c.terrain.exits.length;
    if (exits < m.terrain.exits[0] || exits > m.terrain.exits[1]) fail(`campaign: ${m.name} has ${exits} exits`);
    if (c.money !== m.money || Math.abs(h.money - m.money * CHALLENGE_MONEY) > 1e-6 || c.unlockLevel !== i + 1 || h.cfg.difficulty !== 'hard') fail(`campaign: ${m.name} money ${c.money} tools ${c.unlockLevel}`);
  }
  const c1 = new Game(cfgFor(MAPS[0], 'campaign'));
  if (!c1.lockOf('roundabout') || c1.tierUnlocked('avenue') || c1.unlocked(TIER_DEFS.industry[0].level)) fail('campaign: map 1 has map 3 tools');
  c1.setZone('industry');
  if (c1.zone === 'industry') fail('campaign: map 1 zoned workshops');
  if (new Game(cfgFor(MAPS[2], 'campaign')).lockOf('roundabout')) fail('campaign: map 3 has no roundabouts');

  const hour = (g: Game): void => { g.time = (Math.floor(g.clock) + 1 - TUNING.START_HOUR) * HOUR - DT / 2; g.update(DT); };
  const m = MAPS[1], w = blank();
  w.cfg = cfgFor(m, 'campaign');
  w.tutorialActive = false;
  w.demandOff = true;
  const H = town(w, 300, 300).building!;
  const slot = (Math.floor(w.hour) + 5) % 24;
  const set = (pop: number, perHour: number, trips: number, smooth: number, spent: number): void => {
    H.residents = pop;
    w.run.h.arrived[(Math.floor(w.hour) + 23) % 24] = perHour;
    w.run.h.trips[slot] = trips;
    w.run.h.smooth[slot] = smooth;
    w.run.spent = spent;
  };
  const stars = (): number => grade(w, m).stars;
  set(600, 25, 100, 80, 15000);
  if (stars() !== 3) fail(`grade: ${stars()} stars for a city meeting everything`);
  set(600, 25, 100, 80, m.budget + 1);
  if (stars() !== 2) fail(`grade: ${stars()} stars over budget`);
  set(600, 25, 100, 60, 0);
  if (stars() !== 1) fail(`grade: ${stars()} stars under the flow bar`);
  set(599, 25, 100, 100, 0);
  if (stars() !== 0) fail(`grade: ${stars()} stars short of population`);
  set(600, 24, 100, 100, 0);
  if (stars() !== 0 || grade(w, m).met.join() !== 'true,false') fail(`grade: ${stars()} stars short of trips/h`);
  // the hourly check: Map complete once, the grade reported; spend is network only (zoning excluded)
  const p = MAPS[0], v = blank(), got: number[] = [];
  v.cfg = cfgFor(p, 'campaign');
  v.tutorialActive = false;
  v.demandOff = true;
  v.onGrade = r => got.push(r.stars);
  const V = town(v, 300, 300).building!;
  v.run.spent = p.budget + 1;
  v.spend(500, false);
  if (v.run.spent !== p.budget + 1) fail('grade: zoning counted as network spend');
  V.residents = p.objectives[0].target;
  const fs = (Math.floor(v.hour) + 5) % 24;
  v.run.h.trips[fs] = 100;
  v.run.h.smooth[fs] = 90;
  hour(v);
  if (!v.pendingGrade || v.pendingGrade.stars !== 2 || got.join() !== '2' || !v.run.done || !v.modal) fail(`grade: Map complete ${JSON.stringify(v.pendingGrade)} reported ${got}`);
  v.pendingGrade = null;
  hour(v);
  if (v.pendingGrade || got.length !== 1) fail('grade: Map complete raised twice');
  v.run.spent = 0;
  // the counters roll as the hours pass: refill them in a slot the midnight hour does not drop
  while (v.hour < 23) hour(v);
  v.run.h.trips[5] = 100;
  v.run.h.smooth[5] = 90;
  hour(v);
  if (got.join() !== '2,3' || v.run.stars !== 3 || v.pendingGrade) fail(`grade: midnight regrade reported ${got}`);

  // profile: stars open maps and Endless tools; best grades kept; junk and round-trip
  const pr = profile0();
  if (!mapOpen(pr, MAPS[0]) || mapOpen(pr, MAPS[1]) || toolLevel(pr) !== 1) fail('profile: a new profile opens more than map 1');
  const g2 = (s: number, day = 5, efficiency = 100) => ({ stars: s, met: [], flow: 0.8, spend: 1000, efficiency, day });
  if (!recordGrade(pr, MAPS[0], g2(1)) || recordGrade(pr, MAPS[0], g2(1, 3, 50)) || pr.best[MAPS[0].id].efficiency !== 100 || pr.best[MAPS[0].id].day !== 3) fail(`profile: best ${JSON.stringify(pr.best)}`);
  if (!mapOpen(pr, MAPS[1]) || mapOpen(pr, MAPS[2]) || toolLevel(pr) !== 1) fail('profile: 1 star opened the wrong maps');
  recordGrade(pr, MAPS[0], g2(3));
  recordGrade(pr, MAPS[1], g2(2));
  recordGrade(pr, MAPS[2], g2(0));
  recordGrade(pr, MAPS[0], g2(1, 9), true);
  recordGrade(pr, MAPS[0], g2(1, 8), true);
  if (totalStars(pr) !== 5 || !mapOpen(pr, MAPS[3]) || mapOpen(pr, MAPS[4]) || toolLevel(pr) !== 2 || pr.stars[MAPS[2].id] !== undefined || pr.challenge[MAPS[0].id] !== 8) fail(`profile: ${JSON.stringify(pr)}`);
  pr.tips.push('tutorial');
  pr.stats.trips = 1234;
  if (JSON.stringify(parseProfile(JSON.stringify(pr))) !== JSON.stringify(pr)) fail('profile: does not round-trip');
  const blankP = JSON.stringify(profile0());
  for (const junk of [null, '', '{', '[]', '{"v":2,"stars":{"meadowbrook":3}}', '"x"']) if (JSON.stringify(parseProfile(junk)) !== blankP) fail(`profile: junk ${junk} gave data`);
  const odd = parseProfile('{"v":1,"stars":{"a":7,"b":"x"},"tips":[1,"t"],"stats":{"trips":"9"}}');
  if (odd.stars.a !== 3 || 'b' in odd.stars || odd.tips.join() !== 't' || odd.stats.trips !== 0) fail(`profile: bad fields kept ${JSON.stringify(odd)}`);

  // Challenge: permanent roads, the deadline, gridlock
  const midnight = (g: Game) => { g.time = ((g.today + 1) * 24 - TUNING.START_HOUR) * HOUR - DT / 2; g.update(DT); };
  const ch = blank(), street: RoadType = { tier: 'street', lanes: 1, oneWay: false };
  ch.cfg = cfgFor(MAPS[0], 'challenge');
  ch.tutorialActive = false;
  ch.demandOff = true;
  ch.commitPath(ch.planPath([{ x: 100, y: 500 }, { x: 600, y: 500 }], 0, street));
  ch.commitPath(ch.planPath([{ x: 100, y: 700 }, { x: 600, y: 700 }], 0, street));
  ch.demolishAt({ x: 350, y: 700 });
  if (ch.graph.edges.length !== 1) fail('challenge: a road built today could not be demolished');
  midnight(ch);
  ch.demolishAt({ x: 350, y: 500 });
  if (ch.graph.edges.length !== 1 || !ch.message.startsWith('Challenge:')) fail('challenge: an older road was demolished');
  while (!ch.gameOver && ch.day < 20) midnight(ch);
  if (ch.gameOver !== 'deadline' || ch.day !== ch.deadline + 1) fail(`challenge: '${ch.gameOver}' on day ${ch.day}, deadline ${ch.deadline}`);
  const gl = blank();
  gl.cfg = cfgFor(MAPS[0], 'challenge');
  gl.tutorialActive = false;
  gl.stats.today.gaveup = 10;
  gl.stats.today.smooth = 30;
  midnight(gl);
  if (gl.gameOver !== '') fail('challenge: a quarter of the trips given up ended it');
  gl.stats.today.gaveup = 41;
  gl.stats.today.smooth = 59;
  midnight(gl);
  if (gl.gameOver !== 'gridlock') fail(`challenge: '${gl.gameOver}' after a day of 41% given up`);

  // saves: the run state round-trips; a v1 'career' save without it loads as Endless with every tool
  v.upgrades = ['crew']; v.tokens = ['plaza']; v.milestone = 2; v.spare = { kind: 'money', amount: 5 }; v.feats = { streak: 7 };
  const json = serialize(v), back = deserialize(json);
  if (back.upgrades.join() !== 'crew' || back.tokens.join() !== 'plaza' || back.milestone !== 2 || back.spare?.kind !== 'money' || back.feats.streak !== 7) fail('save: milestones and feats do not round-trip');
  if (serialize(back) !== json || back.run.stars !== 3 || back.run.spent !== v.run.spent || back.cfg.map !== p.id) fail('save: the campaign run does not round-trip');
  const d = JSON.parse(json) as { cfg: { mode: string; map?: string }; run?: unknown };
  d.cfg = { ...d.cfg, mode: 'career' };
  delete d.cfg.map;
  delete d.run;
  delete (d as { ms?: unknown }).ms;
  const old = deserialize(JSON.stringify(d));
  if (old.cfg.mode !== 'endless' || old.goals || old.unlockLevel !== Infinity || old.run.spent !== 0) fail(`save: an old career save loaded as ${old.cfg.mode}`);
  if (old.milestone !== milestonesAt(old, old.population) || old.offers || old.upgrades.length) fail(`save: an old save's milestones ${old.milestone}`);
}
// Events: roadworks warn for an hour, then shut J-K (a car already routed over it turns off at J and arrives round P-Q, no new route
// uses it), the road reopens when they end; a wreck slows its edge, rain every road; active events round-trip a save; off in Creative
{
  const w = blank(), wg = w.graph, flat: RoadType = { tier: 'avenue', lanes: 1, oneWay: false };
  const X = town(w, 200, 300), Z = town(w, 1000, 300, 'shop', true);
  const J = wg.addNode(400, 300), K = wg.addNode(800, 300), P = wg.addNode(400, 600), Q = wg.addNode(800, 600);
  for (const [a, b] of [[X, J], [J, K], [K, Z], [J, P], [P, Q], [Q, K]]) w.commitPath(w.planPath([a!, b!], 0, flat));
  w.demandOff = true;
  const jk = wg.edgeBetween(J, K)!, ev = startEvent(w, 'roadworks', jk);
  w.queueTrip(X.building!, Z.building!, 'commute');
  for (let t = 0; t < 60 && !w.cars.length; t++) w.update(DT);
  if (!w.cars.length || wg.shut.size || w.cars[0]!.path?.[1] !== K) fail(`events: the car does not set off over J-K during the warning (${w.cars[0]?.path?.map(n => n.id)})`);
  w.time = ev.at;
  w.update(DT);
  if (!wg.shut.has(jk) || findPath(wg, X, Z)?.[2] === K) fail('events: roadworks did not shut J-K');
  for (let t = 0; t < 40 * 60 && !w.score; t++) {
    w.update(DT);
    if (w.cars.some(c => c.lane.edge === jk)) fail('events: a car drove onto the closed road');
  }
  if (w.score !== 1) fail(`events: the trip did not arrive round the roadworks (score ${w.score})`);
  const json = serialize(w), back = deserialize(json), be = back.events[0];
  if (back.events.length !== 1 || be?.kind !== 'roadworks' || be.edge?.a.x !== jk.a.x || be.edge.b.x !== jk.b.x || serialize(back) !== json) fail('events: an active event does not round-trip a save');
  w.time = ev.end;
  w.update(DT);
  if (w.events.length || wg.shut.size || findPath(wg, X, Z)?.[2] !== K) fail('events: the road did not reopen after the roadworks');
  const wreck = startEvent(w, 'accident', jk), rain = startEvent(w, 'rain');
  w.time = rain.at;
  w.update(DT);
  if (wreck.base === null || wg.slow.get(jk) !== WRECK_V || wg.wet !== RAIN_V || wg.speedX(jk) !== WRECK_V * RAIN_V || wg.speedX(wg.edgeBetween(J, P)!) !== RAIN_V) fail('events: a wreck or rain does not slow traffic');
  w.time = rain.end;
  w.update(DT);
  if (w.events.length || wg.wet !== 1 || wg.slow.size) fail('events: the wreck and rain did not end');
  if (eventsOn(new Game({ ...SIM, mode: 'creative' })) || !eventsOn(new Game({ ...SIM, mode: 'creative', events: 'on' })) || !eventsOn(new Game(SIM))) fail('events: the Creative toggle');
  // an old save has no events: none run and the first may start 4 hours on
  const d = JSON.parse(json) as { ev?: unknown; time: number };
  delete d.ev;
  const old = deserialize(JSON.stringify(d));
  if (old.events.length || old.nextEventAt !== d.time + 4 * HOUR) fail('events: an old save loads with events');
}
// G7 undo: a build bumps edits; restoring the pre-build save in place takes the road and its cost back on the same Game object.
// Juice: a road that jammed and cooled throws one 'clear' sparkle and chime; income pops a coin
{
  const w = blank(), a = { x: 100, y: 500 }, b = { x: 500, y: 500 }, before = serialize(w), m0 = w.money, e0 = w.edits;
  w.commitPath(w.planPath([a, b], 0, { tier: 'avenue', lanes: 1, oneWay: false }));
  if (w.edits === e0 || !w.graph.edges.length || w.money === m0) fail('undo: a build did not count as an edit');
  const self = w, tool = w.tool = 'demolish';
  restore(w, before);
  if (w !== self || w.graph.edges.length || w.money !== m0 || w.tool !== tool || w.edits === e0) fail('undo: restore did not rewind the build in place');
  w.commitPath(w.planPath([a, b], 0, { tier: 'avenue', lanes: 1, oneWay: false }));
  const e = w.graph.edges[0];
  e.heat = 0.95;
  w.update(DT);
  e.heat = 0.1;
  w.sfx.clear();
  for (let t = 0; t < 70; t++) w.update(DT);
  if (w.fx.filter(f => f.kind === 'clear').length !== 1 || !w.sfx.has('clear')) fail('juice: a cleared jam did not sparkle and chime');
  for (let t = 0; t < 3 * 60; t++) w.update(DT);
  if (w.fx.length) fail('juice: fx did not age out');
}
const out = game.reports.reduce<Record<string, number>>((o, r) => (o[r.outcome] = (o[r.outcome] ?? 0) + 1, o), {});
console.log(`SIMCHECK OK: t=${game.time.toFixed(0)}s day=${game.day} score=${game.score} cars=${game.cars.length} maxCars=${maxCars} `
  + `pending=${game.buildings.reduce((n, b) => n + b.pending.length, 0)} commutes=${commutes.length} outcomes=${JSON.stringify(out)}`);
process.exit(0);
