// One PixiJS application for the whole game. Scenes draw in a fixed logical space
// (portrait 720x1280) that is scaled to fit any screen.

import { Application, Container } from 'pixi.js';

export const VIEW_W = 720;
export const VIEW_H = 1280;

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
    this.app.ticker.add((t) => {
      this.layout();
      this.scene?.update(Math.min(0.05, t.deltaMS / 1000) * this.speed);
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

  /** Screen pixels per logical unit (for converting finger travel). */
  get pxPerUnit(): number {
    return this.scale;
  }
}
