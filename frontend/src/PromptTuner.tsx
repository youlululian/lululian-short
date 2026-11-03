import { useEffect, useState } from "react";
import { Bot, ThumbsDown, ThumbsUp } from "lucide-react";
import { api, post } from "./api";
import { Episode, Job, JobKind, Project, media } from "./types";

type Feedback = {
  id: string;
  shot_id: string;
  revision: number;
  rating: "satisfied" | "unsatisfied";
  notes: string;
  edited_prompt: string;
  created_at: string;
  snapshot: { video: string; prompt: string };
  proposal: {
    video_prompt: string;
    change_summary: string;
    feedback_summary?: {
      retain_rules: string[];
      avoid_rules: string[];
      optimization_rules: string[];
    };
    annotations?: {
      history_requested: number;
      history_used: number;
      total: number;
      passed: number;
      failed: number;
    };
  } | null;
  applied_source: string | null;
  applied_revision: number | null;
};

export function PromptTuner({
  project,
  episode,
  jobs,
  busy,
  dirty,
  mode,
  onSaved,
  runJob,
  notify,
}: {
  project: Project;
  episode?: Episode;
  jobs: Job[];
  busy: boolean;
  dirty: boolean;
  mode: string;
  onSaved: (p: Project) => void;
  runJob: (kind: JobKind, extra?: object) => Promise<void>;
  notify: (s: string) => void;
}) {
  const [shotId, setShotId] = useState("");
  const [edited, setEdited] = useState("");
  const [notes, setNotes] = useState("");
  const [optimizationMode, setOptimizationMode] = useState("agent");
  const [feedbackLimit, setFeedbackLimit] = useState(8);
  const validLimit =
    Number.isInteger(feedbackLimit) &&
    feedbackLimit >= 0 &&
    feedbackLimit <= 50;
  const [records, setRecords] = useState<Feedback[]>([]);
  const [pending, setPending] = useState(false);
  const shot = episode?.shots.find((s) => s.id === shotId) || episode?.shots[0];
  const jobVersions = jobs
    .filter((j) => j.kind === "prompt_tune")
    .map((j) => `${j.id}:${j.status}`)
    .join(",");
  useEffect(() => {
    setEdited(
      shot
        ? shot.video_prompt ||
            `风格：${project.document.style}。场景：${shot.scene}。角色：${project.document.characters
              .filter((c) => shot.characters.includes(c.id))
              .map((c) => `${c.name}：${c.appearance}`)
              .join(
                "；",
              )}。画面：${shot.visual}。运镜：${shot.camera}。对白/旁白：${shot.narration}。`
        : "",
    );
    setNotes("");
  }, [shot?.id, shot?.video_prompt, shot?.video]);
  useEffect(() => {
    let stopped = false;
    void api<Feedback[]>(`/projects/${project.id}/feedback`)
      .then((rows) => {
        if (!stopped) setRecords(rows);
      })
      .catch((e) => {
        if (!stopped) notify(e.message);
      });
    return () => {
      stopped = true;
    };
  }, [project.id, project.revision, jobVersions, notify]);
  const reload = async () =>
    setRecords(await api<Feedback[]>(`/projects/${project.id}/feedback`));
  const act = async (fn: () => Promise<void>) => {
    setPending(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const blocked = busy || dirty || pending;
  const approved = project.document.approved_hash === project.content_hash;
  const canTune = mode === "live" && approved && !shot?.locked;
  const autoTune = canTune && optimizationMode === "agent";
  const saveFeedback = (rating: Feedback["rating"]) =>
    void act(async () => {
      if (!shot) return;
      const row = await api<Feedback>(
        `/projects/${project.id}/feedback`,
        post({
          revision: project.revision,
          shot_id: shot.id,
          rating,
          notes,
          edited_prompt: edited,
        }),
      );
      await reload();
      if (rating === "unsatisfied" && autoTune)
        await runJob("prompt_tune", {
          feedback_id: row.id,
          feedback_limit: feedbackLimit,
          shot_id: shot.id,
          episode_id: episode?.id,
        });
      else notify("人工反馈已保存；可选择采用人工版本");
    });
  const apply = (record: Feedback, source: "human" | "agent") =>
    void act(async () => {
      const saved = await api<Project>(
        `/projects/${project.id}/feedback/${record.id}/apply`,
        post({ revision: project.revision, source }),
      );
      onSaved(saved);
      await reload();
      notify("已采用提示词；原视频仍保留，可点击重生成查看效果");
    });
  return (
    <section className="prompt-tuner" aria-label="人工反馈调优">
      <div className="section-heading">
        <div>
          <h3>
            <Bot size={18} />
            人工反馈 → 提示词调优
          </h3>
          <p>看片、手动修改、表达满意度，让下一轮提示词依据你的反馈改进。</p>
        </div>
      </div>
      <label>
        反馈镜头
        <select
          value={shot?.id || ""}
          onChange={(e) => setShotId(e.target.value)}
        >
          <option value="" disabled>
            暂无镜头
          </option>
          {episode?.shots.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
              {s.video ? "" : "（待生成视频）"}
            </option>
          ))}
        </select>
      </label>
      {shot?.video && (
        <video
          className="feedback-preview"
          controls
          preload="metadata"
          src={media(project.id, shot.video)}
        />
      )}
      <label className="below">
        人工优化后的生成提示词
        <textarea
          rows={5}
          maxLength={8000}
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
        />
      </label>
      <label className="below">
        具体反馈
        <textarea
          rows={2}
          maxLength={3000}
          placeholder="例如：保留人物造型，把拿信动作放慢，镜头不要切换。"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="form-grid below">
        <label>
          优化方式
          <select
            value={optimizationMode}
            onChange={(e) => setOptimizationMode(e.target.value)}
          >
            <option value="manual">人工修改，手动采用</option>
            <option value="agent">Agent 总结标注后调优</option>
          </select>
        </label>
        <label>
          使用历史人工标注数量
          <input
            type="number"
            min={0}
            max={50}
            value={feedbackLimit}
            disabled={optimizationMode === "manual" || blocked}
            onChange={(e) => setFeedbackLimit(Number(e.target.value))}
          />
        </label>
      </div>
      <p className="muted-text small">
        满意记为通过，不满意记为不通过。当前反馈始终使用，另取同一镜头、同一剧本内容下最近{" "}
        {feedbackLimit} 条历史标注，不足按实际数量；填 0 表示仅使用当前反馈。
      </p>
      <div className="button-row below">
        <button
          className="secondary"
          disabled={blocked || !shot?.video || edited.trim().length < 5}
          onClick={() => saveFeedback("satisfied")}
        >
          <ThumbsUp size={15} />
          满意，记录偏好
        </button>
        <button
          className="primary"
          disabled={
            blocked ||
            !shot?.video ||
            edited.trim().length < 5 ||
            (autoTune && !validLimit)
          }
          onClick={() => saveFeedback("unsatisfied")}
        >
          <ThumbsDown size={15} />
          {autoTune ? "不满意，提交并调优" : "不满意，记录反馈"}
        </button>
      </div>
      <p className="muted-text small">
        {!shot?.video
          ? "先生成或上传镜头视频，再对实际结果反馈。"
          : !canTune
            ? "自动调优需要真实文本模型、已确认剧本及未锁定镜头。"
            : "每条反馈最多调优 3 次，每轮最多两次文本模型调用：先总结人工标注，再生成提示词；提案由你决定是否采用。"}{" "}
        满意反馈用于后续提示词优化参考，不会直接训练模型。
      </p>
      {records
        .filter((f) => f.shot_id === shot?.id)
        .slice(0, 8)
        .map((record) => {
          const current =
            record.revision === project.revision && !record.applied_source;
          const attempts = jobs.filter(
            (j) =>
              j.kind === "prompt_tune" && j.payload.feedback_id === record.id,
          );
          const latest = attempts[0];
          return (
            <article className="feedback-record" key={record.id}>
              <div className="section-heading">
                <strong>
                  {record.rating === "satisfied" ? "满意反馈" : "待改进反馈"} ·{" "}
                  {new Date(record.created_at).toLocaleString("zh-CN")}
                </strong>
                <span className="tiny-label">
                  {record.applied_source
                    ? "已采用"
                    : current
                      ? "当前版本"
                      : "历史版本"}
                </span>
              </div>
              <p>{record.notes || "未填写额外说明"}</p>
              {record.proposal?.feedback_summary && (
                <div className="feedback-summary">
                  <h4>人工通过 / 不通过标注总结</h4>
                  {record.proposal.annotations && (
                    <p>
                      实际使用 {record.proposal.annotations.total} 条标注（历史{" "}
                      {record.proposal.annotations.history_used}/
                      {record.proposal.annotations.history_requested} 条 + 当前
                      1 条）；通过 {record.proposal.annotations.passed}{" "}
                      条，不通过 {record.proposal.annotations.failed} 条。
                    </p>
                  )}
                  {(
                    [
                      ["retain_rules", "通过样本：保留什么"],
                      ["avoid_rules", "不通过样本：避免什么"],
                      ["optimization_rules", "下一轮：如何优化"],
                    ] as const
                  ).map(([key, title]) => (
                    <div key={key}>
                      <strong>{title}</strong>
                      <ul>
                        {record.proposal!.feedback_summary![key].length ? (
                          record.proposal!.feedback_summary![key].map(
                            (rule, i) => <li key={i}>{rule}</li>,
                          )
                        ) : (
                          <li>暂无足够标注依据。</li>
                        )}
                      </ul>
                    </div>
                  ))}
                  <small>
                    以上为 Agent 对人工标注的归纳，请结合实际视频核对。
                  </small>
                </div>
              )}
              <div className="prompt-comparison">
                <div>
                  <h4>人工版本</h4>
                  <pre>{record.edited_prompt}</pre>
                </div>
                <div>
                  <h4>Agent 提案</h4>
                  {record.proposal ? (
                    <>
                      <pre>{record.proposal.video_prompt}</pre>
                      <p>{record.proposal.change_summary}</p>
                    </>
                  ) : (
                    <p>{latest ? latest.message : "尚无提案"}</p>
                  )}
                </div>
              </div>
              {latest?.status === "failed" && (
                <p className="console-notice">{latest.message}</p>
              )}
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={blocked || !current || !approved || shot?.locked}
                  onClick={() => apply(record, "human")}
                >
                  采用人工版本
                </button>
                <button
                  className="secondary"
                  disabled={
                    blocked ||
                    !current ||
                    !record.proposal ||
                    !approved ||
                    shot?.locked
                  }
                  onClick={() => apply(record, "agent")}
                >
                  采用 Agent 提案
                </button>
                <button
                  className="text-button"
                  disabled={
                    blocked ||
                    !current ||
                    !canTune ||
                    optimizationMode !== "agent" ||
                    !validLimit ||
                    attempts.length >= 3
                  }
                  onClick={() =>
                    void runJob("prompt_tune", {
                      feedback_id: record.id,
                      feedback_limit: feedbackLimit,
                      shot_id: shot?.id,
                      episode_id: episode?.id,
                    })
                  }
                >
                  {attempts.length ? "再次调优" : "根据标注生成提案"}（
                  {attempts.length}/3）
                </button>
                {record.applied_revision === project.revision && (
                  <button
                    className="primary"
                    disabled={blocked || !canTune}
                    onClick={() =>
                      void runJob("videos", {
                        episode_id: episode?.id,
                        shot_id: shot?.id,
                        overwrite: true,
                      })
                    }
                  >
                    用当前提示词重生成
                  </button>
                )}
              </div>
            </article>
          );
        })}
    </section>
  );
}
