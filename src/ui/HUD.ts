import type { Game, Overlay, Tool } from '../core/Game.ts';
import type { Ledger, PathPlan } from '../core/Game.ts';
import { CONTROL_LABEL, HOUR, TOOL_LOCK, fmtMin, jamAt, fmtMoney, levelPop, levelUnlocks, ZONE_KEYS } from '../core/Game.ts';
import type { Sample } from '../core/Metrics.ts';
import { ICHG, ICHG_KEYS } from '../core/Templates.ts';
import type { Ichg } from '../core/Templates.ts';
import { DIFFICULTY, PURPOSES, SPECIALS, SPECIAL_KEYS, TIERS, TIER_DEFS, ZONES, ZONE_NAME, TUNING as T } from '../core/config.ts';
import { upgradeBlock } from '../core/Zones.ts';
import { grade, milestonePop, objLabel, objText, objValue, offerText, takeOffer, unlockAt } from '../core/Campaign.ts';
import { rewardText } from '../core/Achievements.ts';
import { EVENTS } from '../core/Events.ts';
import type { AchDef } from '../core/Achievements.ts';
import type { Purpose, Site, Special, Tier, Zone } from '../core/config.ts';
import type { Building } from '../entities/Building.ts';
import type { Car, Kind } from '../entities/Car.ts';
import type { TripReport } from '../entities/Trip.ts';
import type { Vec } from '../util/geom.ts';
import type { Control, RingSize, RoadType } from '../network/RoadGraph.ts';
import { RINGS } from '../network/RoadGraph.ts';
import type { LinkPreset, Move, Preset } from '../network/Junction.ts';
import { MAX_PHASES, PHASE_MAX, PHASE_MIN, addPhase, applyPreset, approachOf, cycleSig, linkPreset, links, mainEdges, planOf, removePhase, setSeconds } from '../network/Junction.ts';
import { icon } from './icons.ts';
import { KEY_TOOLS } from './Input.ts';
import { sound } from './Sound.ts';
import { stepDone } from './Tutorial.ts';
import type { Tutorial } from './Tutorial.ts';

// Dock tools; the number keys follow the dock order (Input's KEY_TOOLS)
const TOOLS: Record<Tool, { label: string; tip: string }> = {
  road: { label: 'Road', tip: 'Click start, click end. Hold the end and drag to bend. V: straight or curved, Shift: straight once, Ctrl: 15° steps. Esc cancels.' },
  grid: { label: 'Grid', tip: 'Street grid: click a corner, click the end of the first side (any angle), then click how deep. Uses the road type; pick the block size beside it.' },
  light: { label: 'Light', tip: `Click an intersection (3+ roads). ${fmtMoney(T.LIGHT_COST)}, ${fmtMoney(T.LIGHT_UPKEEP)}/day. Edit it for phases and lane connections.` },
  roundabout: { label: 'Roundabout', tip: `Click an intersection; pick the size beside Build (a bigger ring is faster and takes more and wider roads, but needs more room). From ${fmtMoney(T.ROUNDABOUT_COST)}, ${fmtMoney(T.ROUNDABOUT_UPKEEP)}/day.` },
  interchange: { label: 'Interchange', tip: 'Click a junction to turn it into a diamond, cloverleaf (4 roads) or trumpet (3 roads). The ghost shows it and its price before you build.' },
  zone: { label: 'Zones', tip: 'Drag along a road to zone the lots on both sides (Shift: one side); buildings grow there when the zone is in demand and traffic flows. A drag that starts on a lot of the held zone erases. Tab: next zone, Esc stops.' },
  place: { label: 'Place', tip: 'Click where the building goes. Esc puts it back.' },
  edit: { label: 'Edit', tip: 'Click a car to follow it, a building for its details, a junction for its control, light phases and lane connections (drag from a lane to a road), or a road to change its type. Drag a road to bend it.' },
  demolish: { label: 'Demolish', tip: 'Click a road, sign, light, roundabout or building to remove it. Roads refund 100% on the day you built them, 50% later; a building goes for free and its lot stays zoned (an occupied one takes a second click).' },
};
// Tools in the Build menu; Edit and Demolish stay in the dock
const BUILD: Tool[] = ['road', 'grid', 'light', 'roundabout', 'interchange', 'zone'];
const keyOf = (t: Tool): string => t === 'zone' ? 'Z' : String(KEY_TOOLS.indexOf(t) + 1);
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
// A zone's brush button: its picture, name and a demand bar (filled up for demand, red down for a surplus); z 'none' = Unzone
const zoneBtn = (z: Zone | 'none'): string => z === 'none'
  ? `<button class="zone unzone" data-zone="none" aria-pressed="false" data-tip="Unzone: drag over lots to clear them. An empty lot refunds its price">${icon('demolish')}<span>Unzone</span></button>`
  : `<button class="zone" data-zone="${z}" aria-pressed="false" data-tip="${ZONE_NAME[z]}: drag along a road to zone it. ${ZONE_TIP[z]}">${zonePic(z)}<span>${ZONE_NAME[z]}</span><span class="dm" data-z="${z}"><i></i></span></button>`;
// A special's button in the Build menu: its picture, name and price; locked ones stay clickable so the ghost says why
const SPECIAL_PIC: Record<Special, string> = {
  plaza: '<path d="M2 9h20v12H2z" fill="#DCDFE2"/><path d="M9 9h6v12H9z" fill="#BFD4EA"/><path d="M2 6h20v3H2z" fill="#E5484D"/><circle cx="12" cy="17" r="2" fill="#9CC9E8"/>',
  terminal: '<path d="M3 13h5v8H3zM9 13h5v8H9zM15 13h6v8h-6z" fill="#3F7FBF"/><path d="M3 15h5M9 17h5" stroke="#D9534F"/><path d="M2 5h20v2H2zM4 7v14M20 7v14" stroke="#E0A21C" stroke-width="2"/>',
  stadium: '<ellipse cx="12" cy="13" rx="10" ry="8" fill="#8E949B"/><ellipse cx="12" cy="13" rx="6.5" ry="4.5" fill="#6FB04F"/><path d="M12 8.5v9" stroke="#fff"/><path d="M3 3v4M21 3v4" stroke="#5B6168" stroke-width="2"/>',
  hospital: '<path d="M3 6h18v15H3z" fill="#F2F4F5"/><path d="M10.5 9h3v9h-3z M7.5 12h9v3h-9z" fill="#E5484D"/>',
};
const specialBtn = (s: Special): string =>
  `<button class="zone special" data-special="${s}" aria-pressed="false" data-tip="${SPECIALS[s].name}: ${SPECIALS[s].tip}"><svg class="zpic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#5B6168" stroke-width="1.2" stroke-linejoin="round">${SPECIAL_PIC[s]}</svg><span>${SPECIALS[s].name}</span><small class="num">${fmtMoney(SPECIALS[s].cost)}</small>${icon('lock', 'lock')}</button>`;
const ZONE_TIP: Record<Zone, string> = {
  home: 'Homes grow when there are jobs to fill.',
  shop: 'Shops grow when residents and visitors need somewhere to shop.',
  office: 'Offices grow when residents lack jobs.',
  industry: 'Workshops grow when shops need goods and exits take exports.',
};

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
const ringTip = (r: number, price = true): string => `${RINGS[r].label} ring: up to ${RINGS[r].arms} roads, ${RINGS[r].lanes} lane${RINGS[r].lanes > 1 ? 's' : ''} each way${price ? ` · ${fmtMoney(T.ROUNDABOUT_COST * RINGS[r].cost)}` : ''}`;
// one button per roundabout size; a = the data attribute it sets
const ringBtns = (a: string, on: number): string => RINGS.map((x, r) =>
  `<button class="lane wide" ${a}="${r}" aria-pressed="${r === on}" data-tip="${ringTip(r)}"><small>${x.label}</small></button>`).join('');
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
const ERROR_RE = /^(Not enough|Too low|Too steep|Invalid|Already|Place on|Highways give|Unlocks on|Challenge:|Blocked|Overlaps|Outside|No room|The bank froze|Repaying takes|Buildings need|Nearby|Needs|Interchanges|Upgrade|The roads|A cloverleaf|\w+ needs a junction)/;

