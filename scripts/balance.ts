// Headless balance report: simulates thousands of Penalty Runs with bot players.
// Usage: npm run balance [-- 3000]

import { type BotSkill, botRun } from '../src/run/bots';
import { STAGES } from '../src/run/run';

const N = Number(process.argv[2]) || 2000;

for (const skill of ['random', 'casual', 'smart'] as BotSkill[]) {
  const reached = new Array(STAGES.length + 1).fill(0);
  let goalsFor = 0;
  for (let i = 0; i < N; i++) {
    const run = botRun(1000 + i, skill);
    reached[run.wins]++;
    goalsFor += run.wins;
  }
  const champ = reached[STAGES.length];
  const cum = reached.map((_, k) => reached.slice(k).reduce((a, b) => a + b, 0) / N);
  console.log(`\n${skill.padEnd(7)} avg matches won ${(goalsFor / N).toFixed(2)}, champion ${((champ / N) * 100).toFixed(1)}%`);
  console.log('  reached stage: ' + STAGES.map((s, k) => `${s.name} ${(cum[k] * 100).toFixed(0)}%`).join(' · '));
}
