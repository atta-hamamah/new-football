// One PixiJS application for the whole game. Scenes draw in a fixed logical space
// (landscape 1280x720) that is scaled to fit any screen.

import { Application, Container } from 'pixi.js';
// Register text rendering before the renderer is created. The 7v7 code that uses Text is
// loaded later (lazily), and a renderer only picks up render pipes that exist at creation.
import 'pixi.js/text';

export const VIEW_W = 1280;
export const VIEW_H = 720;

export interface Scene {
  readonly root: Container;
  update(dt: number): void;
  destroy(): void;
}

export class Stage {
  readonly app = new Application();
  private readonly world = new Container();
  private scene: Scene | null = null;
  private lastW = 0;
  private lastH = 0;
  scale = 1;
  /** Playback speed multiplier for automated tests (?speed=8). Never changes outcomes. */
  readonly speed = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1);
  offsetX = 0;
  offsetY = 0;
  /** Shows the idle menu backdrop (set by main). Replaces whatever scene is running. */
  idle: () => void = () => this.show(null);

  async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      resizeTo: parent,
      background: 0x050914,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    parent.appendChild(this.app.canvas);
    this.app.canvas.style.touchAction = 'none';
    this.app.stage.addChild(this.world);
    // Keep real time down to 5 fps (slow phones, software-rendered test browsers): a Wi-Fi host
    // that fell behind would slow the match down for everyone. The ticker caps each frame's
    // step at 1/minFPS, so the game doesn't jump ahead after the app was in the background.
    this.app.ticker.minFPS = 5;
    this.app.ticker.add((t) => {
      this.layout();
      this.scene?.update((t.deltaMS / 1000) * this.speed);
    });
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  show(scene: Scene | null): void {
    if (this.scene) {
      this.world.removeChild(this.scene.root);
      this.scene.destroy();
    }
    this.scene = scene;
    if (scene) this.world.addChild(scene.root);
  }

  /** "Cover" for the background, but scenes keep their key content inside the 720x1280 safe box. */
  private layout(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.scale = Math.min(w / VIEW_W, h / VIEW_H);
    this.offsetX = (w - VIEW_W * this.scale) / 2;
    this.offsetY = (h - VIEW_H * this.scale) / 2;
    this.world.scale.set(this.scale);
    this.world.position.set(this.offsetX, this.offsetY);
  }

  /** Converts a pointer event position to logical scene coordinates. */
  toView(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.offsetX) / this.scale, y: (clientY - rect.top - this.offsetY) / this.scale };
  }

  /** The part of the logical space that is on screen: wider (or taller) than 1280x720 on most phones. */
  visibleRect(): { x: number; y: number; w: number; h: number } {
    const s = this.scale;
    return { x: -this.offsetX / s, y: -this.offsetY / s, w: this.app.screen.width / s, h: this.app.screen.height / s };
  }

  /** Screen pixels per logical unit (for converting finger travel). */
  get pxPerUnit(): number {
    return this.scale;
  }
}
