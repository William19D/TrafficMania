// Tips (docs/design/game-v3.md 6): a card in region F the first time something happens, once per profile (profile.tips), one at a time;
// the next due one shows after it closes. Silent while the tutorial runs, behind modals and with tips turned off.
import type { Game, Tool } from '../core/Game.ts';
import { fmtMoney } from '../core/Game.ts';
import { EVENTS, where } from '../core/Events.ts';
import { TIER_DEFS, ZONE_NAME, TUNING as T } from '../core/config.ts';
import type { Zone } from '../core/config.ts';
import { ZONE_LIST } from '../core/Zones.ts';
import { profile, saveProfile } from '../core/Profile.ts';
import type { Vec } from '../util/geom.ts';
import { icon } from './icons.ts';

export interface Tip { id: string; text: string; at: Vec | null }
// when: a pure read, false when not due, else true or the spot it is about (Show me jumps there)
interface Def { id: string; text: (g: Game) => string; when: (g: Game) => Vec | boolean | null | undefined }
const def = (id: string, text: string | ((g: Game) => string), when: Def['when']): Def => ({ id, text: typeof text === 'string' ? () => text : text, when });
const mid = (e: { a: Vec; b: Vec }): Vec => ({ x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 });
const open = (g: Game, z: Zone): boolean => g.unlocked(TIER_DEFS[z][0].level);

// A new tool's first use: one line each (road and zones are the tutorial's)
const TOOL_TIPS: Partial<Record<Tool, string>> = {
  grid: 'Grid: click a corner, click the end of the first side, then click how deep. The block size sits beside Build.',
  light: 'Lights give each road its turn. Edit a light to stretch the green for the busy road.',
  roundabout: 'Roundabouts keep traffic rolling with no stops. A bigger ring carries more but needs more room, and 2 or 3 ring lanes more still: pick them beside Build.',
  interchange: 'Interchanges lift turns off the junction: a diamond, cloverleaf or trumpet. The ghost shows it and its price first.',
  edit: 'Edit: click a car to follow it, a building for its details, a junction for its control, or a road to change its type.',
  demolish: 'Demolish refunds a road built today in full, an older one by half. A building goes for free and its lot stays zoned.',
};

const DEFS: Def[] = [
  def('noroad', 'This building has no road. Connect its door: a road passing by gets a driveway.', g => g.buildings.find(b => !b.connected && b.kind !== 'gate')?.node),
  def('jam', 'Red roads are jammed. Turn on the heat map (C) to find the worst spot, then give its traffic another way round or more lanes.',
    g => { const e = g.graph.edges.find(e => !e.drive && e.heat > 0.7); return e && mid(e); }),
  def('gaveup', 'A driver gave up. Their trip report (T) shows where they got stuck.', g => { const r = g.reports.find(r => r.outcome === 'gaveup'); return r && (r.jam ?? true); }),
  def('unhappy', 'Unhappy homes stop growing and empty out. Click one with Edit to see why.', g => g.buildings.find(b => b.kind === 'home' && !b.abandoned && b.residents > 0 && b.happy < T.GROW_LO)),
  def('pin', 'The pin counts down until this building shrinks or is abandoned. Fix the cause its card names.', g => g.buildings.find(b => b.downH > 0 && b.cause)),
  def('loan', g => `The bank lent you money at ${g.loanRate * 100}% a day (${fmtMoney(T.LOAN_STEP)} at a time). Repay it from the loan chip, top left.`, g => g.loan > 0),
  def('jobs', 'Homes stopped growing: people need jobs. Paint Office lots (purple) along a road.', g => g.population >= 100 && g.demand.home <= 0 && g.demand.office > 0.2 && open(g, 'office')),
  ...ZONE_LIST.map(z => def(`demand:${z}`, `${ZONE_NAME[z]} demand is high: paint more ${ZONE_NAME[z]} lots.`, g => g.demand[z] > 0.5 && g.population >= 100 && open(g, z))),
  def('exit', 'A highway exit is linked: exports, imports and visitors now use it, and pay trade income.', g => g.linkedExits()[0]),
  def('noise', 'Residents dislike loud roads. Keep big roads away from homes.', g => g.buildings.find(b => b.kind === 'home' && b.parts.noise > 0.4)),
  def('milestone', 'You picked a milestone card. The other one comes back first at the next milestone.', g => g.milestone > 0 && !g.offers),
  ...(Object.keys(TOOL_TIPS) as Tool[]).map(t => def(`tool:${t}`, TOOL_TIPS[t]!, g => g.tool === t)),
  ...(Object.keys(EVENTS) as (keyof typeof EVENTS)[]).map(k => def(`event:${k}`, `${EVENTS[k].name}: ${EVENTS[k].quest}. The chip at the top left counts down; meet it for a reward.`,
    g => { const e = g.events.find(e => e.kind === k); return e && (where(e) ?? true); })),
];

// The first tip due that this profile has not seen (pure)
export function dueTip(g: Game, seen: readonly string[]): Tip | null {
  for (const d of DEFS) {
    if (seen.includes(d.id)) continue;
    const w = d.when(g);
    if (w) return { id: d.id, text: d.text(g), at: typeof w === 'object' ? { x: w.x, y: w.y } : null };
  }
  return null;
}

export class Tips {
  private el: HTMLElement;
  private cur: Tip | null = null;
  private checkAt = 0;
  private hideAt = 0;

  constructor(root: HTMLElement, private game: Game, private jump: (p: Vec) => void) {
    this.el = document.createElement('div');
    this.el.className = 'panel tutorial tipcard';
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    this.el.innerHTML = `<div class="tut-head">${icon('help')}<b>Tip</b></div><p></p>
      <div class="actions"><button class="btn ghost off" data-tip="Turn tips back on from the menu: Profile">Tips off</button><span><button class="btn look">Show me</button> <button class="btn primary ok">Got it</button></span></div>`;
    root.appendChild(this.el);
    (this.el.querySelector('.ok') as HTMLButtonElement).onclick = () => this.close();
    (this.el.querySelector('.look') as HTMLButtonElement).onclick = () => { if (this.cur?.at) this.jump(this.cur.at); };
    (this.el.querySelector('.off') as HTMLButtonElement).onclick = () => { profile().tipsOff = true; saveProfile(); this.close(); };
  }

  // Twice a second: the next due tip, if none is up; a tip closes itself after 20 s
  update(): void {
    const now = performance.now(), g = this.game, p = profile();
    if (this.cur) { if (now >= this.hideAt || p.tipsOff) this.close(); return; }
    if (now < this.checkAt || p.tipsOff || g.tutorialActive || g.modal) return;
    this.checkAt = now + 500;
    const t = dueTip(g, p.tips);
    if (!t) return;
    this.cur = t;
    this.hideAt = now + 20000;
    p.tips.push(t.id);
    saveProfile();
    (this.el.querySelector('p') as HTMLElement).textContent = t.text;
    (this.el.querySelector('.look') as HTMLElement).hidden = !t.at;
    this.el.hidden = false;
  }

  private close(): void {
    this.cur = null;
    this.el.hidden = true;
    this.checkAt = performance.now() + 1500;
  }
}
