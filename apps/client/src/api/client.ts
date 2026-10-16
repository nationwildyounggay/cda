/**
 * API 客户端。
 *
 * 所有与后端的通信都经过这里 —— 集中处理 token、超时、错误。
 * 页面与 store 不直接调 fetch。
 *
 * 地址来源（按优先级）：
 *   1. 构建时的 VITE_CDA_API
 *   2. 运行时的 localStorage（方便在手机上切环境，不用重新构建）
 *   3. 同源 /api（生产环境前后端同域时的默认值）
 */

const TOKEN_KEY = 'cda.token.v1'
const API_KEY = 'cda.apiBase.v1'

export function apiBase(): string {
  try {
    const saved = uni.getStorageSync(API_KEY)
    if (saved) return String(saved).replace(/\/$/, '')
  } catch {
    /* 存储不可用则回落 */
  }
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CDA_API
  if (env) return env.replace(/\/$/, '')
  return '/api'
}

export function setApiBase(base: string): void {
  try {
    uni.setStorageSync(API_KEY, base.replace(/\/$/, ''))
  } catch {
    /* 忽略 */
  }
}

export function getToken(): string {
  try {
    return String(uni.getStorageSync(TOKEN_KEY) ?? '')
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    if (token) uni.setStorageSync(TOKEN_KEY, token)
    else uni.removeStorageSync(TOKEN_KEY)
  } catch {
    /* 忽略 */
  }
}

export interface ApiError {
  status: number
  message: string
}

export class ApiFailure extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiFailure'
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** 无 token 也要能调的接口（登录、注册） */
  anonymous?: boolean
  /** 超时毫秒；默认 12 秒 */
  timeout?: number
}

/**
 * 发请求。约定：HTTP 非 2xx 一律抛 ApiFailure，
 * 业务层用 try/catch 或 .catch 处理，避免每处都判断 res.ok。
 */
export async function request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous, timeout = 12000 } = opts
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!anonymous) {
    const t = getToken()
    if (t) headers.authorization = `Bearer ${t}`
  }

  // uni.request 在小程序端没有 fetch，用 uni.request 保证多端一致
  const res = await new Promise<{ statusCode: number; data: any }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiFailure(0, '请求超时，请检查网络')), timeout)
    uni.request({
      url: apiBase() + path,
      method: method as never,
      header: headers,
      data: body as never,
      timeout,
      success: (r) => {
        clearTimeout(timer)
        resolve({ statusCode: r.statusCode, data: r.data })
      },
      fail: (e) => {
        clearTimeout(timer)
        reject(new ApiFailure(0, e?.errMsg ? '网络不可用：' + e.errMsg : '网络不可用'))
      },
    })
  })

  const data = res.data ?? {}
  if (res.statusCode === 401 && !anonymous) {
    // 登录态失效：清 token 并引导重新登录
    setToken('')
    throw new ApiFailure(401, data.error ?? '登录已过期，请重新登录')
  }
  if (res.statusCode < 200 || res.statusCode >= 300 || data.ok === false) {
    throw new ApiFailure(res.statusCode, data.error ?? `请求失败（${res.statusCode}）`)
  }
  return data as T
}

/** 统一把错误转成可展示的文案 */
export function errText(e: unknown): string {
  if (e instanceof ApiFailure) return e.message
  if (e instanceof Error) return e.message
  return '未知错误'
}

// ── 各领域接口 ────────────────────────────────────────

