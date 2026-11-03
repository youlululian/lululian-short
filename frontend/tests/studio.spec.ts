import { test, expect } from "@playwright/test";

test("create, generate, review, approve and produce storyboard images", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "我的作品" })).toBeVisible();
  await page.screenshot({ path: "test-results/dashboard.png", fullPage: true });
  await page.getByRole("button", { name: "新建短剧", exact: true }).click();
  await page.getByRole("button", { name: "试试示例" }).click();
  const creation = page.waitForResponse(
    (r) => r.url().endsWith("/api/projects") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
  const project = await (await creation).json();
  try {
    await page.getByRole("button", { name: "生成剧本", exact: true }).click();
    await page.getByRole("button", { name: "故事剧本", exact: true }).click();
    await expect(page.getByLabel("集名").first()).toHaveValue(
      "第 1 集 · 明日来信（演示）",
      { timeout: 15000 },
    );
    await page.getByRole("button", { name: "评审中心", exact: true }).click();
    await page.getByRole("button", { name: "运行剧本 Judge" }).click();
    await expect(
      page.getByRole("heading", { name: "规则检查（无 AI 评分）" }),
    ).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "确认剧本，进入制作" }).click();
    await expect(page.getByRole("status")).toContainText("已确认");
    await page.getByRole("button", { name: "分镜工作台", exact: true }).click();
    await page.getByRole("button", { name: "生成缺失画面" }).click();
    await expect(page.locator(".shot-preview img")).toHaveCount(4, {
      timeout: 15000,
    });
    await page.screenshot({
      path: "test-results/storyboard.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "编辑镜头" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "完成编辑" }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/mobile.png", fullPage: false });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test("settings persist without exposing keys", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "视频 Judge", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("模型设置已保存");
});

