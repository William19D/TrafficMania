import type { Game, Overlay, Tool } from '../core/Game.ts';
import type { Ledger, PathPlan } from '../core/Game.ts';
import { CONTROL_LABEL, HOUR, TOOL_LOCK, fmtMin, jamAt, fmtMoney, levelBatch, levelPop, levelUnlocks, ZONE_KEYS } from '../core/Game.ts';
import type { Sample } from '../core/Metrics.ts';
import { ICHG, ICHG_KEYS } from '../core/Templates.ts';
import type { Ichg } from '../core/Templates.ts';
import { DIFFICULTY, ENDLESS_POP, LEVELS, PURPOSES, TIERS, ZONES, TUNING as T } from '../core/config.ts';
import type { Purpose, Site, Tier, Zone } from '../core/config.ts';
import type { Building } from '../entities/Building.ts';
import type { Car, Kind } from '../entities/Car.ts';
import type { TripReport } from '../entities/Trip.ts';
import type { Vec } from '../util/geom.ts';
import type { Control, RoadType } from '../network/RoadGraph.ts';
import type { Move, Preset } from '../network/Junction.ts';
import { MAX_PHASES, PHASE_MAX, PHASE_MIN, addPhase, applyPreset, approachOf, cycleSig, mainEdges, planOf, removePhase, setSeconds, toggleBan } from '../network/Junction.ts';
import { icon } from './icons.ts';
import { KEY_TOOLS } from './Input.ts';

// Dock tools; the number keys follow the dock order (Input's KEY_TOOLS)
const TOOLS: Record<Tool, { label: string; tip: string }> = {
  road: { label: 'Road', tip: 'Click start, click end. Hold the end and drag to bend. V: straight or curved, Shift: straight once, Ctrl: 15° steps. Esc cancels.' },
  grid: { label: 'Grid', tip: 'Street grid: click a corner, click the end of the first side (any angle), then click how deep. Uses the road type; pick the block size beside it.' },
  light: { label: 'Light', tip: `Click an intersection (3+ roads). ${fmtMoney(T.LIGHT_COST)}, ${fmtMoney(T.LIGHT_UPKEEP)}/day. Edit it for phases and turn bans.` },
  roundabout: { label: 'Roundabout', tip: `Click an intersection. Lets 3 cars through at once. ${fmtMoney(T.ROUNDABOUT_COST)}, ${fmtMoney(T.ROUNDABOUT_UPKEEP)}/day.` },
  interchange: { label: 'Interchange', tip: 'Click a junction to turn it into a diamond, cloverleaf (4 roads) or trumpet (3 roads). The ghost shows it and its price before you build.' },
  place: { label: 'Buildings', tip: 'Place buildings from the tray. Near a road they face it and get a free driveway; R turns a free one. Esc stops.' },
  edit: { label: 'Edit', tip: `Click a car to follow it, a building for its details, a junction for its control, light phases and turn bans, or a road to change its type. Drag a road to bend it, a building to move it (${fmtMoney(T.MOVE_COST)}).` },
  demolish: { label: 'Demolish', tip: 'Click a road, sign, light, roundabout or building to remove it. Roads refund 100% on the day you built them, 50% later; a building goes back to the tray (an occupied one takes a second click).' },
};
const keyOf = (t: Tool): string => t === 'place' ? 'B' : String(KEY_TOOLS.indexOf(t) + 1);
// Tray picture of a zone: a small front view in its map colours (house, shop with an awning, office tower, factory)
const ZONE_PIC: Record<Site, (f: string, o: string, r: string) => string> = {
  home: (f, o, r) => `<path d="M5 11h14v10H5z" fill="${f}"/><path d="M2.5 12 12 4l9.5 8z" fill="${r}"/><path d="M10 15h4v6h-4z" fill="${o}"/>`,
  shop: (f, o, r) => `<path d="M3 10h18v11H3z" fill="${f}"/><path d="M2 6h20v4H2z" fill="${r}"/><path d="M7 6v4M12 6v4M17 6v4" stroke="${o}"/><path d="M6 13h7v4H6zM15 13h3v8h-3z" fill="#fff"/>`,
  office: (f, o, r) => `<path d="M6 3h12v18H6z" fill="${f}"/><path d="M6 3h12v3H6z" fill="${r}"/><path d="M9 9h2M13 9h2M9 12.5h2M13 12.5h2M9 16h2M13 16h2" stroke="#fff" stroke-width="2"/>`,
  industry: (f, o, r) => `<path d="M16 3h3v18h-3z" fill="${o}"/><path d="M2 21V11l5-4v4l5-4v4l4-3v13z" fill="${f}"/><path d="M5 14h2M9.5 14h2" stroke="${r}" stroke-width="2"/>`,
  gate: (f, o) => `<path d="M11 13h2v8h-2z" fill="${o}"/><path d="M3 4h18v9H3z" fill="${f}"/><path d="M7 8.5h8M12.5 6l2.5 2.5-2.5 2.5" stroke="#fff"/>`,
};
const zonePic = (z: Site): string => {
  const { fill, out, roof } = ZONES[z];
  return `<svg class="zpic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="${out}" stroke-width="1.5" stroke-linejoin="round">${ZONE_PIC[z](fill, out, roof)}</svg>`;
};
const count = (n: number): string => n === Infinity ? '∞' : String(n);

const ONEWAY_TIP = 'One-way: half the price, cars only drive in the direction you build';
const laneTip = (n: number) => `${n} lane${n > 1 ? 's' : ''} per direction. Price ×${n}`;
const TIER_KEYS = Object.keys(TIERS) as Tier[];
// Avenue · 50 km/h · 1-2 lanes · $90/tile
const tierTip = (t: Tier): string => {
  const x = TIERS[t], l = x.lanes;
  return `${x.label} · ${x.kmh} km/h · ${l[0]}${l.length > 1 ? `-${l[l.length - 1]}` : ''} lane${l[l.length - 1] > 1 ? 's' : ''} · ${fmtMoney(x.cost)}/tile`
    + (x.access ? '' : ' · no building access');
};
// Dock swatch of a tier: a short band, taller up the hierarchy, with the tier's centre marking
function tierPic(t: Tier): string {
  const h = 8 + 2 * TIER_KEYS.indexOf(t), x = TIERS[t];
  const line = x.line === 'yellow' ? '<path d="M8 12h24" stroke="#E6C84B"/>'
    : x.line === 'median' ? '<path d="M8 12h24" stroke="#BFD8A0" stroke-width="2.5"/>'
    : x.line === 'double' ? '<path d="M8 11h24M8 13h24" stroke="#A3A39F" stroke-width="1"/>' : '';
  return `<rect x="6" y="${12 - h / 2}" width="28" height="${h}" rx="1.5" fill="${x.fill}" stroke="${x.out}"/>${line}`;
}

const GRID_SIZES = [3, 4, 6] as const;
// Road tool shape, one toggle showing the active mode (a two-button segment did not fit the dock at 1280px)
const RMODE_TIP = {
  straight: 'Straight roads: they run straight from click to click. Click for curves',
  curve: 'Curved roads: they bend to meet the roads they join smoothly; hold Shift for a straight one. Click for straight',
};

const SPEEDS: { s: 0 | 1 | 2 | 4; icon: string; lbl: string; tip: string; key?: string }[] = [
  { s: 0, icon: 'pause', lbl: 'II', tip: 'Pause', key: 'Space' },
  { s: 1, icon: 'play', lbl: '1x', tip: 'Normal speed' },
  { s: 2, icon: 'fast', lbl: '2x', tip: 'Fast' },
  { s: 4, icon: 'faster', lbl: '4x', tip: 'Fastest' },
];

// Game messages rewritten to say what to do
const FRIENDLY: Record<string, string> = {
  'Not enough money': 'Not enough money: wait for income or demolish a road built today for a full refund',
  'Too low for the mountain': 'Too low: raise to L6+ or use Ground (L0) to dig a tunnel',
  'Already exists': 'That road already exists: start or end somewhere new',
  'Invalid terrain': 'Roads cannot start or end in water or on a mountain',
  'Place on an intersection': 'Click a junction where 3 or more roads meet',
  'Highways give no building access': 'Highways give no building access: join buildings with a street or avenue to a junction on the highway',
  'Blocked by a building': 'Roads cannot run through a building: go around it, or end at its door',
  'Overlaps a road': 'Buildings cannot stand on a road: move it beside the road',
  'Too steep: make the ramp longer': 'Too steep: a ramp climbs one level per tile, make it longer',
  'Buildings need a ground road': 'Buildings need a ground road: come down to the ground before the door',
  'Nearby roads are in the way': 'Nearby roads are in the way: an interchange needs clear land around the junction',
};
const ERROR_RE = /^(Not enough|Too low|Too steep|Invalid|Already|Place on|Highways give|Unlocks at|Blocked|Overlaps|Outside|None left|No buildings|Buildings need|Nearby|Needs|Interchanges|Upgrade|The roads|A cloverleaf|\w+ needs a junction)/;

