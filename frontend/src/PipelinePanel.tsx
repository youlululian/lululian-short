import { useEffect, useState } from "react";
import { Clapperboard, Film, ShieldCheck, Workflow } from "lucide-react";
import { PipelinePromptEditor } from "./PipelinePromptEditor";
import { PromptTuner } from "./PromptTuner";
import { api } from "./api";
import {
  Episode,
  Job,
  JobKind,
  Project,
  PipelinePrompts,
  VideoReview,
  jobNames,
  media,
} from "./types";

type Stage = "script" | "judge" | "production" | "video_judge";
type Event = {
  seq: number;
  kind: string;
  created_at: string;
  data: Record<string, unknown>;
};
const stages: {
  id: Stage;
  name: string;
  description: string;
  icon: typeof Film;
}[] = [
  {
    id: "script",
    name: "剧本生产",
    description: "创意 → 角色 → 分集与分镜",
    icon: Clapperboard,
  },
  {
    id: "judge",
    name: "剧本 Judge",
    description: "检查问题 → 人工确认",
    icon: ShieldCheck,
  },
  {
    id: "production",
    name: "视频生产",
    description: "画面与声音 → 镜头 → 成片",
    icon: Film,
  },
  {
    id: "video_judge",
    name: "视频 Judge",
    description: "镜头检查 → 成片一致性",
    icon: ShieldCheck,
  },
];
const statusNames = {
  queued: "排队中",
  running: "运行中",
  succeeded: "任务已完成",
  failed: "执行失败",
};
const stageOf = (kind: JobKind): Stage =>
  kind === "script" || kind === "judge" || kind === "video_judge"
    ? kind
    : "production";

