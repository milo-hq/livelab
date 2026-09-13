import { expect, test } from '@playwright/test';

const MEDIAMTX_API = process.env.MEDIAMTX_API ?? 'http://localhost:9997';

test.beforeAll(async () => {
  try {
    const r = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    const j = (await r.json()) as { items: { name: string; ready: boolean }[] };
    const demo = j.items.find((i) => i.name === 'live/demo');
    test.skip(!demo?.ready, 'MediaMTX has no live/demo stream (run `pnpm infra:up`)');
  } catch {
    test.skip(true, 'MediaMTX API unreachable (run `pnpm infra:up`)');
  }
});

test('viewer can watch the demo room and chat', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByPlaceholder('昵称').fill('e2e-viewer');
  await page.getByRole('button', { name: '进入' }).click();
  await expect(page.getByText('e2e-viewer')).toBeVisible();

  await page.goto('/room/demo');
  const video = page.locator('video');
  await expect(video).toBeVisible();
  // The player must reach a moving timeline within 15s (first frame + playback).
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(1);

  // The QoE overlay reports the pathway actually used.
  await page.keyboard.press('i');
  await expect(page.getByText(/pathway/)).toBeVisible();
  await expect(page.locator('text=/llhls@|whep@|flv@/').first()).toBeVisible();

  // Chat round-trip: optimistic echo replaced by the server copy.
  const input = page.getByPlaceholder(/说点什么/);
  await input.fill('hello from e2e');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('hello from e2e')).toBeVisible();
});
