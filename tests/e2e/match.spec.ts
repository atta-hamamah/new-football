import { expect, test, type Page } from '@playwright/test';

interface MatchHook {
  view: { state: string; clock: number; score: number[]; players: { x: number; y: number; human: number; team: number }[] } | null;
}
// Software-rendered CI browsers are slow at phone resolutions; a 1x screen keeps two "phones" smooth.
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });

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
  await expect.poll(async () => (await view(page))?.state, { timeout: 5000 }).toBe('play');
  const before = (await view(page))!;
  // Keyboard: run up the pitch, then pass.
  await page.keyboard.down('w');
  await page.waitForTimeout(800);
  await page.keyboard.up('w');
  await page.keyboard.press('j');
  await page.waitForTimeout(600);
  const after = (await view(page))!;
  expect(after.clock).toBeLessThan(before.clock);
  await page.screenshot({ path: 'test-results/match-cpu.png' });
  await page.click('.match-hud .icon-btn');
  await expect(page.locator('#play-cpu')).toBeVisible();
});

test('Wi-Fi: one phone hosts, another joins, both play the same match', async ({ browser }) => {
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true };
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
  await expect.poll(async () => (await view(joinPage))?.state, { timeout: 8000 }).toBe('play');

  // Sam (red, attacks down the pitch) holds "right" on his screen.
  await expect.poll(async () => (await view(hostPage))?.state, { timeout: 8000 }).toBe('play');
  const before = (await view(hostPage))!;
  const sam = before.players.findIndex((p) => p.human === 1);
  expect(before.players[sam].team).toBe(1);
  await joinPage.keyboard.down('d');
  await joinPage.waitForTimeout(1500);
  await joinPage.keyboard.up('d');
  const after = (await view(hostPage))!;
  // Red's view is rotated, so screen-right is pitch -x.
  expect(after.players[sam].x).toBeLessThan(before.players[sam].x - 1);

  // Both screens agree on the match.
  const hv = (await view(hostPage))!;
  const jv = (await view(joinPage))!;
  expect(Math.abs(hv.clock - jv.clock)).toBeLessThan(1);
  expect(jv.players.some((p) => p.human === 0)).toBe(true);
  await joinPage.screenshot({ path: 'test-results/match-wifi-joiner.png' });
  await hostPage.screenshot({ path: 'test-results/match-wifi-host.png' });

  // Host quits: the joiner is told.
  await hostPage.click('.match-hud .icon-btn');
  await expect(joinPage.locator('.banner')).toContainText('Connection lost', { timeout: 5000 });
});
