// Review screenshots of every main screen on a landscape phone (npm run shots).
// Saved to test-results/shots/ (or $SHOTS_DIR). The game clock is frozen for each
// in-match picture, so moments like the fireball land exactly.

import { expect, test, type Page } from '@playwright/test';

const OUT = process.env.SHOTS_DIR ?? 'test-results/shots';
const phone = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

interface Hooks {
  __game: { stage: { app: { ticker: { speed: number } } }; penalty: { phase: string } | null };
  __match: {
    view: { state: string; duel: { tick: number; ticks: number } | null; players: { human: number; charge: number }[] } | null;
    session: {
      sim: {
        ball: { owner: number };
        players: { x: number; y: number; fx: number; fy: number; protect: number }[];
        humans: Map<number, { controlled: number }>;
        shoot(i: number, col: number, high: boolean, power: number): boolean;
      };
    };
  };
}

async function shot(page: Page, name: string, freeze = false) {
  if (freeze) await page.evaluate(() => ((window as unknown as Hooks).__game.stage.app.ticker.speed = 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  if (freeze) await page.evaluate(() => ((window as unknown as Hooks).__game.stage.app.ticker.speed = 1));
}

const until = (page: Page, fn: () => boolean | undefined, timeout = 30_000) =>
  page.waitForFunction(fn, undefined, { timeout, polling: 30 });

test('menu and Penalty Run', async ({ browser }) => {
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto('/');
  await expect(page.locator('#play-run')).toBeVisible();
  await shot(page, '01-menu');
  await page.click('#play-run');
  await expect(page.locator('.opp-card')).toBeVisible();
  await shot(page, '02-run-map');
  await page.click('#kickoff');
  await until(page, () => (window as unknown as Hooks).__game.penalty?.phase === 'aim');
  await shot(page, '03-penalty-aim');
  const box = (await page.locator('canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.75;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy - 30, { steps: 6 });
  await shot(page, '04-penalty-aiming');
  await page.mouse.up();
  await page.waitForTimeout(250);
  await shot(page, '05-penalty-result');
  await until(page, () => ['runup', 'react'].includes((window as unknown as Hooks).__game.penalty?.phase ?? ''));
  await shot(page, '06-penalty-keeping');
});

test('7v7 vs computer: charge, fireball, save', async ({ browser }) => {
  const page = await (await browser.newContext(phone)).newPage();
  await page.goto('/');
  await page.click('#play-match');
  await shot(page, '07-match-menu');
  await page.click('#play-cpu');
  await until(page, () => (window as unknown as Hooks).__match?.view?.state === 'play');
  await page.waitForTimeout(1500);
  await shot(page, '08-match-play', true);

  // My player on the ball in front of the box, safe from tackles while charging.
  await page.evaluate(() => {
    const sim = (window as unknown as Hooks).__match.session.sim;
    const i = sim.humans.get(0)!.controlled;
    Object.assign(sim.players[i], { x: -4, y: 14, fx: 0, fy: 1, protect: 6 });
    sim.ball.owner = i;
  });
  await page.keyboard.down('k');
  await until(page, () => ((window as unknown as Hooks).__match.view?.players.find((p) => p.human === 0)?.charge ?? -1) >= 0.5);
  await shot(page, '09-match-charging', true);
  await until(page, () => ((window as unknown as Hooks).__match.view?.players.find((p) => p.human === 0)?.charge ?? -1) >= 1);
  await shot(page, '10-match-full-charge', true);
  await page.keyboard.down('w'); // aim: top post
  await page.waitForTimeout(80);
  // Shots are quick (a fireball is ~0.3 s): slow the clock so the mid-flight moment can't be skipped.
  await page.evaluate(() => ((window as unknown as Hooks).__game.stage.app.ticker.speed = 0.25));
  await page.keyboard.up('k');
  await until(page, () => {
    const v = (window as unknown as Hooks).__match.view;
    return v?.state === 'duel' && !!v.duel && v.duel.tick >= v.duel.ticks * 0.45;
  });
  await shot(page, '11-match-fireball', true);
  await page.keyboard.up('w');
  await until(page, () => (window as unknown as Hooks).__match.view?.state === 'play');
  await page.waitForTimeout(800);

  // The computer shoots at my goal: the dive prompt.
  await page.evaluate(() => {
    const sim = (window as unknown as Hooks).__match.session.sim;
    const striker = 11;
    Object.assign(sim.players[striker], { x: 3, y: -15, fx: 0, fy: -1 });
    sim.ball.owner = striker;
    sim.shoot(striker, 1, false, 0.75);
  });
  await expect(page.locator('.dive-hint')).toBeVisible();
  await page.waitForTimeout(150);
  await shot(page, '12-match-defending', true);
});

test('Wi-Fi lobby and match', async ({ browser }) => {
  const hostPage = await (await browser.newContext(phone)).newPage();
  const joinPage = await (await browser.newContext(phone)).newPage();
  await hostPage.goto('/');
  await hostPage.click('#play-match');
  await hostPage.click('#host-wifi');
  await hostPage.fill('#name', 'Atta');
  await hostPage.click('#name-ok');
  await joinPage.goto('/');
  await joinPage.click('#play-match');
  await joinPage.click('#join-wifi');
  await joinPage.fill('#name', 'Sam');
  await joinPage.click('#name-ok');
  await expect(joinPage.locator('.game', { hasText: 'Atta' })).toBeVisible();
  await shot(joinPage, '13-wifi-games');
  await joinPage.locator('.game', { hasText: 'Atta' }).click();
  await expect(hostPage.locator('.lobby-player')).toHaveCount(2);
  await shot(hostPage, '14-wifi-lobby-host');
  await shot(joinPage, '15-wifi-lobby-joiner');
  await hostPage.click('#start-match');
  await until(joinPage, () => (window as unknown as Hooks).__match?.view?.state === 'play');
  await joinPage.waitForTimeout(1500);
  await shot(joinPage, '16-wifi-match-joiner');
});
