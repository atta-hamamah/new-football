// Landscape touch controls.
// Left half: floating joystick (push past the rim to sprint, direction locks while sprinting).
// Right side: PASS and SHOOT. Hold SHOOT to charge; the stick picks where the shot goes.
// Defending a shot: push the stick toward the ball and tap a button to dive.

import { haptic } from '../ui/audio';
import { h } from '../ui/dom';
import { type Input, SPRINT_AT } from './types';

const STICK_R = 64;

const ICON_PASS =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h12M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SHOOT =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7.5l3.2 2.3-1.2 3.8h-4l-1.2-3.8z" fill="currentColor"/></svg>';

function iconButton(cls: string, icon: string, label: string): HTMLButtonElement {
  const b = h('button', { class: `act ${cls}` });
  b.innerHTML = `<span class="act-ring"></span><span class="act-face">${icon}<span class="act-label">${label}</span></span>`;
  return b;
}

export class Controls {
  readonly el: HTMLElement;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly passBtn: HTMLButtonElement;
  private readonly shootBtn: HTMLButtonElement;
  private readonly diveHint: HTMLElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  /** Joystick in screen space (x right, y down), magnitude 0..1. */
  private stick = { x: 0, y: 0 };
  private keys = new Set<string>();
  private pass = false;
  private shoot = false;
  private dive = -1;
  private diving = false;

  /** `flip` = 1 for the team attacking pitch +y (shown to the right), -1 for the other team. */
  constructor(private readonly flip: number) {
    this.base = h('div', { class: 'stick-base hidden' });
    this.knob = h('div', { class: 'stick-knob' });
    this.base.appendChild(this.knob);
    this.passBtn = iconButton('pass', ICON_PASS, 'PASS');
    this.shootBtn = iconButton('shoot', ICON_SHOOT, 'SHOOT');
    this.diveHint = h(
      'div',
      { class: 'dive-hint hidden' },
      h('div', { class: 'dive-title' }, 'SAVE IT!'),
      h('div', { class: 'dive-sub' }, 'Push the stick toward the ball · tap to dive'),
      h('div', { class: 'dive-bar' }, h('span', {})),
    );
    const zone = h('div', { class: 'stick-zone' });
    const hint = h('div', { class: 'stick-hint' }, 'MOVE');
    this.el = h(
      'div',
      { class: 'controls' },
      zone,
      hint,
      this.base,
      h('div', { class: 'buttons' }, this.passBtn, this.shootBtn),
      this.diveHint,
    );

    zone.addEventListener('pointerdown', (e) => {
      hint.remove();
      this.onDown(e);
    });
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e));
    const hold = (btn: HTMLButtonElement, set: (v: boolean) => void) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture?.(e.pointerId);
        if (this.diving) {
          this.commitDive();
          return;
        }
        set(true);
        btn.classList.add('down');
        haptic(8);
      });
      const up = () => {
        set(false);
        btn.classList.remove('down');
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    };
    hold(this.passBtn, (v) => (this.pass = v));
    hold(this.shootBtn, (v) => (this.shoot = v));
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    this.el.remove();
  }

  /** Shows the dive prompt while the opponent's shot is in the air. `secondsLeft` animates the bar. */
  setDiving(on: boolean, secondsLeft = 0.5): void {
    if (on === this.diving) return;
    this.diving = on;
    this.diveHint.classList.toggle('hidden', !on);
    this.el.classList.toggle('diving', on);
    if (on) {
      const bar = this.diveHint.querySelector('.dive-bar span') as HTMLElement;
      bar.style.animation = 'none';
      void bar.offsetWidth;
      bar.style.animation = `drain ${Math.max(0.2, secondsLeft)}s linear forwards`;
    } else this.dive = -1;
  }

  /** Fills the ring on the SHOOT button (0..1), or hides it (-1). */
  setCharge(c: number): void {
    this.shootBtn.style.setProperty('--charge', String(Math.max(0, c)));
    this.shootBtn.classList.toggle('charging', c >= 0);
    this.shootBtn.classList.toggle('full', c >= 0.999);
  }

  private onDown(e: PointerEvent): void {
    if (this.stickId !== null) return;
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.remove('hidden');
    this.knob.style.transform = 'translate(-50%, -50%)';
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.stickId) return;
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    const d = Math.hypot(dx, dy);
    // Past the rim = over-extended (sprint / longest pass / high shot).
    const over = d > STICK_R * 1.05;
    const mag = over ? 1 : Math.min(SPRINT_AT - 0.01, d / STICK_R);
    this.stick = d > 4 ? { x: (dx / d) * mag, y: (dy / d) * mag } : { x: 0, y: 0 };
    const k = Math.min(d, STICK_R * 1.15) / (d || 1);
    this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    this.base.classList.toggle('over', over);
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.stick = { x: 0, y: 0 };
    this.base.classList.add('hidden');
    this.base.classList.remove('over');
  }

  /** Dive where the stick points: up/down = side, centred = stay, pushed to the edge = high. */
  private commitDive(): void {
    if (!this.diving || this.dive >= 0) return;
    const inp = this.read();
    const mag = Math.hypot(inp.mx, inp.my);
    if (mag < 0.3) this.dive = 6;
    else {
      const col = inp.mx > 0.35 ? 1 : inp.mx < -0.35 ? -1 : 0;
      this.dive = (mag >= SPRINT_AT ? 3 : 0) + col + 1;
    }
    haptic(20);
  }

  private readonly onKey = (e: KeyboardEvent) => {
    this.keys.add(e.key.toLowerCase());
    if (this.diving && (e.key === ' ' || e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'k')) this.commitDive();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** Current input in pitch coordinates. */
  read(): Input {
    let sx = this.stick.x;
    let sy = this.stick.y;
    const k = this.keys;
    const kx = (k.has('arrowright') || k.has('d') ? 1 : 0) - (k.has('arrowleft') || k.has('a') ? 1 : 0);
    const ky = (k.has('arrowdown') || k.has('s') ? 1 : 0) - (k.has('arrowup') || k.has('w') ? 1 : 0);
    if (kx || ky) {
      const l = Math.hypot(kx, ky);
      const mag = k.has('shift') ? 1 : 0.8;
      sx = (kx / l) * mag;
      sy = (ky / l) * mag;
    }
    return {
      // Landscape: screen right = towards the goal you attack (pitch +y for team 0),
      // screen down = pitch +x. Mirrored for the other team.
      mx: sy * this.flip,
      my: sx * this.flip,
      pass: !this.diving && (this.pass || (k.has(' ') && !this.diving) || k.has('j')),
      shoot: !this.diving && (this.shoot || k.has('k')),
      dive: this.dive,
    };
  }
}
