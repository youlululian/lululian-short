import { useState } from "react";
import { Film, ShieldCheck, Workflow } from "lucide-react";
import { api } from "./api";
import { Episode, Job, JobKind, Project, VideoReview, media } from "./types";

type Event = {
  seq: number;
  kind: string;
  created_at: string;
  data: Record<string, unknown>;
};

export function PipelinePanel({
  project,
  jobs,
  episode,
  busy,
  mode,
  runJob,
  notify,
}: {
  project: Project;
  jobs: Job[];
  episode?: Episode;
  busy: boolean;
  mode: string;
  runJob: (kind: JobKind, extra?: object) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [rounds, setRounds] = useState(2);
  const [calls, setCalls] = useState(20);
  const [events, setEvents] = useState<Event[]>([]);
  const review = jobs.find(
    (j) => j.kind === "video_judge" && j.status === "succeeded",
  );
  const runs = jobs.filter((j) => j.kind === "pipeline");
  const loadEvents = async (id: string) => {
    try {
      setEvents(
        await api<Event[]>(`/projects/${project.id}/jobs/${id}/events`),
      );
    } catch (e) {
      notify((e as Error).message);
    }
  };
  return (
    <section className="pipeline-panel">
      <div className="section-heading below">
        <div>
          <h2>视频 Judge · 剧本一致性</h2>
          <p>
            将实际视频与分镜一起送入本地 Qwen-VL 或 Gemini，返回问题时间段。
          </p>
        </div>
      </div>
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy || !episode || mode === "demo"}
          onClick={() => void runJob("videos", { episode_id: episode?.id })}
        >
          <Film size={15} />
          生成本集缺失视频
        </button>
        <button
          className="secondary"
          disabled={busy || !episode || mode === "demo"}
          onClick={() =>
            void runJob("video_judge", {
              episode_id: episode?.id,
              max_calls: calls,
            })
          }
        >
          <ShieldCheck size={15} />
          评审本集镜头
        </button>
      </div>
      {review?.result?.reports?.map((item, index) => (
        <VideoReport
          key={index}
          report={item.review}
          video={media(project.id, item.video)}
        />
      ))}
      <div className="section-heading below">
        <div>
          <h2>自动制作与返修</h2>
          <p>
            需要已确认的剧本。生成 → 逐镜评审 → 修订提示词 → 限次重生成 → 合成 →
            成片复核。
          </p>
        </div>
      </div>
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
      <p className="muted-text small">
        本次处理：{episode?.title || "尚无剧集"}
        。锁定镜头不会自动重做；不确定判断会停下等待人工处理。调用次数并不等于金额预算。
      </p>
      <button
        className="primary below"
        disabled={busy || !episode || mode === "demo"}
        onClick={() => {
          if (
            confirm(
              `启动「${episode?.title}」自动流水线？最多 ${calls} 次模型调用，每镜最多 ${rounds} 轮。云端调用会产生服务商费用。`,
            )
          )
            void runJob("pipeline", {
              episode_id: episode?.id,
              max_rounds: rounds,
              max_calls: calls,
            });
        }}
      >
        <Workflow size={16} />
        启动制作流水线
      </button>
      {runs.map((j) => (
        <div className="run-item" key={j.id}>
          <span>
            {new Date(j.created_at).toLocaleString("zh-CN")} · {j.status}
          </span>
          <button className="text-button" onClick={() => void loadEvents(j.id)}>
            查看每轮记录
          </button>
          <p>{j.message}</p>
        </div>
      ))}
      {events.map((event) => (
        <details className="event-record" key={event.seq}>
          <summary>
            {event.kind} ·{" "}
            {new Date(event.created_at).toLocaleTimeString("zh-CN")}
          </summary>
          <pre>{JSON.stringify(event.data, null, 2)}</pre>
        </details>
      ))}
    </section>
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
          {report.verdict === "pass"
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
