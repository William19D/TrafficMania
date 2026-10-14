import type { Game, Tool } from '../core/Game.ts';
import { DAY_SECONDS, fmtMoney, income } from '../core/Game.ts';
import { TUNING as T } from '../core/config.ts';
import type { RoadType } from '../network/RoadGraph.ts';
import { icon } from './icons.ts';

const TOOLS: { tool: Tool; label: string; key: string; tip: string }[] = [
  { tool: 'road', label: 'Road', key: '1', tip: 'Click start, click end. Drag the end to bend. Esc cancels.' },
  { tool: 'light', label: 'Light', key: '2', tip: `Click an intersection (3+ roads). ${fmtMoney(T.LIGHT_COST)}, ${fmtMoney(T.LIGHT_UPKEEP)}/day.` },
  { tool: 'roundabout', label: 'Roundabout', key: '3', tip: `Click an intersection. Lets 3 cars through at once. ${fmtMoney(T.ROUNDABOUT_COST)}, ${fmtMoney(T.ROUNDABOUT_UPKEEP)}/day.` },
  { tool: 'edit', label: 'Edit', key: '4', tip: 'Click a road to change its lanes or direction. Drag a road to bend it.' },
  { tool: 'demolish', label: 'Demolish', key: '5', tip: 'Click a road or a light/roundabout to remove it. Refunds 100% on the day you built it, 50% later.' },
];

const ONEWAY_TIP = 'One-way: half the price, cars only drive in the direction you build';
const laneTip = (n: number) => `${n} lane${n > 1 ? 's' : ''} per direction. Price ×${n}`;

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
};
const ERROR_RE = /^(Not enough|Too low|Invalid|Already|Place on)/;

const CONTROLS: [string, string][] = [
  ['Road / Light / Roundabout / Edit / Demolish', '<kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> <kbd>5</kbd>'],
  ['Place road', 'click start, click end'],
  ['Bend road', 'hold on the end point and drag'],
  ['Edit road', '<kbd>4</kbd>, click to select, drag to bend'],
  ['Road type', 'Lanes 1 / 2 / 3 and One-way in the dock (new roads, or the selected road)'],
  ['Cancel road', '<kbd>Esc</kbd> or right-click'],
  ['Raise / lower road', '<kbd>PageUp</kbd> / <kbd>PageDown</kbd> or <kbd>+</kbd> / <kbd>-</kbd>'],
  ['Pause / resume', '<kbd>Space</kbd>'],
  ['Zoom / pan', 'wheel / right- or middle-drag'],
  ['Help', '<kbd>?</kbd>'],
];

const ROAD_TIP = 'Road elevation: Ground or viaduct L1-L10';

