import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

// Every sound is synthesised with Web Audio: no asset files, tiny download, and the
// crowd can react to what happens (roar on goals, groan on misses).

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crowd: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  muted = false;

  /** Browsers only allow audio after a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    // Pinkish noise: sounds more like a crowd than white noise.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.6;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private burst(dur: number, type: BiquadFilterType, freq: number, vol: number, attack = 0.01, toFreq?: number, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (toFreq) f.frequency.exponentialRampToValueAtTime(toFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  /** Low background murmur of the crowd while in a stadium. */
  ambience(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    if (on && !this.crowd) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 700;
      f.Q.value = 0.6;
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 1.5);
      src.connect(f).connect(gain).connect(this.master);
      src.start();
      this.crowd = { src, gain };
    } else if (!on && this.crowd) {
      const c = this.crowd;
      c.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      c.src.stop(ctx.currentTime + 0.7);
      this.crowd = null;
    }
  }

  /** Crowd tension rising during the run-up / aim. */
  tension(level: number): void {
    if (this.crowd && this.ctx) this.crowd.gain.gain.setTargetAtTime(0.1 + level * 0.12, this.ctx.currentTime, 0.3);
  }

  kick(power = 1): void {
    this.tone(140, 0.16, 'sine', 0.6 * power, 0, 45);
    this.burst(0.05, 'highpass', 2500, 0.25 * power);
  }

  whistle(long = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const blasts = long ? [0, 0.3, 0.6] : [0];
    for (const d of blasts) {
      const t = ctx.currentTime + d;
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const g = ctx.createGain();
      osc.frequency.value = 2900;
      lfo.frequency.value = 35;
      lfoGain.gain.value = 120;
      lfo.connect(lfoGain).connect(osc.frequency);
      const dur = long && d === 0.6 ? 0.6 : 0.22;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.setValueAtTime(0.12, t + dur - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.master);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + dur + 0.02);
      lfo.stop(t + dur + 0.02);
    }
  }

  goal(): void {
    this.burst(0.25, 'highpass', 3000, 0.25, 0.005, 1200); // net swish
    this.burst(2.6, 'bandpass', 600, 0.75, 0.15, 900, 0.05); // roar
    this.burst(2.2, 'bandpass', 1500, 0.3, 0.2, 2000, 0.1);
  }

  save(): void {
    this.burst(0.12, 'lowpass', 900, 0.6, 0.004);
    this.tone(180, 0.12, 'sine', 0.35, 0, 90);
    this.burst(1.6, 'bandpass', 500, 0.45, 0.1, 400, 0.08); // "ooh"
  }

  post(): void {
    [880, 1318, 2093, 2637].forEach((f, i) => this.tone(f, 0.9 - i * 0.15, 'sine', 0.18 / (i + 1)));
    this.burst(1.4, 'bandpass', 450, 0.4, 0.1, 300, 0.1);
  }

  miss(): void {
    this.burst(1.6, 'lowpass', 600, 0.45, 0.15, 250);
  }

  dive(): void {
    this.burst(0.18, 'bandpass', 1200, 0.2, 0.01, 400);
  }

  click(): void {
    this.tone(900, 0.05, 'sine', 0.12);
  }

  card(): void {
    this.tone(660, 0.12, 'triangle', 0.15);
    this.tone(990, 0.18, 'triangle', 0.12, 0.06);
  }

  fanfare(): void {
    [0, 4, 7, 12, 16, 19, 24].forEach((s, k) => this.tone(392 * Math.pow(2, s / 12), 0.5, 'triangle', 0.16, k * 0.08));
  }

  lose(): void {
    [7, 4, 0, -5].forEach((s, k) => this.tone(392 * Math.pow(2, s / 12), 0.45, 'triangle', 0.14, k * 0.18));
  }
}

/** Short vibration: native haptics in the app (iPhone + Android), vibrate() in browsers. */
export function haptic(ms: number): void {
  if (Capacitor.isNativePlatform()) {
    void Haptics.impact({ style: ms >= 30 ? ImpactStyle.Heavy : ms >= 15 ? ImpactStyle.Medium : ImpactStyle.Light }).catch(() => {});
    return;
  }
  try {
    navigator.vibrate?.(ms);
  } catch {
    // unsupported
  }
}

export const sfx = new Sfx();
