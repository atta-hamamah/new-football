// Everything an upgrade can change. One object, read by the duel code.

export interface PlayerStats {
  /** Ball speed, m/s. */
  shotSpeed: number;
  /** Aim wobble multiplier. */
  sway: number;
  /** Random aiming error, metres (standard deviation). */
  shotError: number;
  keeperReach: number;
  keeperAdjust: number;
  /** Seconds (real time) to choose a dive after the ball is struck. */
  reactionWindow: number;
  /** Time scale while the ball flies towards you. */
  slowmo: number;
  /** Added to the honesty of keepers' leans. */
  readKeeper: number;
  /** Added to the honesty of shooters' run-up leans. */
  readShooter: number;
  cornerBonus: number;
  postIn: boolean;
  scout: boolean;
  hotStreak: boolean;
  /** Retakes per match. */
  retakes: number;
  /** Lost matches you can survive. */
  lives: number;
}

export function baseStats(): PlayerStats {
  return {
    shotSpeed: 25,
    sway: 1,
    shotError: 0.12,
    keeperReach: 1.15,
    keeperAdjust: 0,
    reactionWindow: 0.5,
    slowmo: 0.32,
    readKeeper: 0,
    readShooter: 0,
    cornerBonus: 0,
    postIn: false,
    scout: false,
    hotStreak: false,
    retakes: 0,
    lives: 0,
  };
}
