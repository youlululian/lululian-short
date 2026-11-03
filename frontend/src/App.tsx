import { useCallback, useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  Clapperboard,
  Clock3,
  Download,
  Film,
  FolderOpen,
  Image,
  LayoutGrid,
  Loader2,
  LockKeyhole,
  Mic,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UnlockKeyhole,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { api, post } from "./api";
import { PipelinePanel } from "./PipelinePanel";
import {
  Character,
  Document,
  Episode,
  Job,
  JobKind,
  Project,
  ProjectInput,
  Settings,
  Shot,
  jobNames,
  media,
  uid,
} from "./types";

const sample: ProjectInput = {
  title: "明日来信",
  premise:
    "一家即将关门的旧书店里，年轻店主收到一封来自明天的信。她每改变一个选择，信里的内容就会改变。",
  genre: "悬疑",
  style: "电影感漫画",
  aspect: "9:16",
  episode_count: 1,
};
type Tab = "story" | "characters" | "shots" | "review" | "exports";
type Notify = (message: string) => void;

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [view, setView] = useState<"projects" | "settings">("projects");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const notify = useCallback<Notify>((message) => setToast(message), []);
  const refresh = useCallback(async () => {
    try {
      const [list, config] = await Promise.all([
        api<Project[]>("/projects"),
        api<Settings>("/settings"),
      ]);
      setProjects(list);
      setSettings(config);
      setConnectionError("");
    } catch (e) {
      setConnectionError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 6000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    const poll = async () => {
      try {
        const list = await api<Job[]>(`/projects/${selected.id}/jobs`);
        if (disposed) return;
        setJobs(list);
        if (!list.some((j) => ["queued", "running"].includes(j.status))) {
          const latest = await api<Project>(`/projects/${selected.id}`);
          if (!disposed)
            setSelected((current) =>
              current?.id === latest.id && current.revision !== latest.revision
                ? latest
                : current,
            );
        }
      } catch (e) {
        if (!disposed) notify((e as Error).message);
      }
    };
    void poll();
    const interval = setInterval(poll, 1800);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [selected?.id, notify]);
  const openProject = (project: Project) => {
    setSelected(project);
    setJobs([]);
    setView("projects");
  };
  const leave = () => {
    setSelected(null);
    setJobs([]);
    setView("projects");
    void refresh();
  };
  const saveProject = (project: Project) => {
    setSelected(project);
    setProjects((items) =>
      items.map((p) => (p.id === project.id ? project : p)),
    );
  };
  const requestJob = async (pid: string, body: object) => {
    await api(`/projects/${pid}/jobs`, post(body));
    setJobs(await api<Job[]>(`/projects/${pid}/jobs`));
  };
  const filtered = projects.filter((p) =>
    `${p.document.title} ${p.document.genre}`.includes(search),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={leave}>
          <span className="brand-mark">
            <Clapperboard size={23} />
          </span>
          <span>
            鹿连<span className="brand-en">LULULIAN STUDIO</span>
          </span>
        </button>
        <div className="nav-caption">创作空间</div>
        <button
          className={`nav-item ${view === "projects" ? "active" : ""}`}
          onClick={leave}
        >
          <LayoutGrid size={18} />
          我的作品<span className="nav-count">{projects.length}</span>
        </button>
        <button
          className={`nav-item ${view === "settings" ? "active" : ""}`}
          onClick={() => {
            setView("settings");
            setSelected(null);
          }}
        >
          <Settings2 size={18} />
          模型设置
        </button>
        <div className="sidebar-note">
          <span className="tiny-label">FROM IDEA TO SCREEN</span>
          <p>
            让脑海里的故事，
            <br />
            有自己的画面。
          </p>
          <div className="note-line" />
        </div>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          <span>本地工作空间</span>
          <small>v0.1</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={14} />
            <span>
              {view === "settings"
                ? "模型设置"
                : selected?.document.title || "我的作品"}
            </span>
          </div>
          <div className="topbar-right">
            <span
              className={`mode-badge ${settings?.mode === "live" ? "live" : ""}`}
            >
              {settings?.mode === "live" ? "真实生成模式" : "演示模式"}
            </span>
            <span className="avatar">L</span>
          </div>
        </header>
        {connectionError ? (
          <div className="connection-error">
            <CircleHelp />
            <h2>暂时无法连接工作台</h2>
            <p>{connectionError}</p>
            <button className="primary" onClick={() => void refresh()}>
              重新连接
            </button>
          </div>
        ) : view === "settings" && settings ? (
          <SettingsView
            settings={settings}
            onSaved={setSettings}
            notify={notify}
          />
        ) : selected ? (
          <Workspace
            project={selected}
            jobs={jobs}
            mode={settings?.mode || "demo"}
            onSave={saveProject}
            onBack={leave}
            requestJob={requestJob}
            notify={notify}
          />
        ) : (
          <div className="dashboard">
            <div className="page-heading">
              <div>
                <span className="eyebrow">YOUR DIRECTOR'S DESK</span>
                <h1>
                  我的作品
                  <span className="heading-count">
                    {projects.length.toString().padStart(2, "0")}
                  </span>
                </h1>
                <p>从一个念头开始，拍出你的下一个故事。</p>
              </div>
              <button className="primary" onClick={() => setCreating(true)}>
                <Plus size={17} />
                新建短剧
              </button>
            </div>
            <section className="hero">
              <div className="hero-copy">
                <span className="hero-tag">
                  <span />
                  灵感，正在开场
                </span>
                <h2>
                  把一闪而过的灵感，
                  <br />
                  变成值得看完的故事。
                </h2>
                <p>剧本、角色、分镜与成片，在同一张创作桌上完成。</p>
                <button onClick={() => setCreating(true)}>
                  开启我的第一幕 <ArrowRight size={17} />
                </button>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="film-frame frame-back">
                  <span>SCENE / 02</span>
                  <div className="art-moon" />
                  <div className="art-hill" />
                </div>
                <div className="film-frame frame-front">
                  <span>TAKE / 01</span>
                  <div className="art-sun" />
                  <div className="art-mountain" />
                  <div className="art-person" />
                  <small>A STORY ONLY YOU CAN TELL</small>
                </div>
                <div className="floating-label">
                  <Clapperboard size={16} />
                  每一帧，都有故事。
                </div>
              </div>
            </section>
            <div className="collection-bar">
              <div className="collection-title">
                全部作品 <span>{projects.length}</span>
              </div>
              <label className="search">
                <Search size={16} />
                <input
                  placeholder="搜索作品或题材"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            {loading ? (
              <div className="empty">
                <Loader2 className="spin" />
                <p>正在打开工作空间…</p>
              </div>
            ) : (
              <div className="project-grid">
                {filtered.map((p, index) => {
                  const shots = p.document.episodes.flatMap((e) => e.shots);
                  const cover = shots.find((s) => s.image)?.image;
                  return (
                    <button
                      className="project-card"
                      key={p.id}
                      onClick={() => openProject(p)}
                    >
                      <div className={`project-cover tone-${index % 3}`}>
                        {cover ? (
                          <img
                            src={media(p.id, cover)}
                            alt={p.document.title}
                          />
                        ) : (
                          <>
                            <div className="cover-orbit" />
                            <span className="cover-title">
                              {p.document.title.slice(0, 10)}
                            </span>
                          </>
                        )}
                        <span className="cover-badge">{p.document.aspect}</span>
                        <span className="cover-open">
                          <ArrowRight size={20} />
                        </span>
                      </div>
                      <div className="project-info">
                        <div>
                          <h3>{p.document.title}</h3>
                          <MoreHorizontal size={18} />
                        </div>
                        <p>
                          {p.document.genre} <span>·</span>{" "}
                          {p.document.episodes.length} 集 <span>·</span>{" "}
                          {shots.length} 个镜头
                        </p>
                        <footer>
                          <span>
                            <span
                              className={`status-dot ${shots.length ? "" : "muted"}`}
                            />
                            {shots.length ? "制作中" : "创意草稿"}
                          </span>
                          <time>
                            {new Date(p.updated_at).toLocaleDateString("zh-CN")}
                          </time>
                        </footer>
                      </div>
                    </button>
                  );
                })}
                <button
                  className="new-project-card"
                  onClick={() => setCreating(true)}
                >
                  <span>
                    <Plus size={26} />
                  </span>
                  <h3>下一个故事，从这里开始</h3>
                  <p>写下一句话，开启新的创作</p>
                </button>
              </div>
            )}
            {!loading && search && !filtered.length && (
              <p className="muted-text">没有找到匹配的作品。</p>
            )}
            <footer className="page-footer">
              LULULIAN STUDIO <span>创作有序，想象无界。</span>
            </footer>
          </div>
        )}
      </main>
      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            const project = await api<Project>("/projects", post(input));
            setProjects([project, ...projects]);
            setCreating(false);
            openProject(project);
          }}
          notify={notify}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function CreateModal({
  onClose,
  onCreate,
  notify,
}: {
  onClose: () => void;
  onCreate: (input: ProjectInput) => Promise<void>;
  notify: Notify;
}) {
  const [input, setInput] = useState<ProjectInput>({
    ...sample,
    title: "",
    premise: "",
  });
  const [busy, setBusy] = useState(false);
  const update = (key: keyof ProjectInput, value: string | number) =>
    setInput({ ...input, [key]: value });
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
      >
        <div className="modal-heading">
          <span className="eyebrow">A NEW BEGINNING</span>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <h2 id="create-title">你的故事，叫什么？</h2>
        <p className="muted-text">先写下创意，细节留给创作时慢慢打磨。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onCreate(input);
            } catch (error) {
              notify((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            作品名称
            <input
              autoFocus
              required
              maxLength={100}
              placeholder="给你的短剧起个名字"
              value={input.title}
              onChange={(e) => update("title", e.target.value)}
            />
          </label>
          <label htmlFor="create-premise">
            <span className="label-row">
              故事创意
              <button
                type="button"
                className="text-button"
                aria-label="试试示例"
                onClick={() => setInput(sample)}
              >
                <Sparkles size={13} />
                试试示例
              </button>
            </span>
            <textarea
              id="create-premise"
              required
              minLength={5}
              maxLength={12000}
              rows={5}
              placeholder="谁遇到了什么事？他想要什么，又有什么阻碍？"
              value={input.premise}
              onChange={(e) => update("premise", e.target.value)}
            />
          </label>
          <div className="form-grid">
            <label>
              题材
              <select
                value={input.genre}
                onChange={(e) => update("genre", e.target.value)}
              >
                {["悬疑", "都市情感", "奇幻", "古装", "喜剧", "成长"].map(
                  (x) => (
                    <option key={x}>{x}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              视觉风格
              <select
                value={input.style}
                onChange={(e) => update("style", e.target.value)}
              >
                {[
                  "电影感漫画",
                  "写实电影",
                  "日系动画",
                  "水墨国风",
                  "温暖插画",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              画幅
              <select
                value={input.aspect}
                onChange={(e) => update("aspect", e.target.value)}
              >
                <option>9:16</option>
                <option>16:9</option>
                <option>1:1</option>
              </select>
            </label>
            <label>
              计划集数
              <input
                required
                type="number"
                min={1}
                max={12}
                value={input.episode_count}
                onChange={(e) =>
                  update("episode_count", Number(e.target.value))
                }
              />
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <ArrowRight size={16} />
              )}
              创建作品
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Workspace({
  project,
  jobs,
  mode,
  onSave,
  onBack,
  requestJob,
  notify,
}: {
  project: Project;
  jobs: Job[];
  mode: string;
  onSave: (p: Project) => void;
  onBack: () => void;
  requestJob: (pid: string, body: object) => Promise<void>;
  notify: Notify;
}) {
  const [document, setDocument] = useState<Document>(project.document);
  const [baseRevision, setBaseRevision] = useState(project.revision);
  const [tab, setTab] = useState<Tab>("story");
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setDocument(project.document);
    setBaseRevision(project.revision);
  }, [project.id, project.revision, dirty]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const active = jobs.find((j) => ["queued", "running"].includes(j.status));
  const busy = pending || !!active;
  const episode = document.episodes[episodeIndex] || document.episodes[0];
  const shots = document.episodes.flatMap((e) => e.shots);
  const edit = (next: Document) => {
    setDocument(next);
    setDirty(true);
  };
  const updateEpisode = (value: Episode) =>
    edit({
      ...document,
      episodes: document.episodes.map((e) => (e.id === value.id ? value : e)),
    });
  const updateShot = (value: Shot) =>
    edit({
      ...document,
      episodes: document.episodes.map((e) => ({
        ...e,
        shots: e.shots.map((s) => (s.id === value.id ? value : s)),
      })),
    });
  const save = async () => {
    if (!dirty) return project;
    const saved = await api<Project>(`/projects/${project.id}`, {
      method: "PUT",
      body: JSON.stringify({ revision: baseRevision, document }),
    });
    onSave(saved);
    setDirty(false);
    return saved;
  };
  const action = async (callback: () => Promise<unknown>) => {
    setPending(true);
    try {
      await callback();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const runJob = (kind: JobKind, extra = {}) =>
    action(async () => {
      await save();
      await requestJob(project.id, { kind, ...extra });
      if (kind === "judge" || kind === "asset_check") setTab("review");
      notify(`${jobNames[kind]}任务已提交`);
    });
  const generateScript = () => {
    if (
      shots.length &&
      !confirm("重新生成会替换现有剧本、角色和分镜。确定继续？")
    )
      return;
    void runJob("script", { overwrite: shots.length > 0 });
  };
  const latestReview = jobs.find(
    (j) => j.kind === "judge" && j.status === "succeeded",
  );
  const assetReview = jobs.find(
    (j) => j.kind === "asset_check" && j.status === "succeeded",
  );
  const selectedShot = shots.find((s) => s.id === editing);
  const moveShot = (index: number, delta: number) => {
    if (!episode) return;
    const next = [...episode.shots];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    updateEpisode({ ...episode, shots: next });
  };
  const exports = jobs.filter(
    (j) =>
      ["render", "pipeline"].includes(j.kind) &&
      j.status === "succeeded" &&
      j.result?.video,
  );
  const tabs: { id: Tab; name: string; icon: typeof Film }[] = [
    { id: "story", name: "故事剧本", icon: Clapperboard },
    { id: "characters", name: "角色设定", icon: Users },
    { id: "shots", name: "分镜工作台", icon: Film },
    { id: "review", name: "评审中心", icon: ShieldCheck },
    { id: "exports", name: "成片导出", icon: Download },
  ];
  return (
    <div className="workspace">
      <div className="workspace-heading">
        <div>
          <button
            className="back-link"
            onClick={() => {
              if (!dirty || confirm("有未保存的修改，确定离开？")) onBack();
            }}
          >
            <ArrowLeft size={14} />
            全部作品
          </button>
          <h1>{document.title}</h1>
          <p>
            {document.genre} <span> / </span> {document.style} <span> / </span>{" "}
            {document.aspect}
          </p>
        </div>
        <div className="button-row">
          <span className="save-state">
            {dirty ? "有未保存修改" : "已保存至本机"}
          </span>
          <button
            className="secondary"
            disabled={busy || !dirty}
            onClick={() =>
              void action(async () => {
                await save();
                notify("已保存");
              })
            }
          >
            <Save size={16} />
            保存修改
          </button>
          <button className="primary" disabled={busy} onClick={generateScript}>
            <WandSparkles size={16} />
            {shots.length ? "重新创作" : "生成剧本"}
          </button>
        </div>
      </div>
      {mode === "demo" && (
        <div className="notice">
          <Sparkles size={16} />
          <span>
            演示模式使用固定示例故事与占位画面，不调用
            AI，也不产生配音。真实创作请在模型设置中配置接口。
          </span>
        </div>
      )}
      <div className="pipeline">
        {["创意与剧本", "Judge 评审", "人工确认", "素材制作", "成片导出"].map(
          (name, i) => (
            <div key={name}>
              <span
                className={
                  i === 0 ||
                  (i === 1 && latestReview) ||
                  (i === 2 && document.approved_hash) ||
                  (i === 3 && shots.some((s) => s.image)) ||
                  (i === 4 && exports.length)
                    ? "done"
                    : ""
                }
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              {name}
              {i < 4 && <ChevronRight size={14} />}
            </div>
          ),
        )}
      </div>
      {active && (
        <div className="job-progress">
          <Loader2 size={17} className="spin" />
          <span>
            {jobNames[active.kind]} · {active.message || "排队中"}
          </span>
          <strong>{active.progress}%</strong>
          <div style={{ width: `${active.progress}%` }} />
        </div>
      )}
      <nav className="tabs">
        {tabs.map((t) => (
          <button
            className={tab === t.id ? "selected" : ""}
            key={t.id}
            onClick={() => setTab(t.id)}
          >
            <t.icon size={17} />
            {t.name}
          </button>
        ))}
      </nav>
      <div className="workspace-body">
        <section className="workspace-content">
          <fieldset disabled={busy} className="editor-fieldset">
            {tab === "story" && (
              <div className="story-editor">
                <div className="section-heading">
                  <h2>故事的起点</h2>
                  <span className="tiny-label">THE STORY</span>
                </div>
                <label>
                  作品名称
                  <input
                    value={document.title}
                    maxLength={100}
                    onChange={(e) =>
                      edit({ ...document, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  故事创意
                  <textarea
                    rows={4}
                    value={document.premise}
                    onChange={(e) =>
                      edit({ ...document, premise: e.target.value })
                    }
                  />
                </label>
                <div className="form-grid three">
                  <label>
                    视觉风格
                    <input
                      value={document.style}
                      onChange={(e) =>
                        edit({ ...document, style: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    画幅
                    <select
                      value={document.aspect}
                      onChange={(e) =>
                        edit({
                          ...document,
                          aspect: e.target.value as Document["aspect"],
                        })
                      }
                    >
                      <option>9:16</option>
                      <option>16:9</option>
                      <option>1:1</option>
                    </select>
                  </label>
                  <label>
                    计划集数
                    <input
                      type="number"
                      min={1}
                      max={12}
                      value={document.episode_count}
                      onChange={(e) =>
                        edit({
                          ...document,
                          episode_count: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </div>
                <div className="section-heading below">
                  <h2>分集剧本</h2>
                  <span>{document.episodes.length} 集</span>
                </div>
                {document.episodes.length === 0 ? (
                  <div className="inline-empty">
                    <Clapperboard size={32} />
                    <h3>第一幕还在等待开场</h3>
                    <p>完善创意后，点击右上角「生成剧本」。</p>
                  </div>
                ) : (
                  document.episodes.map((ep, i) => (
                    <article className="episode-editor" key={ep.id}>
                      <span className="episode-number">
                        EP. {String(i + 1).padStart(2, "0")}
                      </span>
                      <label>
                        集名
                        <input
                          value={ep.title}
                          onChange={(e) =>
                            updateEpisode({ ...ep, title: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        剧情梗概
                        <textarea
                          rows={3}
                          value={ep.synopsis}
                          onChange={(e) =>
                            updateEpisode({ ...ep, synopsis: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        结尾悬念
                        <input
                          value={ep.hook}
                          onChange={(e) =>
                            updateEpisode({ ...ep, hook: e.target.value })
                          }
                        />
                      </label>
                      <button
                        className="text-button"
                        onClick={() => {
                          setEpisodeIndex(i);
                          setTab("shots");
                        }}
                      >
                        查看 {ep.shots.length} 个分镜 <ArrowRight size={14} />
                      </button>
                    </article>
                  ))
                )}
              </div>
            )}
            {tab === "characters" && (
              <>
                <div className="section-heading">
                  <div>
                    <h2>角色档案</h2>
                    <p>固定外貌与动机，让角色在每一幕都保持一致。</p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() =>
                      edit({
                        ...document,
                        characters: [
                          ...document.characters,
                          {
                            id: uid(),
                            name: "新角色",
                            role: "配角",
                            appearance: "",
                            motivation: "",
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={15} />
                    添加角色
                  </button>
                </div>
                <div className="character-grid">
                  {document.characters.map((c, i) => {
                    const update = (value: Partial<Character>) =>
                      edit({
                        ...document,
                        characters: document.characters.map((x) =>
                          x.id === c.id ? { ...c, ...value } : x,
                        ),
                      });
                    return (
                      <article className="character-card" key={c.id}>
                        <div className={`character-avatar tone-${i % 3}`}>
                          {c.name[0]}
                        </div>
                        <div className="form-grid">
                          <label>
                            姓名
                            <input
                              value={c.name}
                              onChange={(e) => update({ name: e.target.value })}
                            />
                          </label>
                          <label>
                            定位
                            <input
                              value={c.role}
                              onChange={(e) => update({ role: e.target.value })}
                            />
                          </label>
                        </div>
                        <label>
                          外貌与服装
                          <textarea
                            rows={3}
                            value={c.appearance}
                            onChange={(e) =>
                              update({ appearance: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          人物动机
                          <textarea
                            rows={3}
                            value={c.motivation}
                            onChange={(e) =>
                              update({ motivation: e.target.value })
                            }
                          />
                        </label>
                        <button
                          className="text-button danger"
                          onClick={() => {
                            if (
                              confirm(`删除角色「${c.name}」并移除分镜引用？`)
                            )
                              edit({
                                ...document,
                                characters: document.characters.filter(
                                  (x) => x.id !== c.id,
                                ),
                                episodes: document.episodes.map((e) => ({
                                  ...e,
                                  shots: e.shots.map((s) => ({
                                    ...s,
                                    characters: s.characters.filter(
                                      (id) => id !== c.id,
                                    ),
                                  })),
                                })),
                              });
                          }}
                        >
                          删除角色
                        </button>
                      </article>
                    );
                  })}
                </div>
                {!document.characters.length && (
                  <div className="inline-empty">
                    <Users size={32} />
                    <p>生成剧本后会出现角色，也可以手动添加。</p>
                  </div>
                )}
              </>
            )}
            {tab === "shots" && (
              <>
                <div className="section-heading">
                  <div>
                    <h2>分镜工作台</h2>
                    <p>把故事拆成可以看见、听见的瞬间。</p>
                  </div>
                  <select
                    aria-label="选择剧集"
                    value={episode?.id || ""}
                    onChange={(e) =>
                      setEpisodeIndex(
                        document.episodes.findIndex(
                          (x) => x.id === e.target.value,
                        ),
                      )
                    }
                  >
                    {document.episodes.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="shot-toolbar">
                  <span>
                    {episode?.shots.length || 0} 个镜头 ·{" "}
                    {Math.round(
                      episode?.shots.reduce((a, s) => a + s.duration, 0) || 0,
                    )}{" "}
                    秒（脚本时长）
                  </span>
                  <div className="button-row">
                    <button
                      className="secondary"
                      disabled={!episode}
                      onClick={() =>
                        void runJob("images", { episode_id: episode?.id })
                      }
                    >
                      <Image size={15} />
                      生成缺失画面
                    </button>
                    <button
                      className="secondary"
                      disabled={!episode || mode === "demo"}
                      onClick={() =>
                        void runJob("voice", { episode_id: episode?.id })
                      }
                    >
                      <Mic size={15} />
                      生成缺失配音
                    </button>
                  </div>
                </div>
                <div className="shot-grid">
                  {episode?.shots.map((shot, index) => (
                    <article className="shot-card" key={shot.id}>
                      <button
                        className="shot-preview"
                        onClick={() => setEditing(shot.id)}
                      >
                        {shot.image ? (
                          <img
                            src={media(project.id, shot.image)}
                            alt={shot.title}
                          />
                        ) : (
                          <div className="shot-placeholder">
                            <Film size={30} />
                            <span>
                              {shot.video
                                ? "已上传视频 · 点击编辑"
                                : "等待画面"}
                            </span>
                          </div>
                        )}
                        <span className="shot-index">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="shot-duration">{shot.duration}s</span>
                        {shot.locked && (
                          <span className="shot-locked">
                            <LockKeyhole size={14} />
                          </span>
                        )}
                      </button>
                      <div className="shot-info">
                        <h3>{shot.title}</h3>
                        <p>{shot.scene}</p>
                        <div className="shot-dialogue">
                          {shot.narration || "暂无台词"}
                        </div>
                        <footer>
                          <div>
                            <span
                              className={
                                shot.image || shot.video ? "asset-ready" : ""
                              }
                            >
                              <Image size={13} />
                              画面
                            </span>
                            <span className={shot.audio ? "asset-ready" : ""}>
                              <Mic size={13} />
                              配音
                            </span>
                          </div>
                          <div>
                            <button
                              aria-label="上移镜头"
                              disabled={index === 0}
                              onClick={() => moveShot(index, -1)}
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              aria-label="下移镜头"
                              disabled={index === episode.shots.length - 1}
                              onClick={() => moveShot(index, 1)}
                            >
                              <ArrowDown size={14} />
                            </button>
                            <button
                              aria-label="编辑镜头"
                              onClick={() => setEditing(shot.id)}
                            >
                              <MoreHorizontal size={17} />
                            </button>
                          </div>
                        </footer>
                      </div>
                    </article>
                  ))}
                </div>
                {episode && (
                  <button
                    className="add-shot"
                    onClick={() =>
                      updateEpisode({
                        ...episode,
                        shots: [
                          ...episode.shots,
                          {
                            id: uid(),
                            title: "新镜头",
                            scene: "",
                            visual: "",
                            narration: "",
                            image_prompt: "",
                            camera: "push",
                            duration: 5,
                            characters: [],
                            locked: false,
                            image: null,
                            audio: null,
                            video: null,
                            video_prompt: "",
                            use_video_audio: true,
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={16} />
                    添加镜头
                  </button>
                )}
                {!episode && (
                  <div className="inline-empty">
                    <Film size={32} />
                    <p>先生成剧本，再开始设计分镜。</p>
                  </div>
                )}
              </>
            )}
            {tab === "review" && (
              <>
                <div className="section-heading">
                  <div>
                    <h2>评审与确认</h2>
                    <p>先看清问题，再把故事交给制作。</p>
                  </div>
                  <button
                    className="primary"
                    disabled={!shots.length}
                    onClick={() => void runJob("judge")}
                  >
                    <ShieldCheck size={16} />
                    运行剧本 Judge
                  </button>
                </div>
                <ReviewPanel
                  review={latestReview}
                  empty="尚未执行剧本评审。修改内容后，需要重新评审并确认。"
                />
                <div className="approval-bar">
                  <p>
                    确认代表你已阅读当前版本的评审意见，并决定继续制作。内容变更后需要重新确认。
                  </p>
                  <button
                    className="secondary"
                    disabled={!latestReview || dirty}
                    onClick={() =>
                      void action(async () => {
                        const p = await api<Project>(
                          `/projects/${project.id}/approve`,
                          post({}),
                        );
                        onSave(p);
                        notify("当前剧本版本已确认，可以生成素材");
                      })
                    }
                  >
                    <Check size={16} />
                    确认剧本，进入制作
                  </button>
                </div>
                <div className="section-heading below">
                  <div>
                    <h2>素材技术检查</h2>
                    <p>
                      检查文件是否存在、可解码。语义一致性请使用下面的视频
                      Judge；本地 Qwen-VL 不检查音轨。
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={!shots.length}
                    onClick={() => void runJob("asset_check")}
                  >
                    检查素材
                  </button>
                </div>
                <ReviewPanel
                  review={assetReview}
                  empty="尚未检查素材。技术检查通过不代表内容质量通过。"
                />
                <PipelinePanel
                  project={project}
                  jobs={jobs}
                  episode={episode}
                  busy={busy}
                  mode={mode}
                  runJob={runJob}
                  notify={notify}
                />
              </>
            )}
            {tab === "exports" && (
              <>
                <div className="section-heading">
                  <div>
                    <h2>把故事带到银幕上</h2>
                    <p>
                      合成 H.264 MP4，包含字幕、镜头运动与已上传或生成的配音。
                    </p>
                  </div>
                </div>
                <div className="export-config">
                  <Film size={32} />
                  <div>
                    <h3>{document.aspect} · 24 FPS</h3>
                    <p>
                      没有配音的镜头保留静音；默认保留视频原音轨，单独配音优先。优先使用镜头视频，其次使用图片。
                    </p>
                  </div>
                  <select
                    aria-label="导出剧集"
                    value={episode?.id || ""}
                    onChange={(e) =>
                      setEpisodeIndex(
                        document.episodes.findIndex(
                          (x) => x.id === e.target.value,
                        ),
                      )
                    }
                  >
                    {document.episodes.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                  <button
                    className="primary"
                    disabled={!episode}
                    onClick={() =>
                      void runJob("render", { episode_id: episode?.id })
                    }
                  >
                    <Play size={15} />
                    合成这一集
                  </button>
                </div>
                {exports.map((j) => (
                  <article className="export-card" key={j.id}>
                    <video
                      controls
                      preload="metadata"
                      src={media(project.id, j.result?.video)}
                    />
                    <div>
                      <span className="eyebrow">FINISHED CUT</span>
                      <h3>
                        {document.episodes.find(
                          (e) => e.id === j.result?.episode_id,
                        )?.title || "历史成片"}
                      </h3>
                      <p>
                        {j.result?.duration} 秒 ·{" "}
                        {new Date(j.created_at).toLocaleString("zh-CN")}
                      </p>
                      {j.result?.revision !== project.revision && (
                        <p className="muted-text">此成片来自较早的项目版本。</p>
                      )}
                      <div className="button-row">
                        <a
                          className="primary"
                          download
                          href={media(project.id, j.result?.video)}
                        >
                          <Download size={15} />
                          下载 MP4
                        </a>
                        <a
                          className="secondary"
                          download
                          href={media(project.id, j.result?.subtitles)}
                        >
                          下载 SRT
                        </a>
                        <button
                          className="secondary"
                          disabled={
                            busy ||
                            mode === "demo" ||
                            j.result?.revision !== project.revision
                          }
                          onClick={() =>
                            void runJob("video_judge", {
                              export_id: j.result?.video?.replace(".mp4", ""),
                            })
                          }
                        >
                          <ShieldCheck size={15} />
                          评审此成片
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
                {!exports.length && (
                  <div className="inline-empty">
                    <Download size={32} />
                    <p>完成分镜素材后，合成你的第一支短剧。</p>
                  </div>
                )}
                <a
                  className="text-button"
                  href={`/api/projects/${project.id}/export`}
                  download
                >
                  导出项目 JSON <Download size={14} />
                </a>
              </>
            )}
          </fieldset>
        </section>
        <aside className="activity-panel">
          <div className="section-heading">
            <h3>制作动态</h3>
            <Clock3 size={15} />
          </div>
          <div className="activity-summary">
            <div>
              <strong>{shots.length}</strong>
              <span>镜头</span>
            </div>
            <div>
              <strong>{shots.filter((s) => s.image || s.video).length}</strong>
              <span>已有画面</span>
            </div>
            <div>
              <strong>{shots.filter((s) => s.audio).length}</strong>
              <span>已有配音</span>
            </div>
          </div>
          {jobs.slice(0, 12).map((j) => (
            <div className={`activity-item ${j.status}`} key={j.id}>
              <span className="activity-dot" />
              <h4>
                {jobNames[j.kind]}
                <small>
                  {j.status === "succeeded"
                    ? "完成"
                    : j.status === "failed"
                      ? "失败"
                      : "进行中"}
                </small>
              </h4>
              <p>{j.message || "任务排队中"}</p>
              <time>
                {new Date(j.created_at).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
              {j.status === "failed" && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void runJob(j.kind, { ...j.payload, overwrite: false })
                  }
                >
                  重试未完成部分
                </button>
              )}
            </div>
          ))}
          {!jobs.length && (
            <p className="activity-empty">
              创作从这里留下足迹。
              <br />
              生成与导出任务会显示在这里。
            </p>
          )}
          <div className="workspace-danger">
            <button
              className="text-button danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`永久删除「${document.title}」及其本地素材？`))
                  void action(async () => {
                    await api(`/projects/${project.id}`, { method: "DELETE" });
                    onBack();
                  });
              }}
            >
              <Trash2 size={13} />
              删除作品
            </button>
          </div>
        </aside>
      </div>
      {selectedShot && (
        <ShotEditor
          shot={selectedShot}
          project={project}
          characters={document.characters}
          busy={busy}
          onClose={() => setEditing(null)}
          onChange={updateShot}
          onDelete={() => {
            if (confirm("删除这个镜头？")) {
              edit({
                ...document,
                episodes: document.episodes.map((e) => ({
                  ...e,
                  shots: e.shots.filter((s) => s.id !== selectedShot.id),
                })),
              });
              setEditing(null);
            }
          }}
          onGenerate={(kind) =>
            void runJob(kind, { shot_id: selectedShot.id, overwrite: true })
          }
          onUpload={async (kind, file) => {
            await save();
            const form = new FormData();
            form.append("file", file);
            const p = await api<Project>(
              `/projects/${project.id}/shots/${selectedShot.id}/upload/${kind}`,
              { method: "POST", body: form },
            );
            onSave(p);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function ReviewPanel({ review, empty }: { review?: Job; empty: string }) {
  const result = review?.result;
  if (!result)
    return (
      <div className="review-empty">
        <ShieldCheck size={28} />
        <p>{empty}</p>
      </div>
    );
  return (
    <div className="review-result">
      <div className="review-score">
        <strong>{result.score ?? "—"}</strong>
        <div>
          <h3>
            {result.source === "model"
              ? "模型评审"
              : result.source === "rules"
                ? "规则检查（无 AI 评分）"
                : "素材技术检查"}
          </h3>
          <p>{result.summary}</p>
        </div>
        <span className={`review-badge ${result.passed ? "pass" : ""}`}>
          {result.passed ? "本轮未发现阻断项" : "建议修改"}
        </span>
      </div>
      {result.findings?.map((finding, index) => (
        <div className={`finding ${finding.severity}`} key={index}>
          <span>{finding.severity === "error" ? "问题" : "建议"}</span>
          <div>
            <p>{finding.message}</p>
            {finding.suggestion && <small>{finding.suggestion}</small>}
          </div>
        </div>
      ))}
      <small className="muted-text">
        评审时间：{new Date(review.created_at).toLocaleString("zh-CN")}
        。报告针对当时的版本。
      </small>
    </div>
  );
}

function ShotEditor({
  shot,
  project,
  characters,
  busy,
  onClose,
  onChange,
  onDelete,
  onGenerate,
  onUpload,
  notify,
}: {
  shot: Shot;
  project: Project;
  characters: Character[];
  busy: boolean;
  onClose: () => void;
  onChange: (s: Shot) => void;
  onDelete: () => void;
  onGenerate: (kind: JobKind) => void;
  onUpload: (kind: string, file: File) => Promise<void>;
  notify: Notify;
}) {
  const [uploading, setUploading] = useState(false);
  const change = (value: Partial<Shot>) => onChange({ ...shot, ...value });
  return (
    <div className="modal-backdrop">
      <section
        className="shot-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shot-title"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">SHOT EDITOR</span>
            <h2 id="shot-title">打磨每一个镜头</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭镜头编辑"
          >
            <X size={22} />
          </button>
        </div>
        <div className="shot-editor-layout">
          <div>
            <div className="editor-preview">
              {shot.video ? (
                <video controls src={media(project.id, shot.video)} />
              ) : shot.image ? (
                <img src={media(project.id, shot.image)} alt={shot.title} />
              ) : (
                <div className="shot-placeholder">
                  <Image size={42} />
                  <p>画面从这里诞生</p>
                </div>
              )}
            </div>
            <div className="upload-options">
              {(["image", "audio", "video"] as const).map((kind, i) => (
                <label className="secondary" key={kind}>
                  {["上传图片", "上传配音", "上传视频"][i]}
                  <input
                    type="file"
                    accept={`${kind}/*`}
                    disabled={busy || uploading || shot.locked}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setUploading(true);
                      try {
                        await onUpload(kind, file);
                        notify("素材已保存");
                      } catch (error) {
                        notify((error as Error).message);
                      } finally {
                        setUploading(false);
                      }
                    }}
                  />
                </label>
              ))}
            </div>
            {shot.audio && (
              <audio controls src={media(project.id, shot.audio)} />
            )}
            <p className="muted-text small">
              支持图片和不超过 120 秒的音视频，单文件 ≤ 30 MB。
            </p>
            <button
              className="secondary full"
              disabled={busy}
              onClick={() => change({ locked: !shot.locked })}
            >
              {shot.locked ? (
                <UnlockKeyhole size={15} />
              ) : (
                <LockKeyhole size={15} />
              )}
              {shot.locked ? "解锁镜头" : "锁定镜头，批量生成时跳过"}
            </button>
            <button
              className="text-button danger below"
              disabled={busy || shot.locked}
              onClick={onDelete}
            >
              <Trash2 size={14} />
              删除镜头
            </button>
          </div>
          <fieldset
            disabled={busy || uploading || shot.locked}
            className="editor-fieldset"
          >
            <label>
              镜头名称
              <input
                value={shot.title}
                onChange={(e) => change({ title: e.target.value })}
              />
            </label>
            <label>
              场景
              <input
                value={shot.scene}
                onChange={(e) => change({ scene: e.target.value })}
              />
            </label>
            <label>
              画面动作
              <textarea
                rows={3}
                value={shot.visual}
                onChange={(e) => change({ visual: e.target.value })}
              />
            </label>
            <label>
              台词／旁白
              <textarea
                rows={3}
                value={shot.narration}
                onChange={(e) => change({ narration: e.target.value })}
              />
            </label>
            <label>
              视频生成提示词
              <textarea
                rows={3}
                value={shot.video_prompt}
                onChange={(e) => change({ video_prompt: e.target.value })}
              />
            </label>
            <label>
              生图提示词
              <textarea
                rows={3}
                value={shot.image_prompt}
                onChange={(e) => change({ image_prompt: e.target.value })}
              />
            </label>
            <div className="form-grid">
              <label>
                时长（秒）
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={0.5}
                  value={shot.duration}
                  onChange={(e) => change({ duration: Number(e.target.value) })}
                />
              </label>
              <label>
                运镜
                <select
                  value={shot.camera}
                  onChange={(e) =>
                    change({ camera: e.target.value as Shot["camera"] })
                  }
                >
                  <option value="push">缓慢推进</option>
                  <option value="pull">缓慢拉远</option>
                  <option value="static">固定镜头</option>
                </select>
              </label>
            </div>
            <div className="character-picks">
              <label>
                <input
                  type="checkbox"
                  checked={shot.use_video_audio}
                  onChange={(e) =>
                    change({ use_video_audio: e.target.checked })
                  }
                />
                保留视频原音轨（单独配音优先）
              </label>
              {characters.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={shot.characters.includes(c.id)}
                    onChange={(e) =>
                      change({
                        characters: e.target.checked
                          ? [...shot.characters, c.id]
                          : shot.characters.filter((id) => id !== c.id),
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="button-row">
              <button
                className="secondary"
                onClick={() => onGenerate("images")}
              >
                <Image size={15} />
                重做画面
              </button>
              <button
                className="secondary"
                onClick={() => onGenerate("videos")}
              >
                <Film size={15} />
                重做 H3 视频
              </button>
              <button className="secondary" onClick={() => onGenerate("voice")}>
                <Mic size={15} />
                重做配音
              </button>
            </div>
            <p className="small muted-text">
              修改后点击工作台「保存修改」。改变剧本内容后，需重新评审并确认才能生成。
            </p>
          </fieldset>
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            完成编辑
          </button>
        </div>
      </section>
    </div>
  );
}

function SettingsView({
  settings,
  onSaved,
  notify,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
  notify: Notify;
}) {
  const [value, setValue] = useState(settings);
  const [busy, setBusy] = useState(false);
  return (
    <div className="settings-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR CREATIVE ENGINE</span>
          <h1>模型设置</h1>
          <p>让适合的模型，负责适合的创作环节。</p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const body = { ...value };
            for (const k of [
              "text",
              "image",
              "voice",
              "judge",
              "vision",
              "video",
            ] as const) {
              const { configured: _, ...config } = body[k];
              body[k] = config;
            }
            const next = await api<Settings>("/settings", {
              method: "PUT",
              body: JSON.stringify(body),
            });
            onSaved(next);
            setValue(next);
            notify("模型设置已保存");
          } catch (error) {
            notify((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mode-options">
          <button
            type="button"
            className={value.mode === "demo" ? "selected" : ""}
            onClick={() => setValue({ ...value, mode: "demo" })}
          >
            <Sparkles />
            <strong>演示模式</strong>
            <p>固定示例、占位画面，无外部调用。</p>
            {value.mode === "demo" && <Check size={18} />}
          </button>
          <button
            type="button"
            className={value.mode === "live" ? "selected" : ""}
            onClick={() => setValue({ ...value, mode: "live" })}
          >
            <WandSparkles />
            <strong>真实生成</strong>
            <p>使用你的模型接口，按服务商标准计费。</p>
            {value.mode === "live" && <Check size={18} />}
          </button>
        </div>
        <div className="notice">
          <LockKeyhole size={16} />
          <span>
            密钥只保存在本机服务端，不会回传给页面。留空保留已有密钥。API
            地址请包含版本路径（例如 /v1）。
          </span>
        </div>
        {(
          [
            {
              key: "text",
              title: "剧本模型",
              sub: "创作故事、角色与分镜 · Chat Completions",
            },
            {
              key: "judge",
              title: "剧本 Judge",
              sub: "独立评审剧本 · 留空模型名称时使用剧本模型，不评审图片和视频",
            },
            {
              key: "image",
              title: "画面模型",
              sub: "生成分镜图片 · Images Generations",
            },
            {
              key: "voice",
              title: "配音模型",
              sub: "把台词变成声音 · Audio Speech",
            },
            {
              key: "vision",
              title: "视频 Judge",
              sub: "对照剧本评审实际视频 · 本地 Qwen-VL / Gemini",
            },
            {
              key: "video",
              title: "MiniMax H3 视频生成",
              sub: "本地 SGLang H3 服务 / MiniMax 官方 API",
            },
          ] as const
        ).map(({ key, title, sub }) => (
          <section className="provider-card" key={key}>
            <div className="section-heading">
              <div>
                <h2>{title}</h2>
                <p>{sub}</p>
              </div>
              <span
                className={`config-badge ${value[key].configured ? "configured" : ""}`}
              >
                {value[key].configured ? "已保存密钥" : "待配置"}
              </span>
            </div>
            <label>
              API 地址
              <input
                type="url"
                required
                value={value[key].base_url}
                onChange={(e) =>
                  setValue({
                    ...value,
                    [key]: { ...value[key], base_url: e.target.value },
                  })
                }
              />
            </label>
            <div className="form-grid">
              <label>
                模型名称
                <input
                  placeholder="填写服务商提供的模型 ID"
                  value={value[key].model}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      [key]: { ...value[key], model: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={
                    value[key].configured
                      ? "已保存，留空保持不变"
                      : "输入 API Key"
                  }
                  value={value[key].api_key}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      [key]: { ...value[key], api_key: e.target.value },
                    })
                  }
                />
              </label>
            </div>
            {key === "vision" && (
              <label>
                视频 Judge 部署方式
                <select
                  value={value.vision_backend}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      vision_backend: e.target
                        .value as Settings["vision_backend"],
                      vision: {
                        ...value.vision,
                        base_url:
                          e.target.value === "gemini"
                            ? "https://generativelanguage.googleapis.com/v1beta"
                            : "http://127.0.0.1:8001/v1",
                        model:
                          e.target.value === "gemini"
                            ? ""
                            : "Qwen/Qwen3-VL-8B-Instruct",
                      },
                    })
                  }
                >
                  <option value="local">本地 Qwen-VL（仅视觉）</option>
                  <option value="gemini">Gemini API（视频与音轨）</option>
                </select>
              </label>
            )}
            {key === "video" && (
              <div className="form-grid">
                <label>
                  H3 部署方式
                  <select
                    value={value.video_backend}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        video_backend: e.target
                          .value as Settings["video_backend"],
                        video: {
                          ...value.video,
                          base_url:
                            e.target.value === "minimax"
                              ? "https://api.minimax.io/v2"
                              : "http://127.0.0.1:30010/v1",
                        },
                      })
                    }
                  >
                    <option value="local">本地 SGLang</option>
                    <option value="minimax">MiniMax 官方 API</option>
                  </select>
                </label>
                <label>
                  云端分辨率
                  <select
                    value={value.video_resolution}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        video_resolution: e.target
                          .value as Settings["video_resolution"],
                      })
                    }
                  >
                    <option>768P</option>
                    <option>2K</option>
                    <option>480P</option>
                  </select>
                </label>
              </div>
            )}
            {key === "voice" && (
              <label>
                音色 ID
                <input
                  value={value.voice_name}
                  onChange={(e) =>
                    setValue({ ...value, voice_name: e.target.value })
                  }
                />
              </label>
            )}
          </section>
        ))}
        <div className="settings-actions">
          <p>
            兼容协议因服务商而异。H3 与多模态 Judge 可连接本地服务或云端 API。
          </p>
          <button className="primary" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            保存设置
          </button>
        </div>
      </form>
    </div>
  );
}
