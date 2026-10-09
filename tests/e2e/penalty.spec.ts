import { expect, test, type Page } from '@playwright/test';

const phase = (page: Page) =>
  page.evaluate(() => (window as unknown as { __game: { penalty: { phase: string } | null } }).__game.penalty?.phase);

async function boot(page: Page) {
  await page.goto('/?speed=4');
  await expect(page.locator('#play-run')).toBeVisible();
}

/** Plays kicks with real touch-style input until the shootout ends. */
async function playShootout(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height * 0.75;
  let aims = 0;
  for (let i = 0; i < 400; i++) {
    const p = await phase(page);
    if (p === 'pick' || p === 'end' || p === 'map') return p;
    if (p === 'aim') {
      // Aim towards a corner, alternating sides, then release.
      const dir = aims++ % 2 ? 1 : -1;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dir * 80, cy - 25, { steps: 6 });
      await page.waitForTimeout(120);
      await page.mouse.up();
    } else if (p === 'runup' || p === 'react') {
      await page.keyboard.press(i % 2 ? 'a' : 'd');
    }
    if (await page.locator('#retake-yes').isVisible()) await page.click('#retake-yes');
    await page.waitForTimeout(100);
  }
  throw new Error('shootout did not finish');
}

test('menu → run map → a full shootout with real input', async ({ page }) => {
  await boot(page);
  await page.screenshot({ path: 'test-results/menu.png' });
  await page.click('#play-run');
  await expect(page.locator('.ladder li')).toHaveCount(8);
  await expect(page.locator('.opp-card')).toContainText('The Rookie');
  await page.screenshot({ path: 'test-results/map.png' });
  await page.click('#kickoff');
  await expect(page.locator('.board')).toBeVisible();
  const end = await playShootout(page);
  await page.screenshot({ path: 'test-results/after-shootout.png' });
  if (end === 'pick') {
    await expect(page.locator('.card')).toHaveCount(3);
    await page.locator('.card').first().click();
    await expect(page.locator('.ladder li.current')).toContainText('Village Cup');
    await expect(page.locator('.kit .chip')).toHaveCount(1);
  } else {
    await expect(page.locator('.end h2')).toHaveText('RUN OVER');
    await expect(page.locator('.grid')).toHaveText('🟥');
  }
});

test('daily run shows the date and the same opponent for everyone', async ({ page, browser }) => {
  await boot(page);
  await page.click('#play-daily');
  await expect(page.locator('.map-head h2')).toContainText('DAILY RUN');
  const name = await page.locator('.opp-name').textContent();
  const other = await (await browser.newContext()).newPage();
  await other.goto('/?speed=4');
  await other.click('#play-daily');
  await expect(other.locator('.opp-name')).toHaveText(name!);
});
