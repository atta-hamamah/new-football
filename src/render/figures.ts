// Stylised players drawn with vector shapes. Units: pixels at a given metre scale.

import { Container, Graphics } from 'pixi.js';

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const GLOVE = 0xc6ff00;
// a b c d e f g
const SEGMENTS = ['1111110', '0110000', '1101101', '1111001', '0110011', '1011011', '1011111', '1110000', '1111111', '1111011'].map((s) =>
  s.split('').map(Number),
);

function darken(c: number, k: number): number {
  const r = Math.round(((c >> 16) & 255) * k);
  const g = Math.round(((c >> 8) & 255) * k);
  const b = Math.round((c & 255) * k);
  return (r << 16) | (g << 8) | b;
}

/** Goalkeeper seen from the front. Origin = body centre (about 1 m above the ground). */
export class KeeperFigure {
  readonly root = new Container();
  private readonly ready = new Graphics();
  private readonly stretch = new Graphics();
  private readonly shadow = new Graphics();

  constructor(
    private readonly S: number,
    color: number,
    skin = SKIN[1],
  ) {
    this.root.addChild(this.ready, this.stretch);
    this.stretch.visible = false;
    this.setKit(color, skin);
  }

  get shadowGraphic(): Graphics {
    return this.shadow;
  }

  setKit(color: number, skin = SKIN[1]): void {
    const S = this.S;
    const m = (v: number) => v * S;
    const shorts = darken(color, 0.35);
    for (const [g, armsUp] of [
      [this.ready, false],
      [this.stretch, true],
    ] as const) {
      g.clear();
      // legs
      g.roundRect(m(-0.2), m(0.05), m(0.15), m(0.9), m(0.06)).fill(darken(color, 0.25));
      g.roundRect(m(0.05), m(0.05), m(0.15), m(0.9), m(0.06)).fill(darken(color, 0.25));
      // boots
      g.roundRect(m(-0.23), m(0.88), m(0.2), m(0.1), m(0.04)).fill(0x111111);
      g.roundRect(m(0.03), m(0.88), m(0.2), m(0.1), m(0.04)).fill(0x111111);
      // shorts
      g.roundRect(m(-0.25), m(-0.05), m(0.5), m(0.3), m(0.06)).fill(shorts);
      // arms
      const arm = (x0: number, y0: number, x1: number, y1: number) => {
        g.moveTo(m(x0), m(y0))
          .lineTo(m(x1), m(y1))
          .stroke({ width: m(0.13), color, cap: 'round' });
        g.circle(m(x1), m(y1), m(0.085)).fill(GLOVE);
      };
      if (armsUp) {
        arm(-0.22, -0.5, -0.32, -1.25);
        arm(0.22, -0.5, 0.32, -1.25);
      } else {
        arm(-0.24, -0.48, -0.6, -0.15);
        arm(0.24, -0.48, 0.6, -0.15);
      }
      // torso
      g.roundRect(m(-0.27), m(-0.6), m(0.54), m(0.6), m(0.12)).fill(color);
      g.roundRect(m(-0.27), m(-0.6), m(0.54), m(0.12), m(0.06)).fill(darken(color, 0.8));
      // head
      g.circle(0, m(-0.77), m(0.13)).fill(skin);
      g.ellipse(0, m(-0.86), m(0.13), m(0.06)).fill(0x2b1b10);
    }
    this.shadow.clear().ellipse(0, 0, m(0.5), m(0.09)).fill({ color: 0x000000, alpha: 0.35 });
  }

  setStretch(on: boolean): void {
    this.ready.visible = !on;
    this.stretch.visible = on;
  }
}

/** Penalty taker seen from behind. Origin = feet. */
export class ShooterFigure {
  readonly root = new Container();
  private readonly body = new Container();
  private readonly legs = new Graphics();
  private readonly torso = new Graphics();

  constructor(
    private readonly S: number,
    color: number,
    number: number,
    skin = SKIN[2],
  ) {
    this.body.addChild(this.torso);
    this.root.addChild(this.legs, this.body);
    this.draw(color, number, skin);
  }

  private draw(color: number, num: number, skin: number): void {
    const m = (v: number) => v * this.S;
    const l = this.legs.clear();
    l.roundRect(m(-0.2), m(-0.95), m(0.16), m(0.9), m(0.06)).fill(skin);
    l.roundRect(m(0.04), m(-0.95), m(0.16), m(0.9), m(0.06)).fill(skin);
    l.roundRect(m(-0.21), m(-0.45), m(0.18), m(0.35), m(0.05)).fill(0xffffff);
    l.roundRect(m(0.03), m(-0.45), m(0.18), m(0.35), m(0.05)).fill(0xffffff);
    l.roundRect(m(-0.24), m(-0.1), m(0.21), m(0.12), m(0.04)).fill(0x111111);
    l.roundRect(m(0.03), m(-0.1), m(0.21), m(0.12), m(0.04)).fill(0x111111);
    l.roundRect(m(-0.27), m(-1.1), m(0.54), m(0.3), m(0.06)).fill(darken(color, 0.35));

    // Torso pivots at the hips so a lean reads clearly.
    this.body.position.set(0, m(-1.0));
    const t = this.torso.clear();
    t.moveTo(m(-0.24), m(-0.55))
      .lineTo(m(-0.45), m(-0.05))
      .stroke({ width: m(0.12), color: skin, cap: 'round' });
    t.moveTo(m(0.24), m(-0.55))
      .lineTo(m(0.45), m(-0.05))
      .stroke({ width: m(0.12), color: skin, cap: 'round' });
    t.roundRect(m(-0.29), m(-0.68), m(0.58), m(0.72), m(0.14)).fill(color);
    t.roundRect(m(-0.29), m(-0.68), m(0.58), m(0.1), m(0.05)).fill(darken(color, 0.75));
    t.circle(0, m(-0.84), m(0.14)).fill(skin);
    t.ellipse(0, m(-0.88), m(0.15), m(0.12)).fill(0x1a120b);
    // Shirt number as 7-segment digits (no font needed).
    const digits = String(num);
    const w = m(0.12);
    const hgt = m(0.24);
    digits.split('').forEach((d, i) => {
      const x0 = (i - (digits.length - 1) / 2) * w * 1.5 - w / 2;
      const y0 = m(-0.5);
      const seg = SEGMENTS[Number(d)];
      const lines: [number, number, number, number][] = [
        [0, 0, 1, 0],
        [1, 0, 1, 0.5],
        [1, 0.5, 1, 1],
        [0, 1, 1, 1],
        [0, 0.5, 0, 1],
        [0, 0, 0, 0.5],
        [0, 0.5, 1, 0.5],
      ];
      lines.forEach(([ax, ay, bx, by], k) => {
        if (seg[k]) t.moveTo(x0 + ax * w, y0 + ay * hgt).lineTo(x0 + bx * w, y0 + by * hgt);
      });
      t.stroke({ width: m(0.04), color: 0xffffff, alpha: 0.9, cap: 'round' });
    });
  }

  /** Leans the upper body; positive = to the right as seen from behind. */
  lean(rad: number): void {
    this.body.rotation = rad;
  }
}