test("four stages enforce approval and show independent controls", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/projects", {
    data: {
      title: "四阶段控制验收",
      premise: "书店店主收到一封来自明天的信。",
      episode_count: 2,
    },
  });
  const project = await response.json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("/");
    await page.getByRole("button", { name: /四阶段控制验收/ }).click();
    await expect(
      page.getByRole("heading", { name: "流水线控制台", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(4);
    await page.getByRole("tab", { name: /视频生产/ }).click();
    await expect(
      page.getByRole("button", { name: "执行制作步骤" }),
    ).toBeDisabled();
    await page.getByRole("tab", { name: /剧本生产/ }).click();
    await page.getByRole("button", { name: "启动剧本生产" }).click();
    await expect(
      page.getByText("当前已有 2 集、8 个镜头。", { exact: false }),
    ).toBeVisible({ timeout: 15000 });
    await page.getByRole("tab", { name: /剧本 Judge/ }).click();
    await page.getByRole("button", { name: "启动剧本评审" }).click();
    await expect(
      page.getByRole("button", { name: "确认当前剧本", exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    await page
      .getByRole("button", { name: "确认当前剧本", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "当前剧本已确认", exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /视频生产/ }).click();
    await page.getByLabel("处理剧集").selectOption({ index: 2 });
    await page.getByLabel("制作步骤").selectOption("images");
    await expect(
      page.getByRole("button", { name: "执行制作步骤" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "执行制作步骤" }).click();
    await expect(
      page.getByText("没有待生成素材；", { exact: false }),
    ).toBeVisible({ timeout: 15000 });
    const current = await (
      await request.get(`/api/projects/${project.id}`)
    ).json();
    expect(
      current.document.episodes[0].shots.every(
        (s: { image: string | null }) => !s.image,
      ),
    ).toBeTruthy();
    expect(
      current.document.episodes[1].shots.every(
        (s: { image: string | null }) => !!s.image,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: "test-results/pipelines.png",
      fullPage: true,
    });
    await page.getByRole("tab", { name: /视频 Judge/ }).click();
    await page.getByLabel("评审范围").selectOption("final");
    await expect(
      page.getByRole("button", { name: "启动视频评审" }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: "test-results/pipelines-mobile.png",
      fullPage: false,
    });
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
  }
});

test("setup assistant reports missing keys without enabling live mode", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模型配置助手" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "开始自动配置" }).click();
  await expect(
    page.getByText("仍有配置需要处理，原设置未改变。", { exact: false }),
  ).toBeVisible({ timeout: 15000 });
  expect((await (await request.get("/api/settings")).json()).mode).toBe("demo");
  await page.screenshot({
    path: "test-results/model-setup.png",
    fullPage: true,
  });
});

test("human feedback drives a bounded prompt proposal without changing the script", async ({
  page,
  request,
}) => {
  const { createServer } = await import("node:http");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const fixtureDir = mkdtempSync(join(tmpdir(), "lululian-feedback-"));
  const videoPath = join(fixtureDir, "fixture.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=160x240:d=1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    { stdio: "ignore" },
  );
  let calls = 0;
  const model = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      calls += 1;
      const input = JSON.parse(body);
      expect(input.tools).toBeUndefined();
      expect(input.messages[1].content).toContain("动作放慢");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  video_prompt:
                    "固定机位，保持原角色造型，缓慢拿起信封，不切换镜头。",
                  change_summary: "根据人工反馈放慢拿信动作并固定机位。",
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const settings = await (await request.get("/api/settings")).json();
  for (const role of ["text", "image", "voice", "judge", "vision", "video"])
    delete settings[role].configured;
  const project = await (
    await request.post("/api/projects", {
      data: { title: "反馈调优验收", premise: "年轻店主发现一封未来的信。" },
    })
  ).json();
  const run = async (kind: string) => {
    const res = await request.post(`/api/projects/${project.id}/jobs`, {
      data: { kind },
    });
    expect(res.ok()).toBeTruthy();
    const job = await res.json();
    await expect
      .poll(
        async () =>
          (
            await (await request.get(`/api/projects/${project.id}/jobs`)).json()
          ).find((j: { id: string }) => j.id === job.id).status,
      )
      .toBe("succeeded");
  };
  try {
    await run("script");
    await run("judge");
    expect(
      (await request.post(`/api/projects/${project.id}/approve`)).ok(),
    ).toBeTruthy();
    let current = await (
      await request.get(`/api/projects/${project.id}`)
    ).json();
    const shot = current.document.episodes[0].shots[0];
    const uploaded = await request.post(
      `/api/projects/${project.id}/shots/${shot.id}/upload/video`,
      {
        multipart: {
          file: {
            name: "fixture.mp4",
            mimeType: "video/mp4",
            buffer: readFileSync(videoPath),
          },
        },
      },
    );
    expect(uploaded.ok()).toBeTruthy();
    current = await (await request.get(`/api/projects/${project.id}`)).json();
    expect(
      (
        await request.put("/api/settings", {
          data: {
            ...settings,
            mode: "live",
            text: {
              base_url: `http://127.0.0.1:${port}/v1`,
              api_key: "",
              model: "fixture-writer",
            },
          },
        })
      ).ok(),
    ).toBeTruthy();
    await page.goto("/");
    await page.getByRole("button", { name: /反馈调优验收/ }).click();
    await page.getByRole("tab", { name: /视频生产/ }).click();
    await page
      .getByLabel("人工优化后的生成提示词")
      .fill("保持原人物服饰，动作放慢，固定机位拍摄拿信过程。");
    await page.getByLabel("具体反馈").fill("动作放慢，背景和人物保持不变。");
    await page.getByRole("button", { name: "不满意，提交并调优" }).click();
    await expect(
      page.getByRole("button", { name: "采用 Agent 提案" }),
    ).toBeEnabled({ timeout: 15000 });
    expect(calls).toBe(1);
    await expect(
      page.getByText("根据人工反馈放慢拿信动作并固定机位。", { exact: true }),
    ).toBeVisible();
    expect(
      (await (await request.get(`/api/projects/${project.id}`)).json())
        .revision,
    ).toBe(current.revision);
    await page.screenshot({
      path: "test-results/prompt-feedback.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "采用 Agent 提案" }).click();
    await expect(page.getByRole("status")).toContainText("已采用提示词");
    const updated = await (
      await request.get(`/api/projects/${project.id}`)
    ).json();
    expect(updated.content_hash).toBe(current.content_hash);
    expect(updated.document.episodes[0].shots[0].video).toBe(
      current.document.episodes[0].shots[0].video,
    );
    expect(updated.document.episodes[0].shots[0].video_prompt).toContain(
      "固定机位",
    );
    await page.getByRole("button", { name: "满意，记录偏好" }).click();
    await expect(page.getByText("满意反馈 ·", { exact: false })).toBeVisible();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    await request.put("/api/settings", { data: settings });
    await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
