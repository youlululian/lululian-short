# Lululian Short · 鹿连短剧

**面向工业化生产的可迭代 AI 短剧创作系统。**

项目围绕剧本、角色、分镜、视频生成、双重 Judge 和反馈训练构建制作闭环，支持本地模型与云端 API。目标是让每轮创作都有明确输入、可检查的产物、可追踪的评审和可控制的返修成本。

> 当前为 v0.1 开发版。工作台、项目存储、剧本生成、剧本 Judge、人工确认、分镜素材生成与上传、FFmpeg 合成已实现。本地／云端视频 Judge、H3 生成与训练管线正在下一批提交中接入。尚未经过生产负载验证。

## 启动

需要 Python 3.11+、Node.js 22+、uv 和 FFmpeg。

```bash
uv sync
npm --prefix frontend ci
npm --prefix frontend run build
uv run uvicorn lululian.main:app --app-dir backend --host 127.0.0.1 --port 8000
```

访问 http://127.0.0.1:8000 。API 文档位于 `/docs`。

开发时分别启动后端和前端：`npm --prefix frontend run dev`，打开 http://127.0.0.1:5173 。

## 制作流程

1. 创建作品，填写创意、题材、风格、画幅与集数。
2. 生成剧本、角色与分镜，手动修改内容。
3. 运行剧本 Judge，查看问题并人工确认当前版本。
4. 生成或上传画面与配音；可锁定镜头、调整顺序、单镜重做。
5. 检查素材，按集导出带字幕的 MP4、SRT 和项目 JSON。

修改创作内容会使原确认失效，需要重新评审。素材生成失败会保存之前完成的镜头，重试默认只补齐缺失素材。

## 模型设置

默认演示模式不使用外部模型：固定示例故事、明确标注的占位画面、规则检查，无假配音或假 AI 评分。

在「模型设置」中配置文本、图片、配音与独立剧本 Judge 的 API 地址、模型名称、密钥。文本可连接 DeepSeek 或兼容 Chat Completions 的本地服务。配置后切换真实模式。不同服务商对生图与配音参数的支持可能不同。

密钥写入本机 `.data/settings.json`（权限 0600），不回传到前端。也可通过 `.env.example` 所列环境变量配置；界面保存的设置优先。数据库、密钥、生成素材均排除在 Git 之外。

## 技术与边界

- React + TypeScript + Vite 中文工作台。
- FastAPI + SQLite WAL 项目与任务存储。
- 每个项目同时只运行一个任务；文件逐镜保存，程序重启将中断任务标记为失败，等待人工重试。
- FFmpeg 合成 H.264/AAC；Pillow 绘制字幕，独立导出 SRT。
- 第一版以单机、单用户、单后端进程为部署边界；不要启用多个 Uvicorn worker，也不要直接暴露公网。
- 规则检查不是语义模型评审，技术素材检查不是视频内容 Judge。

## 验证

```bash
uv run pytest
uv run ruff check backend
npm --prefix frontend run build
```

真实模型调用需要自行配置密钥或部署模型。仓库不包含任何训练权重、密钥或用户素材。