const kbd = (t: Tool): string => `<kbd>${keyOf(t)}</kbd>`;
export const CONTROLS: [string, string][] = [
  [KEY_TOOLS.map(t => TOOLS[t].label).join(' / '), KEY_TOOLS.map(kbd).join(' ')],
  ['Build menu: roads, junctions, zones', 'click Build; <kbd>Esc</kbd> or a click outside closes it. The keys pick its tools directly'],
  ['Zone brush / next zone', '<kbd>Z</kbd> / <kbd>Tab</kbd>; drag along a road (<kbd>Shift</kbd>: one side), start on a lot of the zone to erase'],
  ['Place road', 'click start, click end'],
  ['Bend road', 'hold on the end point and drag'],
  ['Straight / curved roads', '<kbd>V</kbd> switches; hold <kbd>Shift</kbd> for one straight road'],
  ['Road angle in 15° steps', 'hold <kbd>Ctrl</kbd> or <kbd>Alt</kbd> while placing'],
  ['Cancel road', '<kbd>Esc</kbd> or right-click'],
  ['Undo / redo a build, paint or demolish', '<kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Ctrl</kbd> + <kbd>Y</kbd> (not in Challenge)'],
  ['Road type', 'tier (dirt to highway), lanes 1 / 2 / 3 and One-way beside Build: new roads, or the road selected with Edit'],
  ['Raise / lower road', '<kbd>PageUp</kbd> / <kbd>PageDown</kbd> or <kbd>+</kbd> / <kbd>-</kbd>'],
  ['Ramp', 'start or end a road on a road of another level: it climbs one level per tile'],
  ['Street grid', `${kbd('grid')}: click a corner, the end of the first side, then the depth`],
  ['Interchange', `${kbd('interchange')}: click a junction, pick a type, then Build`],
  ['Edit road', `${kbd('edit')}, click to select, drag to bend`],
  ['Edit junction', `${kbd('edit')}, click a junction: control and light phases; drag from a lane to a road to connect it, click a line to remove it`],
  ['Follow a car / building details', `${kbd('edit')}, click it; <kbd>Esc</kbd> stops`],
  ['Demolish a building', `${kbd('demolish')}, click it (its lot stays zoned)`],
  ['Heat map / noise and pollution', '<kbd>C</kbd> switches the overlay'],
  ['Metrics / trip reports / notifications', '<kbd>M</kbd> / <kbd>T</kbd> / <kbd>N</kbd>'],
  ['Trip purpose dots on vehicles', '<kbd>P</kbd>'],
  ['Mute / unmute sound', '<kbd>Shift</kbd> + <kbd>M</kbd>; volumes in the menu (<kbd>Esc</kbd>), Sound'],
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
  roundabout: 'Roundabout: cars merge into gaps in the ring traffic, no stopping when it is clear',
};
const MOVES = ['Left', 'Straight', 'Right'];
const PRESETS: [Preset, string, string][] = [
  ['two', '2 phases', 'One phase per axis, lefts give way to oncoming traffic'],
  ['lefts', 'Protected lefts', '4 phases: per axis a protected-left phase, then straight and right'],
  ['each', 'One at a time', 'Each approach gets its own phase'],
];
const LINK_PRESETS: [LinkPreset, string, string][] = [
  ['auto', 'Reset to auto', 'Back to the default: the leftmost lane also turns left, the rightmost also right, every turn allowed'],
  ['any', 'Any lane', 'Every lane takes every turn'],
  ['nolefts', 'No lefts', 'Removes every left turn (and U-turn); cars reroute'],
];
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
const compass = (a: number): string => COMPASS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
const pad = (n: number) => String(n).padStart(2, '0');

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// ---------- analysis: trip reports, the car card, metrics ----------
// A trip or its report: where it goes (a commute out goes to work, a highway exit is out of town) and what it is called
interface Leg { purpose: Purpose; back: boolean; from: Building; to: Building }
const PLACE: Record<Site, string> = { home: 'home', shop: 'the shop', office: 'the office', industry: 'the factory', gate: 'the highway' };
const destOf = (t: Leg): string => t.purpose === 'commute' && !t.back && t.to.kind !== 'gate' ? 'work' : t.to.special ? `the ${t.to.label.toLowerCase()}` : PLACE[t.to.kind];
const NAME: Record<Purpose, string> = { commute: 'Commute', shop: 'Shopping trip', freight: 'Delivery', visit: 'Visitor', emergency: 'Emergency call' };
const tripName = (t: Leg): string => {
  const out = t.to.kind === 'gate', inn = t.from.kind === 'gate';
  if (t.back) return t.purpose === 'freight' ? 'Empty truck back' : t.purpose === 'emergency' ? 'Ambulance back' : out ? 'Leaving town' : 'Trip home';
  return out ? 'Export' : inn && t.purpose === 'freight' ? 'Import' : inn && t.purpose === 'commute' ? 'Commute from outside' : NAME[t.purpose];
};
const JAM_AT: Record<Control | 'road', string> = {
  light: 'at a traffic light', roundabout: 'at a roundabout', yield: 'at a yield sign', stop: 'at a stop sign', none: 'at a junction', road: 'in a queue',
};
const KIND_LABEL: Record<Kind, string> = { car: 'Car', truck: 'Truck', moto: 'Motorbike', ambulance: 'Ambulance' };
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
// Legend panel per overlay; the trip purposes' roof dots are listed whenever they show (Purpose toggle or the traffic overlay)
const DOTS = '<b>Roof dot: trip purpose</b>' + Object.values(PURPOSES).map(p => `<span><i class="dot" style="background:${p.color}"></i>${p.label}</span>`).join('');
const LEGEND: Record<Overlay, string> = {
  none: "<b>Cars</b><span>Paint is the owner's choice</span><span><kbd>P</kbd> shows each trip's purpose</span>",
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

// Count a number to its new value over ~400ms (ease-out); reduced motion and first fills snap
const ticking = new WeakMap<HTMLElement, number>();
function countTo(el: HTMLElement, from: number | undefined, to: number, fmt: (n: number) => string): void {
  cancelAnimationFrame(ticking.get(el) ?? 0);
  if (from === undefined || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t: number): void => {
    const k = Math.min(1, (t - t0) / 400);
    el.textContent = fmt(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) ticking.set(el, requestAnimationFrame(step));
  };
  ticking.set(el, requestAnimationFrame(step));
}

function toolBtn(t: Tool): string {
  const k = keyOf(t);
  return `<button class="tool${t === 'demolish' ? ' destroy' : ''}" data-tool="${t}" aria-pressed="false" data-tip="${TOOLS[t].tip}" data-key="${k}">`
    + `<span class="kb" aria-hidden="true">${k}</span>${icon(t)}<span class="lbl">${TOOLS[t].label}</span>`
    + `${icon('lock', 'lock')}</button>`;
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
    clock?: number; msg: string; said?: number; junction?: string; ichg?: string; gsz?: string; danger?: number; pick?: string; happy?: string; alarm?: string; event?: string; pop?: string; popN?: number; city?: number; zones?: string; loan?: string; modal?: string;
    views?: string; tokens?: string; car?: string; bld?: string; feed?: string; metrics?: string; obj?: string; news?: string;
  } = { msg: '' };
  // Analysis panels open (M, T); the car the car card shows; when the trip feed was last drawn (real ms, it redraws at most twice a second)
  private show = { metrics: false, feed: false, news: false };
  // notifications seen (Game.newsN when the panel was last open)
  private seen = 0;
  // Map 1's script: region O lists its steps while it runs
  tut: Tutorial | null = null;
  private carFor: Car | null = null;
  private feedAt = 0;
  // The speed to resume when a modal closes
  private resume: 0 | 1 | 2 | 4 = 1;
  onTutorial: (() => void) | null = null;
  // Game over: play the same map again, or go to the main menu; the menu button (pause menu)
  onRestart: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  onPause: (() => void) | null = null;
  // Map complete: to the campaign's map select
  onMaps: (() => void) | null = null;
  // Moves the camera there: the next building without a road (warning chip), a trip report's spot
  onJump: ((p: Vec) => void) | null = null;
  private dangerIdx = 0;
  private jPhase = 0;

  // signal: aborted when this game's HUD is replaced, removing its window, document and root listeners
  constructor(private root: HTMLElement, private game: Game, signal?: AbortSignal) {
    root.innerHTML = `
      <div class="topl">
      <div class="panel res" role="group" aria-label="Resources">
        <div class="chip money" data-tip="Money" tabindex="0">${icon('money')}<b class="num"></b><small class="net num"></small><span class="delta" aria-hidden="true"></span></div>
        <div class="chip people" tabindex="0" data-tip="">${icon('people')}<span class="pp"><span><b class="pv num"></b><small class="pn num"></small></span><span class="pbar"><i></i></span></span></div>
        <div class="chip happy" tabindex="0" data-tip="">${icon('smile')}<b class="hv num"></b></div>
        <div class="chip demand" tabindex="0" data-tip="" aria-label="Zone demand">${ZONE_KEYS.map(z => `<span class="dm" data-z="${z}"><i></i><small>${ZONE_NAME[z][0]}</small></span>`).join('')}</div>
        <button class="chip loan" hidden data-action="repay" data-tip="">${icon('money')}<b class="ln num"></b></button>
        <div class="chip lvl" tabindex="0" data-tip="">${icon('star')}<b>Lv <span class="lvn num"></span></b></div>
        <div class="chip danger" hidden tabindex="0" role="button" data-tip="Their people cannot travel until a road reaches the door. Click to jump to the next one.">${icon('warning')}<b><span class="cnt num"></span><span class="long"> without a road</span></b></div>
        <div class="chip danger alarm" hidden tabindex="0" data-tip="">${icon('warning')}<b class="atxt"></b></div>
        <div class="chip event" hidden tabindex="0" data-tip="">${icon('warning')}<b class="etxt"></b></div>
        <div class="obj" hidden role="group" aria-label="Objectives">
          <button class="ohead" data-action="obj" aria-expanded="true" data-tip="Objectives: meet them all for a star. Click to fold"><b class="oname"></b><span class="ostars"></span>${icon('chev', 'chev')}</button>
          <div class="obody"></div>
        </div>
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
        <button class="btn" data-action="tutorial">Play the tutorial on Meadowbrook</button>
      </div>
      <div class="panel views" role="group" aria-label="Analysis">
        <button class="iconbtn" data-view="heat" aria-pressed="false" aria-label="Traffic heat map" data-tip="Traffic heat map: green roads flow, red ones are jammed; discs show cars waiting at junctions" data-key="C">${icon('heat')}</button>
        <button class="iconbtn" data-view="noise" aria-pressed="false" aria-label="Noise and pollution" data-tip="Noise and pollution: loud roads and factory smog, with each home's happiness" data-key="C">${icon('noise')}</button>
        <button class="iconbtn" data-view="purpose" aria-pressed="false" aria-label="Trip purpose" data-tip="Trip purpose: a coloured dot on every vehicle's roof (commute, shopping, freight, visitors)" data-key="P">${icon('tag')}</button>
        <button class="iconbtn" data-view="feed" aria-pressed="false" aria-label="Trip reports" data-tip="Trip reports: what residents say about their trips. Click one to look" data-key="T">${icon('list')}</button>
        <button class="iconbtn bell" data-view="news" aria-pressed="false" aria-label="Notifications" data-tip="Notifications: what happened in the city. Click one to look" data-key="N">${icon('bell')}<b class="badge num" hidden></b></button>
        <button class="iconbtn" data-view="metrics" aria-pressed="false" aria-label="Metrics" data-tip="Metrics: waiting cars, trip times, throughput, money, population and happiness over the run" data-key="M">${icon('chart')}</button>
        <button class="iconbtn snd" data-view="sound" data-key="Shift+M"></button>
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
        <div class="panel pop npanel" hidden role="dialog" aria-label="Notifications">
          <div class="pop-head"><h2>Notifications</h2><button class="iconbtn" data-v="news" aria-label="Close [N]">${icon('close')}</button></div>
          <div class="jbody nbody"></div>
        </div>
        <div class="panel pop mpanel" hidden role="dialog" aria-label="Metrics">
          <div class="pop-head"><h2>Metrics</h2><button class="iconbtn" data-v="metrics" aria-label="Close [M]">${icon('close')}</button></div>
          <div class="jbody mbody"></div>
        </div>
      </div>
      <div class="panel dock" role="toolbar" aria-label="Tools">
        <button class="tool buildbtn" data-action="build" aria-expanded="false" aria-controls="bmenu" data-tip="Build: roads, junctions and zones"><span class="bico"></span><span class="lbl">Build</span>${icon('chev', 'chev')}</button>
        <div class="ctx" role="group" aria-label="Tool options">
        <button class="lane wide rmode" data-action="curve" data-key="V"></button>
        <div class="seg gsz" role="group" aria-label="Grid block size" hidden>
          ${GRID_SIZES.map(n => `<button class="lane" data-grid="${n}" aria-pressed="false" data-tip="Blocks of about ${n} tiles"><b>${n}</b><small>tiles</small></button>`).join('')}
        </div>
        <div class="seg rsz" role="group" aria-label="Roundabout size">${ringBtns('data-ring', 0)}</div>
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
        </div>
        <span class="sep"></span>
        ${toolBtn('edit')}
        ${toolBtn('demolish')}
      </div>
      <div class="panel bmenu" id="bmenu" role="group" aria-label="Build menu">
        <div class="bgrp"><h3>Roads</h3><div class="brow">${toolBtn('road')}${toolBtn('grid')}</div></div>
        <div class="bgrp"><h3>Junctions</h3><div class="brow">${toolBtn('light')}${toolBtn('roundabout')}${toolBtn('interchange')}</div></div>
        <div class="bgrp"><h3>Zones <kbd>Z</kbd></h3><div class="brow">${ZONE_KEYS.map(zoneBtn).join('')}${zoneBtn('none')}</div></div>
        <div class="bgrp"><h3>Specials</h3><div class="brow">${SPECIAL_KEYS.map(specialBtn).join('')}</div></div>
      </div>
      <div class="leftcol">
        <div class="panel tray" role="group" aria-label="Zone brush" hidden>
          <small class="tray-h">Zone brush <kbd>Tab</kbd></small>
          ${ZONE_KEYS.map(zoneBtn).join('')}${zoneBtn('none')}
          <small class="tray-h tray-f">Shift: one side · bars: demand</small>
        </div>
        <div class="panel legend" role="group" aria-label="Map legend">${LEGEND.none}</div>
      </div>
      <div class="toasts" role="status" aria-live="polite"></div>
      <div class="modal" hidden></div>
      <div class="tip" role="tooltip" hidden></div>`;
    this.toolBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-tool]'));
    this.speedBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-speed]'));
    this.dayBar = this.q('.day');
    this.tip = this.q('.tip');

    for (const b of this.speedBtns) b.onclick = () => { game.speed = Number(b.dataset.speed) as 0 | 1 | 2 | 4; };
    for (const b of this.toolBtns) b.onclick = () => { game.setTool(b.dataset.tool as Tool); this.setBuild(false); };
    root.querySelectorAll<HTMLButtonElement>('[data-zone]').forEach(b => { b.onclick = () => { game.setZone(b.dataset.zone === 'none' ? null : b.dataset.zone as Zone); this.setBuild(false); }; });
    root.querySelectorAll<HTMLButtonElement>('[data-special]').forEach(b => { b.onclick = () => { game.startPlacing(b.dataset.special as Special); this.setBuild(false); }; });
    this.q('[data-action="repay"]').onclick = () => game.repay();
    this.q('[data-action="obj"]').onclick = e => {
      const o = this.q('.obj'), min = o.classList.toggle('min');
      (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!min));
    };
    this.q('[data-action="build"]').onclick = () => this.setBuild(!this.buildOpen);
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
      else if (v === 'metrics' || v === 'feed' || v === 'news') this.show[v] = !this.show[v];
      else if (v === 'purpose') game.purposeDots = !game.purposeDots;
      else if (v === 'menu') this.onPause?.();
      else if (v === 'sound') this.toggleSound();
    };
    this.q('.rcol').addEventListener('click', e => {
      const t = e.target as Element, v = t.closest<HTMLElement>('[data-v]')?.dataset.v, j = t.closest<HTMLElement>('[data-jump]')?.dataset.jump;
      if (v === 'car') game.follow = null;
      else if (v === 'building') game.picked = null;
      const bb = t.closest<HTMLElement>('[data-b]')?.dataset.b, pb = game.picked;
      if (pb && bb === 'move') game.startMove(pb);
      else if (pb && bb === 'demolish') game.tryDemolish(pb);
      else if (v === 'metrics' || v === 'feed' || v === 'news') this.show[v] = false;
      if (j) {
        const [x, y] = j.split(',').map(Number);
        game.follow = null;
        this.onJump?.({ x, y });
      }
    });
    root.querySelectorAll<HTMLButtonElement>('[data-grid]').forEach(b => { b.onclick = () => { game.gridSize = Number(b.dataset.grid) as Game['gridSize']; }; });
    this.q('[data-action="curve"]').onclick = () => { game.roadCurve = !game.roadCurve; };
    root.querySelectorAll<HTMLButtonElement>('[data-ring]').forEach(b => { b.onclick = () => { game.ringSize = Number(b.dataset.ring) as RingSize; }; });
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
    // a click outside the Build menu closes it; on the map that click does nothing else (its pointerup is eaten too)
    let eat = false;
    document.addEventListener('pointerdown', e => {
      const t = e.target as Element;
      if (!this.buildOpen || t.closest('.bmenu, .buildbtn')) return;
      this.setBuild(false);
      if (t.tagName === 'CANVAS') { eat = true; e.stopPropagation(); }
    }, { capture: true, signal });
    document.addEventListener('pointerup', e => { if (eat) { eat = false; e.stopPropagation(); } }, { capture: true, signal });
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
    if (g.modal) {
      e.stopPropagation(); // no key reaches Input while a modal is open (tools, level, Esc)
      if (e.key === 'Enter') { e.preventDefault(); if (g.gameOver) this.onRestart?.(); else if (g.pendingGrade) this.closeGrade(); }
      else if (g.offers && !g.gameOver && !g.pendingGrade && (e.key === '1' || e.key === '2')) this.pick(+e.key - 1);
      return;
    }
    if (e.key === 'Escape' && this.buildOpen) {
      e.stopPropagation();
      this.setBuild(false, true);
    } else if (e.key === 'Escape') {
      this.hideTip();
      this.setHelp(false);
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    } else if (e.key === '?' || e.key === 'h' || e.key === 'H') {
      this.setHelp(!this.helpOpen);
    } else if (e.key === 'c' || e.key === 'C') {
      g.overlay = OVERLAYS[(OVERLAYS.indexOf(g.overlay) + 1) % OVERLAYS.length];
    } else if ((e.key === 'm' || e.key === 'M') && e.shiftKey) {
      this.toggleSound();
    } else if (e.key === 'm' || e.key === 'M') {
      this.show.metrics = !this.show.metrics;
    } else if (e.key === 't' || e.key === 'T') {
      this.show.feed = !this.show.feed;
    } else if (e.key === 'n' || e.key === 'N') {
      this.show.news = !this.show.news;
    } else if (e.key === 'p' || e.key === 'P') {
      g.purposeDots = !g.purposeDots;
    }
  }

  private toggleSound(): void {
    sound.toggleMute();
    this.game.say(sound.mix.muted ? 'Sound off · Shift+M turns it on' : 'Sound on');
  }

  // Build menu: unfolds upward from the Build button, anchored to it
  buildOpen = false;
  setBuild(open: boolean, refocus = false): void {
    if (open === this.buildOpen) return;
    this.buildOpen = open;
    const m = this.q('.bmenu'), b = this.q('.buildbtn');
    if (open) m.style.setProperty('--bx', `${Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, b.getBoundingClientRect().left))}px`);
    m.classList.toggle('open', open);
    b.setAttribute('aria-expanded', String(open));
    this.hideTip();
    if (open) m.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
    else if (refocus || m.contains(document.activeElement)) b.focus({ preventScroll: true });
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
      if (!el?.closest('.dock, .bmenu')) return;
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
    const above = !!el.closest('.dock, .bmenu, .tutorial');
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
  // Milestone card i taken: the game runs again at the speed it had
  private pick(i: number): void {
    takeOffer(this.game, i);
    sound.play('place');
    if (!this.game.modal) this.game.speed = this.resume || 1;
  }

  // Achievement unlocked: a gold toast that stays a little longer
  achieve(d: AchDef): void {
    const el = document.createElement('div');
    el.className = 'toast ach';
    el.innerHTML = `${icon('trophy')}<span class="txt"><b>Achievement: ${esc(d.name)}</b><small>${esc(d.text)}${d.reward ? ` · ${esc(rewardText(d))}` : ''}</small></span>`;
    this.q('.toasts').appendChild(el);
    sound.play('trophy');
    this.game.note(`Achievement: ${d.name}`, null, true);
    setTimeout(() => el.remove(), 5000);
  }

  // Map complete closed: the map plays on (Endless on it), the grade re-runs every midnight
  private closeGrade(): void {
    this.game.pendingGrade = null;
    this.game.speed = this.resume || 1;
  }

  private renderModal(): void {
    const g = this.game, modal = this.q('.modal');
    const open = g.modal;
    this.hideTip();
    this.setHelp(false, false);
    // keep Tab inside the modal
    for (const el of Array.from(this.root.children)) if (el !== modal) el.toggleAttribute('inert', open);
    modal.hidden = !open;
    if (g.gameOver) {
      const d = DIFFICULTY[g.cfg.difficulty];
      const [title, why] = {
        bankrupt: ['Bankrupt', `The city was in debt at ${d.debtDays} midnights in a row.`],
        unhappy: ['The residents left', `City happiness stayed under ${d.failHappy}% for ${T.FAIL_DAYS} midnights in a row.`],
        gridlock: ['Gridlock', 'Over 40% of the day\'s trips gave up waiting.'],
        deadline: ['Out of time', `The objectives were not met by the end of day ${g.goals ? g.deadline : g.day}.`],
      }[g.gameOver];
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title" class="bad">${icon('warning')} ${g.challenge ? 'Challenge failed: ' : ''}${title}</h2>
          <p class="sub">${why}</p>
          <div class="stats">
            <div>${icon('calendar', 'big')}<span>Days</span><b class="num">${g.day}</b></div>
            <div>${icon('star', 'big')}<span>Network spend</span><b class="num">${fmtMoney(g.run.spent)}</b></div>
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
    } else if (g.pendingGrade) {
      if (g.speed) this.resume = g.speed;
      g.speed = 0;
      sound.play('stars');
      const r = g.pendingGrade, m = g.map!, row = (ok: boolean, label: string, val: string) => `<p class="${ok ? '' : 'miss'}">${icon(ok ? 'check' : 'close')}${esc(label)}<b class="num">${val}</b></p>`;
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title">${icon('star')} ${g.challenge ? `Challenge cleared on day ${r.day}` : 'Map complete'}: ${esc(m.name)}</h2>
          <div class="stamp" aria-label="${r.stars} of 3 stars">${[1, 2, 3].map(i => `<i class="${i <= r.stars ? 'on' : ''}">★</i>`).join('')}</div>
          <div class="lvl-grid one">
            <div>${m.objectives.map((o, i) => row(r.met[i], objLabel(o), '')).join('')}
              ${row(r.flow >= m.flow, `★★ Smooth trips ${Math.round(m.flow * 100)}%+`, `${Math.round(r.flow * 100)}%`)}
              ${row(r.stars > 1 && r.spend <= m.budget, `★★★ Network spend within ${fmtMoney(m.budget)}`, fmtMoney(r.spend))}
              <p>${icon('chart')}Efficiency<b class="num">${r.efficiency.toLocaleString('en-US')}</b></p></div>
          </div>
          <p class="sub">${r.stars < 3 ? 'Keep playing: the grade runs again every midnight and the best one counts.' : 'Perfect. Keep playing as long as you like.'}</p>
          <div class="actions"><button class="btn" data-action="maps">Map select</button><button class="btn primary" data-action="continue">Keep playing <kbd>Enter</kbd></button></div>
        </div>`;
      const b = this.q<HTMLButtonElement>('[data-action="continue"]');
      b.onclick = () => this.closeGrade();
      this.q('[data-action="maps"]').onclick = () => { this.closeGrade(); this.onMaps?.(); };
      b.focus();
    } else if (g.offers) {
      // milestone choice: two cards, pick one (the other comes back next time)
      if (g.speed) this.resume = g.speed;
      g.speed = 0;
      sound.play('level');
      const goal = g.goals ? ` of ${esc(g.map!.name)}'s goal` : '';
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title">${icon('star')} Milestone ${g.milestone}: ${Math.round(milestonePop(g, g.milestone)).toLocaleString('en-US')} residents${goal}</h2>
          <p class="sub">Pick one reward. The other one comes back first at the next milestone.</p>
          <div class="offers">${g.offers.map((o, i) => {
            const t = offerText(g, o);
            return `<button class="offer" data-i="${i}">${icon(o.kind === 'money' ? 'money' : o.kind === 'special' ? 'build' : 'tag', 'big')}<b>${esc(t.title)}</b><span>${esc(t.text)}</span><kbd>${i + 1}</kbd></button>`;
          }).join('')}</div>
        </div>`;
      for (const el of Array.from(modal.querySelectorAll<HTMLButtonElement>('.offer'))) el.onclick = () => this.pick(+el.dataset.i!);
      modal.querySelector<HTMLButtonElement>('.offer')?.focus();
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
      // locked tiers stay clickable so Game toasts 'Unlocks on map N'
      b.setAttribute('aria-disabled', String(locked));
      b.dataset.tip = tierTip(k) + (locked ? ` · unlocks on ${unlockAt(TIERS[k].level)}` : delta({ ...t, tier: k }));
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
    else if (k === 'ring') g.setControl(n, 'roundabout', i as RingSize);
    else if (k === 'ph') this.jPhase = i;
    else if (k === 'mv') g.editPlan(n, p => cycleSig(p, this.jPhase, i, Number(b) as Move));
    else if (k === 'sec') g.editPlan(n, p => setSeconds(p, i, p.phases[i].seconds + Number(b)));
    else if (k === 'add') g.editPlan(n, p => { addPhase(p); this.jPhase = p.phases.length - 1; });
    else if (k === 'del') g.editPlan(n, p => removePhase(p, i));
    else if (k === 'pre') g.editPlan(n, p => applyPreset(p, a as Preset));
    else if (k === 'lp') g.editPlan(n, p => linkPreset(p, n, a as LinkPreset));
  }

  private updateJunction(): void {
    const g = this.game, n = g.inspect, panel = this.q('.jpanel');
    const key = n ? `${n.id}|${n.control}|${n.ring}|${n.edges.map(e => e.id)}|${JSON.stringify(n.plan)}|${n.phase}|${this.jPhase}|${g.cityLevel}|${g.today}|${g.tutorialActive}` : '';
    if (key === this.last.junction) return;
    if (n && !this.last.junction?.startsWith(`${n.id}|`)) { this.jPhase = 0; this.setHelp(false, false); }
    this.last.junction = key;
    panel.hidden = !n;
    if (!n) return;
    const p = planOf(n), light = n.control === 'light', lock = g.lockOf('junction');
    this.jPhase = Math.min(this.jPhase, p.phases.length - 1);
    const ring = n.control === 'roundabout', ph = p.phases[this.jPhase];
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
    // Light signals diagram: one arm per approach, three turn buttons beside its incoming lane (left farthest out); a turn no lane
    // connects shows banned
    const arms = p.approaches.map((a, i) => {
      const e = n.edges.find(x => approachOf(p, n, x) === i), lm = e ? links(p, n, e) : [];
      const ux = Math.cos(a), uy = Math.sin(a), rx = uy * 8, ry = -ux * 8;
      const turns = [42, 31, 20].map((r, m) => {
        const x = ux * r + rx, y = uy * r + ry, ban = !lm.some(v => v >> m & 1), s = ph?.sig[i][m] ?? 0;
        const cls = ban ? 'off' : `s${s}`, state = ban ? 'banned' : ['red', 'yield', 'green'][s];
        return `<g data-j="mv:${i}:${m}" class="${cls}" role="button" tabindex="0" aria-label="${MOVES[m]} from the ${compass(a)} arm: ${state}">`
          + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.2"/><text x="${x.toFixed(1)}" y="${(y + 2.3).toFixed(1)}">${MOVES[m][0]}</text></g>`;
      }).join('');
      return [`<line class="arm${main.includes(i) ? ' main' : ''}" x1="0" y1="0" x2="${(ux * 50).toFixed(1)}" y2="${(uy * 50).toFixed(1)}"/>`, turns];
    });
    // all arms first, then the turn buttons on top
    const svg = arms.map(x => x[0]).join('') + arms.map(x => x[1]).join('');
    const note = lock ? `${lock}.` : ring ? '' : 'Drag from a lane to a road to connect it. Click a line to remove it.';
    const set = !!p.lanes?.some(Boolean) || p.ban.some(x => x.some(Boolean));
    const lanes = ring || lock ? '' : `<div class="jpre">${LINK_PRESETS.map(([k, l, t]) => `<button class="btn" data-j="lp:${k}" data-tip="${t}"${k === 'auto' && !set ? ' disabled' : ''}>${l}</button>`).join('')}</div>`;
    const phases = !light || lock ? '' : `<div class="jph">${p.phases.map((x, i) => `
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
      ${n.control === 'roundabout' ? `<div class="seg jctl" role="group" aria-label="Roundabout size">${RINGS.map((x, r) => {
        const d = Math.round(g.controlPrice('roundabout', r as RingSize) - g.controlRefund(n)), room = r === n.ring ? '' : g.ringRoom(n, r as RingSize);
        const t = `${ringTip(r, false)}${r === n.ring ? '' : room ? ` · ${room}` : ` · ${d > 0 ? `costs ${fmtMoney(d)}` : d < 0 ? `refunds ${fmtMoney(-d)}` : 'free'}`}`;
        return `<button class="lane wide" data-j="ring:${r}" aria-pressed="${r === n.ring}" aria-disabled="${!!room}" data-tip="${t}"><small>${x.label}</small></button>`;
      }).join('')}</div>` : ''}
      ${n.control === 'yield' ? `<p class="jnote">The thick arms are the main road: it has right of way, side roads give way.</p>` : ''}
      ${note ? `<p class="jnote">${esc(note)}</p>` : ''}
      ${lanes}
      ${light ? `${lock ? '' : `<p class="jnote">Phase ${this.jPhase + 1}: click a turn to cycle red, yield (gives way to oncoming traffic), green.</p>`}
      <svg class="jsvg${lock ? ' locked' : ''}" viewBox="-54 -54 108 108" role="group" aria-label="Light signals at this junction">${svg}<circle class="hub" r="6"/></svg>` : ''}
      ${phases}`;
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
    const g = this.game, m = sound.mix.muted, key = `${g.overlay}|${g.purposeDots}|${this.show.metrics}|${this.show.feed}|${this.show.news}|${m}`;
    if (key === this.last.views) return;
    this.last.views = key;
    // the speaker shows the sound's state (the menu's Sound page can change it too)
    const snd = this.q('.snd');
    snd.innerHTML = icon(m ? 'mute' : 'sound');
    snd.setAttribute('aria-label', m ? 'Sound off' : 'Sound on');
    snd.dataset.tip = `Sound ${m ? 'off' : 'on'}: click to ${m ? 'turn it on' : 'mute'}. Volumes are in the menu`;
    const on: Record<string, boolean> = { heat: g.overlay === 'heat', noise: g.overlay === 'noise', purpose: g.purposeDots, ...this.show };
    this.root.querySelectorAll<HTMLElement>('[data-view][aria-pressed]').forEach(b => b.setAttribute('aria-pressed', String(on[b.dataset.view!])));
    const dots = g.purposeDots || g.overlay === 'heat';
    this.q('.legend').innerHTML = g.overlay === 'none' && dots ? DOTS : LEGEND[g.overlay] + (dots ? DOTS : '');
    this.q('.mpanel').hidden = !this.show.metrics;
    this.q('.fpanel').hidden = !this.show.feed;
    this.q('.npanel').hidden = !this.show.news;
    this.last.metrics = this.last.feed = this.last.news = undefined;
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
      <p class="jnote">${t.from.label} → ${t.to.label} · ${KIND_LABEL[c.kind]}</p>
      <div class="kv"><span>Driving</span><b class="num${slow ? ' bad' : ''}">${fmtMin(el)}</b><small>${fmtMin(t.ideal)} on empty roads</small></div>
      <div class="kv"><span>Speed</span><b class="num">${kmh} km/h</b><small>${tier.label}, ${tier.kmh} km/h</small></div>
      <div class="kv"><span>Stopped</span><b class="num">${fmtMin(t.stopped)}</b><small>${jam}</small></div>
      <p class="jnote">The camera follows it; the dashed line is its route. Esc stops.</p>`;
  }

  // Building card: residents and happiness parts (home), jobs, staff and goods (workplaces), its last 5 trips
  private updateBuilding(): void {
    const g = this.game, b = g.picked, panel = this.q('.bpanel');
    const mine = b ? g.reports.filter(r => r.from === b || r.to === b).slice(-5).reverse() : [];
    const key = b ? `${g.buildings.indexOf(b)}|${Math.floor(g.clock)}|${b.connected}|${b.abandoned}|${g.armed === b}|${mine.map(r => r.seconds).join()}` : '';
    if (key === this.last.bld) return;
    this.last.bld = key;
    panel.hidden = !b;
    if (!b) return;
    const pc = (x: number) => `${Math.round(100 * x)}%`;
    const bar = (label: string, v: number, bad = false) =>
      `<div class="pbar2${bad ? ' bad' : ''}"><span>${label}</span><i><i style="width:${pc(Math.min(1, v))}"></i></i><b class="num">${pc(v)}</b></div>`;
    let body = '';
    // tier and what its next one waits for (the upgrade countdown runs while nothing is in the way)
    if (b.tier) {
      const tiers = TIER_DEFS[b.kind as Zone], next = tiers[b.tier], why = upgradeBlock(g, b);
      body += `<p class="jnote">Tier ${b.tier} of ${tiers.length}${next ? ` · next: ${next.name} (${next.lots} lots) ${why ? `· ${esc(why)}` : `in ${T.UPGRADE_H - b.upH} h if the lots beside it are free`}` : ''}</p>`;
    }
    if (b.special) body += `<p class="jnote">${esc(SPECIALS[b.special].tip)} Upkeep ${fmtMoney(SPECIALS[b.special].upkeep)}/day · about ${g.tripsPerDay(b)} trips a day</p>`;
    if (b.kind === 'home') {
      const mineC = g.commuters.filter(c => c.home === b), p = b.parts;
      body += `<p class="jnote">${Math.round(b.residents)} / ${b.cap} residents · ${Math.round(b.happy)}% happy · ${mineC.filter(c => c.work).length} of ${mineC.length} commuters have a job</p>`
        + bar('Jobs', p.job) + bar('Shops', p.shop) + bar('Trips', p.trips) + bar('Pollution', p.pollution, true) + bar('Noise', p.noise, true);
    } else {
      body += `<p class="jnote">${b.jobs} jobs · ${pc(b.staffed)} staffed this hour${b.kind === 'shop' ? ` · ${b.stock} goods in stock` : ''}</p>`;
    }
    // traffic access drives growth; a countdown says how long until it is abandoned (or cleared) and why
    if (b.kind !== 'gate') body += bar('Traffic access', b.access, b.access < T.DOWN_A);
    if (b.abandoned) body += '<p class="jnote bad">Abandoned: no residents, jobs or trips until traffic access recovers</p>';
    if (b.cause && b.downH) body += `<p class="jnote bad">${esc(b.cause.text)} · ${b.abandoned ? 'cleared' : 'abandoned'} in ${Math.ceil(T.DOWN_H - b.downH)} h</p>`;
    if (!b.connected) body += '<p class="jnote bad">No road: connect its door</p>';
    const who = g.occupants(b);
    const back = g.specialRefund(b);
    body += `<div class="jpre">${b.lots.length ? '' : `<button class="btn" data-b="move" data-tip="Then click where it goes; Esc puts it back. Keeps its residents, jobs and trips">Move${g.moveCost ? ` · ${fmtMoney(g.moveCost)}` : ''}</button>`}`
      + `<button class="btn" data-b="demolish" data-tip="${back ? `Refunds ${fmtMoney(back)}` : 'Free'}${b.lots.length ? '; its lot stays zoned and grows a new building' : ''}${who ? `. ${who}` : ''}">${g.armed === b ? 'Click again to demolish' : 'Demolish'}</button></div>`;
    this.q('.btitle').innerHTML = `${b.special ? `<svg class="zpic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#5B6168" stroke-width="1.2">${SPECIAL_PIC[b.special]}</svg>` : zonePic(b.kind)}${b.label}${b.lots.length && b.kind !== 'gate' ? ` <small>${ZONE_NAME[b.kind as Zone]}</small>` : ''}`;
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

  // Notifications: newest first, a click jumps to its spot; the bell's badge counts those added since the panel was last open
  private updateNews(): void {
    const g = this.game;
    if (this.show.news) this.seen = g.newsN;
    const unread = g.newsN - this.seen, key = `${g.newsN}|${unread}|${this.show.news}`;
    if (key === this.last.news) return;
    this.last.news = key;
    const b = this.q('.bell .badge');
    b.hidden = !unread;
    b.textContent = unread > 9 ? '9+' : String(unread);
    if (!this.show.news) return;
    this.q('.nbody').innerHTML = g.news.length ? `<div class="flist">${g.news.slice().reverse().map(n => {
      const when = `<small class="num">D${n.day} ${pad(n.hour)}:00</small>`;
      return n.at ? `<button class="nrow" data-jump="${Math.round(n.at.x)},${Math.round(n.at.y)}" data-tip="Click to look">${when}<span>${esc(n.text)}</span></button>`
        : `<div class="nrow">${when}<span>${esc(n.text)}</span></div>`;
    }).join('')}</div>` : '<p class="jnote">Nothing yet: events, loans, milestones, achievements and buildings in trouble show up here.</p>';
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
    const l = g.today ? g.ledger.yesterday : g.ledger.today, net = Math.round(g.taxPerDay() + l.business + l.trade - g.upkeepDay - g.loan * g.loanRate);
    if (money !== L.money || net !== L.net) {
      const c = this.q('.money'), prev = L.money, d = money - (prev ?? money);
      L.money = money;
      L.net = net;
      countTo(c.querySelector('.num') as HTMLElement, prev, money, fmtMoney);
      const n = c.querySelector('.net') as HTMLElement;
      n.textContent = `${net >= 0 ? '+' : ''}${fmtMoney(net)}/day`;
      n.className = `net num ${net < 0 ? 'neg' : 'pos'}`;
      c.classList.toggle('debt', money < 0);
      const y = g.ledger.yesterday, t = g.ledger.today;
      const day = (x: Ledger) => `taxes ${fmtMoney(x.taxes)}, business ${fmtMoney(x.business)}, trade ${fmtMoney(x.trade)}, upkeep −${fmtMoney(x.upkeep)}, building ${fmtMoney(-x.build)}`
        + (x.grants ? `, grants ${fmtMoney(x.grants)}` : '') + (x.interest ? `, interest −${fmtMoney(x.interest)}` : '');
      c.dataset.tip = `Money. Residents pay ${fmtMoney(g.taxPerDay())}/day in taxes (more when they are happy); workers, shoppers and goods`
        + ` arriving pay business income. Exports, imports and visitors through the highway exits pay trade income`
        + (g.linkedExits().length ? '.' : ': none is linked yet, build a road to one at the map edge.')
        + ` Roads and controls cost ${fmtMoney(g.upkeepDay)}/day upkeep.`
        + ` Yesterday: ${day(y)}. Today so far: ${day(t)}.`
        + (g.creative ? '' : ` Below $0 the bank lends ${fmtMoney(T.LOAN_STEP)} at a time, up to ${fmtMoney(g.loanCap)}, at ${g.loanRate * 100}% a day.`);
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
      // the Build button wears the active build tool's icon
      const bt = BUILD.includes(g.tool), bb = this.q('.buildbtn');
      bb.setAttribute('aria-pressed', String(bt));
      const bi = this.q('.bico'); bi.innerHTML = icon(bt ? g.tool : 'build'); bi.dataset.t = bt ? g.tool : 'build';
      bb.dataset.tip = `Build: roads, junctions and zones${bt ? `. Now: ${TOOLS[g.tool].label}` : ''}`;
      this.setBuild(false);
    }

    // Population toward the next milestone (a map's population objective), and the city level; a level-up re-locks / unlocks the dock
    const goal = g.goals ? g.map!.objectives.find(o => o.kind === 'pop')?.target : undefined;
    // Endless: the next milestone choice (Creative: the next city level)
    const ms = !goal && !g.creative, nx = ms ? milestonePop(g, g.milestone + 1) : levelPop(g.cityLevel + 1);
    const pop = Math.round(g.population), next = goal ?? nx, prev = goal ? 0 : ms ? (g.milestone ? milestonePop(g, g.milestone) : 0) : levelPop(g.cityLevel), pk = `${pop}|${g.cityLevel}|${g.milestone}`;
    if (pk !== L.pop) {
      countTo(this.q('.pv'), L.popN, pop, n => n.toLocaleString('en-US'));
      L.pop = pk;
      L.popN = pop;
      this.q('.pn').textContent = ` / ${next.toLocaleString('en-US')}`;
      this.q<HTMLElement>('.pbar i').style.width = `${Math.max(0, Math.min(1, (pop - prev) / (next - prev))) * 100}%`;
      this.q('.people').dataset.tip = `Population ${pop}. ${goal ? `The map's goal: ${next} residents (milestone rewards at 25%, 50% and 75%).` : ms ? `Next milestone reward at ${next} residents.` : `Level ${g.cityLevel + 1} at ${next} residents.`} Happy homes fill up; unhappy ones empty out.`;
    }
    // a milestone's free special shows on its Build menu card
    if (g.tokens.join() !== L.tokens) {
      L.tokens = g.tokens.join();
      this.root.querySelectorAll<HTMLButtonElement>('[data-special]').forEach(b => {
        const s = b.dataset.special as Special;
        b.querySelector('small')!.textContent = g.tokens.includes(s) ? 'Free' : fmtMoney(SPECIALS[s].cost);
      });
    }
    if (g.cityLevel !== L.city) {
      const up = L.city !== undefined;
      L.city = g.cityLevel;
      this.q('.lvn').textContent = String(g.cityLevel);
      this.q('.lvl').hidden = g.goals;
      this.q('.lvl').dataset.tip = `City level ${g.cityLevel}${g.creative ? ' (creative: everything unlocked)' : `: level ${g.cityLevel + 1} at ${levelPop(g.cityLevel + 1).toLocaleString('en-US')} residents`}.`;
      for (const b of this.toolBtns) {
        const f = TOOL_LOCK[b.dataset.tool as Tool], lock = f ? g.lockOf(f) : '';
        b.setAttribute('aria-disabled', String(!!lock));
        const tip = TOOLS[b.dataset.tool as Tool].tip;
        b.dataset.tip = lock ? `${lock}. ${tip}` : tip;
      }
      this.root.querySelectorAll<HTMLButtonElement>('[data-special]').forEach(b => {
        const d = SPECIALS[b.dataset.special as Special], lock = !g.unlocked(d.level);
        b.setAttribute('aria-disabled', String(lock));
        b.dataset.tip = `${d.name}${lock ? ` (unlocks on ${unlockAt(d.level)})` : ''}: ${d.tip} Upkeep ${fmtMoney(d.upkeep)}/day.`;
      });
      this.root.querySelectorAll<HTMLButtonElement>('[data-zone]').forEach(b => {
        const z = b.dataset.zone as Zone | 'none', lv = z === 'none' ? 1 : TIER_DEFS[z][0].level, lock = !g.unlocked(lv);
        b.setAttribute('aria-disabled', String(lock));
        if (lock) b.dataset.tip = `${ZONE_NAME[z as Zone]} zone unlocks on ${unlockAt(lv)}`;
      });
      L.pick = undefined;
      L.level = undefined;
      if (up) flash(this.q('.lvl'), 'bump');
    }

    // Zone demand (hourly): the bars in the top chip and on every brush button; the brush panel shows while the brush is held
    const zk = `${ZONE_KEYS.map(z => g.demand[z].toFixed(2)).join()}|${g.zone}|${g.tool}`;
    if (zk !== L.zones) {
      L.zones = zk;
      this.root.querySelectorAll<HTMLElement>('.dm').forEach(m => {
        const d = g.demand[m.dataset.z as Zone];
        m.style.setProperty('--d', String(Math.abs(d)));
        m.classList.toggle('neg', d < 0);
      });
      this.root.querySelectorAll<HTMLButtonElement>('[data-zone]').forEach(b => b.setAttribute('aria-pressed', String(g.tool === 'zone' && (b.dataset.zone === 'none' ? !g.zone : g.zone === b.dataset.zone))));
      this.q('.tray').hidden = g.tool !== 'zone';
      const pct = (z: Zone) => `${ZONE_NAME[z]} ${g.demand[z] > 0 ? '+' : ''}${Math.round(g.demand[z] * 100)}`;
      this.q('.demand').dataset.tip = `Zone demand (up: the city wants more; down: it has too many): ${ZONE_KEYS.map(pct).join(', ')}.`
        + ' Homes want jobs, jobs want workers, shops want customers and visitors, workshops want shops to supply and exits to export through.';
    }
    const lk = `${Math.round(g.loan)}|${g.frozen}`;
    if (lk !== L.loan) {
      L.loan = lk;
      const c = this.q('.loan');
      c.hidden = !g.loan;
      this.q('.ln').textContent = `Loan ${fmtMoney(g.loan)}`;
      c.dataset.tip = `Bank loan: ${fmtMoney(g.loan)} at ${g.loanRate * 100}% a day (${fmtMoney(g.loan * g.loanRate)}/day). Click to repay ${fmtMoney(Math.min(T.LOAN_STEP, g.loan))}.`
        + (g.frozen ? ' At the limit and still in debt: the city is frozen.' : '');
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
      // ponytail: a locked next level stays clickable so Game toasts 'Unlocks on map N'
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
    this.updateNews();
    this.updateMetrics();
    const gk = `${g.tool}|${g.gridSize}|${g.roadCurve}|${g.ringSize}`;
    if (gk !== L.gsz) {
      L.gsz = gk;
      // the grid is built on the ground: its block size takes the elevation stepper's place
      this.q('.gsz').hidden = g.tool !== 'grid';
      this.q('.stepper').hidden = g.tool === 'grid';
      // road options beside Build, for the tools that use them; the same for Edit and Demolish so those buttons stay put
      this.q('.ctx').hidden = !['road', 'grid', 'edit', 'demolish', 'roundabout'].includes(g.tool);
      // the roundabout tool only shows its ring size there
      this.q('.ctx').classList.toggle('ring', g.tool === 'roundabout');
      this.root.querySelectorAll<HTMLElement>('[data-ring]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.ring) === g.ringSize)));
      const rm = this.q('.rmode'), m = g.roadCurve ? 'curve' : 'straight';
      rm.hidden = g.tool !== 'road';
      rm.innerHTML = `${icon(m)}<small>${m === 'curve' ? 'Curve' : 'Straight'}</small>`;
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
        + (g.challenge ? ` Under ${DIFFICULTY[g.cfg.difficulty].failHappy}% for ${T.FAIL_DAYS} midnights in a row from day ${T.FAIL_FROM_DAY}, the residents leave.` : ' Unhappy homes are abandoned.');
    }

    // Career fail countdown: Debt: 2 days to bankruptcy / Unhappy: 1 day left
    const a = g.alarm, ak = a ? `${a.kind}|${a.days}` : g.frozen ? 'frozen' : '';
    if (ak !== L.alarm) {
      L.alarm = ak;
      const c = this.q('.alarm'), s = a && a.days > 1 ? 's' : '';
      c.hidden = !ak;
      if (!a && ak) {
        this.q('.atxt').textContent = 'Frozen';
        c.dataset.tip = 'The bank froze the city: nothing grows and you cannot zone until money is back over $0. Cut upkeep or get more trips through.';
      } else if (a) {
        this.q('.atxt').textContent = a.kind === 'bankrupt' ? `Debt: ${a.days} day${s} to bankruptcy` : `Unhappy: ${a.days} day${s} left`;
        c.dataset.tip = a.kind === 'bankrupt'
          ? 'Below $0 at midnight counts toward bankruptcy. Earn more (grow the city, get trips through) or demolish roads you do not need.'
          : 'Happiness is too low. Give homes jobs and shops they can reach, smooth trips, and keep factories and loud roads away from them.';
      }
    }

    // Traffic events: name and time left (or until it starts), the quest and reward in the tip
    const ev = g.events.map(e => {
      const d = EVENTS[e.kind], w = g.time < e.at, m = Math.max(1, Math.ceil(((w ? e.at : e.end) - g.time) / HOUR * 60 / 10) * 10);
      return { txt: `${d.name} ${w ? 'in' : '·'} ${m < 60 ? `${m} min` : `${Math.round(m / 60)} h`}`, tip: `${d.name}: ${d.quest}. Reward ${fmtMoney(d.reward * DIFFICULTY[g.cfg.difficulty].tax)}.` };
    }), ek = ev.map(e => e.txt).join(' | ');
    if (ek !== L.event) {
      L.event = ek;
      const c = this.q('.event');
      c.hidden = !ek;
      this.q('.etxt').textContent = ek;
      c.dataset.tip = ev.map(e => e.tip).join(' ');
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
    if (g.said !== L.said) {
      if (L.said !== undefined && ERROR_RE.test(g.message)) sound.play('error');
      L.said = g.said;
    }

    this.updateObjectives();

    const mk = `${g.gameOver}|${!!g.pendingGrade}|${g.offers ? g.milestone : 0}`;
    if (mk !== L.modal) {
      L.modal = mk;
      this.renderModal();
    }
  }

  // Region O: the map's objectives with bars, the ★★ flow and ★★★ spend bars, what the map brings, a Challenge's deadline
  private updateObjectives(): void {
    const g = this.game, box = this.q('.obj'), tut = this.tut?.active ? this.tut : null;
    box.hidden = !g.goals;
    if (!g.goals) return;
    // the tutorial: its steps as a checklist, the current one with its progress
    if (tut) {
      const rows = tut.steps.map((s, i) => {
        const p = i === tut.index ? s.progress?.(g) : undefined, ok = i < tut.index || (i === tut.index && stepDone(s, g) && !!p);
        return `<div class="orow${ok ? ' ok' : ''}${i === tut.index ? ' cur' : i > tut.index ? ' todo' : ''}"><span>${ok ? icon('check') : '<i class="odot"></i>'}${esc(s.goal)}</span>`
          + `<b class="num">${p ? `${p[0]} / ${p[1]}` : ''}</b>${p ? `<i style="--f:${Math.min(1, p[0] / p[1])}"></i>` : ''}</div>`;
      }).join(''), key = `tut|${rows}`;
      if (key === this.last.obj) return;
      this.last.obj = key;
      this.q('.oname').textContent = 'Tutorial';
      this.q('.ostars').innerHTML = '';
      this.q('.obody').innerHTML = rows;
      return;
    }
    const m = g.map!, r = grade(g, m), best = Math.max(g.run.stars, r.stars);
    const bar = (ok: boolean, label: string, val: string, f: number) =>
      `<div class="orow${ok ? ' ok' : ''}"><span>${ok ? icon('check') : '<i class="odot"></i>'}${esc(label)}</span><b class="num">${val}</b><i style="--f:${Math.max(0, Math.min(1, f))}"></i></div>`;
    const rows = m.objectives.map((o, i) => { const v = objValue(g, o); return bar(r.met[i], objLabel(o), objText(o, v), v / o.target); }).join('')
      + bar(r.flow >= m.flow, `★★ Smooth trips ${Math.round(m.flow * 100)}%+`, `${Math.round(r.flow * 100)}%`, r.flow / m.flow)
      + bar(r.spend <= m.budget, `★★★ Spend within ${fmtMoney(m.budget)}`, fmtMoney(r.spend), 1 - r.spend / m.budget)
      + (levelUnlocks(g.mapNo).length ? `<p class="onote new">New here: ${esc(levelUnlocks(g.mapNo).join(', '))}</p>` : '')
      + (g.challenge ? `<p class="onote">Deadline: end of day ${g.deadline}${g.run.done ? ' · cleared' : ` · ${g.deadline - g.day + 1} day${g.deadline - g.day ? 's' : ''} left`}</p>` : '');
    const key = `${rows}|${best}`;
    if (key === this.last.obj) return;
    this.last.obj = key;
    this.q('.oname').textContent = m.name;
    this.q('.ostars').innerHTML = [1, 2, 3].map(i => `<i class="${i <= best ? 'on' : ''}">★</i>`).join('');
    this.q('.obody').innerHTML = rows;
  }
}
