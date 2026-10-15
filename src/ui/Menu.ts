// Main menu (Continue, New game, Load, Sound, Controls) and the pause menu (Esc with nothing to cancel): Resume, Save, Load, Sound,
// Controls, Quit
import type { Game } from '../core/Game.ts';
import { fmtMoney } from '../core/Game.ts';
import { BIOMES, DIFFICULTY, SIZES } from '../core/config.ts';
import type { Biome, Difficulty, GameConfig, MapSize, Mode } from '../core/config.ts';
import { AUTO, SLOTS, peek } from '../core/Save.ts';
import { CONTROLS } from './HUD.ts';
import { icon } from './icons.ts';
import { sound } from './Sound.ts';
import type { Mix } from './Sound.ts';

type View = 'main' | 'new' | 'load' | 'save' | 'help' | 'pause' | 'sound';
export interface MenuHooks {
  game(): Game;
  newGame(cfg: GameConfig): void;
  // false: nothing readable in that slot
  load(key: string): boolean;
  // false: storage full or blocked
  save(key: string): boolean;
  // Quit to menu: the autosave
  quit(): void;
  // Esc opens the pause menu only when nothing else would take it (a road in progress, a selection, a panel, a modal)
  canPause(): boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
// ponytail: a UI roll, not a model one, so it stays off the seeded stream
const randomSeed = (): string => Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
const SLOT_NAME = (key: string): string => key === AUTO ? 'Autosave' : `Slot ${SLOTS.indexOf(key) + 1}`;
const cfgLine = (c: GameConfig): string => `${cap(c.mode)} · ${cap(c.difficulty)} · ${BIOMES[c.biome].label} · ${cap(c.size)}`;
// 'Day 4 · 1,240 residents · Lv 3', or why the slot cannot load
function slotLine(key: string): { ok: boolean; text: string; sub: string } {
  const s = peek(key);
  if (!s) return { ok: false, text: 'Empty', sub: '' };
  if (s === 'bad') return { ok: false, text: 'Unreadable save', sub: 'From another version of the game' };
  return { ok: true, text: `Day ${s.day} · ${Math.round(s.pop).toLocaleString('en-US')} residents · Lv ${s.level}`, sub: `${cfgLine(s.cfg)} · seed ${esc(s.cfg.seed)}` };
}

const MODE_TIP: Record<Mode, string> = {
  career: 'A budget, city levels and unlocks. Bankruptcy or unhappy residents end the game.',
  creative: 'Unlimited money, every tool unlocked, no way to lose.',
};
const diffTip = (d: Difficulty): string => {
  const x = DIFFICULTY[d];
  return `${fmtMoney(x.money)} to start, taxes ×${x.tax}, upkeep ×${x.upkeep}${x.starterRoad ? ', a street in the starter town' : ''}.`;
};

export class Menu {
  private view: View | null = null;
  // where Back goes: the main menu, or the pause menu over a running game
  private home: 'main' | 'pause' = 'main';
  private resume: Game['speed'] = 1;
  private draft: GameConfig | null = null;
  private note = '';

  constructor(private el: HTMLElement, private hud: HTMLElement, private h: MenuHooks) {
    // capture on window, registered before any HUD: while open no key reaches the HUD or the tools (typing in the seed field still works)
    window.addEventListener('keydown', e => this.onKey(e), true);
    el.addEventListener('click', e => {
      const b = (e.target as Element).closest<HTMLElement>('[data-m]');
      if (b && !(b as HTMLButtonElement).disabled) this.act(b.dataset.m!, b.dataset.v);
    });
    // volume sliders: live while dragging, no redraw (the slider keeps focus); the effects one plays a sample when let go
    el.addEventListener('input', e => {
      const r = e.target as HTMLInputElement, k = r.dataset.vol as keyof Mix | undefined;
      if (!k) return;
      sound.set({ [k]: Number(r.value) / 100 });
      r.nextElementSibling!.textContent = `${r.value}%`;
    });
    el.addEventListener('change', e => { if ((e.target as HTMLElement).dataset.vol === 'sfx') sound.play('place'); });
  }

  get open(): boolean { return this.view !== null; }

  // The pause menu stops the clock; the main menu leaves the game behind it as it is
  show(view: View): void {
    const g = this.h.game();
    if (view === 'pause' && !this.view) { this.home = 'pause'; this.note = ''; this.resume = g.speed; g.speed = 0; }
    if (view === 'main') { this.home = 'main'; this.note = ''; g.speed = 0; }
    this.view = view;
    this.el.hidden = false;
    this.hud.inert = true;
    this.render();
  }

