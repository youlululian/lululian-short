export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const detail = Array.isArray(data.detail)
      ? data.detail.map((d: { loc: string[]; msg: string }) => `${d.loc.slice(1).join('.')}: ${d.msg}`).join('；')
      : data.detail
    throw new Error(detail || `请求失败 (${response.status})`)
  }
  return response.status === 204 ? undefined as T : response.json()
}
export const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
