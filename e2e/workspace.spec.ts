import { expect, test, type Page } from '@playwright/test';

const catalogPath =
  '/catalog?filters%5Bkind%5D=component&filters%5Buser%5D=all&limit=20';
const destinations = [
  { label: 'Inventory', heading: 'AI app inventory' },
  { label: 'Reviews', heading: 'Critical app reviews' },
  { label: 'Import', heading: 'Import existing apps' },
  { label: 'Builder guide', heading: 'Builder guide' },
];

async function assertWorkspace(page: Page, heading: string, active?: string) {
  await expect(
    page.getByRole('heading', { level: 1, name: heading }),
  ).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'AI governance' });
  await expect(navigation).toHaveCount(1);
  await expect(
    page.getByRole('link', { name: 'Catalog', exact: true }),
  ).toHaveCount(1);
  await expect(navigation.getByRole('link')).toHaveText([
    'Inventory',
    'Catalog',
    'Reviews',
    'Import',
    'Builder guide',
  ]);
  const activeLink = navigation.locator('[aria-current="page"]');
  if (active) await expect(activeLink).toHaveText(active);
  else await expect(activeLink).toHaveCount(0);

  const hasOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
  expect(hasOverflow).toBe(false);
}

test('workspace screens share navigation and fit the viewport', async ({
  page,
}) => {
  await page.goto(catalogPath);
  const heading = page.getByRole('heading', {
    level: 1,
    name: 'Software catalog',
  });
  const guest = page.getByRole('button', { name: /enter|guest/i }).first();
  await expect(heading.or(guest)).toBeVisible();
  if (await guest.isVisible()) await guest.click();

  await assertWorkspace(page, 'Software catalog', 'Catalog');
  await expect(
    page.getByRole('button', { name: 'Components', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  const navigation = page.getByRole('navigation', { name: 'AI governance' });
  for (const destination of destinations) {
    await navigation
      .getByRole('link', { name: destination.label, exact: true })
      .click();
    await assertWorkspace(page, destination.heading, destination.label);
  }

  await navigation
    .getByRole('link', { name: 'Inventory', exact: true })
    .click();
  await page.getByRole('link', { name: 'Register app', exact: true }).click();
  await assertWorkspace(page, 'Register an AI app');
});