export function PipelinePanel({
  project,
  jobs,
  episode,
  busy,
  dirty,
  mode,
  runJob,
  notify,
  selectEpisode,
  navigate,
  approve,
  generateScript,
  onSaved,
  onPromptsChange,
}: {
  project: Project;
  jobs: Job[];
  episode?: Episode;
  busy: boolean;
  dirty: boolean;
  mode: string;
  runJob: (kind: JobKind, extra?: object) => Promise<void>;
  notify: (message: string) => void;
  selectEpisode: (id: string) => void;
  navigate: (tab: "story" | "shots" | "review" | "exports") => void;
  approve: () => void;
  generateScript: () => void;
  onSaved: (p: Project) => void;
  onPromptsChange: (prompts: PipelinePrompts) => void;
}) {
  const [stage, setStage] = useState<Stage>("script");
  const [shotId, setShotId] = useState("");
  const [operation, setOperation] = useState<JobKind>("videos");
  const [overwrite, setOverwrite] = useState(false);
  const [scope, setScope] = useState("episode");
  const [exportId, setExportId] = useState("");
  const [rounds, setRounds] = useState(2);
  const [calls, setCalls] = useState(20);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    setShotId("");
    setExportId("");
    setSelectedJobId("");
  }, [episode?.id]);
  const shots = project.document.episodes.flatMap((e) => e.shots);
  const approved =
    !dirty &&
    !!project.content_hash &&
    project.document.approved_hash === project.content_hash;
  const review = jobs.find(
    (j) => j.kind === "judge" && j.status === "succeeded",
  );
  const currentReview =
    !dirty && review?.result?.content_hash === project.content_hash;
  const inEpisode = (j: Job) =>
    !j.payload.episode_id || j.payload.episode_id === episode?.id;
  const exports = jobs.filter(
    (j) =>
      ["render", "pipeline"].includes(j.kind) &&
      j.status === "succeeded" &&
      j.result?.video &&
      j.result?.episode_id === episode?.id,
  );
  const exportJob = exports.find((j) => j.id === exportId) || exports[0];
  const scopedJobs = jobs.filter(
    (j) =>
      stageOf(j.kind) === stage &&
      (stage === "script" ||
        stage === "judge" ||
        (inEpisode(j) &&
          (!j.payload.shot_id ||
            episode?.shots.some((s) => s.id === j.payload.shot_id)) &&
          (!j.payload.export_id ||
            exports.some(
              (e) => e.result?.video === `${j.payload.export_id}.mp4`,
            )))),
  );
  const selectedJob =
    scopedJobs.find((j) => j.id === selectedJobId) || scopedJobs[0];
  useEffect(() => {
    setEvents([]);
    if (!selectedJob) return;
    let stopped = false;
    const load = async () => {
      try {
        const rows = await api<Event[]>(
          `/projects/${project.id}/jobs/${selectedJob.id}/events`,
        );
        if (!stopped) setEvents(rows);
      } catch (e) {
        if (!stopped) notify((e as Error).message);
      }
    };
    void load();
    const timer =
      selectedJob.status === "running" || selectedJob.status === "queued"
        ? setInterval(load, 2000)
        : undefined;
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [project.id, selectedJob?.id, selectedJob?.status, notify]);
  const blocked = busy || dirty;
  const limitsValid =
    Number.isInteger(rounds) &&
    rounds >= 1 &&
    rounds <= 4 &&
    Number.isInteger(calls) &&
    calls >= 1 &&
    calls <= 100;
  const targets =
    episode?.shots.filter((s) => !shotId || s.id === shotId) || [];
  const field =
    operation === "images"
      ? "image"
      : operation === "voice"
        ? "audio"
        : "video";
  const generatable = targets.filter(
    (s) => !s.locked && (overwrite || !s[field]),
  );
  const productionReason = !approved
    ? "请先评审并确认当前剧本。"
    : !episode?.shots.length
      ? "请选择有分镜的剧集。"
      : mode === "demo" && ["videos", "voice"].includes(operation)
        ? "真实视频和配音需要在模型设置中启用真实模式。"
        : operation === "render"
          ? episode.shots.some((s) => !s.video && !s.image)
            ? "本集还有镜头没有画面，请先补齐。"
            : "合成用于预览；交付前还需运行成片 Judge。"
          : !generatable.length
            ? "没有待生成素材；可选择重做，或在分镜工作台解锁镜头。"
            : `将处理 ${generatable.length} 个镜头，锁定镜头会跳过。`;
  const canProduce =
    approved &&
    !!episode?.shots.length &&
    (operation === "render"
      ? episode.shots.every((s) => s.video || s.image)
      : !!generatable.length &&
        !(mode === "demo" && ["videos", "voice"].includes(operation)));
  const reviewTargets =
    scope === "shot"
      ? targets.filter((s) => s.id === shotId)
      : episode?.shots || [];
  const canReviewVideo =
    mode === "live" &&
    limitsValid &&
    (scope === "final"
      ? !!exportJob && exportJob.result?.revision === project.revision
      : reviewTargets.length > 0 &&
        reviewTargets.every((s) => s.video) &&
        reviewTargets.length <= calls);
  const submit = (kind: JobKind, extra: object = {}) => {
    setSelectedJobId("");
    void runJob(kind, extra);
  };
  const oldVideoReport =
    selectedJob?.kind === "video_judge" &&
    selectedJob.result?.revision !== project.revision;
  return (
    <div className="pipeline-console">
      <div className="section-heading">
        <div>
          <h2>流水线控制台</h2>
          <p>四个阶段独立运行。剧本先确认，视频再制作与评审。</p>
        </div>
        <span className="tiny-label">
          {mode === "live" ? "真实模式" : "演示模式"}
        </span>
      </div>
      <div className="stage-grid" role="tablist" aria-label="制作流水线">
        {stages.map((s, i) => {
          const latest = jobs.find(
            (j) => stageOf(j.kind) === s.id && (i < 2 || inEpisode(j)),
          );
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={stage === s.id}
              className={`stage-card ${stage === s.id ? "selected" : ""}`}
              onClick={() => {
                setStage(s.id);
                setSelectedJobId("");
              }}
            >
              <span className="stage-number">
                0{i + 1}
                <s.icon size={19} />
              </span>
              <strong>{s.name}</strong>
              <small>{s.description}</small>
              <span className="stage-status">
                {latest
                  ? latest.status === "succeeded" &&
                    latest.result?.passed === false
                    ? "评审完成 · 需修改"
                    : statusNames[latest.status]
                  : "尚未运行"}
              </span>
            </button>
          );
        })}
      </div>
      <PipelinePromptEditor
        project={project}
        busy={busy}
        onChange={onPromptsChange}
        notify={notify}
      />
      {dirty && (
        <p className="console-notice">
          有未保存的修改，请先点击上方「保存修改」。修改剧本后需要重新评审并确认。
        </p>
      )}
      {busy && (
        <p className="console-notice">
          项目任务正在执行，可切换阶段查看结果；新的操作需等待当前任务完成。
        </p>
      )}
      {(stage === "production" || stage === "video_judge") && (
        <label className="below">
          处理剧集
          <select
            value={episode?.id || ""}
            onChange={(e) => selectEpisode(e.target.value)}
          >
            <option value="" disabled>
              请选择剧集
            </option>
            {project.document.episodes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <section
        className="stage-detail"
        aria-label={`${stages.find((s) => s.id === stage)?.name}控制`}
      >
        {stage === "script" && (
          <>
            <h3>01 · 剧本生产</h3>
            <p>
              依据作品创意、风格和集数，生成角色、分集剧本与分镜。当前已有{" "}
              {project.document.episodes.length} 集、{shots.length} 个镜头。
            </p>
            <p className="muted-text">
              重新生产会替换剧本、角色和分镜；存在锁定镜头时需先解锁。
            </p>
            <div className="button-row">
              <button
                className="primary"
                disabled={blocked || shots.some((s) => s.locked)}
                onClick={generateScript}
              >
                启动剧本生产
              </button>
              <button className="secondary" onClick={() => navigate("story")}>
                编辑创意与剧本
              </button>
              <button
                className="text-button"
                disabled={!shots.length}
                onClick={() => setStage("judge")}
              >
                下一步：剧本 Judge →
              </button>
            </div>
          </>
        )}
        {stage === "judge" && (
          <>
            <h3>02 · 剧本 Judge</h3>
            <p>
              检查当前项目的全部剧集。
              {mode === "demo"
                ? "演示模式只做规则检查，不产生 AI 评分。"
                : "使用独立剧本 Judge；未单独配置时使用文本模型。"}
            </p>
            <div className="button-row">
              <button
                className="primary"
                disabled={blocked || !shots.length}
                onClick={() => submit("judge")}
              >
                启动剧本评审
              </button>
              <button
                className="secondary"
                disabled={blocked || !currentReview || approved}
                onClick={approve}
              >
                {approved ? "当前剧本已确认" : "确认当前剧本"}
              </button>
              <button className="text-button" onClick={() => navigate("story")}>
                修改剧本
              </button>
            </div>
            <p className="muted-text">
              确认表示你已阅读评审意见并决定继续制作；剧本修改由你完成，当前不会自动改写故事。
            </p>
            {review && !currentReview && (
              <p className="console-notice">
                下方是历史评审，当前剧本需要重新评审。
              </p>
            )}
            {review?.result && (
              <div className="console-review">
                <strong>
                  {review.result.source === "rules"
                    ? "规则检查（无 AI 评分）"
                    : `剧本评分 ${review.result.score} / 100`}{" "}
                  · {review.result.passed ? "未发现阻断项" : "建议修改"}
                </strong>
                <p>{review.result.summary}</p>
                {review.result.findings?.map((f, i) => (
                  <div className="finding" key={i}>
                    <span>{f.severity === "error" ? "问题" : "建议"}</span>
                    <div>
                      <p>{f.message}</p>
                      <small>{f.suggestion}</small>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {approved && (
              <button
                className="text-button"
                onClick={() => setStage("production")}
              >
                下一步：视频生产 →
              </button>
            )}
          </>
        )}
        {stage === "production" && (
          <>
            <h3>03 · 视频生产</h3>
            <div className="form-grid">
              <label>
                制作步骤
                <select
                  value={operation}
                  onChange={(e) => setOperation(e.target.value as JobKind)}
                >
                  <option value="videos">生成镜头视频</option>
                  <option value="images">生成分镜画面</option>
                  <option value="voice">生成旁白配音</option>
                  <option value="render">合成本集成片</option>
                </select>
              </label>
              <label>
                镜头范围
                <select
                  value={operation === "render" ? "" : shotId}
                  disabled={operation === "render"}
                  onChange={(e) => setShotId(e.target.value)}
                >
                  <option value="">本集全部镜头</option>
                  {episode?.shots.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                      {s.locked ? "（锁定）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {operation !== "render" && (
              <label className="console-toggle">
                <input
                  type="checkbox"
                  checked={overwrite}
                  onChange={(e) => setOverwrite(e.target.checked)}
                />
                重新生成已有素材（默认仅补齐缺失素材）
              </label>
            )}
            <p className="muted-text">{productionReason}</p>
            <div className="button-row">
              <button
                className="primary"
                disabled={blocked || !canProduce}
                onClick={() => {
                  if (
                    overwrite &&
                    operation !== "render" &&
                    !confirm("将替换所选范围中未锁定镜头的当前素材，确定重做？")
                  )
                    return;
                  submit(operation, {
                    episode_id: episode?.id,
                    shot_id: operation === "render" ? null : shotId || null,
                    overwrite: operation === "render" ? false : overwrite,
                  });
                }}
              >
                执行制作步骤
              </button>
              <button className="secondary" onClick={() => navigate("shots")}>
                编辑分镜与素材
              </button>
              <button
                className="text-button"
                onClick={() => setStage("video_judge")}
              >
                前往视频 Judge →
              </button>
            </div>
          </>
        )}
        {stage === "video_judge" && (
          <>
            <h3>04 · 视频 Judge</h3>
            <p>
              实际视频与剧本一起评审。检查结果包含问题时间段和修改建议；本地
              Qwen-VL 仅检查视觉。
            </p>
            <div className="form-grid">
              <label>
                评审范围
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="episode">本集全部镜头</option>
                  <option value="shot">单个镜头</option>
                  <option value="final">整集成片</option>
                </select>
              </label>
              {scope === "shot" && (
                <label>
                  评审镜头
                  <select
                    value={shotId}
                    onChange={(e) => setShotId(e.target.value)}
                  >
                    <option value="">请选择镜头</option>
                    {episode?.shots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                        {s.video ? "" : "（缺视频）"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {scope === "final" && (
                <label>
                  选择成片
                  <select
                    value={exportJob?.id || ""}
                    onChange={(e) => setExportId(e.target.value)}
                  >
                    <option value="" disabled>
                      尚无成片
                    </option>
                    {exports.map((j) => (
                      <option value={j.id} key={j.id}>
                        {new Date(j.created_at).toLocaleString("zh-CN")}
                        {j.result?.revision !== project.revision
                          ? "（旧版本）"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label className="below">
              评审调用上限
              <input
                type="number"
                min={1}
                max={100}
                value={calls}
                onChange={(e) => setCalls(Number(e.target.value))}
              />
            </label>
            <p className="muted-text">
              {mode !== "live"
                ? "请先配置本地或 Gemini 视频模型并切换真实模式。"
                : scope === "final"
                  ? "只能复核当前项目版本的成片；旧版本请先重新合成。"
                  : "需补齐所选镜头的视频；镜头数量不能超过调用上限。"}
            </p>
            <button
              className="primary"
              disabled={blocked || !canReviewVideo}
              onClick={() =>
                submit(
                  "video_judge",
                  scope === "final"
                    ? {
                        episode_id: episode?.id,
                        export_id: exportJob?.result?.video?.replace(
                          ".mp4",
                          "",
                        ),
                        max_calls: calls,
                      }
                    : {
                        episode_id: episode?.id,
                        shot_id: scope === "shot" ? shotId : null,
                        max_calls: calls,
                      },
                )
              }
            >
              启动视频评审
            </button>
          </>
        )}
      </section>
      {(stage === "production" || stage === "video_judge") && (
        <details className="loop-settings">
          <summary>
            <Workflow size={17} />
            自动执行视频生产与返修
          </summary>
          <p>
            从已确认剧本出发，生成 → 逐镜评审 → 修订提示词 → 重生成 → 合成 →
            成片复核。成片不通过或判断不确定时停下，交给你处理。
          </p>
          <div className="form-grid">
            <label>
              每镜最多评审轮次
              <input
                type="number"
                min={1}
                max={4}
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
              />
            </label>
            <label>
              本次模型调用上限
              <input
                type="number"
                min={1}
                max={100}
                value={calls}
                onChange={(e) => setCalls(Number(e.target.value))}
              />
            </label>
          </div>
          <p className="muted-text">
            仅处理所选剧集。锁定镜头不会自动重做；调用次数不等于金额预算。
          </p>
          <button
            className="primary"
            disabled={
              blocked ||
              !approved ||
              !episode?.shots.length ||
              mode !== "live" ||
              !limitsValid
            }
            onClick={() => {
              setStage("production");
              submit("pipeline", {
                episode_id: episode?.id,
                max_rounds: rounds,
                max_calls: calls,
              });
            }}
          >
            启动自动制作与返修
          </button>
        </details>
      )}
      {(stage === "production" || stage === "video_judge") && (
        <PromptTuner
          project={project}
          episode={episode}
          jobs={jobs}
          busy={busy}
          dirty={dirty}
          mode={mode}
          onSaved={onSaved}
          runJob={runJob}
          notify={notify}
        />
      )}
      <section className="console-history" aria-label="阶段运行记录">
        <h3>阶段运行记录</h3>
        {!scopedJobs.length ? (
          <p className="muted-text">这个阶段尚无任务记录。</p>
        ) : (
          <>
            <label>
              选择运行记录
              <select
                value={selectedJob?.id || ""}
                onChange={(e) => setSelectedJobId(e.target.value)}
              >
                {scopedJobs.map((j) => (
                  <option value={j.id} key={j.id}>
                    {jobNames[j.kind]} · {statusNames[j.status]} ·{" "}
                    {new Date(j.created_at).toLocaleString("zh-CN")}
                  </option>
                ))}
              </select>
            </label>
            {selectedJob && (
              <div className="run-item">
                <strong>
                  {jobNames[selectedJob.kind]} ·{" "}
                  {statusNames[selectedJob.status]}
                </strong>
                <p>{selectedJob.message}</p>
                <progress
                  aria-label="阶段任务进度"
                  value={selectedJob.progress}
                  max={100}
                />
                <span> {selectedJob.progress}%</span>
                {oldVideoReport && (
                  <p className="console-notice">
                    此评审来自历史版本，不能作为当前版本的通过依据。
                  </p>
                )}
                {selectedJob.result?.video && (
                  <a
                    className="secondary"
                    href={media(project.id, selectedJob.result.video)}
                    download
                  >
                    下载本次成片
                  </a>
                )}
                {selectedJob.result?.reports?.map((item, i) => (
                  <VideoReport
                    key={i}
                    report={item.review}
                    video={media(project.id, item.video)}
                  />
                ))}
                {selectedJob.result?.final_review && (
                  <VideoReport
                    report={selectedJob.result.final_review}
                    video={media(project.id, selectedJob.result.video)}
                  />
                )}
              </div>
            )}
            {events.map((event) => (
              <details className="event-record" key={event.seq}>
                <summary>
                  {event.kind} ·{" "}
                  {new Date(event.created_at).toLocaleTimeString("zh-CN")}
                </summary>
                <pre>{JSON.stringify(event.data, null, 2)}</pre>
              </details>
            ))}
          </>
        )}
      </section>
    </div>
  );
}

function VideoReport({
  report,
  video,
}: {
  report: VideoReview;
  video: string;
}) {
  return (
    <div className="video-report">
      <video controls preload="metadata" src={video} />
      <div>
        <h3>
          {report.score} / 100 ·{" "}
          {report.passed
            ? "通过"
            : report.verdict === "uncertain"
              ? "需人工判断"
              : "需修改"}
        </h3>
        <p>{report.summary}</p>
        <small>
          {report.source} ·{" "}
          {report.audio_reviewed ? "包含音轨评审" : "仅视觉，音频未评审"}
        </small>
        {report.issues.map((issue, i) => (
          <div className="finding" key={i}>
            <span>
              {issue.start.toFixed(1)}–{issue.end.toFixed(1)}s
            </span>
            <div>
              <p>{issue.evidence}</p>
              <small>{issue.suggestion}</small>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
