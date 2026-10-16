// Soft shapes (glows, shadows, light pools, vignettes) drawn once with Canvas 2D gradients.
// Far cheaper than blur filters, which re-blur their whole area on every frame.

import { Container, Sprite, Texture } from 'pixi.js';

const cache = new Map<number, Texture>();

/**
 * A white disc that stays solid out to `hard` (0..1 of its radius), then fades to nothing
 * at the edge. Tint, scale and alpha it like any sprite. The texture is 1 unit = 1/128.
 */
export function softDisc(hard = 0.5): Texture {
  const key = Math.round(hard * 100);
  let tex = cache.get(key);
  if (!tex) {
    const s = 128;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(hard, 'rgba(255,255,255,1)');
    // Ease out over the soft part so the edge has no visible ring.
    for (let k = 1; k <= 4; k++) {
      const t = k / 5;
      grad.addColorStop(hard + (1 - hard) * t, `rgba(255,255,255,${((1 - t) * (1 - t)).toFixed(3)})`);
    }
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    tex = Texture.from(c);
    cache.set(key, tex);
  }
  return tex;
}

/** One soft blob, sized by its full (faded) radii. */
export function softSprite(x: number, y: number, rx: number, ry: number, color: number, alpha: number, hard = 0.5): Sprite {
  const s = new Sprite(softDisc(hard));
  s.anchor.set(0.5);
  s.position.set(x, y);
  s.width = rx * 2;
  s.height = ry * 2;
  s.tint = color;
  s.alpha = alpha;
  return s;
}

/** Darkens the edges of a screen-space box (centred), extending past it for wide screens. */
export function vignette(w: number, h: number, strength = 0.45): Sprite {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s * 0.5);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.6, `rgba(0,0,0,${(strength * 0.45).toFixed(3)})`);
  grad.addColorStop(1, `rgba(0,0,0,${strength})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const sp = new Sprite(Texture.from(c));
  sp.anchor.set(0.5);
  sp.position.set(w / 2, h / 2);
  // The gradient reaches full strength at the box corners' distance; go wider for side margins.
  sp.width = w * 1.4;
  sp.height = h * 1.35;
  return sp;
}

/** A pool of soft sprites redrawn every frame (shadows, glows) without allocating. */
export class SoftLayer {
  readonly root = new Container();
  private used = 0;

  constructor(private readonly hard = 0.5) {}

  begin(): void {
    this.used = 0;
  }

  add(x: number, y: number, rx: number, ry: number, color: number, alpha: number): void {
    let s = this.root.children[this.used] as Sprite | undefined;
    if (!s) {
      s = new Sprite(softDisc(this.hard));
      s.anchor.set(0.5);
      this.root.addChild(s);
    }
    this.used++;
    s.visible = true;
    s.position.set(x, y);
    s.width = rx * 2;
    s.height = ry * 2;
    s.tint = color;
    s.alpha = alpha;
  }

  end(): void {
    for (let i = this.used; i < this.root.children.length; i++) this.root.children[i].visible = false;
  }
}
