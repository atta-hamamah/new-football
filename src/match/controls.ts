// Touch controls: a floating joystick (left half), PASS and SHOOT buttons (right),
// and swipe-to-dive while you are defending a shot. Keyboard works on desktop too.

import { haptic } from '../ui/audio';
import { h } from '../ui/dom';
import { type Input, SPRINT_AT } from './types';

const STICK_R = 62;

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
  private swipe: { id: number; x: number; y: number } | null = null;

  /** `flip` = 1 if this player attacks up the screen in pitch +y, -1 if the view is rotated. */
  constructor(private readonly flip: number) {
    this.base = h('div', { class: 'stick-base hidden' });
    this.knob = h('div', { class: 'stick-knob' });
    this.base.appendChild(this.knob);
    this.passBtn = h('button', { class: 'act pass' }, 'PASS');
    this.shootBtn = h('button', { class: 'act shoot' }, 'SHOOT');
    this.diveHint = h(
      'div',
      { class: 'dive-hint hidden' },
      h('div', { class: 'dive-title' }, 'SAVE IT!'),
      h('div', {}, 'Swipe ← ↑ → to dive'),
    );
    const zone = h('div', { class: 'stick-zone' });
    this.el = h('div', { class: 'controls' }, zone, this.base, h('div', { class: 'buttons' }, this.passBtn, this.shootBtn), this.diveHint);

    zone.addEventListener('pointerdown', (e) => this.onDown(e));
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('pointerup', (e) => this.onUp(e));
    this.el.addEventListener('pointercancel', (e) => this.onUp(e));
    const hold = (btn: HTMLButtonElement, set: (v: boolean) => void) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.diving) return this.onDown(e);
        set(true);
        btn.classList.add('down');
        haptic(8);
      });
      const up = () => {
        set(false);
        btn.classList.remove('down');
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', up);
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

  /** Shows the dive prompt while the opponent's shot is in the air. */
  setDiving(on: boolean): void {
    if (on === this.diving) return;
    this.diving = on;
    this.diveHint.classList.toggle('hidden', !on);
    this.el.classList.toggle('diving', on);
    if (!on) this.dive = -1;
  }

  private onDown(e: PointerEvent): void {
    if (this.diving) {
      this.swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }
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
    if (this.swipe && e.pointerId === this.swipe.id) {
      const dx = e.clientX - this.swipe.x;
      const dy = e.clientY - this.swipe.y;
      if (dx * dx + dy * dy > 40 * 40) this.finishSwipe(dx, dy);
      return;
    }
    if (e.pointerId !== this.stickId) return;
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    const d = Math.hypot(dx, dy);
    // Past the rim = over-extended (sprint / far pass / high shot).
    const over = d > STICK_R * 1.05;
    const mag = over ? 1 : Math.min(SPRINT_AT - 0.01, d / STICK_R);
    this.stick = d > 4 ? { x: (dx / d) * mag, y: (dy / d) * mag } : { x: 0, y: 0 };
    const k = Math.min(d, STICK_R * 1.15) / (d || 1);
    this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    this.base.classList.toggle('over', over);
  }

  private onUp(e: PointerEvent): void {
    if (this.swipe && e.pointerId === this.swipe.id) {
      this.finishSwipe(e.clientX - this.swipe.x, e.clientY - this.swipe.y);
      return;
    }
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.stick = { x: 0, y: 0 };
    this.base.classList.add('hidden');
    this.base.classList.remove('over');
  }

  private finishSwipe(dx: number, dy: number): void {
    this.swipe = null;
    if (!this.diving || this.dive >= 0) return;
    const len = Math.hypot(dx, dy);
    if (len < 20) {
      this.dive = 6; // stay
      return;
    }
    const colScreen = dx > 0.4 * len ? 1 : dx < -0.4 * len ? -1 : 0;
    const row = dy < -0.35 * len ? 1 : 0;
    this.dive = row * 3 + colScreen * this.flip + 1;
    haptic(20);
  }

  private readonly onKey = (e: KeyboardEvent) => {
    this.keys.add(e.key.toLowerCase());
    if (this.diving && this.dive < 0) {
      const map: Record<string, number> = { q: 3, w: 4, e: 5, a: 0, s: 1, d: 2 };
      const k = e.key.toLowerCase();
      if (k in map) {
        const z = map[k];
        const col = (z % 3) - 1;
        this.dive = Math.floor(z / 3) * 3 + col * this.flip + 1;
      }
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** Current input in pitch coordinates. */
  read(): Input {
    let sx = this.stick.x;
    let sy = this.stick.y;
    const k = this.keys;
    if (!this.diving) {
      const kx = (k.has('arrowright') || k.has('d') ? 1 : 0) - (k.has('arrowleft') || k.has('a') ? 1 : 0);
      const ky = (k.has('arrowdown') || k.has('s') ? 1 : 0) - (k.has('arrowup') || k.has('w') ? 1 : 0);
      if (kx || ky) {
        const l = Math.hypot(kx, ky);
        const mag = k.has('shift') ? 1 : 0.8;
        sx = (kx / l) * mag;
        sy = (ky / l) * mag;
      }
    }
    return {
      // Screen right/up -> pitch +x/+y for team 0; mirrored for team 1.
      mx: sx * this.flip,
      my: -sy * this.flip,
      pass: this.pass || k.has(' ') || k.has('j'),
      shoot: this.shoot || k.has('k'),
      dive: this.dive,
    };
  }
}
