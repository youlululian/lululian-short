import { useEffect, useRef, useState } from "react";
import { Bot, Check, Loader2, LockKeyhole } from "lucide-react";
import { api, post } from "./api";
import { Settings } from "./types";

type Role = "text" | "vision" | "video";
type SetupRun = {
  id: string;
  status: string;
  profile: string;
  message: string;
  created_at: string;
  steps: {
    role: Role;
    label: string;
    status: string;
    message: string;
    attempts: number;
    model?: string;
    base_url: string;
  }[];
};
const labels: Record<Role, string> = {
  text: "剧本生产 / 剧本 Judge",
  vision: "视频 Judge",
  video: "视频生产",
};
const statusNames: Record<string, string> = {
  running: "检测中",
  cancelling: "停止中",
  cancelled: "已停止",
  succeeded: "已完成",
  failed: "需要处理",
};
const isActive = (run?: SetupRun) =>
  !!run && ["running", "cancelling"].includes(run.status);

export function ModelSetupAssistant({
  settings,
  onSaved,
  onBusy,
  notify,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onBusy: (b: boolean) => void;
  notify: (m: string) => void;
}) {
  const [profile, setProfile] = useState("cloud");
  const [host, setHost] = useState("127.0.0.1");
  const [ports, setPorts] = useState({
    text: 8002,
    vision: 8001,
    video: 30010,
  });
  const [credentials, setCredentials] = useState<
    Record<Role, { api_key: string; model: string }>
  >({
    text: { api_key: "", model: "" },
    vision: { api_key: "", model: "" },
    video: { api_key: "", model: "" },
  });
  const [runs, setRuns] = useState<SetupRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const seen = useRef(new Map<string, string>());
  const callbacks = useRef({ onSaved, onBusy, notify });
  callbacks.current = { onSaved, onBusy, notify };
  const active = runs.find(isActive);
  const busy = loading || submitting || !!active;
  useEffect(() => {
    callbacks.current.onBusy(busy);
  }, [busy]);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api<SetupRun[]>("/model-agent/runs");
        if (stopped) return;
        setRuns(next);
        const newest = next[0];
        if (
          newest?.status === "succeeded" &&
          seen.current.get(newest.id) !== "succeeded"
        ) {
          const value = await api<Settings>("/settings");
          if (!stopped) {
            callbacks.current.onSaved(value);
            setCredentials({
              text: { api_key: "", model: "" },
              vision: { api_key: "", model: "" },
              video: { api_key: "", model: "" },
            });
          }
        }
        for (const run of next) seen.current.set(run.id, run.status);
      } catch (e) {
        if (!stopped) callbacks.current.notify((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
      callbacks.current.onBusy(false);
    };
  }, []);
  const run = async () => {
    setSubmitting(true);
    try {
      await api(
        "/model-agent/runs",
        post({
          profile,
          local_host: host,
          text_port: ports.text,
          vision_port: ports.vision,
          video_port: ports.video,
          ...credentials,
        }),
      );
      setRuns(await api<SetupRun[]>("/model-agent/runs"));
      notify("配置助手已启动，检测过程会显示在下方");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const recent = active || runs[0];
  return (
    <section className="setup-assistant" aria-label="模型配置助手">
      <div className="section-heading">
        <div>
          <span className="eyebrow">MODEL SETUP AGENT</span>
          <h2>
            <Bot size={21} />
            模型配置助手
          </h2>
          <p>选方案 → 输入 Key → 自动检测与选模型 → 保存配置。</p>
        </div>
        <span className="capability-badge">
          <LockKeyhole size={13} />
          仅模型操作
        </span>
      </div>
      <fieldset disabled={busy} className="editor-fieldset">
        <label>
          部署方案
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            <option value="cloud">云端：DeepSeek + Gemini + MiniMax H3</option>
            <option value="hybrid">混合：DeepSeek + 本地 Qwen-VL / H3</option>
            <option value="local">本地：文本模型 + Qwen-VL + H3</option>
          </select>
        </label>
        <p className="muted-text small">
          助手没有修改代码或运行终端的权限。这里只做只读连接检测，不会生成收费视频；本地模式需预先部署模型服务。
        </p>
        <div className="setup-credentials">
          {(["text", "vision", "video"] as Role[]).map((role) => (
            <label key={role}>
              {labels[role]} ·{" "}
              {role === "text"
                ? profile === "local"
                  ? "本地模型"
                  : "DeepSeek"
                : role === "vision"
                  ? profile === "cloud"
                    ? "Gemini"
                    : "本地 Qwen-VL"
                  : profile === "cloud"
                    ? "MiniMax"
                    : "本地 H3"}
              <input
                type="password"
                autoComplete="off"
                aria-label={`助手 ${role} API Key`}
                placeholder={
                  settings[role].configured
                    ? "留空复用同一地址已保存的 Key"
                    : profile === "local" ||
                        (profile === "hybrid" && role !== "text")
                      ? "本地服务无鉴权时可留空"
                      : "输入此服务商的 API Key"
                }
                value={credentials[role].api_key}
                onChange={(e) =>
                  setCredentials({
                    ...credentials,
                    [role]: { ...credentials[role], api_key: e.target.value },
                  })
                }
              />
            </label>
          ))}
        </div>
        <details className="below">
          <summary>指定模型与本地端口（可选）</summary>
          <p className="muted-text small">
            模型名称留空时，从服务返回的列表中选择候选模型。目录检测不能替代实际生成验收。
          </p>
          <div className="setup-credentials">
            {(["text", "vision", "video"] as Role[]).map((role) => (
              <label key={role}>
                {labels[role]}模型
                <input
                  value={credentials[role].model}
                  placeholder="自动选择"
                  onChange={(e) =>
                    setCredentials({
                      ...credentials,
                      [role]: { ...credentials[role], model: e.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
          {profile !== "cloud" && (
            <>
              <label className="below">
                模型服务位置
                <select value={host} onChange={(e) => setHost(e.target.value)}>
                  <option value="127.0.0.1">
                    与工作台在同一主机 / 网络空间
                  </option>
                  <option value="host.docker.internal">
                    Docker 工作台连接宿主机
                  </option>
                </select>
              </label>
              <div className="setup-credentials">
                {(["text", "vision", "video"] as Role[])
                  .filter((r) => profile === "local" || r !== "text")
                  .map((role) => (
                    <label key={role}>
                      {labels[role]}端口
                      <input
                        type="number"
                        min={1024}
                        max={65535}
                        value={ports[role]}
                        onChange={(e) =>
                          setPorts({ ...ports, [role]: Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
              </div>
            </>
          )}
        </details>
        <button
          type="button"
          className="primary below"
          onClick={() => void run()}
        >
          <Bot size={16} />
          开始自动配置
        </button>
      </fieldset>
      {recent && (
        <div className="setup-log" aria-live="polite">
          <div className="section-heading">
            <strong>
              {statusNames[recent.status]} · {recent.message}
            </strong>
            {active && (
              <button
                type="button"
                className="secondary"
                disabled={active.status === "cancelling"}
                onClick={async () => {
                  try {
                    await api(
                      `/model-agent/runs/${active.id}/cancel`,
                      post({}),
                    );
                    setRuns(await api<SetupRun[]>("/model-agent/runs"));
                  } catch (e) {
                    notify((e as Error).message);
                  }
                }}
              >
                停止检测
              </button>
            )}
          </div>
          {recent.steps.map((step) => (
            <div className={`setup-step ${step.status}`} key={step.role}>
              {step.status === "succeeded" ? (
                <Check size={16} />
              ) : step.status === "running" ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <span>!</span>
              )}
              <div>
                <strong>
                  {step.label} · {statusNames[step.status]}
                </strong>
                <p>{step.message}</p>
                <small>
                  {step.base_url}
                  {step.model ? ` · ${step.model}` : ""} · 检测 {step.attempts}{" "}
                  次
                </small>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="muted-text small below">
        通过后会更新剧本、剧本 Judge、视频生成与视频 Judge
        配置，并开启真实模式。图片和独立配音可在下方配置。失败或停止不会应用本次方案。
      </p>
    </section>
  );
}
