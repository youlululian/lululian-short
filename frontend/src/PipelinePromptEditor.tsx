import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { api } from "./api";
import { PipelinePrompts, Project } from "./types";

type PromptKey = keyof PipelinePrompts;
type History = {
  revision: number;
  created_at: string;
  prompts: PipelinePrompts;
};
const stages: { key: PromptKey; name: string }[] = [
  { key: "script", name: "剧本生产" },
  { key: "script_judge", name: "剧本 Judge" },
  { key: "image", name: "分镜画面生成" },
  { key: "video", name: "视频生成" },
  { key: "video_judge", name: "视频 Judge" },
  { key: "feedback_summary", name: "人工标注总结" },
  { key: "prompt_tune", name: "人工反馈提示词调优" },
  { key: "video_repair", name: "Judge 自动返修" },
];
export function PipelinePromptEditor({
  project,
  busy,
  onChange,
  notify,
}: {
  project: Project;
  busy: boolean;
  onChange: (prompts: PipelinePrompts) => void;
  notify: (message: string) => void;
}) {
  const [defaults, setDefaults] = useState<PipelinePrompts | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [selected, setSelected] = useState<PromptKey>("script");
  const [revision, setRevision] = useState("");
  useEffect(() => {
    let disposed = false;
    Promise.all([
      api<PipelinePrompts>("/prompt-defaults"),
      api<History[]>(`/projects/${project.id}/prompt-history`),
    ])
      .then(([values, records]) => {
        if (!disposed) {
          setDefaults(values);
          setHistory(records);
        }
      })
      .catch((e) => {
        if (!disposed) notify(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [project.id, project.revision, notify]);
  const prompts = project.document.pipeline_prompts || defaults;
  return (
    <details className="pipeline-prompt-editor">
      <summary>
        <SlidersHorizontal size={17} />
        流水线提示词 · 人工编辑
      </summary>
      <p>
        修改当前作品各阶段的创作与评审要求。剧本、人物和分镜由系统自动附加，不需要填写占位符。单镜头提示词仍可在分镜或反馈区域单独编辑。
      </p>
      <fieldset disabled={busy || !prompts} className="editor-fieldset">
        <label>
          编辑提示词阶段
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value as PromptKey)}
          >
            {stages.map((stage) => (
              <option key={stage.key} value={stage.key}>
                {stage.name}
              </option>
            ))}
          </select>
        </label>
        <label className="below">
          阶段制作要求
          <textarea
            rows={7}
            maxLength={4000}
            value={prompts?.[selected] || ""}
            onChange={(e) =>
              prompts && onChange({ ...prompts, [selected]: e.target.value })
            }
          />
        </label>
        <div className="section-heading below">
          <small>{prompts?.[selected]?.length || 0} / 4000 字</small>
          <button
            className="secondary"
            disabled={!defaults}
            onClick={() => {
              if (defaults && prompts)
                onChange({ ...prompts, [selected]: defaults[selected] });
            }}
          >
            恢复本阶段默认
          </button>
        </div>
        <p className="console-notice">
          编辑后点击工作台顶部「保存修改」。提示词改变后需要重新评审并确认剧本；已完成的任务保留原提示词记录。固定输出格式、调用上限和
          Agent 权限不能通过这里修改。
        </p>
        <div className="form-grid">
          <label>
            历史提示词版本
            <select
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
            >
              <option value="">选择历史版本</option>
              {history.map((row) => (
                <option value={row.revision} key={row.revision}>
                  版本 {row.revision} ·{" "}
                  {new Date(row.created_at).toLocaleString("zh-CN")}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <button
              className="secondary"
              disabled={!revision}
              onClick={() => {
                const row = history.find(
                  (item) => String(item.revision) === revision,
                );
                if (row) {
                  onChange(row.prompts);
                  notify("已载入历史提示词，保存后生效");
                }
              }}
            >
              载入整套历史提示词
            </button>
          </div>
        </div>
      </fieldset>
    </details>
  );
}
