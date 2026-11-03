# 本地与云端部署

工作台运行在本机。模型部署方式独立选择：可以全本地，也可以 DeepSeek + Gemini + MiniMax API 混合使用。

## 工作台

```bash
bash scripts/start.sh
```

打开 http://127.0.0.1:8000。Docker 方式：`docker compose up --build -d`。

Ubuntu / Debian 直接部署时，先安装视频工具与中文字库：

```bash
apt-get update
apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk
```

中文字库用于演示画面和字幕叠图。仅安装 FFmpeg 仍可能缺少中文字形；后端优先读取 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`。可用 `fc-list :lang=zh` 检查系统字体，并通过实际字幕渲染确认显示正常。

Docker 使用名为 `studio-data` 的持久卷。备份此卷即可保留数据库、配置和素材。停止服务时使用 `docker compose down`；不要加 `-v`，否则会删除数据。

本地验收环境未启动 Docker daemon，因此已校验 Compose 配置，但未声称完成镜像构建与容器运行验收。

单机第一版只允许一个 API 进程。不要设置多个 Uvicorn workers 或多个共享 SQLite 的副本。项目任务、版本和评审记录持久化；进程中断后任务标记为失败，人工重试。H3 已返回任务 ID 的请求会继续轮询。提交请求本身超时时，远端是否创建任务无法确定，应先检查服务商记录，不能假设跨网络 exactly-once。

## 云端组合

在界面「模型设置」中选择真实模式：

| 能力 | API 地址 | 模型 |
| --- | --- | --- |
| 编剧／修订 | `https://api.deepseek.com` | 填写账户可用的 DeepSeek 模型 ID |
| 独立剧本 Judge | 兼容 Chat Completions 的地址 | 可与编剧分开配置；空模型时使用编剧模型 |
| 视频 Judge | `https://generativelanguage.googleapis.com/v1beta` | 账户可用、支持视频输入的 Gemini 模型 ID |
| 视频生成 | `https://api.minimax.io/v2` 或国内接入点 | `MiniMax-H3` |

视频 Judge 选择 Gemini，H3 选择 MiniMax API。两者分别保存 Key。Gemini 使用 `generateContent` 和实际视频字节，不依赖公开素材 URL。短片会转成保留时间轴的 640px 代理视频，总量限制 18 MB。代理视频是有损检查视图，细微缺陷仍需人工检查原片。

DeepSeek 负责文本规划和提示词修订；不会把它当成视频视觉模型。不同能力可自由组合，不要求所有模型来自同一服务商。

## 本地组合

需要独立的 Linux CUDA 模型环境。普通 Mac 可以运行工作台、演示和 FFmpeg；仓库没有在该 Mac 上下载或运行 H3/Qwen GPU 权重。

### Qwen-VL Judge

安装支持 Qwen3-VL 的 vLLM 与视频解码依赖后：

```bash
bash scripts/serve-local-judge.sh
```

界面视频 Judge 选择本地，地址 `http://127.0.0.1:8001/v1`。接口发送真实 MP4 的 data URL，可选附带镜头参考图。Qwen-VL 路径只评视觉，不能声称检查了音轨或读音。

### H3 视频生成

安装支持 MiniMax H3 的 SGLang Diffusion 环境后：

```bash
H3_NUM_GPUS=4 bash scripts/serve-local-h3.sh
```

H3 地址为 `http://127.0.0.1:30010/v1`。当前本地适配实现 T2VA；云端适配支持文字输入，以及已有分镜图作为首帧。SGLang 原始模型部署需要相应显存与主机内存，GPU 数量参数不代表任意硬件都能运行。量化、MLX 与其他推理后端不属于本版已验证范围。

容器中的 `localhost` 是容器自身。连接宿主机服务时改用 `host.docker.internal`，并按实际网络设置模型服务监听地址；不要把模型服务暴露公网。

## 迭代与失败处理

- 单独重做镜头只改该镜头；锁定镜头不自动重生成。
- 自动流水线要求先运行剧本 Judge 并人工确认。
- 每镜默认最多两轮评审，总模型调用默认上限 20；这不是美元预算。
- Judge 返回不确定、锁定镜头未通过、轮次耗尽或预算耗尽时，任务停下，保留素材和事件记录。
- 成片完成后再评审整集。最终检查未通过的产物保留在任务事件中，不标记为可交付。
- 视频生成与 Judge 需要外部服务或 GPU，接口契约有 mock 测试，但尚未用真实付费 Key/GPU 做端到端验收。

## 依赖文档

部署协议以供应方官方文档为准：[Gemini 视频输入](https://ai.google.dev/gemini-api/docs/video-understanding)、[MiniMax H3 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)、[SGLang H3](https://docs.sglang.io/cookbook/diffusion/MiniMax/MiniMax-H3)、[vLLM 多模态](https://docs.vllm.ai/en/latest/features/multimodal_inputs/)。模型权重遵循各自许可证；本仓库不分发权重。