// Dock picture of a road type: white band, gray outline, lane separators, yellow centre line or a one-way arrow
function roadPic(t: RoadType): string {
  const n = t.lanes * (t.oneWay ? 1 : 2), lw = 5, h = n * lw, y0 = 12 - h / 2;
  let s = `<rect x="2" y="${y0}" width="36" height="${h}" rx="1.5" fill="#fff" stroke="#9E9E9A"/>`;
  for (let k = 1; k < n; k++) {
    const y = y0 + k * lw, mid = !t.oneWay && k === t.lanes;
    s += `<path d="M4 ${y}h32" stroke="${mid ? '#E6C84B' : '#C9C9C5'}"${mid ? '' : ' stroke-dasharray="3 2"'}/>`;
  }
  if (t.oneWay) s += '<path d="M14 12h12M22 8l4 4-4 4" stroke="#9E9E9A" fill="none"/>';
  return s;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

// Restart a CSS animation class
function flash(el: Element, cls: string, others: string[] = []): void {
  el.classList.remove(cls, ...others);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

function toolBtn(t: (typeof TOOLS)[number]): string {
  return `<button class="tool${t.tool === 'demolish' ? ' destroy' : ''}" data-tool="${t.tool}" aria-pressed="false" data-tip="${t.tip}" data-key="${t.key}">`
    + `<span class="kb" aria-hidden="true">${t.key}</span>${icon(t.tool)}<span class="lbl">${t.label}</span></button>`;
}

interface Toast { text: string; el: HTMLElement; n: number; timer: ReturnType<typeof setTimeout> }

export class HUD {
  private toolBtns: HTMLButtonElement[];
  private speedBtns: HTMLButtonElement[];
  private dots: HTMLElement[];
  private tip: HTMLElement;
  private tipFor: HTMLElement | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;
  private toasts: Toast[] = [];
  private helpOpen = false;
  private last: {
    money?: number; net?: number; score?: number; speed?: number; tool?: Tool; level?: number;
    week?: number; day?: number; dayFrac?: number; msg: string; danger?: number; pick?: string; over: boolean;
  } = { msg: '', over: false };
  onTutorial: (() => void) | null = null;
  // Called with the most overcrowded city when the warning chip is clicked
  onDanger: ((city: Game['cities'][number]) => void) | null = null;

  constructor(private root: HTMLElement, private game: Game) {
    root.innerHTML = `
      <div class="panel res" role="group" aria-label="Resources">
        <div class="chip money" data-tip="Money" tabindex="0">${icon('money')}<b class="num"></b><small class="net num"></small><span class="delta" aria-hidden="true"></span></div>
        <div class="chip danger" hidden tabindex="0" role="button" data-tip="A city has too many waiting cars. Click to jump to it.">${icon('warning')}<b><span class="long">Overcrowding </span><span class="pct num"></span></b></div>
      </div>
      <div class="panel status">
        <div class="seg" role="group" aria-label="Game speed">
          ${SPEEDS.map(s => `<button class="speed" data-speed="${s.s}" aria-pressed="false" aria-label="${s.tip}" data-tip="${s.tip}"${s.key ? ` data-key="${s.key}"` : ''}>${icon(s.icon)}<small>${s.lbl}</small></button>`).join('')}
        </div>
        <span class="sep"></span>
        <div class="trips" tabindex="0" data-tip="Trips completed: cars that reached their destination.">${icon('car')}<b class="score num">0</b></div>
        <span class="sep"></span>
        <div class="week" tabindex="0" data-tip="">
          <span class="wk"></span>
          <span class="dots">${'<i></i>'.repeat(7)}</span>
        </div>
      </div>
      <button class="panel helpbtn" data-action="help" aria-label="Controls" aria-expanded="false" data-tip="Controls" data-key="?">${icon('help')}</button>
      <div class="panel pop" hidden role="dialog" aria-label="Controls">
        <div class="pop-head"><h2>Controls</h2><button class="iconbtn" data-action="close-help" aria-label="Close [Esc]">${icon('close')}</button></div>
        <table>${CONTROLS.map(([a, b]) => `<tr><th scope="row">${a}</th><td>${b}</td></tr>`).join('')}</table>
        <button class="btn" data-action="tutorial">Replay tutorial</button>
      </div>
      <div class="panel dock" role="toolbar" aria-label="Tools">
        ${TOOLS.slice(0, 3).map(toolBtn).join('')}
        <span class="sep"></span>
        <div class="lanes" data-tip="New roads">
          <svg class="pic rpic" viewBox="0 0 40 24" aria-hidden="true"></svg>
          <span class="plabel"><b>Lanes</b><small class="pctx">per direction</small></span>
          <div class="seg" role="group" aria-label="Lanes per direction">
            ${[1, 2, 3].map(n => `<button class="lane" data-lanes="${n}" aria-pressed="false" data-tip="${laneTip(n)}"><b>${n}</b></button>`).join('')}
          </div>
          <button class="lane wide" data-action="oneway" aria-pressed="false" data-tip="${ONEWAY_TIP}">${icon('oneway')}<small>One-way</small></button>
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
        ${toolBtn(TOOLS[3])}
        ${toolBtn(TOOLS[4])}
      </div>
      <div class="toasts" role="status" aria-live="polite"></div>
      <div class="modal" hidden></div>
      <div class="tip" role="tooltip" hidden></div>`;
    this.toolBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.dock [data-tool]'));
    this.speedBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-speed]'));
    this.dots = Array.from(root.querySelectorAll<HTMLElement>('.dots i'));
    this.tip = this.q('.tip');

    for (const b of this.speedBtns) b.onclick = () => { game.speed = Number(b.dataset.speed) as 0 | 1 | 2 | 4; };
    for (const b of this.toolBtns) b.onclick = () => game.setTool(b.dataset.tool as Tool);
    // Lane picker: edits the selected run (Edit tool) or sets the type of new roads
    const cur = (): RoadType => (game.selected ? game.typeOf(game.selected) : game.roadType);
    const setType = (t: RoadType) => { if (game.selected) game.retype(game.selected, t); else game.setRoadType(t); };
    root.querySelectorAll<HTMLButtonElement>('[data-lanes]').forEach(b => {
      b.onclick = () => setType({ ...cur(), lanes: Number(b.dataset.lanes) as RoadType['lanes'] });
    });
    this.q('[data-action="oneway"]').onclick = () => setType({ ...cur(), oneWay: !cur().oneWay });
    this.q('[data-action="flip"]').onclick = () => { if (game.selected) game.flip(game.selected); };
    this.q('[data-action="level-down"]').onclick = () => game.setLevel(game.level - 1);
    this.q('[data-action="level-up"]').onclick = () => game.setLevel(game.level + 1);
    this.q('[data-action="help"]').onclick = () => this.setHelp(!this.helpOpen);
    this.q('[data-action="close-help"]').onclick = () => this.setHelp(false);
    this.q('[data-action="tutorial"]').onclick = () => { this.setHelp(false); this.onTutorial?.(); };
    const jump = () => {
      const worst = game.cities.reduce((w, c) => (c.overcrowd > (w?.overcrowd ?? 0) ? c : w), null as Game['cities'][number] | null);
      if (worst) this.onDanger?.(worst);
    };
    this.q('.danger').onclick = jump;
    this.q('.danger').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } };
    document.addEventListener('pointerdown', e => {
      if (this.helpOpen && !(e.target as Element).closest('.pop, .helpbtn')) this.setHelp(false, false);
    });
    // capture phase on window: runs before Input's listener, so modal keys never reach the tools
    window.addEventListener('keydown', e => this.onKey(e), true);
    this.bindTips();
  }

  private q<T extends HTMLElement = HTMLElement>(s: string): T {
    return this.root.querySelector(s) as T;
  }

  // ---------- keyboard ----------
  private onKey(e: KeyboardEvent): void {
    const g = this.game;
    if (g.gameOver) {
      e.stopPropagation(); // no key reaches Input while a modal is open (tools, level, Esc)
      if (e.key === 'Enter') { e.preventDefault(); location.reload(); }
      return;
    }
    if (e.key === 'Escape') {
      this.hideTip();
      this.setHelp(false);
    } else if ((e.key === '?' || e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.setHelp(!this.helpOpen);
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
  private bindTips(): void {
    const target = (e: Event) => (e.target as Element).closest<HTMLElement>('[data-tip]');
    this.root.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      const el = target(e);
      if (el === this.tipFor) return;
      this.hideTip();
      if (!el?.dataset.tip) return;
      this.tipFor = el;
      this.tipTimer = setTimeout(() => this.showTip(el), 300);
    });
    this.root.addEventListener('pointerout', e => {
      const to = e.relatedTarget as Node | null;
      if (this.tipFor && to && this.tipFor.contains(to)) return;
      this.hideTip();
    });
    this.root.addEventListener('focusin', e => {
      const el = target(e);
      if (el?.dataset.tip && (e.target as Element).matches(':focus-visible')) this.showTip(el);
    });
    this.root.addEventListener('focusout', () => this.hideTip());
    // touch: long-press a dock button shows its tooltip for 2.5 s
    let press: ReturnType<typeof setTimeout> | undefined;
    this.root.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const el = target(e);
      if (!el?.closest('.dock')) return;
      press = setTimeout(() => { this.showTip(el, true); setTimeout(() => this.hideTip(), 2500); }, 500);
    });
    const stop = () => clearTimeout(press);
    this.root.addEventListener('pointerup', stop);
    this.root.addEventListener('pointercancel', stop);
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
  private renderModal(): void {
    const g = this.game, modal = this.q('.modal');
    const open = g.gameOver;
    this.hideTip();
    this.setHelp(false, false);
    // keep Tab inside the modal
    for (const el of Array.from(this.root.children)) if (el !== modal) el.toggleAttribute('inert', open);
    modal.hidden = !open;
    if (g.gameOver) {
      const city = g.cities.find(c => c.overcrowd >= 1);
      modal.innerHTML = `
        <div class="box" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h2 id="m-title" class="bad">${icon('warning')} Overcrowded!</h2>
          ${city ? `<p class="sub">${esc(city.name)} has too many waiting cars.</p>` : ''}
          <div class="stats">
            <div>${icon('car', 'big')}<span>Trips</span><b class="num">${g.score}</b></div>
            <div>${icon('week', 'big')}<span>Weeks</span><b class="num">${g.week}</b></div>
          </div>
          <div class="actions"><button class="btn primary" data-action="restart">Play again <kbd>Enter</kbd></button></div>
        </div>`;
      const b = this.q<HTMLButtonElement>('[data-action="restart"]');
      b.onclick = () => location.reload();
      b.focus();
    } else {
      modal.innerHTML = '';
    }
  }

  // Lane picker: reflects the selected run (Edit tool) or the type for new roads
  private updatePicker(): void {
    const g = this.game, run = g.selected;
    const t = run ? g.typeOf(run) : g.roadType;
    const key = `${g.tool}|${run ? run.map(e => e.id).join(',') : '-'}|${t.lanes}|${t.oneWay}`;
    if (key === this.last.pick) return;
    this.last.pick = key;
    const off = g.tool !== 'road' && g.tool !== 'edit';
    const box = this.q('.lanes');
    box.classList.toggle('off', off);
    box.dataset.tip = off ? 'Lanes apply to the Road and Edit tools' : run ? 'Editing the selected road' : 'Road type for new roads';
    this.q('.pctx').textContent = run ? 'editing road' : 'per direction';
    this.q('.rpic').innerHTML = roadPic(t);
    // $ to pay (or get back) if the selected run switched to type n
    const delta = (n: RoadType) => {
      if (!run) return '';
      const d = Math.round(g.retypeDelta(run, n));
      return d > 0 ? ` · costs ${fmtMoney(d)}` : d < 0 ? ` · refunds ${fmtMoney(-d)}` : '';
    };
    box.querySelectorAll<HTMLButtonElement>('[data-lanes]').forEach(b => {
      const n = Number(b.dataset.lanes) as RoadType['lanes'];
      b.disabled = off;
      b.setAttribute('aria-pressed', String(t.lanes === n));
      b.dataset.tip = laneTip(n) + delta({ ...t, lanes: n });
    });
    const ow = this.q<HTMLButtonElement>('[data-action="oneway"]');
    ow.disabled = off;
    ow.setAttribute('aria-pressed', String(t.oneWay));
    ow.dataset.tip = ONEWAY_TIP + delta({ ...t, oneWay: !t.oneWay });
    this.q('[data-action="flip"]').hidden = !(run && t.oneWay);
  }

  // ---------- per-frame update: writes the DOM only when a value changed ----------
  update(): void {
    const g = this.game, L = this.last;

    // Money in whole dollars with a 200ms flash per change. Net per day = income (yesterday's, or today's so far
    // on the first day) minus the network's upkeep.
    const money = Math.round(g.money);
    const net = Math.round(income(g.today ? g.ledger.yesterday : g.ledger.today) - g.upkeepDay);
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
      c.dataset.tip = `Money. Trips earn ${fmtMoney(T.ARRIVAL_PAY)} each; roads and controls cost ${fmtMoney(g.upkeepDay)}/day upkeep.`
        + ` Yesterday: income ${fmtMoney(income(y))}, upkeep ${fmtMoney(y.upkeep)}, building ${fmtMoney(y.build)}.`
        + ` Today: income ${fmtMoney(income(t))}, building ${fmtMoney(t.build)}.`;
      if (prev !== undefined && Number.isFinite(d) && d !== 0) {
        (c.querySelector('.delta') as HTMLElement).textContent = d > 0 ? `+${fmtMoney(d)}` : `−${fmtMoney(-d)}`;
        flash(c, d > 0 ? 'gain' : 'spend', ['gain', 'spend']);
      }
    }

    if (g.speed !== L.speed) {
      L.speed = g.speed;
      for (const b of this.speedBtns) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === g.speed));
      this.q('.status').classList.toggle('paused', g.speed === 0);
      L.week = undefined; // relabel Week / Paused below
    }

    const toolChanged = g.tool !== L.tool;
    if (toolChanged) {
      L.tool = g.tool;
      for (const b of this.toolBtns) b.setAttribute('aria-pressed', String(b.dataset.tool === g.tool));
      document.body.dataset.tool = g.tool;
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

    if (g.score !== L.score) {
      const up = L.score !== undefined && g.score > L.score;
      L.score = g.score;
      const s = this.q('.score');
      s.textContent = String(g.score);
      if (up) flash(s, 'bump');
    }

    if (g.week !== L.week || g.day !== L.day) {
      L.week = g.week;
      L.day = g.day;
      L.dayFrac = undefined;
      this.q('.wk').innerHTML = g.speed === 0 ? 'Paused' : `<span class="long">Week </span><span class="short">W</span>${g.week}`;
      this.dots.forEach((d, i) => { d.className = i + 1 < g.day ? 'past' : i + 1 === g.day ? 'now' : ''; });
      this.q('.week').dataset.tip = `Week ${g.week}, day ${g.day} of 7. Upkeep is paid at the end of each day.`;
    }
    const frac = Math.round(((g.time % DAY_SECONDS) / DAY_SECONDS) * 20) / 20;
    if (frac !== L.dayFrac) {
      L.dayFrac = frac;
      this.dots[g.day - 1]?.style.setProperty('--p', String(frac));
    }

    let danger = 0;
    for (const c of g.cities) danger = Math.max(danger, c.overcrowd);
    const pct = Math.ceil(danger * 20) * 5; // ceil: any overcrowd > 0 shows the chip
    if (pct !== L.danger) {
      L.danger = pct;
      const chip = this.q('.danger');
      chip.hidden = pct === 0;
      (chip.querySelector('.pct') as HTMLElement).textContent = `${pct}%`;
    }

    // ponytail: change detection on the text, so an identical message repeated before it clears is not re-toasted
    if (g.message !== L.msg) {
      L.msg = g.message;
      if (g.message) this.toast(g.message);
    }

    if (g.gameOver !== L.over) {
      L.over = g.gameOver;
      this.renderModal();
    }
  }
}
