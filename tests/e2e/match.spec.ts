import { expect, test, type Page } from '@playwright/test';

interface MatchHook {
  view: {
    state: string;
    clock: number;
    score: number[];
    players: { x: number; y: number; human: number; team: number }[];
    tactics: string[];
  } | null;
}
// Landscape phones. Software-rendered CI browsers are slow at high resolutions, so 1x pixels.
test.use({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });

const view = (page: Page) => page.evaluate(() => (window as unknown as { __match: MatchHook | null }).__match?.view ?? null);

async function openMatchMenu(page: Page) {
  await page.goto('/?speed=1');
  await page.click('#play-match');
  await expect(page.locator('#play-cpu')).toBeVisible();
}

test('vs computer: kick off, move, pass, clock runs', async ({ page }) => {
  await openMatchMenu(page);
  await page.click('#play-cpu');
  await expect(page.locator('.mboard')).toBeVisible();
  // We kick off: after the whistle, tap PASS to play the ball to the teammate beside us.
  await expect(page.locator('.kick-hint')).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.keyboard.press('j');
        return (await view(page))?.state;
      },
      { timeout: 5000 },
    )
    .toBe('play');
  const before = (await view(page))!;
  // Keyboard: run towards the goal (to the right), then pass.
  await page.keyboard.down('d');
  await page.waitForTimeout(800);
  await page.keyboard.up('d');
  await page.keyboard.press('j');
  await page.waitForTimeout(600);
  const after = (await view(page))!;
  expect(after.clock).toBeLessThan(before.clock);
  await page.screenshot({ path: 'test-results/match-cpu.png' });

  // Pause: the clock stops, a tactic can be picked mid-match, and play goes on with it.
  await page.click('#pause');
  await expect(page.locator('.pause-menu')).toBeVisible();
  const frozen = (await view(page))!.clock;
  await page.waitForTimeout(500);
  expect((await view(page))!.clock).toBe(frozen);
  await page.click('#tactic-direct');
  await expect(page.locator('#tactic-direct')).toHaveClass(/on/);
  await page.screenshot({ path: 'test-results/match-pause.png' });
  await page.click('#resume');
  await expect(page.locator('.pause-menu')).toHaveCount(0);
  await expect.poll(async () => (await view(page))!.tactics[0]).toBe('direct');
  await expect.poll(async () => (await view(page))!.clock).toBeLessThan(frozen);

  // Quit from the menu.
  await page.keyboard.press('Escape');
  await page.click('#quit');
  await expect(page.locator('#play-cpu')).toBeVisible();
});

test('Wi-Fi: one phone hosts, another joins, both play the same match', async ({ browser }) => {
  const phone = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true };
  const hostPage = await (await browser.newContext(phone)).newPage();
  const joinPage = await (await browser.newContext(phone)).newPage();

  await openMatchMenu(hostPage);
  await hostPage.click('#host-wifi');
  await hostPage.fill('#name', 'Atta');
  await hostPage.click('#name-ok');
  await expect(hostPage.locator('.lobby-player')).toHaveCount(1);

  await openMatchMenu(joinPage);
  await joinPage.click('#join-wifi');
  await joinPage.fill('#name', 'Sam');
  await joinPage.click('#name-ok');
  await joinPage.locator('.game', { hasText: 'Atta' }).click();
  await expect(joinPage.locator('.lobby-player')).toHaveCount(2);
  await expect(hostPage.locator('.lobby-player')).toHaveCount(2);
  await expect(hostPage.locator('.team-col').nth(1)).toContainText('Sam');
  await hostPage.screenshot({ path: 'test-results/lobby-host.png' });

  await hostPage.click('#start-match');
  await expect(joinPage.locator('.mboard')).toBeVisible({ timeout: 5000 });
  // The host's team kicks off: tap PASS.
  await expect
    .poll(
      async () => {
        await hostPage.keyboard.press('j');
        return (await view(hostPage))?.state;
      },
      { timeout: 15000 },
    )
    .toBe('play');
  await expect.poll(async () => (await view(joinPage))?.state, { timeout: 15000 }).toBe('play');

  // Sam (red) holds "right" on his screen: towards the goal red attacks.
  await expect.poll(async () => (await view(hostPage))?.state, { timeout: 15000 }).toBe('play');
  // Control can switch to the teammate nearest the ball, so follow whoever Sam controls.
  const samNow = async () => {
    const v = (await view(hostPage))!;
    const i = v.players.findIndex((p) => p.human === 1);
    return { i, y: v.players[i].y, team: v.players[i].team, state: v.state };
  };
  expect((await samNow()).team).toBe(1);
  await joinPage.keyboard.down('d');
  let moved = 0;
  let prev = await samNow();
  for (let k = 0; k < 10; k++) {
    await hostPage.waitForTimeout(250);
    const cur = await samNow();
    if (cur.i === prev.i && cur.state === 'play') moved += cur.y - prev.y;
    prev = cur;
  }
  await joinPage.keyboard.up('d');
  // Everyone attacks to the right of their own screen: for red that is pitch -y.
  expect(moved).toBeLessThan(-2);

  // Both screens agree on the match.
  const hv = (await view(hostPage))!;
  const jv = (await view(joinPage))!;
  expect(Math.abs(hv.clock - jv.clock)).toBeLessThan(1);
  expect(jv.players.some((p) => p.human === 0)).toBe(true);
  await joinPage.screenshot({ path: 'test-results/match-wifi-joiner.png' });
  await hostPage.screenshot({ path: 'test-results/match-wifi-host.png' });

  // Sam picks red's tactic from his menu while the match goes on: the host plays it, both screens show it.
  await joinPage.click('#pause');
  await expect(joinPage.locator('.pause-head h3')).toHaveText('TACTICS');
  await joinPage.click('#tactic-possession');
  await expect.poll(async () => (await view(hostPage))!.tactics[1]).toBe('possession');
  await expect.poll(async () => (await view(joinPage))!.tactics[1]).toBe('possession');
  await joinPage.click('#resume');

  // Host quits: the joiner is told.
  await hostPage.click('#pause');
  await hostPage.click('#quit');
  await expect(joinPage.locator('.banner', { hasText: 'Connection lost' })).toHaveCount(1, { timeout: 5000 });
});
