export type Character = { id: string; name: string; role: string; appearance: string; motivation: string }
export type Shot = {
  id: string; title: string; scene: string; visual: string; narration: string; image_prompt: string;
  camera: 'static' | 'push' | 'pull'; duration: number; characters: string[]; locked: boolean;
  image: string | null; audio: string | null; video: string | null;
}
export type Episode = { id: string; title: string; synopsis: string; hook: string; shots: Shot[] }
export type ProjectInput = {
  title: string; premise: string; genre: string; style: string; aspect: '9:16' | '16:9' | '1:1'; episode_count: number;
}
export type Document = ProjectInput & { approved_hash: string; characters: Character[]; episodes: Episode[] }
export type Project = { id: string; revision: number; document: Document; created_at: string; updated_at: string }
export type JobKind = 'script' | 'judge' | 'images' | 'voice' | 'render' | 'asset_check'
export type Job = {
  id: string; kind: JobKind; status: 'queued' | 'running' | 'succeeded' | 'failed'; progress: number; message: string;
  created_at: string; payload: { kind: JobKind; episode_id: string | null; shot_id: string | null; overwrite: boolean };
  result: { video?: string; subtitles?: string; episode_id?: string; duration?: number; mode?: string; revision?: number;
    scope?: string; source?: string; score?: number | null; summary?: string; passed?: boolean; content_hash?: string;
    findings?: { severity: string; shot_id?: string; message: string; suggestion?: string }[] } | null;
}
export type Provider = { base_url: string; api_key: string; model: string; configured?: boolean }
export type Settings = { mode: 'demo' | 'live'; text: Provider; image: Provider; voice: Provider; judge: Provider; voice_name: string }
export const jobNames: Record<JobKind, string> = { script: '剧本创作', judge: '剧本评审', images: '分镜生图', voice: '旁白配音', render: '成片合成', asset_check: '素材技术检查' }
export const uid = () => crypto.randomUUID().replaceAll('-', '')
export const media = (pid: string, name: string | null | undefined) => name ? `/media/${pid}/${name}` : ''
