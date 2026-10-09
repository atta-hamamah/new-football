// A Penalty Run: 8 shootouts from Sunday League to the Final, with an upgrade pick
// after every win. Lose a shootout and the run is over (unless you have a spare life).

import { hashSeed, pick, Rng, shuffle } from '../core/rng';
import { KEEPERS, type KeeperProfile, mirrorBias, NORMAL_KEEPERS, type ShooterProfile } from '../duel/ai';
import { baseStats, type PlayerStats } from './stats';
import { rollOffers, type Upgrade, upgradeById } from './upgrades';

export interface Stage {
  name: string;
  boss: boolean;
}

export const STAGES: Stage[] = [
  { name: 'Sunday League', boss: false },
  { name: 'Village Cup', boss: false },
  { name: 'County Cup', boss: false },
  { name: 'Regional Final', boss: true },
  { name: 'National Cup', boss: false },
  { name: 'Quarter-final', boss: false },
  { name: 'Semi-final', boss: false },
  { name: 'The Final', boss: true },
];

export interface Opponent {
  name: string;
  color: number;
  keeper: KeeperProfile;
  shooters: ShooterProfile[];
}

const PREFIX = ['FC', 'Real', 'Dynamo', 'Sporting', 'Athletic', 'Inter', 'United', 'Racing', 'Olympic', 'Royal'];
const PLACE = [
  'Mudford',
  'Pebble Bay',
  'Thunder Hill',
  'Rainy Lane',
  'Old Harbour',
  'Kingsbridge',
  'Saltmarsh',
  'Ironvale',
  'Northgate',
  'Duskwood',
  'Redcliff',
  'Silverlake',
];
const COLORS = [0xe63946, 0x3a86ff, 0xffbe0b, 0x8338ec, 0x06d6a0, 0xfb5607, 0xff006e, 0x2ec4b6, 0xf1faee, 0x9b5de5];
const FIRST = ['Leo', 'Marco', 'Kai', 'Tomás', 'Yusuf', 'Ivan', 'Rafa', 'Sami', 'Nico', 'Omar', 'Jonas', 'Luca', 'Andrés', 'Theo', 'Malik'];

function makeOpponent(rng: Rng, stage: number, usedKeepers: string[]): Opponent {
  const d = stage / (STAGES.length - 1);
  const s = STAGES[stage];
  let keeperId: string;
  if (s.boss) keeperId = stage === STAGES.length - 1 ? 'legend' : 'octopus';
  else {
    const fresh = NORMAL_KEEPERS.filter((k) => !usedKeepers.includes(k) && (stage > 0 || k !== 'analyst'));
    keeperId = stage === 0 ? 'rookie' : pick(rng, fresh.length ? fresh : NORMAL_KEEPERS);
  }
  usedKeepers.push(keeperId);
  const base = KEEPERS[keeperId];
  const keeper: KeeperProfile = {
    ...base,
    bias: rng.chance(0.5) ? mirrorBias(base.bias) : [...base.bias],
    reach: base.reach + 0.28 * d,
    honesty: Math.max(0.25, base.honesty - 0.12 * d),
  };

  const shooters: ShooterProfile[] = [];
  const names = shuffle(rng, [...FIRST]);
  for (let i = 0; i < 5; i++) {
    shooters.push({
      name: names[i],
      speed: 22 + 6 * d + rng.range(0, 3),
      error: Math.max(0.12, 0.4 - 0.22 * d + rng.range(-0.06, 0.06)),
      bias: Array.from({ length: 6 }, () => rng.range(0.4, 2)),
      honesty: Math.max(0.3, 0.62 - 0.3 * d + rng.range(-0.06, 0.06)),
      edge: Math.min(0.95, 0.74 + 0.2 * d + rng.range(-0.04, 0.04)),
    });
  }
  const name = `${pick(rng, PREFIX)} ${pick(rng, PLACE)}`;
  return { name, color: pick(rng, COLORS), keeper, shooters };
}

export type RunStatus = 'playing' | 'champion' | 'over';

export class Run {
  readonly rng: Rng;
  stage = 0;
  stats: PlayerStats = baseStats();
  upgrades: string[] = [];
  /** How often you shot into each of the 6 zones (keepers who "learn" use this). */
  history = [0, 0, 0, 0, 0, 0];
  results: boolean[] = [];
  status: RunStatus = 'playing';
  opponent: Opponent;
  /** Upgrade choice waiting after a win, or null. */
  pendingOffers: Upgrade[] | null = null;
  private readonly usedKeepers: string[] = [];

  constructor(readonly seed: number) {
    this.rng = new Rng(seed);
    this.opponent = makeOpponent(this.rng, 0, this.usedKeepers);
  }

  static daily(date: Date): Run {
    const key = date.toISOString().slice(0, 10);
    return new Run(hashSeed(`daily-${key}`));
  }

  get stageInfo(): Stage {
    return STAGES[this.stage];
  }

  /** Call when a shootout ends. */
  finishMatch(won: boolean): void {
    this.results.push(won);
    if (!won) {
      if (this.stats.lives > 0) {
        this.stats.lives--;
        // Replay the same stage against a fresh opponent.
        this.opponent = makeOpponent(this.rng, this.stage, this.usedKeepers);
        return;
      }
      this.status = 'over';
      return;
    }
    if (this.stage === STAGES.length - 1) {
      this.status = 'champion';
      return;
    }
    this.pendingOffers = rollOffers(this.rng, this.upgrades);
  }

  pickUpgrade(id: string): void {
    if (!this.pendingOffers?.some((u) => u.id === id)) throw new Error('not offered');
    upgradeById(id).apply(this.stats);
    this.upgrades.push(id);
    this.pendingOffers = null;
    this.stage++;
    this.opponent = makeOpponent(this.rng, this.stage, this.usedKeepers);
  }

  get wins(): number {
    return this.results.filter(Boolean).length;
  }
}
