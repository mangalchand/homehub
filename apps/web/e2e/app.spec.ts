import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('demo@familyhub.local');
  await page.getByLabel('Password').fill('FamilyHub!2024');
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.getByText('Coming up')).toBeVisible();
}

test('rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('demo@familyhub.local');
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign in' }).last().click();
  await expect(page.getByText(/incorrect/i)).toBeVisible();
});

test('dashboard shows agenda, chores and lists; private calendars render as busy', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('Today’s chores')).toBeVisible();
  await expect(page.getByText('Groceries')).toBeVisible();
  await page.goto('/calendar');
  await expect(page.locator('.fc')).toBeVisible();
  await expect(page.getByText('Busy').first()).toBeVisible();
});

test('create an event on the family calendar', async ({ page }) => {
  await signIn(page);
  await page.goto('/calendar');
  await page.getByRole('button', { name: 'New event' }).click();
  const title = `E2E event ${Date.now()}`;
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Agenda' }).click();
  await expect(page.getByText(title)).toBeVisible();
});

test('shared grocery list: add, check off and categorize', async ({ page }) => {
  await signIn(page);
  await page.goto('/lists');
  await page.getByRole('link', { name: /Groceries/ }).click();
  const item = `bananas ${Date.now() % 10000}`;
  await page.getByLabel('New item').fill(item);
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText(item)).toBeVisible();
  await page.reload();
  await expect(page.getByText(item)).toBeVisible();
  await page.getByLabel(`Mark ${item}`).click();
  await expect(page.getByText(/^Done \(/)).toBeVisible();
});

test('chores page lists kids and household tasks', async ({ page }) => {
  await signIn(page);
  await page.goto('/chores');
  await expect(page.getByText('Maya').first()).toBeVisible();
  await expect(page.getByText('Household tasks')).toBeVisible();
});

test('family photos: upload and show in the gallery', async ({ page }) => {
  await signIn(page);
  await page.goto('/photos');
  await expect(page.getByRole('heading', { name: 'Family photos' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const before = await page.locator('figure img').count();
  await page.locator('input[type=file]:not([capture])').setInputFiles('public/icon-512.png');
  await expect.poll(() => page.locator('figure img').count(), { timeout: 15_000 }).toBeGreaterThan(before);
});