const kbd = (t: Tool): string => `<kbd>${keyOf(t)}</kbd>`;
export const CONTROLS: [string, string][] = [
  [KEY_TOOLS.map(t => TOOLS[t].label).join(' / '), KEY_TOOLS.map(kbd).join(' ')],
  ['Place buildings (again: next kind) / turn one', '<kbd>B</kbd> / <kbd>R</kbd>'],
  ['Place road', 'click start, click end'],
  ['Bend road', 'hold on the end point and drag'],
  ['Straight / curved roads', '<kbd>V</kbd> switches; hold <kbd>Shift</kbd> for one straight road'],
  ['Road angle in 15° steps', 'hold <kbd>Ctrl</kbd> or <kbd>Alt</kbd> while placing'],
  ['Cancel road', '<kbd>Esc</kbd> or right-click'],
  ['Road type', 'tier (dirt to highway), lanes 1 / 2 / 3 and One-way in the dock: new roads, or the road selected with Edit'],
  ['Raise / lower road', '<kbd>PageUp</kbd> / <kbd>PageDown</kbd> or <kbd>+</kbd> / <kbd>-</kbd>'],
  ['Ramp', 'start or end a road on a road of another level: it climbs one level per tile'],
  ['Street grid', `${kbd('grid')}: click a corner, the end of the first side, then the depth`],
  ['Interchange', `${kbd('interchange')}: click a junction, pick a type, then Build`],
  ['Edit road', `${kbd('edit')}, click to select, drag to bend`],
  ['Edit junction', `${kbd('edit')}, click a junction: control, light phases, turn bans`],
  ['Follow a car / building details', `${kbd('edit')}, click it; <kbd>Esc</kbd> stops`],
  ['Move / demolish a building', `${kbd('edit')}, drag it (<kbd>Esc</kbd> puts it back) / ${kbd('demolish')}, click it`],
  ['Heat map / noise and pollution', '<kbd>C</kbd> switches the overlay'],
  ['Metrics / trip reports', '<kbd>M</kbd> / <kbd>T</kbd>'],
  ['Pause / resume', '<kbd>Space</kbd>'],
  ['Menu: save, load, quit', '<kbd>Esc</kbd> with nothing to cancel'],
  ['Zoom / pan', 'wheel / right- or middle-drag'],
  ['Help', '<kbd>?</kbd>'],
];

const ROAD_TIP = 'Road elevation: Ground or viaduct L1-L10';

// Junction panel
const CONTROL_KEYS = Object.keys(CONTROL_LABEL) as Control[];
const CONTROL_TIP: Record<Control, string> = {
  none: 'No control: one car at a time, first come first served',
  yield: 'Yield signs: the main road (highest tier) has right of way, side roads give way',
  stop: 'All-way stop: every car stops at the line, then one at a time',
  light: 'Traffic light: phases you can edit, protected lefts',
  roundabout: 'Roundabout: up to 3 cars at once, no stopping when it is clear',
};
const MOVES = ['Left', 'Straight', 'Right'];
const PRESETS: [Preset, string, string][] = [
  ['two', '2 phases', 'One phase per axis, lefts give way to oncoming traffic'],
  ['lefts', 'Protected lefts', '4 phases: per axis a protected-left phase, then straight and right'],
  ['each', 'One at a time', 'Each approach gets its own phase'],
];
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
const compass = (a: number): string => COMPASS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
const pad = (n: number) => String(n).padStart(2, '0');

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// ---------- analysis: trip reports, the car card, metrics ----------
// A trip or its report: where it goes (a commute out goes to work, a highway exit is out of town) and what it is called
interface Leg { purpose: Purpose; back: boolean; from: Building; to: Building }
const PLACE: Record<Site, string> = { home: 'home', shop: 'the shop', office: 'the office', industry: 'the factory', gate: 'the highway' };
const destOf = (t: Leg): string => t.purpose === 'commute' && !t.back && t.to.kind !== 'gate' ? 'work' : PLACE[t.to.kind];
const NAME: Record<Purpose, string> = { commute: 'Commute', shop: 'Shopping trip', freight: 'Delivery', visit: 'Visitor' };
const tripName = (t: Leg): string => {
  const out = t.to.kind === 'gate', inn = t.from.kind === 'gate';
  if (t.back) return t.purpose === 'freight' ? 'Empty truck back' : out ? 'Leaving town' : 'Trip home';
  return out ? 'Export' : inn && t.purpose === 'freight' ? 'Import' : inn && t.purpose === 'commute' ? 'Commute from outside' : NAME[t.purpose];
};
const JAM_AT: Record<Control | 'road', string> = {
  light: 'at a traffic light', roundabout: 'at a roundabout', yield: 'at a yield sign', stop: 'at a stop sign', none: 'at a junction', road: 'in a queue',
};
const KIND_LABEL: Record<Kind, string> = { car: 'Car', truck: 'Truck', bus: 'Bus', moto: 'Motorbike', ambulance: 'Ambulance' };
// A trip report in the resident's voice; a stop under a quarter hour is not worth naming
function tripLine(r: TripReport): string {
  const to = destOf(r), x = (n: number) => `${n.toFixed(1)}x`;
  const jam = r.jam && r.jamS >= HOUR / 4 ? `, stuck ${fmtMin(r.jamS)} ${JAM_AT[r.jamAt]}` : '';
  switch (r.outcome) {
    case 'smooth': return `Smooth run to ${to}, ${fmtMin(r.seconds)}`;
    case 'wait': return r.door > HOUR ? `Waited ${fmtMin(r.door)} at the door to get on the road`
      : `${tripName(r)} took ${x(r.ratio)} as long as on empty roads${jam}`;
    case 'detour': return `Detour to ${to}: drove ${x(r.stretch)} the shortest route`;
    case 'gaveup': return `Gave up driving to ${to}${jam || ': waited too long at the door'}`;
    case 'noroute': return `No road to ${to}`;
  }
}
// A clickable report line: jumps to where the trip got stuck, else to where it started
const tripBtn = (r: TripReport): string => {
  const p = r.jam ?? r.from;
  return `<button class="tline o-${r.outcome}" data-jump="${Math.round(p.x)},${Math.round(p.y)}" data-tip="Day ${r.day}, ${pad(Math.floor(r.hour))}:00. Click to look">${esc(tripLine(r))}</button>`;
};
// Metrics charts: series, label, value format; zero: the axis starts at 0; max: at least this top
const CHARTS: { k: keyof Sample; label: string; fmt: (v: number) => string; zero?: boolean; max?: number }[] = [
  { k: 'waiting', label: 'Waiting cars', fmt: n => String(Math.round(n)), zero: true },
  { k: 'trip', label: 'Average trip', fmt: n => fmtMin(n / 60 * HOUR), zero: true },
  { k: 'through', label: 'Trips per hour', fmt: n => String(Math.round(n)), zero: true },
  { k: 'failed', label: 'Failed trips per hour', fmt: n => String(Math.round(n)), zero: true },
  { k: 'trade', label: 'Trade and visitors per hour', fmt: n => String(Math.round(n)), zero: true },
  { k: 'money', label: 'Money', fmt: fmtMoney },
  { k: 'pop', label: 'Population', fmt: n => Math.round(n).toLocaleString('en-US'), zero: true },
  { k: 'happy', label: 'Happiness', fmt: n => `${Math.round(n)}%`, zero: true, max: 100 },
];
function spark(v: number[], zero = false, max = -Infinity): [string, number, number] {
  const lo = Math.min(zero ? 0 : Infinity, ...v), hi = Math.max(max, ...v), k = hi - lo || 1, n = v.length - 1;
  const pts = v.map((y, i) => `${(i / n * 100).toFixed(1)},${(23 - (y - lo) / k * 22).toFixed(1)}`).join(' ');
  return [`<svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`, lo, hi];
}
// Legend panel per overlay (the car colours without one)
const LEGEND: Record<Overlay, string> = {
  none: Object.values(PURPOSES).map(p => `<span><i style="background:${p.color}"></i>${p.label}</span>`).join(''),
  heat: '<b>Traffic</b><span class="grad"></span><span class="ends"><small>flowing</small><small>jammed</small></span><span>Discs: cars waiting at a junction</span>',
  noise: '<b>Noise and pollution</b><span><i style="background:#8E7CC3"></i>Road noise</span><span><i style="background:#9A6B2F"></i>Factory pollution</span>'
    + '<span><i class="dot" style="background:#4CC26A"></i>Happy home</span><span><i class="dot" style="background:#FFB020"></i>Content</span><span><i class="dot" style="background:#E5484D"></i>Moving out</span>',
};
const OVERLAYS: Overlay[] = ['none', 'heat', 'noise'];