export const api = {
  // 认证
  register: (b: Record<string, unknown>) =>
    request<{ token: string; user: any }>('/auth/register', { method: 'POST', body: b, anonymous: true }),
  login: (account: string, password: string) =>
    request<{ token: string; user: any }>('/auth/login', { method: 'POST', body: { account, password }, anonymous: true }),
  logout: () => request('/auth/logout', { method: 'POST' }),

  // 我
  me: () => request<{ user: any }>('/me'),
  updateMe: (b: Record<string, unknown>) => request<{ user: any }>('/me', { method: 'PATCH', body: b }),
  uploadAvatar: (dataUrl: string) =>
    request<{ avatarUrl: string; user: any }>('/me/avatar', { method: 'POST', body: { dataUrl }, timeout: 30000 }),
  myFollowing: () => request<{ users: any[] }>('/me/following'),
  myFavorites: () => request<{ posts: any[] }>('/me/favorites'),
  myHistory: () => request<{ posts: any[] }>('/me/history'),

  // 用户
  searchUsers: (q: string) => request<{ users: any[] }>(`/users?q=${encodeURIComponent(q)}`),
  user: (code: string) => request<{ user: any; posts: any[]; followers: number; following: number; isFollowing: boolean }>(`/users/${code}`),
  follow: (code: string) => request(`/users/${code}/follow`, { method: 'POST' }),
  unfollow: (code: string) => request(`/users/${code}/unfollow`, { method: 'POST' }),
  block: (code: string) => request(`/users/${code}/block`, { method: 'POST' }),
  unblock: (code: string) => request(`/users/${code}/unblock`, { method: 'POST' }),

  // 帖子
  posts: (limit = 20, offset = 0, kind = '') =>
    request<{ posts: any[]; hasMore: boolean; nextOffset: number | null }>(
      `/posts?limit=${limit}&offset=${offset}${kind ? `&kind=${kind}` : ''}`),
  post: (id: string) => request<{ post: any }>(`/posts/${id}`),
  createPost: (b: Record<string, unknown>) => request<{ post: any }>('/posts', { method: 'POST', body: b }),
  like: (id: string) => request<{ likes: number; liked: boolean }>(`/posts/${id}/like`, { method: 'POST' }),
  favorite: (id: string) => request<{ favorited: boolean }>(`/posts/${id}/favorite`, { method: 'POST' }),
  comments: (id: string, limit = 20, offset = 0) =>
    request<{ comments: any[]; hasMore: boolean }>(`/posts/${id}/comments?limit=${limit}&offset=${offset}`),
  addComment: (id: string, text: string) =>
    request<{ comment: any; commentCount: number }>(`/posts/${id}/comments`, { method: 'POST', body: { text } }),

  // 消息
  conversations: () => request<{ conversations: any[] }>('/conversations'),
  // offset=0 取最新一页，offset 增大时加载更早的消息；每页内部按时间正序。
  messages: (peer: string, limit = 50, offset = 0) =>
    request<{ messages: any[]; hasMore: boolean; nextOffset: number | null }>(`/conversations/${peer}/messages?limit=${limit}&offset=${offset}`),
  sendMessage: (peer: string, text: string) =>
    request<{ message: any }>(`/conversations/${peer}/messages`, { method: 'POST', body: { text } }),

  // 地址
  addresses: () => request<{ addresses: any[] }>('/addresses'),
  saveAddress: (b: Record<string, unknown>) => request<{ addresses: any[] }>('/addresses', { method: 'POST', body: b }),
  deleteAddress: (id: string) => request<{ addresses: any[] }>(`/addresses/${id}`, { method: 'DELETE' }),

  // 衣橱
  wardrobe: () => request<{ items: any[] }>('/wardrobe'),
  addWardrobe: (b: Record<string, unknown>) => request('/wardrobe', { method: 'POST', body: b }),
  removeWardrobe: (id: string) => request(`/wardrobe/${id}`, { method: 'DELETE' }),

  health: () => request<{ ts: string }>('/health', { anonymous: true, timeout: 4000 }),
}

// ── 管理后台 ──
// 独立 token（存在另一个 key 里），与用户 token 互不影响 ——
// 同一个浏览器可以既是用户又是管理员，登出用户不会把后台也登出。
const ADMIN_TOKEN_KEY = 'cda.adminToken.v1'

export function getAdminToken(): string {
  try { return String(uni.getStorageSync(ADMIN_TOKEN_KEY) ?? '') } catch { return '' }
}
export function setAdminToken(t: string): void {
  try { if (t) uni.setStorageSync(ADMIN_TOKEN_KEY, t); else uni.removeStorageSync(ADMIN_TOKEN_KEY) } catch { /* 忽略 */ }
}

async function adminRequest<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeout = 12000, anonymous } = opts
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!anonymous) {
    const t = getAdminToken()
    if (t) headers.authorization = `Bearer ${t}`
  }
  const res = await new Promise<{ statusCode: number; data: any }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ApiFailure(0, '请求超时')), timeout)
    uni.request({
      url: apiBase() + '/admin' + path,
      method: method as never, header: headers, data: body as never, timeout,
      success: (r) => { clearTimeout(timer); resolve({ statusCode: r.statusCode, data: r.data }) },
      fail: (e) => { clearTimeout(timer); reject(new ApiFailure(0, e?.errMsg ?? '网络不可用')) },
    })
  })
  const data = res.data ?? {}
  if (res.statusCode === 401 && !anonymous) { setAdminToken(''); throw new ApiFailure(401, data.error ?? '登录已过期') }
  if (res.statusCode < 200 || res.statusCode >= 300 || data.ok === false) {
    throw new ApiFailure(res.statusCode, data.error ?? `请求失败（${res.statusCode}）`)
  }
  return data as T
}

export const adminApi = {
  login: (username: string, password: string) =>
    adminRequest<{ token: string; admin: any }>('/auth/login', { method: 'POST', body: { username, password }, anonymous: true }),
  logout: () => adminRequest('/auth/logout', { method: 'POST' }),
  me: () => adminRequest<{ admin: any }>('/me'),

  dashboard: () => adminRequest<{ stats: Record<string, number> }>('/dashboard'),

  invites: () => adminRequest<{ invites: any[] }>('/invites'),
  createInvites: (count: number, prefix: string, note: string) =>
    adminRequest<{ created: string[] }>('/invites', { method: 'POST', body: { count, prefix, note } }),
  deleteInvite: (code: string) => adminRequest(`/invites/${encodeURIComponent(code)}`, { method: 'DELETE' }),

  users: (q = '', status = '', limit = 20, offset = 0) =>
    adminRequest<{ users: any[]; hasMore: boolean }>(`/users?q=${encodeURIComponent(q)}&status=${status}&limit=${limit}&offset=${offset}`),
  setUserStatus: (code: string, status: string, reason: string) =>
    adminRequest(`/users/${encodeURIComponent(code)}`, { method: 'PATCH', body: { status, reason } }),
  deleteUser: (code: string, reason: string) =>
    adminRequest(`/users/${encodeURIComponent(code)}`, { method: 'DELETE', body: { reason } }),

  logs: (limit = 30, offset = 0) => adminRequest<{ logs: any[]; hasMore: boolean }>(`/logs?limit=${limit}&offset=${offset}`),
}
