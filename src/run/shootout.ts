// Penalty shootout rules: 5 kicks each, alternating (you first), ends early once
// decided, then sudden death in pairs.

export type Side = 'you' | 'them';

export interface Kick {
  side: Side;
  scored: boolean;
}

export class Shootout {
  readonly kicks: Kick[] = [];

  constructor(readonly perSide = 5) {}

  get score(): { you: number; them: number } {
    let you = 0;
    let them = 0;
    for (const k of this.kicks) {
      if (!k.scored) continue;
      if (k.side === 'you') you++;
      else them++;
    }
    return { you, them };
  }

  private taken(side: Side): number {
    return this.kicks.filter((k) => k.side === side).length;
  }

  /** Who kicks next, or null when the shootout is over. */
  get next(): Side | null {
    if (this.winner) return null;
    return this.taken('you') === this.taken('them') ? 'you' : 'them';
  }

  get suddenDeath(): boolean {
    return this.taken('you') >= this.perSide && this.taken('them') >= this.perSide;
  }

  get winner(): Side | null {
    const { you, them } = this.score;
    const ty = this.taken('you');
    const tt = this.taken('them');
    if (ty <= this.perSide && tt <= this.perSide) {
      // Regular kicks: decided when one side cannot catch up any more.
      const leftYou = this.perSide - ty;
      const leftThem = this.perSide - tt;
      if (you > them + leftThem) return 'you';
      if (them > you + leftYou) return 'them';
      if (ty < this.perSide || tt < this.perSide) return null;
    }
    // Sudden death: decided after each complete pair.
    if (ty === tt && you !== them) return you > them ? 'you' : 'them';
    return null;
  }

  record(side: Side, scored: boolean): void {
    if (this.next !== side) throw new Error(`not ${side}'s kick`);
    this.kicks.push({ side, scored });
  }
}