// Restart a CSS animation class
function flash(el: Element, cls: string, others: string[] = []): void {
  el.classList.remove(cls, ...others);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

function toolBtn(t: Tool): string {
  const k = keyOf(t);
  return `<button class="tool${t === 'demolish' ? ' destroy' : ''}" data-tool="${t}" aria-pressed="false" data-tip="${TOOLS[t].tip}" data-key="${k}">`
    + `<span class="kb" aria-hidden="true">${k}</span>${icon(t)}<span class="lbl">${TOOLS[t].label}</span>`
    + `${icon('lock', 'lock')}${t === 'place' ? '<b class="badge num" hidden></b>' : ''}</button>`;
}

interface Toast { text: string; el: HTMLElement; n: number; timer: ReturnType<typeof setTimeout> }

export class HUD {
  private toolBtns: HTMLButtonElement[];
  private speedBtns: HTMLButtonElement[];
  private dayBar: HTMLElement;
  private tip: HTMLElement;
  private tipFor: HTMLElement | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;
  private toasts: Toast[] = [];
  helpOpen = false;
  private last: {
    money?: number; net?: number; arrived?: number; trips?: string; speed?: number; tool?: Tool; level?: number;
    clock?: number; msg: string; junction?: string; ichg?: string; gsz?: string; danger?: number; pick?: string; happy?: string; alarm?: string; pop?: string; city?: number; tray?: string; trayN?: number; modal?: string;
    views?: string; car?: string; bld?: string; feed?: string; metrics?: string;
  } = { msg: '' };
  // Analysis panels open (M, T); the car the car card shows; when the trip feed was last drawn (real ms, it redraws at most twice a second)
  private show = { metrics: false, feed: false };
  private carFor: Car | null = null;
  private feedAt = 0;
  // Last level the player has seen in the level-up modal, and the speed to resume when it closes
  private seenLevel: number;
  private resume: 0 | 1 | 2 | 4 = 1;
  onTutorial: (() => void) | null = null;
  // Game over: play the same map again, or go to the main menu; the menu button (pause menu)
  onRestart: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  onPause: (() => void) | null = null;
  // Moves the camera there: the next building without a road (warning chip), a trip report's spot
  onJump: ((p: Vec) => void) | null = null;
  private dangerIdx = 0;
  // Junction panel: what a turn click edits (light signals of phase jPhase, or bans)
  private jMode: 'signals' | 'bans' = 'signals';
  private jPhase = 0;

  // signal: aborted when this game's HUD is replaced, removing its window, document and root listeners
  constructor(private root: HTMLElement, private game: Game, signal?: AbortSignal) {
    this.seenLevel = game.cityLevel;
    root.innerHTML = `
      <div class="topl">
      <div class="panel res" role="group" aria-label="Resources">
        <div class="chip money" data-tip="Money" tabindex="0">${icon('money')}<b class="num"></b><small class="net num"></small><span class="delta" aria-hidden="true"></span></div>
        <div class="chip people" tabindex="0" data-tip="">${icon('people')}<span class="pp"><span><b class="pv num"></b><small class="pn num"></small></span><span class="pbar"><i></i></span></span></div>
        <div class="chip happy" tabindex="0" data-tip="">${icon('smile')}<b class="hv num"></b></div>
        <div class="chip lvl" tabindex="0" data-tip="">${icon('star')}<b>Lv <span class="lvn num"></span></b></div>
        <div class="chip danger" hidden tabindex="0" role="button" data-tip="Their people cannot travel until a road reaches the door. Click to jump to the next one.">${icon('warning')}<b><span class="cnt num"></span><span class="long"> without a road</span></b></div>
        <div class="chip danger alarm" hidden tabindex="0" data-tip="">${icon('warning')}<b class="atxt"></b></div>
      </div>
      <div class="panel status">
        <div class="seg" role="group" aria-label="Game speed">
          ${SPEEDS.map(s => `<button class="speed" data-speed="${s.s}" aria-pressed="false" aria-label="${s.tip}" data-tip="${s.tip}"${s.key ? ` data-key="${s.key}"` : ''}>${icon(s.icon)}<small>${s.lbl}</small></button>`).join('')}
        </div>
        <span class="sep"></span>
        <div class="trips" tabindex="0" data-tip="">${icon('car')}<b class="score num">0</b><small class="smooth num"></small></div>
        <span class="sep"></span>
        <div class="clock" tabindex="0" data-tip="">
          <span class="ck num"></span>
          <span class="day" aria-hidden="true"><i></i></span>
        </div>
      </div>
      </div>
      <button class="panel helpbtn" data-action="help" aria-label="Controls" aria-expanded="false" data-tip="Controls" data-key="?">${icon('help')}</button>
      <div class="panel pop" hidden role="dialog" aria-label="Controls">
        <div class="pop-head"><h2>Controls</h2><button class="iconbtn" data-action="close-help" aria-label="Close [Esc]">${icon('close')}</button></div>
        <table>${CONTROLS.map(([a, b]) => `<tr><th scope="row">${a}</th><td>${b}</td></tr>`).join('')}</table>
        <button class="btn" data-action="tutorial">Replay tutorial</button>
      </div>
      <div class="panel views" role="group" aria-label="Analysis">
        <button class="iconbtn" data-view="heat" aria-pressed="false" aria-label="Traffic heat map" data-tip="Traffic heat map: green roads flow, red ones are jammed; discs show cars waiting at junctions" data-key="C">${icon('heat')}</button>
        <button class="iconbtn" data-view="noise" aria-pressed="false" aria-label="Noise and pollution" data-tip="Noise and pollution: loud roads and factory smog, with each home's happiness" data-key="C">${icon('noise')}</button>
        <button class="iconbtn" data-view="feed" aria-pressed="false" aria-label="Trip reports" data-tip="Trip reports: what residents say about their trips. Click one to look" data-key="T">${icon('list')}</button>
        <button class="iconbtn" data-view="metrics" aria-pressed="false" aria-label="Metrics" data-tip="Metrics: waiting cars, trip times, throughput, money, population and happiness over the run" data-key="M">${icon('chart')}</button>
        <button class="iconbtn" data-view="menu" aria-label="Menu" data-tip="Menu: save, load, quit" data-key="Esc">${icon('menu')}</button>
      </div>
      <div class="rcol">
        <div class="panel pop cpanel" hidden role="dialog" aria-label="Followed car">
          <div class="pop-head"><h2 class="ctitle"></h2><button class="iconbtn" data-v="car" aria-label="Stop following [Esc]">${icon('close')}</button></div>
          <div class="jbody cbody"></div>
        </div>
        <div class="panel pop bpanel" hidden role="dialog" aria-label="Building">
          <div class="pop-head"><h2 class="btitle"></h2><button class="iconbtn" data-v="building" aria-label="Close [Esc]">${icon('close')}</button></div>
          <div class="jbody bbody"></div>
        </div>
        <div class="panel pop jpanel" hidden role="dialog" aria-label="Junction">
          <div class="pop-head"><h2>Junction</h2><button class="iconbtn" data-j="close" aria-label="Close [Esc]">${icon('close')}</button></div>
          <div class="jbody"></div>
        </div>
        <div class="panel pop ipanel" hidden role="dialog" aria-label="Interchange">
          <div class="pop-head"><h2>Interchange</h2><button class="iconbtn" data-i="close" aria-label="Close [Esc]">${icon('close')}</button></div>
          <div class="jbody ibody"></div>
        </div>
        <div class="panel pop fpanel" hidden role="dialog" aria-label="Trip reports">
          <div class="pop-head"><h2>Trip reports</h2><button class="iconbtn" data-v="feed" aria-label="Close [T]">${icon('close')}</button></div>
          <div class="jbody fbody"></div>
        </div>
        <div class="panel pop mpanel" hidden role="dialog" aria-label="Metrics">
          <div class="pop-head"><h2>Metrics</h2><button class="iconbtn" data-v="metrics" aria-label="Close [M]">${icon('close')}</button></div>
          <div class="jbody mbody"></div>
        </div>
      </div>
      <div class="panel dock" role="toolbar" aria-label="Tools">
        ${toolBtn('road')}
        ${toolBtn('grid')}
        <button class="lane rmode" data-action="curve" data-key="V"></button>
        <div class="seg gsz" role="group" aria-label="Grid block size" hidden>
          ${GRID_SIZES.map(n => `<button class="lane" data-grid="${n}" aria-pressed="false" data-tip="Blocks of about ${n} tiles"><b>${n}</b><small>tiles</small></button>`).join('')}
        </div>
        <span class="sep"></span>
        <div class="lanes" data-tip="New roads">
          <div class="seg tiers" role="group" aria-label="Road tier">
            ${TIER_KEYS.map(t => `<button class="lane tier" data-tier="${t}" aria-pressed="false" aria-label="${TIERS[t].label}" data-tip="${tierTip(t)}"><svg class="pic" viewBox="0 0 40 24" aria-hidden="true">${tierPic(t)}</svg>${icon('lock', 'lock')}</button>`).join('')}
          </div>
          <span class="plabel"><b class="tname">Street</b><small class="pctx">per direction</small></span>
          <div class="seg" role="group" aria-label="Lanes per direction">
            ${[1, 2, 3].map(n => `<button class="lane" data-lanes="${n}" aria-pressed="false" data-tip="${laneTip(n)}"><b>${n}</b></button>`).join('')}
          </div>
          <button class="lane wide" data-action="oneway" aria-pressed="false" data-tip="${ONEWAY_TIP}">${icon('oneway')}<small>One-way</small>${icon('lock', 'lock')}</button>
          <button class="lane wide" data-action="flip" hidden data-tip="Reverse direction">${icon('flip')}<small>Flip</small></button>
        </div>
        <span class="sep"></span>
        <div class="stepper" data-hint="elev" data-tip="${ROAD_TIP}">
          <button class="iconbtn" data-action="level-down" aria-label="Lower road [PageDown]" data-tip="Lower road" data-key="PageDown"><b>−</b></button>
          <svg class="pic" viewBox="0 0 40 24" aria-hidden="true">
            <path class="gnd" d="M1 22.5h38"/>
            <line class="deck" x1="4" x2="36" y1="22" y2="22"/>
            <line class="pillar" x1="12" x2="12" y1="22" y2="22"/>
            <line class="pillar" x1="28" x2="28" y1="22" y2="22"/>
          </svg>
          <span class="elev"><b class="lv num"></b><small class="eh"></small></span>
          <button class="iconbtn" data-action="level-up" aria-label="Raise road [PageUp]" data-tip="Raise road" data-key="PageUp"><b>+</b></button>
        </div>
        <span class="sep"></span>
        ${toolBtn('light')}
        ${toolBtn('roundabout')}
        ${toolBtn('interchange')}
        <span class="sep"></span>
        ${toolBtn('place')}
        <span class="sep"></span>
        ${toolBtn('edit')}
        ${toolBtn('demolish')}
      </div>
      <div class="leftcol">
        <div class="panel tray" role="group" aria-label="Buildings to place">
          <small class="tray-h">Pick a building <kbd>B</kbd></small>
          ${ZONE_KEYS.map(z => `<button class="zone" data-zone="${z}" aria-pressed="false" data-tip="${ZONES[z].label}: pick it, then click the map near a road. B steps to the next kind">${zonePic(z)}<span>${ZONES[z].label}</span><b class="zn num"></b></button>`).join('')}
        </div>
        <div class="panel legend" role="group" aria-label="Map legend">${LEGEND.none}</div>
      </div>
      <div class="toasts" role="status" aria-live="polite"></div>
      <div class="modal" hidden></div>
      <div class="tip" role="tooltip" hidden></div>`;
    this.toolBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.dock [data-tool]'));
    this.speedBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-speed]'));
    this.dayBar = this.q('.day');
    this.tip = this.q('.tip');

    for (const b of this.speedBtns) b.onclick = () => { game.speed = Number(b.dataset.speed) as 0 | 1 | 2 | 4; };
    for (const b of this.toolBtns) b.onclick = () => game.setTool(b.dataset.tool as Tool);
    root.querySelectorAll<HTMLButtonElement>('[data-zone]').forEach(b => { b.onclick = () => game.startPlacing(b.dataset.zone as Zone); });
    // Lane picker: edits the selected run (Edit tool) or sets the type of new roads
    const cur = (): RoadType => (game.selected ? game.typeOf(game.selected) : game.roadType);
    const setType = (t: RoadType) => { if (game.selected) game.retype(game.selected, t); else game.setRoadType(t); };
    root.querySelectorAll<HTMLButtonElement>('[data-lanes]').forEach(b => {
      b.onclick = () => setType({ ...cur(), lanes: Number(b.dataset.lanes) as RoadType['lanes'] });
    });
    // Tier: lanes and one-way are clamped to the new tier (fitType)
    root.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach(b => {
      b.onclick = () => setType({ ...cur(), tier: b.dataset.tier as Tier });
    });
    this.q('[data-action="oneway"]').onclick = () => setType({ ...cur(), oneWay: !cur().oneWay });
    this.q('[data-action="flip"]').onclick = () => { if (game.selected) game.flip(game.selected); };
    this.q('[data-action="level-down"]').onclick = () => game.setLevel(game.level - 1);
    this.q('[data-action="level-up"]').onclick = () => game.setLevel(game.level + 1);
    this.q('[data-action="help"]').onclick = () => this.setHelp(!this.helpOpen);
    this.q('[data-action="close-help"]').onclick = () => this.setHelp(false);
    this.q('[data-action="tutorial"]').onclick = () => { this.setHelp(false); this.onTutorial?.(); };
    const jump = () => {
      const off = game.buildings.filter(b => !b.connected);
      if (off.length) this.onJump?.(off[this.dangerIdx++ % off.length]);
    };
    // Analysis: overlays and panels; a trip line jumps the camera (and stops a follow, which would pull it back)
    this.q('.views').onclick = e => {
      const v = (e.target as Element).closest<HTMLElement>('[data-view]')?.dataset.view;
      if (v === 'heat' || v === 'noise') game.overlay = game.overlay === v ? 'none' : v;
      else if (v === 'metrics' || v === 'feed') this.show[v] = !this.show[v];
      else if (v === 'menu') this.onPause?.();
    };
    this.q('.rcol').addEventListener('click', e => {
      const t = e.target as Element, v = t.closest<HTMLElement>('[data-v]')?.dataset.v, j = t.closest<HTMLElement>('[data-jump]')?.dataset.jump;
      if (v === 'car') game.follow = null;
      else if (v === 'building') game.picked = null;
      const bb = t.closest<HTMLElement>('[data-b]')?.dataset.b, pb = game.picked;
      if (pb && bb === 'move') game.startMove(pb);
      else if (pb && bb === 'demolish') game.tryDemolish(pb);
      else if (v === 'metrics' || v === 'feed') this.show[v] = false;
      if (j) {
        const [x, y] = j.split(',').map(Number);
        game.follow = null;
        this.onJump?.({ x, y });
      }
    });
    root.querySelectorAll<HTMLButtonElement>('[data-grid]').forEach(b => { b.onclick = () => { game.gridSize = Number(b.dataset.grid) as Game['gridSize']; }; });
    this.q('[data-action="curve"]').onclick = () => { game.roadCurve = !game.roadCurve; };
    this.q('.ipanel').onclick = e => { const t = (e.target as Element).closest<HTMLElement>('[data-i]'); if (t) this.onIchg(t.dataset.i!); };
    const jp = this.q('.jpanel');
    jp.onclick = e => { const t = (e.target as Element).closest<HTMLElement>('[data-j]'); if (t) this.onJunction(t.dataset.j!); };
    jp.onkeydown = e => {
      const t = (e.target as Element).closest<HTMLElement>('g[data-j]');
      if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.onJunction(t.dataset.j!); }
    };
    this.q('.danger').onclick = jump;
    this.q('.danger').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } };
    document.addEventListener('pointerdown', e => {
      if (this.helpOpen && !(e.target as Element).closest('.pop, .helpbtn')) this.setHelp(false, false);
    }, { signal });
    // capture phase on window: runs before Input's listener, so modal keys never reach the tools
    window.addEventListener('keydown', e => this.onKey(e), { capture: true, signal });
    this.bindTips(signal);
  }

  private q<T extends HTMLElement = HTMLElement>(s: string): T {
    return this.root.querySelector(s) as T;
  }

  // ---------- keyboard ----------
  private onKey(e: KeyboardEvent): void {
    const g = this.game;
    if (g.gameOver || g.pendingLevel) {
      e.stopPropagation(); // no key reaches Input while a modal is open (tools, level, Esc)
      if (e.key === 'Enter') { e.preventDefault(); if (g.gameOver) this.onRestart?.(); else this.closeLevel(); }
      return;
    }
    if (e.key === 'Escape') {
      this.hideTip();
      this.setHelp(false);
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    } else if (e.key === '?' || e.key === 'h' || e.key === 'H') {
      this.setHelp(!this.helpOpen);
    } else if (e.key === 'c' || e.key === 'C') {
      g.overlay = OVERLAYS[(OVERLAYS.indexOf(g.overlay) + 1) % OVERLAYS.length];
    } else if (e.key === 'm' || e.key === 'M') {
      this.show.metrics = !this.show.metrics;
    } else if (e.key === 't' || e.key === 'T') {
      this.show.feed = !this.show.feed;
    }
  }

  private setHelp(open: boolean, refocus = true): void {
    if (open === this.helpOpen) return;
    this.helpOpen = open;
    const pop = this.q('.pop'), btn = this.q('.helpbtn');
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    this.hideTip();
    if (open) this.q('[data-action="close-help"]').focus();
    else if (refocus) btn.focus();
  }

  // ---------- tooltips: one shared .tip ----------
  private bindTips(signal?: AbortSignal): void {
    const target = (e: Event) => (e.target as Element).closest<HTMLElement>('[data-tip]');
    this.root.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      const el = target(e);
      if (el === this.tipFor) return;
      this.hideTip();
      if (!el?.dataset.tip) return;
      this.tipFor = el;
      this.tipTimer = setTimeout(() => this.showTip(el), 300);
    }, { signal });
    this.root.addEventListener('pointerout', e => {
      const to = e.relatedTarget as Node | null;
      if (this.tipFor && to && this.tipFor.contains(to)) return;
      this.hideTip();
    }, { signal });
    this.root.addEventListener('focusin', e => {
      const el = target(e);
      if (el?.dataset.tip && (e.target as Element).matches(':focus-visible')) this.showTip(el);
    }, { signal });
    this.root.addEventListener('focusout', () => this.hideTip(), { signal });
    // touch: long-press a dock button shows its tooltip for 2.5 s
    let press: ReturnType<typeof setTimeout> | undefined;
    this.root.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const el = target(e);
      if (!el?.closest('.dock')) return;
      press = setTimeout(() => { this.showTip(el, true); setTimeout(() => this.hideTip(), 2500); }, 500);
    }, { signal });
    const stop = () => clearTimeout(press);
    this.root.addEventListener('pointerup', stop, { signal });
    this.root.addEventListener('pointercancel', stop, { signal });
  }

  private showTip(el: HTMLElement, touch = false): void {
    clearTimeout(this.tipTimer);
    this.tipFor = el;
    const key = el.dataset.key;
    this.tip.innerHTML = `${esc(el.dataset.tip ?? '')}${key ? ` <kbd>${esc(key)}</kbd>` : ''}`;
    this.tip.classList.toggle('touch', touch);
    this.tip.hidden = false;
    const r = el.getBoundingClientRect(), t = this.tip.getBoundingClientRect();
    const above = !!el.closest('.dock, .tutorial');
    const x = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
    const y = above ? r.top - t.height - 8 : r.bottom + 8;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${Math.max(8, Math.min(innerHeight - t.height - 8, y))}px`;
  }

  private hideTip(): void {
    clearTimeout(this.tipTimer);
    this.tipFor = null;
    this.tip.hidden = true;
  }

  // ---------- toasts: max 2, duplicates merge ----------
  private toast(raw: string): void {
    const text = FRIENDLY[raw] ?? raw;
    const dup = this.toasts.find(t => t.text === text);
    if (dup) {
      dup.n++;
      (dup.el.querySelector('.n') as HTMLElement).textContent = ` x${dup.n}`;
      clearTimeout(dup.timer);
      dup.timer = setTimeout(() => this.dropToast(dup), 2500);
      return;
    }
    if (this.toasts.length >= 2) this.dropToast(this.toasts[0]);
    const err = ERROR_RE.test(raw);
    const el = document.createElement('div');
    el.className = err ? 'toast err' : 'toast';
    el.innerHTML = `${icon(err ? 'warning' : 'check')}<span class="txt"></span><b class="n num"></b>`;
    (el.querySelector('.txt') as HTMLElement).textContent = text;
    this.q('.toasts').appendChild(el);
    const t: Toast = { text, el, n: 1, timer: setTimeout(() => this.dropToast(t), 2500) };
    this.toasts.push(t);
  }

  private dropToast(t: Toast): void {
    clearTimeout(t.timer);
    t.el.remove();
    this.toasts = this.toasts.filter(x => x !== t);
  }

  // ---------- modals ----------
  // Level-up modal closed: the game runs again at the speed it had
  private closeLevel(): void {
    this.seenLevel = this.game.pendingLevel;
    this.game.pendingLevel = 0;
    this.game.speed = this.resume || 1;
  }

  private renderModal(): void {
    const g = this.game, modal = this.q('.modal');
    const open = !!g.gameOver || !!g.pendingLevel;
    this.hideTip();
    this.setHelp(false, false);
    // keep Tab inside the modal
    for (const el of Array.from(this.root.children)) if (el !== modal) el.toggleAttribute('inert', open);
    modal.hidden = !open;
    if (g.gameOver) {
      const d = DIFFICULTY[g.cfg.difficulty], broke = g.gameOver === 'bankrupt';
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title" class="bad">${icon('warning')} ${broke ? 'Bankrupt' : 'The residents left'}</h2>
          <p class="sub">${broke ? `The city was in debt at ${d.debtDays} midnights in a row.` : `City happiness stayed under ${d.failHappy}% for ${T.FAIL_DAYS} midnights in a row.`}</p>
          <div class="stats">
            <div>${icon('calendar', 'big')}<span>Days</span><b class="num">${g.day}</b></div>
            <div>${icon('star', 'big')}<span>Level</span><b class="num">${g.cityLevel}</b></div>
            <div>${icon('people', 'big')}<span>Population</span><b class="num">${Math.round(g.population).toLocaleString('en-US')}</b></div>
            <div>${icon('car', 'big')}<span>Trips</span><b class="num">${g.stats.arrived.toLocaleString('en-US')}</b></div>
            <div>${icon('smile', 'big')}<span>Smooth trips</span><b class="num">${g.stats.arrived ? Math.round(100 * g.stats.smooth / g.stats.arrived) : 0}%</b></div>
            <div>${icon('money', 'big')}<span>Money</span><b class="num">${fmtMoney(g.money)}</b></div>
          </div>
          <div class="actions"><button class="btn" data-action="to-menu">Main menu</button><button class="btn primary" data-action="restart">Play again <kbd>Enter</kbd></button></div>
        </div>`;
      const b = this.q<HTMLButtonElement>('[data-action="restart"]');
      b.onclick = () => this.onRestart?.();
      this.q('[data-action="to-menu"]').onclick = () => this.onMenu?.();
      b.focus();
    } else if (g.pendingLevel) {
      // every level reached since the last modal (several at once merge): unlocks, the batch and the grants
      if (g.speed) this.resume = g.speed;
      g.speed = 0;
      const lv: number[] = [];
      for (let n = this.seenLevel + 1; n <= g.pendingLevel; n++) lv.push(n);
      const unlocks = lv.flatMap(levelUnlocks), batch = Object.fromEntries(ZONE_KEYS.map(z => [z, 0])) as Record<Zone, number>;
      for (const n of lv) { const b = levelBatch(n); for (const z of ZONE_KEYS) batch[z] += b[z]; }
      const grant = lv.reduce((n, l) => n + g.levelGrant(l), 0), won = lv.includes(LEVELS.length);
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title">${icon('star')} ${won ? 'City complete!' : `Level ${g.pendingLevel}!`}</h2>
          <p class="sub">${Math.round(g.population).toLocaleString('en-US')} residents${won ? ` on day ${g.day}, ${g.stats.arrived.toLocaleString('en-US')} trips. You reached level ${LEVELS.length}: keep going, every ${ENDLESS_POP} more residents bring another batch.` : '. New buildings wait in the tray: place them beside your roads so the city keeps growing.'}</p>
          <div class="lvl-grid">
            <div><h3>New buildings</h3>${ZONE_KEYS.filter(z => batch[z]).map(z => `<p>${zonePic(z)}${ZONES[z].label} <b class="num">×${batch[z]}</b></p>`).join('')}</div>
            <div><h3>Unlocked</h3>${unlocks.length ? unlocks.map(u => `<p>${icon('check')}${esc(u)}</p>`).join('') : '<p class="muted">Nothing new this time</p>'}
              <p>${icon('money')}Grant <b class="num">${fmtMoney(grant)}</b></p></div>
          </div>
          <div class="actions"><button class="btn primary" data-action="continue">Continue <kbd>Enter</kbd></button></div>
        </div>`;
      const b = this.q<HTMLButtonElement>('[data-action="continue"]');
      b.onclick = () => this.closeLevel();
      b.focus();
    } else {
      modal.innerHTML = '';
    }
  }

  // Lane picker: reflects the selected run (Edit tool) or the type for new roads
  private updatePicker(): void {
    const g = this.game, run = g.selected;
    const t = run ? g.typeOf(run) : g.roadType;
    const key = `${g.tool}|${run ? run.map(e => e.id).join(',') : '-'}|${t.tier}|${t.lanes}|${t.oneWay}`;
    if (key === this.last.pick) return;
    this.last.pick = key;
    const off = g.tool !== 'road' && g.tool !== 'edit' && g.tool !== 'grid';
    const box = this.q('.lanes');
    box.classList.toggle('off', off);
    box.dataset.tip = off ? 'Lanes apply to the Road, Grid and Edit tools' : run ? 'Editing the selected road' : 'Road type for new roads';
    const tier = TIERS[t.tier];
    this.q('.tname').textContent = tier.label;
    this.q('.pctx').textContent = run ? 'editing road' : `${tier.kmh} km/h`;
    // $ to pay (or get back) if the selected run switched to type n
    const delta = (n: RoadType) => {
      if (!run) return '';
      const d = Math.round(g.retypeDelta(run, n));
      return d > 0 ? ` · costs ${fmtMoney(d)}` : d < 0 ? ` · refunds ${fmtMoney(-d)}` : '';
    };
    box.querySelectorAll<HTMLButtonElement>('[data-tier]').forEach(b => {
      const k = b.dataset.tier as Tier, locked = !g.tierUnlocked(k);
      b.disabled = off;
      b.setAttribute('aria-pressed', String(t.tier === k));
      // locked tiers stay clickable so Game toasts 'Unlocks at level N'
      b.setAttribute('aria-disabled', String(locked));
      b.dataset.tip = tierTip(k) + (locked ? ` · unlocks at level ${TIERS[k].level}` : delta({ ...t, tier: k }));
    });
    box.querySelectorAll<HTMLButtonElement>('[data-lanes]').forEach(b => {
      const n = Number(b.dataset.lanes) as RoadType['lanes'];
      b.disabled = off || !tier.lanes.includes(n);
      b.setAttribute('aria-pressed', String(t.lanes === n));
      b.dataset.tip = laneTip(n) + delta({ ...t, lanes: n });
    });
    const ow = this.q<HTMLButtonElement>('[data-action="oneway"]');
    const owLock = g.lockOf('oneway');
    ow.disabled = off || !tier.oneWay;
    ow.setAttribute('aria-pressed', String(t.oneWay));
    ow.setAttribute('aria-disabled', String(!!owLock));
    ow.dataset.tip = owLock || ONEWAY_TIP + delta({ ...t, oneWay: !t.oneWay });
    this.q('[data-action="flip"]').hidden = !(run && t.oneWay);
  }

  // ---------- junction panel (Edit tool on a junction) ----------
  private onJunction(cmd: string): void {
    const g = this.game, n = g.inspect;
    if (!n) return;
    const [k, a, b] = cmd.split(':'), i = Number(a);
    if (k === 'close') g.inspect = null;
    else if (k === 'ctl') g.setControl(n, a as Control);
    else if (k === 'mode') this.jMode = a as 'signals' | 'bans';
    else if (k === 'ph') this.jPhase = i;
    else if (k === 'mv') {
      const m = Number(b) as Move;
      if (n.control === 'light' && this.jMode === 'signals') g.editPlan(n, p => cycleSig(p, this.jPhase, i, m));
      else g.editPlan(n, p => toggleBan(p, i, m));
    } else if (k === 'sec') g.editPlan(n, p => setSeconds(p, i, p.phases[i].seconds + Number(b)));
    else if (k === 'add') g.editPlan(n, p => { addPhase(p); this.jPhase = p.phases.length - 1; });
    else if (k === 'del') g.editPlan(n, p => removePhase(p, i));
    else if (k === 'pre') g.editPlan(n, p => applyPreset(p, a as Preset));
  }

  private updateJunction(): void {
    const g = this.game, n = g.inspect, panel = this.q('.jpanel');
    const key = n ? `${n.id}|${n.control}|${n.edges.map(e => e.id)}|${JSON.stringify(n.plan)}|${n.phase}|${this.jMode}|${this.jPhase}|${g.cityLevel}|${g.today}|${g.tutorialActive}` : '';
    if (key === this.last.junction) return;
    if (n && !this.last.junction?.startsWith(`${n.id}|`)) { this.jMode = 'signals'; this.jPhase = 0; this.setHelp(false, false); }
    this.last.junction = key;
    panel.hidden = !n;
    if (!n) return;
    const p = planOf(n), light = n.control === 'light', lock = g.lockOf('junction');
    this.jPhase = Math.min(this.jPhase, p.phases.length - 1);
    const sigs = light && this.jMode === 'signals', ph = p.phases[this.jPhase];
    const main = n.control === 'yield' ? mainEdges(n).map(e => approachOf(p, n, e)) : [];
    const price = (k: Control) => {
      const d = Math.round(g.controlPrice(k) - g.controlRefund(n));
      return d > 0 ? `costs ${fmtMoney(d)}` : d < 0 ? `refunds ${fmtMoney(-d)}` : 'free';
    };
    const ctl = CONTROL_KEYS.map(k => {
      const kl = k === 'roundabout' ? g.lockOf('roundabout') : '';
      return `<button class="lane wide" data-j="ctl:${k}" aria-pressed="${n.control === k}" aria-disabled="${!!kl}"`
        + ` data-tip="${kl || `${CONTROL_TIP[k]}${n.control === k ? '' : ` · ${price(k)}`}`}"><small>${CONTROL_LABEL[k]}</small></button>`;
    }).join('');
    // Diagram: one arm per approach, three turn buttons beside its incoming lane (left farthest out)
    const arms = p.approaches.map((a, i) => {
      const ux = Math.cos(a), uy = Math.sin(a), rx = uy * 8, ry = -ux * 8;
      const turns = [42, 31, 20].map((r, m) => {
        const x = ux * r + rx, y = uy * r + ry, ban = p.ban[i][m], s = ph?.sig[i][m] ?? 0;
        const cls = sigs ? (ban ? 'off' : `s${s}`) : ban ? 'ban' : 'ok';
        const state = sigs ? (ban ? 'banned' : ['red', 'yield', 'green'][s]) : ban ? 'banned' : 'allowed';
        return `<g data-j="mv:${i}:${m}" class="${cls}" role="button" tabindex="0" aria-label="${MOVES[m]} from the ${compass(a)} arm: ${state}">`
          + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.2"/><text x="${x.toFixed(1)}" y="${(y + 2.3).toFixed(1)}">${MOVES[m][0]}</text></g>`;
      }).join('');
      return [`<line class="arm${main.includes(i) ? ' main' : ''}" x1="0" y1="0" x2="${(ux * 50).toFixed(1)}" y2="${(uy * 50).toFixed(1)}"/>`, turns];
    });
    // all arms first, then the turn buttons on top
    const svg = arms.map(x => x[0]).join('') + arms.map(x => x[1]).join('');
    const note = lock ? `${lock}.`
      : sigs ? `Phase ${this.jPhase + 1}: click a turn to cycle red, yield (gives way to oncoming traffic), green.`
      : 'Click a turn to ban or allow it. Cars reroute around banned turns.';
    const phases = !sigs ? '' : `<div class="jph">${p.phases.map((x, i) => `
      <div class="row${i === n.phase ? ' now' : ''}">
        <button class="lane wide" data-j="ph:${i}" aria-pressed="${i === this.jPhase}" data-tip="${i === n.phase ? 'Running now. Click to edit' : 'Click to edit this phase'}"><small>Phase ${i + 1}</small></button>
        <button class="iconbtn" data-j="sec:${i}:-1" aria-label="Phase ${i + 1} shorter" ${x.seconds <= PHASE_MIN ? 'disabled' : ''}><b>−</b></button>
        <b class="num">${x.seconds}s</b>
        <button class="iconbtn" data-j="sec:${i}:1" aria-label="Phase ${i + 1} longer" ${x.seconds >= PHASE_MAX ? 'disabled' : ''}><b>+</b></button>
        <button class="iconbtn" data-j="del:${i}" aria-label="Remove phase ${i + 1}" ${p.phases.length < 2 ? 'disabled' : ''}>${icon('close')}</button>
      </div>`).join('')}
      <button class="btn" data-j="add" ${p.phases.length >= MAX_PHASES ? 'disabled' : ''}>Add phase</button>
      <div class="jpre"><small>Presets</small>${PRESETS.map(([k, l, t]) => `<button class="btn" data-j="pre:${k}" data-tip="${t}">${l}</button>`).join('')}</div>
    </div>`;
    const was = (document.activeElement as Element | null)?.closest<HTMLElement>('.jpanel [data-j]')?.dataset.j;
    this.q('.jpanel .jbody').innerHTML = `
      <div class="seg jctl" role="group" aria-label="Control">${ctl}</div>
      ${n.control === 'yield' ? `<p class="jnote">The thick arms are the main road: it has right of way, side roads give way.</p>` : ''}
      ${light ? `<div class="seg jmode" role="group" aria-label="Turn clicks edit"><button class="lane wide" data-j="mode:signals" aria-pressed="${sigs}"><small>Signals</small></button><button class="lane wide" data-j="mode:bans" aria-pressed="${!sigs}"><small>Turn bans</small></button></div>` : ''}
      <svg class="jsvg${lock ? ' locked' : ''}" viewBox="-54 -54 108 108" role="group" aria-label="Turns at this junction">${svg}<circle class="hub" r="6"/></svg>
      <p class="jnote">${esc(note)}</p>
      ${lock ? '' : phases}`;
    if (was) this.root.querySelector<HTMLElement>(`.jpanel [data-j="${was}"]`)?.focus();
  }

  // ---------- interchange panel (Interchange tool on a junction) ----------
  private onIchg(cmd: string): void {
    const g = this.game, ic = g.ichg;
    if (!ic) return;
    const [k, a] = cmd.split(':');
    if (k === 'close') g.ichg = null;
    else if (k === 'build') g.buildInterchange();
    else if (k === 'kind') {
      const t = ICHG[a as Ichg];
      if (t.arms === ic.node.edges.length) g.ichg = { ...ic, kind: a as Ichg };
      else g.say(`${t.label} needs a junction of ${t.arms} roads`);
    }
  }

  private updateIchg(): void {
    const g = this.game, ic = g.ichg, panel = this.q('.ipanel');
    const plans = ic ? ICHG_KEYS.map(k => g.planInterchange(ic.node, k)) : [];
    const key = ic ? `${ic.node.id}|${ic.kind}|${plans.map(p => `${p.ok}|${p.reason}|${Math.round(p.net ?? 0)}`).join()}` : '';
    if (key === this.last.ichg) return;
    if (ic && !this.last.ichg) this.setHelp(false, false);
    this.last.ichg = key;
    panel.hidden = !ic;
    if (!ic) return;
    const cur = plans[ICHG_KEYS.indexOf(ic.kind)], t = ICHG[ic.kind];
    const price = (p: PathPlan): string => { const d = Math.round(p.net ?? p.cost); return d >= 0 ? fmtMoney(d) : `+${fmtMoney(-d)} back`; };
    const kinds = ICHG_KEYS.map(k => {
      const fits = ICHG[k].arms === ic.node.edges.length;
      return `<button class="lane wide" data-i="kind:${k}" aria-pressed="${k === ic.kind}" aria-disabled="${!fits}"`
        + ` data-tip="${esc(fits ? ICHG[k].tip : `Needs a junction of ${ICHG[k].arms} roads`)}"><small>${ICHG[k].label}</small></button>`;
    }).join('');
    this.q('.ibody').innerHTML = `
      <div class="seg" role="group" aria-label="Interchange type">${kinds}</div>
      <p class="jnote">${esc(t.tip)}</p>
      <p class="jnote${cur.ok ? '' : ' bad'}">${esc(cur.ok ? `${price(cur)} after the refund for the roads it replaces. Ramps and bridges add upkeep.` : FRIENDLY[cur.reason] ?? cur.reason)}</p>
      <div class="jpre"><button class="btn primary" data-i="build"${cur.ok ? '' : ' disabled'}>Build · ${price(cur)}</button><button class="btn" data-i="close">Cancel</button></div>`;
  }

  // ---------- analysis panels ----------
  private updateViews(): void {
    const g = this.game, key = `${g.overlay}|${this.show.metrics}|${this.show.feed}`;
    if (key === this.last.views) return;
    this.last.views = key;
    const on: Record<string, boolean> = { heat: g.overlay === 'heat', noise: g.overlay === 'noise', ...this.show };
    this.root.querySelectorAll<HTMLElement>('[data-view][aria-pressed]').forEach(b => b.setAttribute('aria-pressed', String(on[b.dataset.view!])));
    this.q('.legend').innerHTML = LEGEND[g.overlay];
    this.q('.mpanel').hidden = !this.show.metrics;
    this.q('.fpanel').hidden = !this.show.feed;
    this.last.metrics = this.last.feed = undefined;
  }

  // Followed car: trip, from -> to, time so far against the free-flow time, speed, stops
  private updateCar(): void {
    const g = this.game, c = g.follow, panel = this.q('.cpanel');
    if (!c) { if (this.carFor) { this.carFor = null; this.last.car = ''; panel.hidden = true; } return; }
    const t = c.trip, el = g.time - t.departed, tier = TIERS[c.lane.edge.type.tier], kmh = Math.round(c.speed * tier.kmh / tier.limit);
    const key = `${Math.round(el / HOUR * 60)}|${kmh}|${Math.round(t.stopped / HOUR * 60)}`;
    if (c === this.carFor && key === this.last.car) return;
    this.carFor = c;
    this.last.car = key;
    panel.hidden = false;
    this.q('.ctitle').innerHTML = `<i class="cdot" style="background:${PURPOSES[t.purpose].color}"></i>${tripName(t)}`;
    const slow = t.ideal && el > T.SMOOTH_X * t.ideal;
    const jam = t.jamS >= HOUR / 4 ? `longest ${fmtMin(t.jamS)} ${JAM_AT[jamAt(t.jam)]}` : '';
    this.q('.cbody').innerHTML = `
      <p class="jnote">${ZONES[t.from.kind].label} → ${ZONES[t.to.kind].label} · ${KIND_LABEL[c.kind]}</p>
      <div class="kv"><span>Driving</span><b class="num${slow ? ' bad' : ''}">${fmtMin(el)}</b><small>${fmtMin(t.ideal)} on empty roads</small></div>
      <div class="kv"><span>Speed</span><b class="num">${kmh} km/h</b><small>${tier.label}, ${tier.kmh} km/h</small></div>
      <div class="kv"><span>Stopped</span><b class="num">${fmtMin(t.stopped)}</b><small>${jam}</small></div>
      <p class="jnote">The camera follows it; the dashed line is its route. Esc stops.</p>`;
  }

  // Building card: residents and happiness parts (home), jobs, staff and goods (workplaces), its last 5 trips
  private updateBuilding(): void {
    const g = this.game, b = g.picked, panel = this.q('.bpanel');
    const mine = b ? g.reports.filter(r => r.from === b || r.to === b).slice(-5).reverse() : [];
    const key = b ? `${g.buildings.indexOf(b)}|${Math.floor(g.clock)}|${b.connected}|${g.armed === b}|${mine.map(r => r.seconds).join()}` : '';
    if (key === this.last.bld) return;
    this.last.bld = key;
    panel.hidden = !b;
    if (!b) return;
    const z = ZONES[b.kind], pc = (x: number) => `${Math.round(100 * x)}%`;
    const bar = (label: string, v: number, bad = false) =>
      `<div class="pbar2${bad ? ' bad' : ''}"><span>${label}</span><i><i style="width:${pc(Math.min(1, v))}"></i></i><b class="num">${pc(v)}</b></div>`;
    let body = '';
    if (b.kind === 'home') {
      const mineC = g.commuters.filter(c => c.home === b), p = b.parts;
      body = `<p class="jnote">${Math.round(b.residents)} / ${z.residents} residents · ${Math.round(b.happy)}% happy · ${mineC.filter(c => c.work).length} of ${mineC.length} commuters have a job</p>`
        + bar('Jobs', p.job) + bar('Shops', p.shop) + bar('Trips', p.trips) + bar('Pollution', p.pollution, true) + bar('Noise', p.noise, true);
    } else {
      body = `<p class="jnote">${z.jobs} jobs · ${pc(b.staffed)} staffed this hour${b.kind === 'shop' ? ` · ${b.stock} goods in stock` : ''}</p>`;
    }
    if (!b.connected) body += '<p class="jnote bad">No road: connect its door</p>';
    const who = g.occupants(b);
    body += `<div class="jpre"><button class="btn" data-b="move" data-tip="Then click where it goes; Esc puts it back. Keeps its residents, jobs and trips">Move${g.moveCost ? ` · ${fmtMoney(g.moveCost)}` : ''}</button>`
      + `<button class="btn" data-b="demolish" data-tip="${g.creative ? 'Removes it' : 'Back to the tray, to place again'}${who ? `. ${who}` : ''}">${g.armed === b ? 'Click again to demolish' : 'Demolish'}</button></div>`;
    this.q('.btitle').innerHTML = `${zonePic(b.kind)}${z.label}`;
    this.q('.bbody').innerHTML = body + (mine.length ? `<small class="fsub">Last trips</small>${mine.map(tripBtn).join('')}` : '<p class="jnote">No trips yet</p>');
  }

  // Trip feed: today's outcomes, then the last 30 reports, newest first
  private updateFeed(): void {
    const g = this.game, n = g.stats.arrived + g.stats.failed, key = `${n}|${g.day}`;
    if (!this.show.feed || key === this.last.feed || (this.last.feed !== undefined && performance.now() - this.feedAt < 500)) return;
    this.last.feed = key;
    this.feedAt = performance.now();
    const td = g.stats.today;
    this.q('.fbody').innerHTML = `
      <p class="jnote">Today: <b class="o-smooth">${td.smooth} smooth</b> · <b class="o-wait">${td.wait} long waits</b> · <b class="o-detour">${td.detour} detours</b>`
      + ` · <b class="o-gaveup">${td.gaveup} gave up</b> · <b class="o-noroute">${td.noroute} no road</b></p>`
      + (g.reports.length ? `<div class="flist">${g.reports.slice(-30).reverse().map(tripBtn).join('')}</div>` : '<p class="jnote">No trips yet: they show up here as cars arrive.</p>');
  }

  // Metrics: one sparkline per series over the whole run, redrawn once per sample
  private updateMetrics(): void {
    const g = this.game, m = g.metrics, s = m.samples, key = `${s.length}|${m.every}|${s[s.length - 1]?.day}|${s[s.length - 1]?.hour}`;
    if (!this.show.metrics || key === this.last.metrics) return;
    this.last.metrics = key;
    if (s.length < 2) { this.q('.mbody').innerHTML = '<p class="jnote">Collecting: a point is added every in-game hour.</p>'; return; }
    const rows = CHARTS.filter(c => c.k !== 'money' || !g.creative).map(c => {
      const v = s.map(x => x[c.k] ?? 0), [svg, lo, hi] = spark(v, c.zero, c.max), now = c.fmt(v[v.length - 1]);
      return `<div class="mrow" role="img" aria-label="${c.label}: now ${now}, from ${c.fmt(lo)} to ${c.fmt(hi)}">`
        + `<span>${c.label}</span><b class="num">${now}</b><small class="num">${c.fmt(lo)} – ${c.fmt(hi)}</small>${svg}</div>`;
    }).join('');
    this.q('.mbody').innerHTML = `<p class="jnote">From day ${s[0].day} ${pad(s[0].hour)}:00 to now, a point every ${m.every === 1 ? 'hour' : `${m.every} hours`}.</p>${rows}`;
  }

  // ---------- per-frame update: writes the DOM only when a value changed ----------
  update(): void {
    const g = this.game, L = this.last;

    // Money in whole dollars with a 200ms flash per change. Net per day = taxes at today's rate + business and trade income
    // (yesterday's, or today's so far on the first day) - the network's upkeep; grants are one-off
    const money = Math.round(g.money);
    const l = g.today ? g.ledger.yesterday : g.ledger.today, net = Math.round(g.taxPerDay() + l.business + l.trade - g.upkeepDay);
    if (money !== L.money || net !== L.net) {
      const c = this.q('.money'), prev = L.money, d = money - (prev ?? money);
      L.money = money;
      L.net = net;
      (c.querySelector('.num') as HTMLElement).textContent = fmtMoney(money);
      const n = c.querySelector('.net') as HTMLElement;
      n.textContent = `${net >= 0 ? '+' : ''}${fmtMoney(net)}/day`;
      n.className = `net num ${net < 0 ? 'neg' : 'pos'}`;
      c.classList.toggle('debt', money < 0);
      const y = g.ledger.yesterday, t = g.ledger.today;
      const day = (x: Ledger) => `taxes ${fmtMoney(x.taxes)}, business ${fmtMoney(x.business)}, trade ${fmtMoney(x.trade)}, upkeep −${fmtMoney(x.upkeep)}, building ${fmtMoney(-x.build)}`
        + (x.grants ? `, grants ${fmtMoney(x.grants)}` : '');
      c.dataset.tip = `Money. Residents pay ${fmtMoney(g.taxPerDay())}/day in taxes (more when they are happy); workers, shoppers and goods`
        + ` arriving pay business income. Exports, imports and visitors through the highway exits pay trade income`
        + (g.linkedExits().length ? '.' : ': none is linked yet, build a road to one at the map edge.')
        + ` Roads and controls cost ${fmtMoney(g.upkeepDay)}/day upkeep.`
        + ` Yesterday: ${day(y)}. Today so far: ${day(t)}.`
        + (g.creative ? '' : ` In debt at ${DIFFICULTY[g.cfg.difficulty].debtDays} midnights in a row = bankrupt.`);
      if (prev !== undefined && Number.isFinite(d) && d !== 0) {
        (c.querySelector('.delta') as HTMLElement).textContent = d > 0 ? `+${fmtMoney(d)}` : `−${fmtMoney(-d)}`;
        flash(c, d > 0 ? 'gain' : 'spend', ['gain', 'spend']);
      }
    }

    if (g.speed !== L.speed) {
      L.speed = g.speed;
      for (const b of this.speedBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === g.speed));
      this.q('.status').classList.toggle('paused', g.speed === 0);
      L.clock = undefined; // relabel the clock / Paused below
    }

    const toolChanged = g.tool !== L.tool;
    if (toolChanged) {
      L.tool = g.tool;
      for (const b of this.toolBtns) b.setAttribute('aria-pressed', String(b.dataset.tool === g.tool));
      document.body.dataset.tool = g.tool;
    }

    // Population toward the next milestone, and the city level; a level-up re-locks / unlocks the dock
    const pop = Math.round(g.population), next = levelPop(g.cityLevel + 1), prev = levelPop(g.cityLevel), pk = `${pop}|${g.cityLevel}`;
    if (pk !== L.pop) {
      L.pop = pk;
      this.q('.pv').textContent = pop.toLocaleString('en-US');
      this.q('.pn').textContent = ` / ${next.toLocaleString('en-US')}`;
      this.q<HTMLElement>('.pbar i').style.width = `${Math.max(0, Math.min(1, (pop - prev) / (next - prev))) * 100}%`;
      this.q('.people').dataset.tip = `Population ${pop}. Level ${g.cityLevel + 1} at ${next} residents. Happy homes fill up; unhappy ones empty out.`;
    }
    if (g.cityLevel !== L.city) {
      const up = L.city !== undefined;
      L.city = g.cityLevel;
      this.q('.lvn').textContent = String(g.cityLevel);
      const soon = [g.cityLevel + 1, g.cityLevel + 2].map(n => [n, levelUnlocks(n)] as const).filter(([, u]) => u.length);
      this.q('.lvl').dataset.tip = `City level ${g.cityLevel}${g.creative ? ' (creative: everything unlocked)' : ''}.`
        + (g.creative ? '' : soon.map(([n, u]) => ` Level ${n}: ${u.join(', ')}.`).join(''));
      for (const b of this.toolBtns) {
        const f = TOOL_LOCK[b.dataset.tool as Tool], lock = f ? g.lockOf(f) : '';
        b.setAttribute('aria-disabled', String(!!lock));
        const tip = TOOLS[b.dataset.tool as Tool].tip;
        b.dataset.tip = lock ? `${lock}. ${tip}` : tip;
      }
      L.pick = undefined;
      L.level = undefined;
      if (up) flash(this.q('.lvl'), 'bump');
    }

    // Tray: one card per zone with buildings left; the dock badge counts them all
    const yk = `${ZONE_KEYS.map(z => g.tray[z]).join(',')}|${g.placing}`;
    if (yk !== L.tray) {
      const before = L.trayN;
      L.tray = yk;
      let total = 0;
      this.root.querySelectorAll<HTMLButtonElement>('[data-zone]').forEach(b => {
        const z = b.dataset.zone as Zone, n = g.tray[z];
        total += n;
        b.hidden = n < 1;
        b.setAttribute('aria-pressed', String(g.placing === z));
        (b.querySelector('.zn') as HTMLElement).textContent = `×${count(n)}`;
      });
      this.q('.tray').hidden = total < 1;
      const badge = this.q('.badge');
      badge.hidden = total < 1;
      this.q('[data-tool="place"]').classList.toggle('ready', total >= 1);
      badge.textContent = count(total);
      L.trayN = total;
      if (before !== undefined && total > before && Number.isFinite(total)) flash(badge, 'pulse');
    }

    if (toolChanged || g.level !== L.level) {
      const pulse = L.level !== undefined && g.level !== L.level;
      const lv = g.level;
      L.level = lv;
      // demolishAt prefers the current level, so Demolish keeps the stepper live
      const off = g.tool !== 'road' && g.tool !== 'demolish';
      const st = this.q('.stepper');
      st.classList.toggle('off', off);
      st.dataset.tip = off ? 'Elevation applies to the Road tool' : ROAD_TIP;
      this.q<HTMLButtonElement>('[data-action="level-down"]').disabled = off || lv <= 0;
      // ponytail: a locked next level stays clickable so Game toasts 'Unlocks at level N'
      this.q('[data-action="level-up"]').setAttribute('aria-disabled', String(!!g.lockOf(lv + 1 >= 6 ? 'high' : 'viaduct')));
      this.q<HTMLButtonElement>('[data-action="level-up"]').disabled = off || lv >= 10;
      this.q('.lv').textContent = lv === 0 ? 'Ground' : `L${lv}`;
      this.q('.eh').textContent = lv === 0 ? 'Ground · tunnels through mountains' : lv < 6 ? `Viaduct · price ×${(T.VIADUCT_X + T.VIADUCT_LEVEL_X * lv).toFixed(1)}` : 'Viaduct · clears mountains';
      const y = String(lv === 0 ? 22 : 20 - lv * 1.6);
      const deck = st.querySelector('.deck')!;
      deck.setAttribute('y1', y);
      deck.setAttribute('y2', y);
      st.querySelectorAll('.pillar').forEach(p => {
        p.setAttribute('y1', y);
        p.setAttribute('visibility', lv === 0 ? 'hidden' : 'visible');
      });
      if (pulse) flash(this.q('.elev'), 'pulse');
    }

    this.updatePicker();
    this.updateJunction();
    this.updateIchg();
    this.updateViews();
    this.updateCar();
    this.updateBuilding();
    this.updateFeed();
    this.updateMetrics();
    const gk = `${g.tool}|${g.gridSize}|${g.roadCurve}`;
    if (gk !== L.gsz) {
      L.gsz = gk;
      // the grid is built on the ground: its block size takes the elevation stepper's place
      this.q('.gsz').hidden = g.tool !== 'grid';
      this.q('.stepper').hidden = g.tool === 'grid';
      const rm = this.q('.rmode'), m = g.roadCurve ? 'curve' : 'straight';
      rm.hidden = g.tool !== 'road';
      rm.innerHTML = icon(m);
      rm.setAttribute('aria-label', `Road shape: ${m}. Switch [V]`);
      rm.dataset.tip = RMODE_TIP[m];
      this.root.querySelectorAll<HTMLElement>('[data-grid]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.grid) === g.gridSize)));
    }

    // Trips today: arrivals and their smooth share
    const td = g.stats.today, arrived = td.smooth + td.wait + td.detour, tk = `${g.stats.arrived}|${g.stats.failed}|${g.day}`;
    if (tk !== L.trips) {
      const up = L.arrived !== undefined && g.stats.arrived > L.arrived;
      L.trips = tk;
      L.arrived = g.stats.arrived;
      const s = this.q('.score');
      s.textContent = String(arrived);
      this.q('.smooth').textContent = arrived ? ` · ${Math.round(100 * td.smooth / arrived)}% smooth` : '';
      this.q('.trips').dataset.tip = `Trips today: ${arrived} arrived (${td.smooth} smooth, ${td.wait} long waits, ${td.detour} detours), `
        + `${td.gaveup} gave up, ${td.noroute} found no road. All time: ${g.stats.arrived} arrived.`;
      if (up) flash(s, 'bump');
    }

    // Clock in 10-minute steps: Day 4 · 08:20; the day bar fills by the same steps (144 a day, under a pixel each)
    const tick = Math.floor(g.clock * 6);
    if (tick !== L.clock) {
      L.clock = tick;
      const h = Math.floor(g.hour), m = Math.floor((g.hour - h) * 6) * 10, time = `${pad(h)}:${pad(m)}`;
      this.q('.ck').innerHTML = g.speed === 0 ? 'Paused' : `<span class="long">Day </span><span class="short">D</span>${g.day} · ${time}`;
      this.dayBar.style.setProperty('--p', String((h + m / 60) / 24));
      this.q('.clock').dataset.tip = `Day ${g.day}, ${time}. Commuters leave home between 6:00 and 10:00 and drive back after a ${T.WORK_HOURS}-hour shift;`
        + ' shoppers go out from mid-morning to the evening. Taxes and upkeep are paid by the hour.';
    }

    // City happiness: smile 60+, neutral 30-60, frown under 30 (shape and colour), the weighted parts in the tooltip
    const hp = Math.round(g.happiness), cp = g.cityParts, pc = (x: number) => `${Math.round(100 * x)}%`;
    const hk = `${hp}|${Object.values(cp).map(pc).join()}`;
    if (hk !== L.happy) {
      L.happy = hk;
      const c = this.q('.happy'), face = hp >= T.GROW_HI ? 'smile' : hp >= T.GROW_LO ? 'neutral' : 'frown';
      c.querySelector('.ico')!.outerHTML = icon(face);
      c.classList.toggle('good', face === 'smile');
      c.classList.toggle('bad', face === 'frown');
      this.q('.hv').textContent = `${hp}%`;
      c.dataset.tip = `City happiness ${hp}%, averaged over a day. Jobs ${pc(cp.job)}, shops ${pc(cp.shop)}, trips ${pc(cp.trips)},`
        + ` pollution ${pc(cp.pollution)}, noise ${pc(cp.noise)}. Happy homes fill up and pay more taxes; under ${T.GROW_LO}% people move out.`
        + (g.creative ? '' : ` Under ${DIFFICULTY[g.cfg.difficulty].failHappy}% for ${T.FAIL_DAYS} midnights in a row from day ${T.FAIL_FROM_DAY}, the residents leave.`);
    }

    // Career fail countdown: Debt: 2 days to bankruptcy / Unhappy: 1 day left
    const a = g.alarm, ak = a ? `${a.kind}|${a.days}` : '';
    if (ak !== L.alarm) {
      L.alarm = ak;
      const c = this.q('.alarm'), s = a && a.days > 1 ? 's' : '';
      c.hidden = !a;
      if (a) {
        this.q('.atxt').textContent = a.kind === 'bankrupt' ? `Debt: ${a.days} day${s} to bankruptcy` : `Unhappy: ${a.days} day${s} left`;
        c.dataset.tip = a.kind === 'bankrupt'
          ? 'Below $0 at midnight counts toward bankruptcy. Earn more (grow the city, get trips through) or demolish roads you do not need.'
          : 'Happiness is too low. Give homes jobs and shops they can reach, smooth trips, and keep factories and loud roads away from them.';
      }
    }

    const off = g.buildings.reduce((n, b) => n + +!b.connected, 0);
    if (off !== L.danger) {
      L.danger = off;
      const chip = this.q('.danger');
      chip.hidden = off === 0;
      (chip.querySelector('.cnt') as HTMLElement).textContent = `${off} building${off > 1 ? 's' : ''}`;
    }

    // ponytail: change detection on the text, so an identical message repeated before it clears is not re-toasted
    if (g.message !== L.msg) {
      L.msg = g.message;
      if (g.message) this.toast(g.message);
    }

    const mk = `${g.gameOver}|${g.pendingLevel}`;
    if (mk !== L.modal) {
      L.modal = mk;
      this.renderModal();
    }
  }
}
