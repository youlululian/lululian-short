import { test, expect } from '@playwright/test'

test('create, generate, review, approve and produce storyboard images', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '我的作品' })).toBeVisible()
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true })
  await page.getByRole('button', { name: '新建短剧', exact: true }).click()
  await page.getByRole('button', { name: '试试示例' }).click()
  const creation = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST')
  await page.getByRole('button', { name: '创建作品', exact: true }).click()
  const project = await (await creation).json()
  try {
    await page.getByRole('button', { name: '生成剧本', exact: true }).click()
    await expect(page.getByLabel('集名').first()).toHaveValue('第 1 集 · 明日来信（演示）', { timeout: 15000 })
    await page.getByRole('button', { name: '评审中心', exact: true }).click()
    await page.getByRole('button', { name: '运行剧本 Judge' }).click()
    await expect(page.getByRole('heading', { name: '规则检查（无 AI 评分）' })).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: '确认剧本，进入制作' }).click()
    await expect(page.getByRole('status')).toContainText('已确认')
    await page.getByRole('button', { name: '分镜工作台', exact: true }).click()
    await page.getByRole('button', { name: '生成缺失画面' }).click()
    await expect(page.locator('.shot-preview img')).toHaveCount(4, { timeout: 15000 })
    await page.screenshot({ path: 'test-results/storyboard.png', fullPage: true })
    await page.getByRole('button', { name: '编辑镜头' }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: '完成编辑' }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: 'test-results/mobile.png', fullPage: false })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    expect(errors).toEqual([])
  } finally {
    await request.delete(`/api/projects/${project.id}`)
  }
})

test('settings persist without exposing keys', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '视频 Judge', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('模型设置已保存')
})
