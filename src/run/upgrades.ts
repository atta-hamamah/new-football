import { Rng, weightedIndex } from '../core/rng';
import type { PlayerStats } from './stats';

export type Rarity = 'common' | 'rare';
export type UpgradeKind = 'shoot' | 'save' | 'special';

export interface Upgrade {
  id: string;
  name: string;
  desc: string;
  icon: string;
  kind: UpgradeKind;
  rarity: Rarity;
  /** Can only be taken once. */
  unique?: boolean;
  apply(s: PlayerStats): void;
}

export const UPGRADES: Upgrade[] = [
  {
    id: 'laser',
    name: 'Laser Boots',
    desc: 'Your shots fly 15% faster. Less time for the keeper.',
    icon: '⚡',
    kind: 'shoot',
    rarity: 'common',
    apply: (s) => void (s.shotSpeed *= 1.15),
  },
  {
    id: 'steady',
    name: 'Ice in the Veins',
    desc: 'Aim wobble reduced by 35%.',
    icon: '🧊',
    kind: 'shoot',
    rarity: 'common',
    apply: (s) => void (s.sway *= 0.65),
  },
  {
    id: 'sniper',
    name: 'Sniper',
    desc: 'Your random aiming error is halved.',
    icon: '🎯',
    kind: 'shoot',
    rarity: 'common',
    apply: (s) => void (s.shotError *= 0.5),
  },
  {
    id: 'corners',
    name: 'Top Bins',
    desc: 'Keepers reach 0.25 m less on corner shots.',
    icon: '📐',
    kind: 'shoot',
    rarity: 'common',
    apply: (s) => void (s.cornerBonus += 0.25),
  },
  {
    id: 'postin',
    name: 'Lucky Post',
    desc: 'Shots that clip the frame go in.',
    icon: '🍀',
    kind: 'shoot',
    rarity: 'rare',
    unique: true,
    apply: (s) => void (s.postIn = true),
  },
  {
    id: 'scout',
    name: 'Scouting Report',
    desc: "See the keeper's favourite zones before you shoot.",
    icon: '📋',
    kind: 'shoot',
    rarity: 'common',
    unique: true,
    apply: (s) => void (s.scout = true),
  },
  {
    id: 'readkeeper',
    name: 'Mind Reader',
    desc: "Keepers' leans are 20% more honest.",
    icon: '🔮',
    kind: 'shoot',
    rarity: 'common',
    apply: (s) => void (s.readKeeper += 0.2),
  },
  {
    id: 'streak',
    name: 'Hot Streak',
    desc: 'After you score, your next shot has no wobble.',
    icon: '🔥',
    kind: 'shoot',
    rarity: 'rare',
    unique: true,
    apply: (s) => void (s.hotStreak = true),
  },
  {
    id: 'gloves',
    name: 'Big Gloves',
    desc: 'Your keeper reaches 0.15 m further.',
    icon: '🧤',
    kind: 'save',
    rarity: 'common',
    apply: (s) => void (s.keeperReach += 0.15),
  },
  {
    id: 'reflex',
    name: 'Cat Reflexes',
    desc: '+0.15 s to choose your dive.',
    icon: '🐱',
    kind: 'save',
    rarity: 'common',
    apply: (s) => void (s.reactionWindow += 0.15),
  },
  {
    id: 'bullet',
    name: 'Bullet Time',
    desc: 'Time slows down more while the ball flies at you.',
    icon: '⏳',
    kind: 'save',
    rarity: 'common',
    apply: (s) => void (s.slowmo *= 0.7),
  },
  {
    id: 'readshooter',
    name: 'Body Language',
    desc: "Shooters' run-up leans are 20% more honest.",
    icon: '👀',
    kind: 'save',
    rarity: 'common',
    apply: (s) => void (s.readShooter += 0.2),
  },
  {
    id: 'stretch',
    name: 'Late Stretch',
    desc: 'After diving, your keeper adjusts 15% towards the ball.',
    icon: '🤸',
    kind: 'save',
    rarity: 'common',
    apply: (s) => void (s.keeperAdjust += 0.15),
  },
  {
    id: 'retake',
    name: 'VAR Review',
    desc: 'Once per match, retake a penalty you missed.',
    icon: '📺',
    kind: 'special',
    rarity: 'rare',
    apply: (s) => void (s.retakes += 1),
  },
  {
    id: 'life',
    name: 'Second Leg',
    desc: 'Survive one lost match.',
    icon: '❤️',
    kind: 'special',
    rarity: 'rare',
    apply: (s) => void (s.lives += 1),
  },
];

export function upgradeById(id: string): Upgrade {
  const u = UPGRADES.find((x) => x.id === id);
  if (!u) throw new Error(`unknown upgrade ${id}`);
  return u;
}

/** Three different upgrades, weighted by rarity, skipping unique ones already owned. */
export function rollOffers(rng: Rng, owned: readonly string[], count = 3): Upgrade[] {
  const pool = UPGRADES.filter((u) => !(u.unique && owned.includes(u.id)));
  const offers: Upgrade[] = [];
  while (offers.length < count && pool.length) {
    const i = weightedIndex(
      rng,
      pool.map((u) => (u.rarity === 'rare' ? 1 : 3)),
    );
    offers.push(pool.splice(i, 1)[0]);
  }
  return offers;
}
