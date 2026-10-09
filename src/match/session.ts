// A Session feeds the match screen: it advances the game (or receives it from the
// network) and returns what to draw. Local play and Wi-Fi play share the same screen.

import { MatchSim } from './sim';
import { DT, type Input, type MatchEvent, type Team } from './types';
import { type ViewState, viewFromSim } from './view';

export interface Session {
  readonly mySlot: number;
  readonly myTeam: Team;
  readonly names: Map<number, string>;
  /** Called every frame with real elapsed seconds and the local input. */
  update(dt: number, input: Input): { view: ViewState | null; events: MatchEvent[] };
  /** Whether "Rematch" is possible from this device. */
  readonly canRestart: boolean;
  restart(): void;
  close(): void;
  /** Set when the connection is lost (clients). */
  lost?: string;
}

/** Runs a fixed-step simulation from real time. Used by local play and by the Wi-Fi host. */
export class SimRunner {
  sim: MatchSim;
  private acc = 0;

  constructor(private readonly make: () => MatchSim) {
    this.sim = make();
  }

  reset(): void {
    this.sim = this.make();
    this.acc = 0;
  }

  /** Steps as many ticks as fit in `dt`. `inputs` is read each tick. */
  advance(dt: number, inputs: () => ReadonlyMap<number, Input>, onTick?: (events: MatchEvent[]) => void): MatchEvent[] {
    this.acc += dt;
    const all: MatchEvent[] = [];
    let steps = 0;
    while (this.acc >= DT && steps++ < 8) {
      this.acc -= DT;
      const ev = this.sim.step(inputs());
      all.push(...ev);
      onTick?.(ev);
    }
    if (steps >= 8) this.acc = 0; // tab was in the background: don't fast-forward
    return all;
  }
}

/** You against the computer on this device. */
export class LocalSession implements Session {
  readonly mySlot = 0;
  readonly myTeam: Team = 0;
  readonly names = new Map<number, string>([[0, 'YOU']]);
  readonly canRestart = true;
  private readonly runner: SimRunner;

  constructor(difficulty: number, duration = 180) {
    this.runner = new SimRunner(() => {
      const sim = new MatchSim({ duration, difficulty, seed: (Math.random() * 2 ** 32) >>> 0 });
      sim.addHuman(0, 0, 'YOU');
      return sim;
    });
  }

  get sim(): MatchSim {
    return this.runner.sim;
  }

  update(dt: number, input: Input): { view: ViewState; events: MatchEvent[] } {
    const events = this.runner.advance(dt, () => new Map([[0, input]]));
    return { view: viewFromSim(this.runner.sim), events };
  }

  restart(): void {
    this.runner.reset();
  }

  close(): void {}
}
