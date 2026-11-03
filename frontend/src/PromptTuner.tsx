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
  proposal: { video_prompt: string; change_summary: string } | null;
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
      if (rating === "unsatisfied" && canTune)
        await runJob("prompt_tune", {
          feedback_id: row.id,
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
          disabled={blocked || !shot?.video || edited.trim().length < 5}
          onClick={() => saveFeedback("unsatisfied")}
        >
          <ThumbsDown size={15} />
          {canTune ? "不满意，提交并调优" : "不满意，记录反馈"}
        </button>
      </div>
      <p className="muted-text small">
        {!shot?.video
          ? "先生成或上传镜头视频，再对实际结果反馈。"
          : !canTune
            ? "自动调优需要真实文本模型、已确认剧本及未锁定镜头。"
            : "每条反馈最多调优 3 次，每次调用一次文本模型；提案由你决定是否采用。"}{" "}
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
                    blocked || !current || !canTune || attempts.length >= 3
                  }
                  onClick={() =>
                    void runJob("prompt_tune", {
                      feedback_id: record.id,
                      shot_id: shot?.id,
                      episode_id: episode?.id,
                    })
                  }
                >
                  再次调优（{attempts.length}/3）
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