  private close(restore: boolean): void {
    if (restore) this.h.game().speed = this.resume;
    this.view = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.hud.inert = false;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.view) {
      if (e.key === 'Escape' && !e.repeat && this.h.canPause()) { e.preventDefault(); e.stopImmediatePropagation(); this.show('pause'); }
      return;
    }
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (this.view === 'pause') this.close(true); else if (this.view !== 'main') this.show(this.home); }
    else if (e.key === 'Enter' && (e.target as Element).matches('.seed')) { e.preventDefault(); this.act('start'); }
  }

  private act(m: string, v?: string): void {
    const d = this.draft;
    if (m === 'resume') this.close(true);
    else if (m === 'back') this.show(this.home);
    else if (m === 'new' || m === 'load' || m === 'save' || m === 'help' || m === 'sound') this.show(m);
    else if (m === 'snd' && v) { const [k, x] = v.split(':'); sound.set({ [k]: x === '1' }); this.render(); }
    else if (m === 'continue') { if (this.h.load(AUTO)) this.close(false); else this.render(); }
    else if (m === 'slot' && v) {
      if (this.view === 'save') { this.note = this.h.save(v) ? `Saved to ${SLOT_NAME(v)}.` : 'Could not save: storage is full or blocked.'; this.show('pause'); }
      else if (this.h.load(v)) this.close(false);
      else this.render();
    } else if (m === 'quit') { this.h.quit(); this.show('main'); }
    else if (m === 'copy') {
      const seed = this.h.game().cfg.seed;
      navigator.clipboard?.writeText(seed).then(() => { this.note = 'Seed copied.'; this.render(); }, () => { this.note = 'Copy blocked: select the seed and copy it.'; this.render(); });
    } else if (d && m === 'opt' && v) {
      const [k, x] = v.split(':') as [keyof GameConfig, string];
      this.draft = { ...d, seed: this.seedField(), [k]: x };
      this.render();
    } else if (d && m === 'dice') { this.draft = { ...d, seed: randomSeed() }; this.render(); this.el.querySelector<HTMLInputElement>('.seed')?.focus(); }
    else if (d && m === 'start') { this.h.newGame({ ...d, seed: this.seedField() || randomSeed() }); this.close(false); }
  }

  private seedField(): string {
    return (this.el.querySelector<HTMLInputElement>('.seed')?.value ?? this.draft?.seed ?? '').trim().slice(0, 64);
  }

  private render(): void {
    const v = this.view!, g = this.h.game();
    const btn = (m: string, label: string, cls = '', extra = '') => `<button class="btn ${cls}" data-m="${m}"${extra}>${label}</button>`;
    const back = btn('back', 'Back', 'ghost');
    let body = '';
    if (v === 'main') {
      const a = slotLine(AUTO);
      body = `<h1 id="mn-title" class="brand">TrafficMania</h1>
        <p class="sub">Design the road network, find the bottleneck, fix it and grow the city.</p>
        <div class="mlist">
          ${a.ok ? btn('continue', `<span>Continue</span><small>${a.text}</small>`, 'primary') : ''}
          ${btn('new', 'New game', a.ok ? '' : 'primary')}${btn('load', 'Load game')}${btn('sound', 'Sound')}${btn('help', 'Controls')}
        </div>`;
    } else if (v === 'pause') {
      body = `<h2 id="mn-title">Paused</h2>
        <p class="sub">${cfgLine(g.cfg)} · Day ${g.day}</p>
        <div class="seedrow"><span>Seed</span><code>${esc(g.cfg.seed)}</code>
          <button class="iconbtn" data-m="copy" aria-label="Copy the seed" title="Copy the seed">${icon('copy')}</button></div>
        <div class="mlist">
          ${btn('resume', 'Resume <kbd>Esc</kbd>', 'primary')}${btn('save', `${icon('save')}Save game`)}${btn('load', 'Load game')}
          ${btn('sound', 'Sound')}${btn('help', 'Controls')}${btn('quit', 'Quit to menu')}
        </div>
        <p class="note" role="status">${esc(this.note)}</p>`;
    } else if (v === 'load' || v === 'save') {
      const keys = v === 'load' ? [AUTO, ...SLOTS] : SLOTS;
      body = `<h2 id="mn-title">${v === 'load' ? 'Load game' : 'Save game'}</h2>
        <p class="sub">${v === 'load' ? 'The autosave is written every midnight and when you quit to the menu.' : 'Saving over a slot replaces it. Cars on the road are not saved: their trips start again from the door.'}</p>
        <div class="slots">${keys.map(k => {
          const s = slotLine(k), ok = v === 'save' || s.ok;
          return `<button class="slot" data-m="slot" data-v="${k}"${ok ? '' : ' disabled'}><b>${SLOT_NAME(k)}</b><span>${s.text}</span><small>${s.sub}</small></button>`;
        }).join('')}</div>
        <div class="actions">${back}</div>`;
    } else if (v === 'sound') {
      const x = sound.mix;
      // onV: the value of k that 'On' sets (muted is on when false)
      const toggle = (k: 'muted' | 'musicOn', label: string, onV: boolean) => `
        <div class="field" role="group" aria-label="${label}"><span class="flabel">${label}</span>
          <div class="opts">${([['On', onV], ['Off', !onV]] as const).map(([l, v]) => `<button class="opt" data-m="snd" data-v="${k}:${+v}" aria-pressed="${x[k] === v}">${l}</button>`).join('')}</div></div>`;
      const slider = (k: 'master' | 'music' | 'sfx', label: string) => `
        <label class="field"><span class="flabel">${label}</span>
          <span class="vol"><input type="range" min="0" max="100" step="5" data-vol="${k}" value="${Math.round(x[k] * 100)}"><output>${Math.round(x[k] * 100)}%</output></span></label>`;
      body = `<h2 id="mn-title">Sound</h2>
        <p class="sub"><kbd>Shift</kbd> + <kbd>M</kbd> mutes or unmutes at any time.</p>
        ${toggle('muted', 'Sound', false)}
        ${slider('master', 'Master volume')}${slider('sfx', 'Effects and city')}
        ${toggle('musicOn', 'Music', true)}${slider('music', 'Music volume')}
        <div class="actions">${back}</div>`;
    } else if (v === 'help') {
      body = `<h2 id="mn-title">Controls</h2>
        <table>${CONTROLS.map(([a, b]) => `<tr><th scope="row">${a}</th><td>${b}</td></tr>`).join('')}</table>
        <div class="actions">${back}</div>`;
    } else {
      const d = this.draft ??= { ...g.cfg, seed: randomSeed() };
      const group = <K extends keyof GameConfig>(k: K, label: string, opts: [string, string][], tip: string) => `
        <div class="field" role="group" aria-label="${label}"><span class="flabel">${label}</span>
          <div class="opts">${opts.map(([x, l]) => `<button class="opt" data-m="opt" data-v="${k}:${x}" aria-pressed="${d[k] === x}">${l}</button>`).join('')}</div>
          <small>${tip}</small></div>`;
      body = `<h2 id="mn-title">New game</h2>
        ${group('mode', 'Mode', [['career', 'Career'], ['creative', 'Creative']], MODE_TIP[d.mode])}
        ${group('difficulty', 'Difficulty', (Object.keys(DIFFICULTY) as Difficulty[]).map(x => [x, cap(x)]), diffTip(d.difficulty))}
        ${group('biome', 'Biome', (Object.keys(BIOMES) as Biome[]).map(x => [x, BIOMES[x].label]), '')}
        ${group('size', 'Map size', (Object.keys(SIZES) as MapSize[]).map(x => [x, cap(x)]), '')}
        <label class="field"><span class="flabel">Seed</span>
          <span class="seedin"><input class="seed" maxlength="64" spellcheck="false" autocomplete="off" value="${esc(d.seed)}">
          <button class="iconbtn" data-m="dice" aria-label="Random seed" title="Random seed">${icon('dice')}</button></span>
          <small>The same seed, biome and size always give the same map.</small></label>
        <div class="actions">${back}${btn('start', 'Start', 'primary')}</div>`;
    }
    // focus stays on the control that redrew the view (an option, the dice), else the first action
    const f = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement) ? document.activeElement.dataset : null;
    this.el.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-labelledby="mn-title">${body}</div>`;
    const same = f?.v ? this.el.querySelector<HTMLElement>(`[data-v="${f.v}"]`) : f?.m === 'copy' ? this.el.querySelector<HTMLElement>('[data-m="copy"]') : null;
    const first = (sel: string) => this.el.querySelector<HTMLElement>(sel);
    (same ?? first('.btn.primary') ?? first('.slot:not(:disabled)') ?? first('.btn'))?.focus();
  }
}
