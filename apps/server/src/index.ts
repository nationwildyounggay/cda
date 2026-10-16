/**
 * 搭 · CDA 后端。
 *
 * 零 npm 依赖：node:http + node:sqlite + node:crypto。
 * 10 人内测规模，够用且没有安装/供应链风险。
 *
 * 启动：node --experimental-strip-types src/index.ts
 * 环境变量：
 *   CDA_PORT     监听端口（默认 8787）
 *   CDA_DB       数据库文件（默认 ./data/cda.db）
 *   CDA_INVITES  初始邀请码，逗号分隔（仅首次运行时写入）
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep, extname } from 'node:path'
import {
  openDb, hashPassword, verifyPassword, formatUserCode, nextUserSeq,
  nowIso, newId, newToken,
  checkAttempts, recordFailure, clearFailures,
  type DB,
} from './db.ts'
import {
  ADMIN_PERMS, can, checkAdminAttempts, recordAdminFailure, clearAdminFailures,
  issueAdminToken, currentAdmin, audit, toAdmin, seedOwner, deny,
  type AdminRole,
} from './admin.ts'

const PORT = Number(process.env.CDA_PORT ?? 8787)
const DB_PATH = process.env.CDA_DB ?? './data/cda.db'
mkdirSync(dirname(DB_PATH), { recursive: true })
const db: DB = openDb(DB_PATH)

seedInvites()
seedOwner(db)

// ── 小工具 ────────────────────────────────────────────

type Req = IncomingMessage & { code?: string; params: Record<string, string>; query: URLSearchParams; body: any }
type Handler = (req: Req, res: ServerResponse) => void | Promise<void>

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res: ServerResponse, status: number, message: string): void {
  json(res, status, { ok: false, error: message })
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    // 限制体积，防止超大请求打爆内存
    if (size > 1_000_000) throw new Error('请求体过大')
    chunks.push(c as Buffer)
  }
  if (!chunks.length) return {}
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return body
}

/** 把 /api/users/:code 这样的模式编译成正则 */
function compile(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = []
  const re = new RegExp(
    '^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)' }) + '$',
  )
  return { re, keys }
}

const routes: Array<{ method: string; pattern: string; re: RegExp; keys: string[]; auth: boolean; fn: Handler }> = []

function route(method: string, pattern: string, auth: boolean, fn: Handler): void {
  const { re, keys } = compile(pattern)
  routes.push({ method, pattern, re, keys, auth, fn })
}

// ── 风格 / 品牌：分表读写 ─────────────────────────────

function stylesOf(code: string): string[] {
  return (db.prepare('SELECT style_id FROM user_styles WHERE code = ? ORDER BY sort_order').all(code) as any[])
    .map((r) => r.style_id)
}
function brandsOf(code: string): string[] {
  return (db.prepare('SELECT brand_id FROM user_brands WHERE code = ? ORDER BY sort_order').all(code) as any[])
    .map((r) => r.brand_id)
}
/** 全量替换：先删后插，顺序即 sort_order（主页取前 5 个靠它） */
function setStyles(code: string, ids: string[]): void {
  db.prepare('DELETE FROM user_styles WHERE code = ?').run(code)
  const ins = db.prepare('INSERT OR IGNORE INTO user_styles (code, style_id, sort_order) VALUES (?,?,?)')
  ids.forEach((id, i) => ins.run(code, String(id), i))
}
function setBrands(code: string, ids: string[]): void {
  db.prepare('DELETE FROM user_brands WHERE code = ?').run(code)
  const ins = db.prepare('INSERT OR IGNORE INTO user_brands (code, brand_id, sort_order) VALUES (?,?,?)')
  ids.forEach((id, i) => ins.run(code, String(id), i))
}

// ── 分页 ──────────────────────────────────────────────
// 原来所有列表都是硬编码 LIMIT，翻页要改接口。统一收口到这里。

const MAX_LIMIT = 50
function page(req: Req): { limit: number; offset: number } {
  const rawLimit = Number(req.query.get('limit'))
  const rawOffset = Number(req.query.get('offset'))
  // SQLite LIMIT/OFFSET 只接受整数；非有限值使用默认值，超大偏移限制到安全整数。
  const limit = Number.isFinite(rawLimit) && rawLimit !== 0
    ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(rawLimit))) : 20
  const offset = Number.isFinite(rawOffset)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(rawOffset))) : 0
  return { limit, offset }
}
function paged<T>(res: ServerResponse, key: string, rows: T[], limit: number, offset: number): void {
  /*
   * 调用方会多取一条（limit + 1）来判断还有没有下一页，避免额外的 COUNT 查询。
   * **必须把多取的那条切掉** —— 否则每页多返回一条，
   * 且下一页会与上一页重叠一条。
   * （这是 L3 分页用例抓出来的真 bug：请求 limit=5 返回了 6 条，
   *   第二页与第一页有 1 条重复。）
   */
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  json(res, 200, {
    ok: true,
    [key]: page,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  })
}

// ── 在线状态：节流写入 ────────────────────────────────
// 原来每个请求都 UPDATE 一次，写放大明显。60 秒内只写一次。

const PRESENCE_THROTTLE_MS = 60_000
const lastPresence = new Map<string, number>()
function touchPresence(code: string, online = true): void {
  const now = Date.now()
  if (now - (lastPresence.get(code) ?? 0) < PRESENCE_THROTTLE_MS) return
  lastPresence.set(code, now)
  db.prepare('UPDATE users SET is_online = ?, last_seen_at = ? WHERE code = ?')
    .run(online ? 1 : 0, nowIso(), code)
}

// ── 鉴权 ──────────────────────────────────────────────

function currentUser(req: Req): any | null {
  const h = req.headers.authorization ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  if (!token) return null
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as any
  if (!s) return null
  if (new Date(s.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return null
  }
  return db.prepare('SELECT * FROM users WHERE code = ?').get(s.code) ?? null
}

/** 把数据库行转成前端要的形状（snake_case → camelCase，JSON 字段解析） */
function toUser(u: any, opts: { self?: boolean } = {}): any {
  if (!u) return null
  const privacy = JSON.parse(u.privacy || '{}')
  const hide = privacy.hideOnlineStatus
  return {
    code: u.code,
    nickname: u.nickname,
    gender: u.gender,
    birthday: u.birthday,
    avatarHex: u.avatar_hex,
    avatarUrl: u.avatar_url ?? '',
    styles: stylesOf(u.code),
    brands: brandsOf(u.code),
    status: u.status,
    region: privacy.hideRegion ? '' : u.region,
    privacy,
    // 自己看得到自己的在线状态；别人看你时受隐私设置约束
    isOnline: opts.self ? true : !hide && !!u.is_online,
    lastSeenAt: opts.self || !hide ? u.last_seen_at : '',
    createdAt: u.created_at,
    // 身型：注册时填的，个人主页与 3D 人偶都该用它
    body: {
      heightCm: u.height_cm ?? 0, weightKg: u.weight_kg ?? 0,
      chestCm: u.chest_cm ?? 0, waistCm: u.waist_cm ?? 0, hipCm: u.hip_cm ?? 0,
    },
    ...(opts.self ? { phone: u.phone ?? '', email: u.email ?? '' } : {}),
  }
}

function issueToken(code: string): string {
  const token = newToken()
  const now = Date.now()
  db.prepare('INSERT INTO sessions (token, code, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, code, nowIso(), new Date(now + 30 * 864e5).toISOString())
  return token
}

// ── 邀请码 ────────────────────────────────────────────

function seedInvites(): void {
  const raw = process.env.CDA_INVITES
  const row = db.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }
  if (row.n > 0) return
  const codes = (raw ? raw.split(',') : ['CDA-BETA-0001', 'CDA-BETA-0002', 'CDA-BETA-0003'])
    .map((s) => s.trim()).filter(Boolean)
  const ins = db.prepare('INSERT OR IGNORE INTO invites (code, note, created_at) VALUES (?,?,?)')
  for (const c of codes) ins.run(c, '初始邀请码', nowIso())
  console.log(`[CDA] 已写入 ${codes.length} 个邀请码：${codes.join(', ')}`)
}

// ── 路由：认证 ────────────────────────────────────────

route('POST', '/api/auth/register', false, (req, res) => {
  const b = req.body
  const needed = ['password', 'nickname']
  for (const k of needed) if (!b[k]) return fail(res, 400, `缺少字段 ${k}`)
  if (String(b.password).length < 6) return fail(res, 400, '密码至少 6 位')
  if (!b.phone && !b.email) return fail(res, 400, '请提供手机号或邮箱')
  // 格式校验放在服务端 —— 前端的校验可以被绕过，服务端才是最后一道
  if (b.phone && !/^1[3-9]\d{9}$/.test(String(b.phone))) {
    return fail(res, 400, '手机号格式不正确')
  }
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email))) {
    return fail(res, 400, '邮箱格式不正确')
  }
  if (b.nickname && (String(b.nickname).trim().length < 2 || String(b.nickname).length > 16)) {
    return fail(res, 400, '昵称需 2–16 个字')
  }

  // 邀请码校验 —— 没有短信资质，用它控制注册入口
  if (b.inviteCode) {
    const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(String(b.inviteCode)) as any
    if (!inv) return fail(res, 403, '邀请码无效')
    if (inv.used_by) return fail(res, 403, '邀请码已被使用')
  }

  const dup = b.phone
    ? db.prepare('SELECT code FROM users WHERE phone = ?').get(String(b.phone))
    : db.prepare('SELECT code FROM users WHERE email = ?').get(String(b.email))
  if (dup) return fail(res, 409, '该手机号或邮箱已注册')

  const seq = nextUserSeq(db)
  const code = formatUserCode(seq)
  const { hash, salt } = hashPassword(String(b.password))
  db.prepare(`INSERT INTO users
    (code, seq, phone, email, password_hash, password_salt, nickname, gender, birthday,
     avatar_hex, region, privacy, height_cm, weight_kg, chest_cm, waist_cm, hip_cm,
     last_seen_at, is_online, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    code, seq, b.phone ?? null, b.email ?? null, hash, salt,
    String(b.nickname), b.gender ?? 'female', b.birthday ?? '',
    b.avatarHex ?? '#c9b8a8',
    b.region ?? '中国', JSON.stringify(b.privacy ?? {}),
    Number(b.heightCm) || 0, Number(b.weightKg) || 0,
    Number(b.chestCm) || 0, Number(b.waistCm) || 0, Number(b.hipCm) || 0,
    nowIso(), 1, nowIso(),
  )
  setStyles(code, Array.isArray(b.styles) ? b.styles : [])
  setBrands(code, Array.isArray(b.brands) ? b.brands : [])
  if (b.inviteCode) {
    db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(code, nowIso(), String(b.inviteCode))
  }
  const u = db.prepare('SELECT * FROM users WHERE code = ?').get(code)
  json(res, 200, { ok: true, token: issueToken(code), user: toUser(u, { self: true }) })
})

route('POST', '/api/auth/login', false, (req, res) => {
  const b = req.body
  const account = String(b.account ?? '').trim()
  if (!account || !b.password) return fail(res, 400, '请输入账号与密码')

  // 频率限制：防撞库。按「账号 + 来源 IP」计数，任一维度都可能被换，
  // 两个一起记能同时挡住「撞一个账号」和「用一个 IP 撞很多账号」。
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]!.trim()
  const keys = [`acct:${account}`, `ip:${ip}`]
  for (const k of keys) {
    const c = checkAttempts(db, k)
    if (!c.allowed) {
      res.setHeader('retry-after', String(c.retryAfterSec ?? 600))
      return fail(res, 429, `尝试过于频繁，请 ${Math.ceil((c.retryAfterSec ?? 600) / 60)} 分钟后再试`)
    }
  }
  const u = db.prepare('SELECT * FROM users WHERE phone = ? OR email = ? OR code = ?')
    .get(account, account, account) as any
  // 账号不存在与密码错误返回同一句话，避免暴露账号是否注册过
  if (!u || !verifyPassword(String(b.password), u.password_hash, u.password_salt)) {
    for (const k of keys) recordFailure(db, k)
    return fail(res, 401, '账号或密码不正确')
  }
  if (u.status === 'disabled') return fail(res, 403, '账号已被禁用')
  for (const k of keys) clearFailures(db, k)
  db.prepare('UPDATE users SET is_online = 1, last_seen_at = ? WHERE code = ?').run(nowIso(), u.code)
  json(res, 200, { ok: true, token: issueToken(u.code), user: toUser(u, { self: true }) })
})

route('POST', '/api/auth/logout', true, (req, res) => {
  const h = req.headers.authorization ?? ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : ''
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
  lastPresence.delete(req.code!)
  db.prepare('UPDATE users SET is_online = 0, last_seen_at = ? WHERE code = ?').run(nowIso(), req.code!)
  json(res, 200, { ok: true })
})

// ── 路由：我 ──────────────────────────────────────────

route('GET', '/api/me', true, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE code = ?').get(req.code!)
  json(res, 200, { ok: true, user: toUser(u, { self: true }) })
})

/**
 * 上传头像。
 *
 * 用 base64 data URL 传输（uni-app 的 chooseImage 在小程序端只能拿到临时路径，
 * base64 是 H5 与小程序都通用的方式）。
 *
 * **存文件而不是把 base64 塞进数据库** ——
 * 后者会让库迅速膨胀，且每次查用户都要读几十 KB 的无用数据。
 */
route('POST', '/api/me/avatar', true, (req, res) => {
  const dataUrl = String(req.body?.dataUrl ?? '')
  const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/)
  if (!m) return fail(res, 400, '图片格式不支持（仅 png/jpeg/webp）')
  const buf = Buffer.from(m[2]!, 'base64')
  // 限制 500KB：头像是小图，超过这个尺寸说明前端没压缩
  if (buf.length > 500 * 1024) return fail(res, 400, '图片过大，请压缩后再上传（上限 500KB）')

  const dir = join(dirname(process.env.CDA_DB ?? './data/cda.db'), 'avatars')
  mkdirSync(dir, { recursive: true })
  const ext = m[1] === 'jpg' ? 'jpeg' : m[1]!
  const file = join(dir, `${req.code}.${ext}`)
  writeFileSync(file, buf)

  const url = `/api/avatar/${req.code}?v=${Date.now()}`
  db.prepare('UPDATE users SET avatar_url = ? WHERE code = ?').run(url, req.code!)
  const u = db.prepare('SELECT * FROM users WHERE code = ?').get(req.code!)
  json(res, 200, { ok: true, avatarUrl: url, user: toUser(u, { self: true }) })
})

/** 取头像。不加鉴权 —— 头像是公开展示的，加鉴权反而让 <img> 用不了 */
route('GET', '/api/avatar/:code', false, (req, res) => {
  // 参数已经 URL 解码，必须在拼接文件路径前拒绝目录分隔符等非法字符。
  if (!/^CDA_\d{8,}$/.test(req.params.code!)) return fail(res, 400, '用户码格式不正确')
  const dir = join(dirname(process.env.CDA_DB ?? './data/cda.db'), 'avatars')
  for (const ext of ['png', 'jpeg', 'webp']) {
    const f = join(dir, `${req.params.code}.${ext}`)
    if (existsSync(f)) {
      const buf = readFileSync(f)
      res.writeHead(200, {
        'content-type': `image/${ext}`,
        'content-length': String(buf.length),
        'cache-control': 'public, max-age=86400',
      })
      return res.end(buf)
    }
  }
  fail(res, 404, '无头像')
})

route('PATCH', '/api/me', true, (req, res) => {
  const b = req.body ?? {}
  const map: Record<string, string> = {
    nickname: 'nickname', gender: 'gender', birthday: 'birthday', avatarHex: 'avatar_hex',
    region: 'region', status: 'status',
    // 身型可在「我的资料」里补填 —— 注册时是选填的
    heightCm: 'height_cm', weightKg: 'weight_kg',
    chestCm: 'chest_cm', waistCm: 'waist_cm', hipCm: 'hip_cm',
  }
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, col] of Object.entries(map)) {
    if (b[k] !== undefined) { sets.push(`${col} = ?`); vals.push(b[k]) }
  }
  if (b.privacy !== undefined) { sets.push('privacy = ?'); vals.push(JSON.stringify(b.privacy)) }
  if (sets.length) {
    vals.push(req.code!)
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE code = ?`).run(...(vals as any[]))
  }
  // 风格与品牌走分表，顺序即优先级
  if (Array.isArray(b.styles)) setStyles(req.code!, b.styles)
  if (Array.isArray(b.brands)) setBrands(req.code!, b.brands)
  const u = db.prepare('SELECT * FROM users WHERE code = ?').get(req.code!)
  json(res, 200, { ok: true, user: toUser(u, { self: true }) })
})

// ── 路由：用户 ────────────────────────────────────────

route('GET', '/api/users', true, (req, res) => {
  const q = (req.query.get('q') ?? '').trim()
  if (!q) return json(res, 200, { ok: true, users: [] })
  const like = `%${q}%`
  const { limit, offset } = page(req)
  // 先过滤隐私再分页，否则隐藏用户会占据名额，并使 hasMore 提前变成 false。
  const rows = db.prepare(`
    SELECT * FROM users
    WHERE (nickname LIKE ? OR code LIKE ?) AND code != ?
      AND COALESCE(json_extract(privacy, '$.hideFromSearch'), 0) = 0
    ORDER BY seq ASC LIMIT ? OFFSET ?
  `).all(like, like, req.code!, limit + 1, offset) as any[]
  paged(res, 'users', rows.map((u) => toUser(u)), limit, offset)
})

route('GET', '/api/users/:code', true, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE code = ?').get(req.params.code!)
  if (!u) return fail(res, 404, '用户不存在')
  const followers = (db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee = ?').get(req.params.code!) as any).n
  const following = (db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower = ?').get(req.params.code!) as any).n
  const isFollowing = !!db.prepare('SELECT 1 FROM follows WHERE follower = ? AND followee = ?')
    .get(req.code!, req.params.code!)
  const posts = db.prepare('SELECT * FROM posts WHERE author_code = ? ORDER BY created_at DESC LIMIT 30')
    .all(req.params.code!) as any[]
  json(res, 200, {
    ok: true, user: toUser(u), followers, following, isFollowing,
    posts: posts.map(toPost),
  })
})

/** 关注 / 取消关注 / 拉黑 —— 统一在这里，避免重复写 */
for (const [path, action] of [
  ['/api/users/:code/follow', 'follow'],
  ['/api/users/:code/unfollow', 'unfollow'],
  ['/api/users/:code/block', 'block'],
  ['/api/users/:code/unblock', 'unblock'],
] as const) {
  route('POST', path, true, (req, res) => {
    const me = req.code!
    const peer = req.params.code!
    if (peer === me) return fail(res, 400, '不能对自己操作')
    if (action === 'follow') {
      // 被对方拉黑时不允许关注
      const blocked = db.prepare('SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?').get(peer, me)
      if (blocked) return fail(res, 403, '对方已将你加入黑名单')
      db.prepare('INSERT OR IGNORE INTO follows (follower, followee, created_at) VALUES (?,?,?)').run(me, peer, nowIso())
    } else if (action === 'unfollow') {
      db.prepare('DELETE FROM follows WHERE follower = ? AND followee = ?').run(me, peer)
    } else if (action === 'block') {
      db.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?,?,?)').run(me, peer, nowIso())
      // 拉黑同时解除互相关注
      db.prepare('DELETE FROM follows WHERE (follower = ? AND followee = ?) OR (follower = ? AND followee = ?)').run(me, peer, peer, me)
    } else {
      db.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?').run(me, peer)
    }
    json(res, 200, { ok: true })
  })
}

route('GET', '/api/me/following', true, (req, res) => {
  const rows = db.prepare(
    'SELECT u.* FROM follows f JOIN users u ON u.code = f.followee WHERE f.follower = ? ORDER BY f.created_at DESC',
  ).all(req.code!) as any[]
  json(res, 200, { ok: true, users: rows.map((u) => toUser(u)) })
})

route('GET', '/api/me/favorites', true, (req, res) => {
  const rows = db.prepare(
    'SELECT p.* FROM favorites f JOIN posts p ON p.id = f.post_id WHERE f.code = ? ORDER BY f.created_at DESC',
  ).all(req.code!) as any[]
  json(res, 200, { ok: true, posts: rows.map(toPost) })
})

route('GET', '/api/me/history', true, (req, res) => {
  const rows = db.prepare(
    'SELECT p.* FROM history h JOIN posts p ON p.id = h.post_id WHERE h.code = ? ORDER BY h.viewed_at DESC LIMIT 50',
  ).all(req.code!) as any[]
  json(res, 200, { ok: true, posts: rows.map(toPost) })
})

// ── 路由：帖子 ────────────────────────────────────────

function toPost(p: any, likedByMe = false): any {
  if (!p) return null
  return {
    id: p.id,
    authorCode: p.author_code,
    author: p.author_nickname ?? undefined,
    avatarHex: p.author_avatar ?? undefined,
    title: p.title,
    coverHex: p.cover_hex,
    tags: JSON.parse(p.tags || '[]'),
    likes: p.likes,
    comments: p.comment_count ?? 0,
    ratio: p.ratio,
    kind: p.kind ?? 'outfit',
    linkedProductId: p.linked_product_id ?? undefined,
    createdAt: p.created_at,
    likedByMe,
  }
}

route('GET', '/api/posts', true, (req, res) => {
  const { limit, offset } = page(req)
  // kind: outfit=穿搭 / idle=闲置；不传则全部
  const kind = req.query.get('kind') ?? ''
  const where = kind ? 'WHERE p.kind = ?' : ''
  const args: unknown[] = kind ? [kind] : []
  // 评论数由评论表推导，不再依赖 posts 上那个没人维护的计数器
  const rows = db.prepare(`
    SELECT p.*, u.nickname AS author_nickname, u.avatar_hex AS author_avatar,
           (SELECT COUNT(*) AS n FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p JOIN users u ON u.code = p.author_code
    ${where}
    ORDER BY p.created_at DESC LIMIT ? OFFSET ?`).all(...(args as any[]), limit + 1, offset) as any[]
  const liked = new Set(
    (db.prepare('SELECT post_id FROM post_likes WHERE code = ?').all(req.code!) as any[]).map((r) => r.post_id),
  )
  paged(res, 'posts', rows.map((p) => toPost(p, liked.has(p.id))), limit, offset)
})

// ── 评论 ──

route('GET', '/api/posts/:id/comments', true, (req, res) => {
  const { limit, offset } = page(req)
  const rows = db.prepare(`
    SELECT c.*, u.nickname AS author_nickname, u.avatar_hex AS author_avatar
    FROM comments c JOIN users u ON u.code = c.author_code
    WHERE c.post_id = ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?`)
    .all(req.params.id!, limit + 1, offset) as any[]
  paged(res, 'comments', rows.map((c) => ({
    id: c.id, postId: c.post_id, text: c.text,
    authorCode: c.author_code, author: c.author_nickname, avatarHex: c.author_avatar,
    createdAt: c.created_at,
  })), limit, offset)
})

route('POST', '/api/posts/:id/comments', true, (req, res) => {
  const text = String(req.body?.text ?? '').trim()
  if (!text) return fail(res, 400, '评论不能为空')
  if (text.length > 500) return fail(res, 400, '评论过长')
  if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(req.params.id!)) {
    return fail(res, 404, '帖子不存在')
  }
  const id = newId('cm')
  db.prepare('INSERT INTO comments (id, post_id, author_code, text, created_at) VALUES (?,?,?,?,?)')
    .run(id, req.params.id!, req.code!, text, nowIso())
  const u = db.prepare('SELECT nickname, avatar_hex FROM users WHERE code = ?').get(req.code!) as any
  const n = (db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?').get(req.params.id!) as any).n
  json(res, 200, {
    ok: true, commentCount: n,
    comment: { id, postId: req.params.id!, text, authorCode: req.code!, author: u.nickname, avatarHex: u.avatar_hex, createdAt: nowIso() },
  })
})

route('DELETE', '/api/comments/:id', true, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id!) as any
  if (!c) return fail(res, 404, '评论不存在')
  // 只有作者本人能删自己的评论
  if (c.author_code !== req.code!) return fail(res, 403, '只能删除自己的评论')
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id!)
  json(res, 200, { ok: true })
})

route('GET', '/api/posts/:id', true, (req, res) => {
  const p = db.prepare(`
    SELECT p.*, u.nickname AS author_nickname, u.avatar_hex AS author_avatar,
           (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p JOIN users u ON u.code = p.author_code WHERE p.id = ?`).get(req.params.id!) as any
  if (!p) return fail(res, 404, '帖子不存在')
  // 记录浏览历史
  db.prepare('INSERT OR REPLACE INTO history (code, post_id, viewed_at) VALUES (?,?,?)')
    .run(req.code!, p.id, nowIso())
  const liked = !!db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND code = ?').get(p.id, req.code!)
  json(res, 200, { ok: true, post: toPost(p, liked) })
})

route('POST', '/api/posts', true, (req, res) => {
  const b = req.body ?? {}
  if (!String(b.title ?? '').trim()) return fail(res, 400, '请填写内容')
  const id = newId('post')
  // kind 只允许两个值 —— 防止塞进任意字符串
  const kind = b.kind === 'idle' ? 'idle' : 'outfit'
  db.prepare(`INSERT INTO posts (id, author_code, title, cover_hex, tags, ratio, kind, linked_product_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, req.code!, String(b.title), b.coverHex ?? '#dddddd',
    JSON.stringify(b.tags ?? []), Number(b.ratio) || 1, kind, b.linkedProductId ?? null, nowIso(),
  )
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(id)
  json(res, 200, { ok: true, post: toPost(p) })
})

route('POST', '/api/posts/:id/like', true, (req, res) => {
  const id = req.params.id!
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(id)
  if (!p) return fail(res, 404, '帖子不存在')
  const has = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND code = ?').get(id, req.code!)
  if (has) {
    db.prepare('DELETE FROM post_likes WHERE post_id = ? AND code = ?').run(id, req.code!)
    db.prepare('UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = ?').run(id)
  } else {
    db.prepare('INSERT INTO post_likes (post_id, code, created_at) VALUES (?,?,?)').run(id, req.code!, nowIso())
    db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').run(id)
  }
  const after = db.prepare('SELECT likes FROM posts WHERE id = ?').get(id) as any
  json(res, 200, { ok: true, likes: after.likes, liked: !has })
})

route('POST', '/api/posts/:id/favorite', true, (req, res) => {
  const id = req.params.id!
  const has = db.prepare('SELECT 1 FROM favorites WHERE code = ? AND post_id = ?').get(req.code!, id)
  if (has) db.prepare('DELETE FROM favorites WHERE code = ? AND post_id = ?').run(req.code!, id)
  else db.prepare('INSERT INTO favorites (code, post_id, created_at) VALUES (?,?,?)').run(req.code!, id, nowIso())
  json(res, 200, { ok: true, favorited: !has })
})

// ── 路由：消息 ────────────────────────────────────────

/** 会话按用户码排序后存 user_a/user_b，保证同一对人只有一条会话 */
function convOf(me: string, peer: string): string {
  const [a, b] = [me, peer].sort()
  const found = db.prepare('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?').get(a!, b!) as any
  if (found) return found.id
  const id = newId('conv')
  db.prepare('INSERT INTO conversations (id, user_a, user_b, updated_at) VALUES (?,?,?,?)').run(id, a!, b!, nowIso())
  return id
}

route('GET', '/api/conversations', true, (req, res) => {
  const me = req.code!
  const rows = db.prepare(
    'SELECT * FROM conversations WHERE user_a = ? OR user_b = ? ORDER BY updated_at DESC',
  ).all(me, me) as any[]
  const list = rows.map((c) => {
    const peerCode = c.user_a === me ? c.user_b : c.user_a
    const peer = db.prepare('SELECT * FROM users WHERE code = ?').get(peerCode) as any
    const last = db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at DESC LIMIT 1').get(c.id) as any
    const unread = (db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND from_code != ? AND read_at IS NULL',
    ).get(c.id, me) as any).n
    return {
      id: c.id,
      peer: toUser(peer),
      lastMessage: last ? { text: last.text, fromMe: last.from_code === me, createdAt: last.created_at } : null,
      unread,
      updatedAt: c.updated_at,
    }
  })
  json(res, 200, { ok: true, conversations: list })
})

route('GET', '/api/conversations/:peer/messages', true, (req, res) => {
  const me = req.code!
  const peer = req.params.peer!
  const convId = convOf(me, peer)
  // offset 从最新消息向过去翻页；页内仍按时间正序展示。
  const { limit, offset } = page(req)
  const rows = db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
    .all(convId, limit + 1, offset) as any[]
  const hasMore = rows.length > limit
  const messages = rows.slice(0, limit).reverse()
  // 仅标记实际返回的消息，不把未加载的旧页或探测下一页的那条也设为已读。
  if (messages.length) {
    const placeholders = messages.map(() => '?').join(',')
    db.prepare(`UPDATE messages SET read_at = ?
      WHERE conv_id = ? AND from_code != ? AND read_at IS NULL AND id IN (${placeholders})`)
      .run(nowIso(), convId, me, ...messages.map((m) => m.id))
  }
  json(res, 200, {
    ok: true,
    messages: messages.map((m) => ({
      id: m.id, text: m.text, fromMe: m.from_code === me, createdAt: m.created_at,
    })),
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  })
})

route('POST', '/api/conversations/:peer/messages', true, (req, res) => {
  const me = req.code!
  const peer = req.params.peer!
  const text = String(req.body?.text ?? '').trim()
  if (!text) return fail(res, 400, '消息不能为空')
  if (text.length > 1000) return fail(res, 400, '消息过长')
  const target = db.prepare('SELECT * FROM users WHERE code = ?').get(peer) as any
  if (!target) return fail(res, 404, '用户不存在')
  // 被拉黑则不能发
  if (db.prepare('SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?').get(peer, me)) {
    return fail(res, 403, '对方已将你加入黑名单')
  }
  const convId = convOf(me, peer)
  const id = newId('msg')
  db.prepare('INSERT INTO messages (id, conv_id, from_code, text, created_at) VALUES (?,?,?,?,?)')
    .run(id, convId, me, text, nowIso())
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowIso(), convId)
  json(res, 200, { ok: true, message: { id, text, fromMe: true, createdAt: nowIso() } })
})

// ── 路由：收货地址 ────────────────────────────────────

route('GET', '/api/addresses', true, (req, res) => {
  const rows = db.prepare('SELECT * FROM addresses WHERE code = ? ORDER BY is_default DESC, rowid DESC')
    .all(req.code!) as any[]
  json(res, 200, { ok: true, addresses: rows.map(toAddress) })
})

function toAddress(a: any): any {
  return {
    id: a.id, name: a.name, phone: a.phone, province: a.province, city: a.city,
    district: a.district, detail: a.detail, isDefault: !!a.is_default, tag: a.tag,
  }
}

route('POST', '/api/addresses', true, (req, res) => {
  const b = req.body ?? {}
  if (!b.name || !b.phone || !b.province || !b.detail) return fail(res, 400, '地址信息不完整')
  if (!/^1[3-9]\d{9}$/.test(String(b.phone))) return fail(res, 400, '手机号格式不正确')
  const id = b.id && db.prepare('SELECT 1 FROM addresses WHERE id = ? AND code = ?').get(b.id, req.code!)
    ? b.id : newId('addr')
  if (b.isDefault) db.prepare('UPDATE addresses SET is_default = 0 WHERE code = ?').run(req.code!)
  db.prepare(`INSERT OR REPLACE INTO addresses
    (id, code, name, phone, province, city, district, detail, is_default, tag, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, req.code!, String(b.name), String(b.phone), String(b.province),
    String(b.city ?? ''), String(b.district ?? ''), String(b.detail),
    b.isDefault ? 1 : 0, String(b.tag ?? ''), nowIso(),
  )
  const rows = db.prepare('SELECT * FROM addresses WHERE code = ? ORDER BY is_default DESC, rowid DESC').all(req.code!) as any[]
  json(res, 200, { ok: true, addresses: rows.map(toAddress) })
})

route('DELETE', '/api/addresses/:id', true, (req, res) => {
  db.prepare('DELETE FROM addresses WHERE id = ? AND code = ?').run(req.params.id!, req.code!)
  const rows = db.prepare('SELECT * FROM addresses WHERE code = ? ORDER BY is_default DESC, rowid DESC').all(req.code!) as any[]
  json(res, 200, { ok: true, addresses: rows.map(toAddress) })
})

// ── 路由：衣橱 ────────────────────────────────────────

route('GET', '/api/wardrobe', true, (req, res) => {
  const rows = db.prepare('SELECT * FROM wardrobe WHERE code = ? ORDER BY created_at DESC').all(req.code!) as any[]
  json(res, 200, {
    ok: true,
    items: rows.map((w) => ({
      id: w.id, productId: w.product_id, colorId: w.color_id, size: w.size,
      source: w.source, note: w.note, createdAt: w.created_at,
    })),
  })
})

route('POST', '/api/wardrobe', true, (req, res) => {
  const b = req.body ?? {}
  if (!b.productId) return fail(res, 400, '缺少 productId')
  const id = newId('w')
  db.prepare(`INSERT OR IGNORE INTO wardrobe (id, code, product_id, color_id, size, source, note, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id, req.code!, String(b.productId), String(b.colorId ?? ''), String(b.size ?? ''),
    String(b.source ?? 'manual'), String(b.note ?? ''), nowIso(),
  )
  json(res, 200, { ok: true })
})

route('DELETE', '/api/wardrobe/:id', true, (req, res) => {
  db.prepare('DELETE FROM wardrobe WHERE id = ? AND code = ?').run(req.params.id!, req.code!)
  json(res, 200, { ok: true })
})

// ── 管理后台路由 ──────────────────────────────────────

const ADMIN_PERM_OF: Record<string, string> = {
  'GET /invites': 'invite.write',
  'POST /invites': 'invite.write',
  'DELETE /invites': 'invite.write',
  'GET /users': 'user.read',
  'PATCH /users': 'user.disable',
  'DELETE /users': 'user.delete',
  'GET /logs': 'audit.read',
  'GET /dashboard': 'stats.read',
}

function adminIp(req: Req): string {
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
    .split(',')[0]!.trim()
}

async function handleAdmin(req: Req, res: ServerResponse, pathname: string): Promise<void> {
  const sub = pathname.replace(/^\/api\/admin/, '') || '/'
  const ip = adminIp(req)

  // ── 登录（无需 token）──
  if (sub === '/auth/login' && req.method === 'POST') {
    let body: any
    try { body = await readBody(req) } catch (e) { return fail(res, 400, (e as Error).message) }
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    if (!username || !password) return fail(res, 400, '请输入账号与密码')

    const keys = [`a:${username}`, `i:${ip}`]
    for (const k of keys) {
      const c = checkAdminAttempts(db, k)
      if (!c.allowed) {
        res.setHeader('retry-after', String(c.retryAfterSec ?? 1800))
        return fail(res, 429, `尝试过于频繁，请 ${Math.ceil((c.retryAfterSec ?? 1800) / 60)} 分钟后再试`)
      }
    }

    const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as any
    // 账号不存在与密码错误返回同一句话，避免枚举管理员账号
    if (!a || !verifyPassword(password, a.password_hash, a.password_salt)) {
      for (const k of keys) recordAdminFailure(db, k)
      return fail(res, 401, '账号或密码不正确')
    }
    if (a.status !== 'active') return fail(res, 403, '该管理员已被禁用')
    for (const k of keys) clearAdminFailures(db, k)

    db.prepare('UPDATE admins SET last_login_at = ?, last_login_ip = ? WHERE id = ?').run(nowIso(), ip, a.id)
    const token = issueAdminToken(db, a.id, ip)
    audit(db, a, 'admin.login', a.username, `从 ${ip} 登录`, ip)
    return json(res, 200, { ok: true, token, admin: toAdmin(a) })
  }

  // ── 以下全部需要管理员 token ──
  const me = currentAdmin(db, req.headers.authorization ?? '')
  if (!me) return fail(res, 401, '未登录或登录已过期')
  const role = me.role as AdminRole

  let body: any = {}
  if (req.method !== 'GET') {
    try { body = await readBody(req) } catch (e) { return fail(res, 400, (e as Error).message) }
  }

  /** 统一鉴权：把方法+路径前缀映射到权限位 */
  const need = (perm: string): boolean => {
    if (!can(role, perm)) { deny(res, perm); return false }
    return true
  }

  if (sub === '/auth/logout' && req.method === 'POST') {
    const t = (req.headers.authorization ?? '').slice(7)
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(t)
    audit(db, me, 'admin.logout', me.username, '', ip)
    return json(res, 200, { ok: true })
  }

  if (sub === '/me' && req.method === 'GET') {
    return json(res, 200, { ok: true, admin: toAdmin(me) })
  }

  // ── 邀请码管理（最紧急：现在只有 12 个，用完要改数据库）──
  if (sub === '/invites' && req.method === 'GET') {
    if (!need('invite.write')) return
    const rows = db.prepare(`
      SELECT i.*, u.nickname AS used_nickname
      FROM invites i LEFT JOIN users u ON u.code = i.used_by
      ORDER BY i.used_by IS NOT NULL, i.code`).all() as any[]
    return json(res, 200, {
      ok: true,
      invites: rows.map((r) => ({
        code: r.code, note: r.note, usedBy: r.used_by,
        usedNickname: r.used_nickname, usedAt: r.used_at, createdAt: r.created_at,
      })),
    })
  }

  if (sub === '/invites' && req.method === 'POST') {
    if (!need('invite.write')) return
    const count = Math.min(50, Math.max(1, Number(body.count) || 1))
    const prefix = String(body.prefix ?? 'CDA-BETA').replace(/[^A-Za-z0-9-]/g, '').slice(0, 16) || 'CDA-BETA'
    const note = String(body.note ?? '').slice(0, 100)
    const created: string[] = []
    const ins = db.prepare('INSERT OR IGNORE INTO invites (code, note, created_at) VALUES (?,?,?)')
    // 从现有最大编号往后接，避免与已有邀请码撞号
    let n = (db.prepare('SELECT COUNT(*) AS n FROM invites').get() as any).n
    for (let i = 0; i < count; i++) {
      let code = ''
      for (let tryN = 0; tryN < 200; tryN++) {
        n++
        code = `${prefix}-${String(n).padStart(2, '0')}`
        const exists = db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code)
        if (!exists) break
      }
      if (!code || db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code)) continue
      ins.run(code, note, nowIso())
      created.push(code)
    }
    audit(db, me, 'invite.create', created.join(','), `生成 ${created.length} 个：${note}`, ip)
    return json(res, 200, { ok: true, created })
  }

  const invDel = sub.match(/^\/invites\/(.+)$/)
  if (invDel && req.method === 'DELETE') {
    if (!need('invite.write')) return
    const code = decodeURIComponent(invDel[1]!)
    const row = db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as any
    if (!row) return fail(res, 404, '邀请码不存在')
    // 已使用的不能删 —— 删了会丢掉「谁用哪个码注册的」这条线索
    if (row.used_by) return fail(res, 400, '该邀请码已被使用，不能作废')
    db.prepare('DELETE FROM invites WHERE code = ?').run(code)
    audit(db, me, 'invite.delete', code, '', ip)
    return json(res, 200, { ok: true })
  }

  // ── 用户管理 ──
  if (sub === '/users' && req.method === 'GET') {
    if (!need('user.read')) return
    const q = (req.query.get('q') ?? '').trim()
    const status = req.query.get('status') ?? ''
    const { limit, offset } = page(req)
    const where: string[] = []
    const vals: unknown[] = []
    if (q) { where.push('(nickname LIKE ? OR code LIKE ? OR phone LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`) }
    if (status) { where.push('status = ?'); vals.push(status) }
    const sql = `SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`
    const rows = db.prepare(sql).all(...(vals as any[]), limit + 1, offset) as any[]
    const showPhone = can(role, 'user.phone')
    const list = rows.map((u) => ({
      code: u.code, nickname: u.nickname, gender: u.gender, status: u.status,
      avatarHex: u.avatar_hex, createdAt: u.created_at, lastSeenAt: u.last_seen_at,
      isOnline: !!u.is_online,
      // 手机号是唯一能定位到真人的标识：viewer 完全不可见，其他人看到也记审计
      phone: showPhone ? (u.phone ?? '') : '***',
      email: showPhone ? (u.email ?? '') : '***',
      postCount: (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_code = ?').get(u.code) as any).n,
    }))
    if (q && showPhone) audit(db, me, 'user.search', q, '含手机号检索', ip)
    return paged(res, 'users', list, limit, offset)
  }

  const userPatch = sub.match(/^\/users\/([^/]+)$/)
  if (userPatch && req.method === 'PATCH') {
    if (!need('user.disable')) return
    const code = decodeURIComponent(userPatch[1]!)
    const status = String(body.status ?? '')
    if (!['active', 'disabled'].includes(status)) return fail(res, 400, '状态只能是 active 或 disabled')
    // **禁用必须填原因** —— 强制写进审计日志，否则事后说不清为什么封的人
    const reason = String(body.reason ?? '').trim()
    if (status === 'disabled' && reason.length < 2) {
      return fail(res, 400, '禁用用户必须填写原因')
    }
    const u = db.prepare('SELECT * FROM users WHERE code = ?').get(code) as any
    if (!u) return fail(res, 404, '用户不存在')
    db.prepare('UPDATE users SET status = ? WHERE code = ?').run(status, code)
    if (status === 'disabled') {
      // 禁用即踢下线，否则他手上的 token 还能用到过期
      db.prepare('DELETE FROM sessions WHERE code = ?').run(code)
      db.prepare('UPDATE users SET is_online = 0 WHERE code = ?').run(code)
    }
    audit(db, me, status === 'disabled' ? 'user.disable' : 'user.enable', code, reason, ip)
    return json(res, 200, { ok: true })
  }

  const userDel = sub.match(/^\/users\/([^/]+)$/)
  if (userDel && req.method === 'DELETE') {
    if (!need('user.delete')) return
    const code = decodeURIComponent(userDel[1]!)
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 2) return fail(res, 400, '删除用户必须填写原因')
    const u = db.prepare('SELECT * FROM users WHERE code = ?').get(code) as any
    if (!u) return fail(res, 404, '用户不存在')
    // ⚠️ 删除前先单独备份一次。
    // 起因：曾误删过 3 个刚注册的用户，而当日备份还是几小时前的、
    // WAL 也已 checkpoint，数据完全找不回来。这个代价不能再付第二次。
    try {
      const dir = process.env.CDA_BACKUP_DIR ?? join(dirname(process.env.CDA_DB ?? './data/cda.db'), 'backups')
      mkdirSync(dir, { recursive: true })
      const f = join(dir, `predelete-${code}-${Date.now()}.db`)
      db.exec(`VACUUM INTO '${f}'`)
      console.log(`[CDA] 删除用户前已备份：${f}`)
    } catch (e) {
      return fail(res, 500, `删除前的安全备份失败，已中止删除：${(e as Error).message}`)
    }
    // 外键都是 ON DELETE CASCADE，删用户会连带清掉他的帖子/消息/地址等
    db.prepare('DELETE FROM users WHERE code = ?').run(code)
    audit(db, me, 'user.delete', code, `昵称 ${u.nickname}｜原因：${reason}`, ip)
    return json(res, 200, { ok: true })
  }

  // ── 审计日志 ──
  if (sub === '/logs' && req.method === 'GET') {
    if (!need('audit.read')) return
    const { limit, offset } = page(req)
    const rows = db.prepare('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit + 1, offset) as any[]
    return paged(res, 'logs', rows.map((r) => ({
      id: r.id, username: r.username, action: r.action, target: r.target,
      detail: r.detail, ip: r.ip, createdAt: r.created_at,
    })), limit, offset)
  }

  // ── 看板 ──
  if (sub === '/dashboard' && req.method === 'GET') {
    if (!need('stats.read')) return
    const one = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...(a as any[])) as any).n as number
    const since7 = new Date(Date.now() - 7 * 864e5).toISOString()
    return json(res, 200, {
      ok: true,
      stats: {
        users: one('SELECT COUNT(*) AS n FROM users'),
        usersNew7d: one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', since7),
        online: one('SELECT COUNT(*) AS n FROM users WHERE is_online = 1'),
        posts: one('SELECT COUNT(*) AS n FROM posts'),
        comments: one('SELECT COUNT(*) AS n FROM comments'),
        messages: one('SELECT COUNT(*) AS n FROM messages'),
        invitesTotal: one('SELECT COUNT(*) AS n FROM invites'),
        invitesAvailable: one('SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL'),
        reportsPending: one("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"),
      },
    })
  }

  return fail(res, 404, `无此管理接口：${req.method} ${pathname}`)
}

// ── 静态文件 ──────────────────────────────────────────

const WEB_ROOT = process.env.CDA_WEB ?? '../client/dist/build/h5'
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  // 3D 网格是二进制大文件，必须给对类型并允许长缓存
  '.obj': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  /*
   * ⚠️ WASM 必须是 application/wasm。
   * 给成 application/octet-stream 时，浏览器会拒绝
   * WebAssembly.instantiateStreaming（它按 MIME 决定能否流式编译），
   * 表现为端侧推理模型加载失败 —— 而静态文件本身明明返回 200，
   * 排查时很容易误以为是模型或路径的问题。
   */
  '.wasm': 'application/wasm',
  // MediaPipe 的模型包（按 arrayBuffer 读取，octet-stream 即可）
  '.task': 'application/octet-stream',
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\//, '')
  // 比较路径边界，不能用字符串前缀（web-private 并不属于 web）。
  const rootAbs = resolve(WEB_ROOT)
  const full = resolve(rootAbs, rel)
  const fromRoot = relative(rootAbs, full)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return fail(res, 403, '禁止访问')
  }

  let target = full
  if (!existsSync(target) || statSync(target).isDirectory()) {
    // hash 路由：找不到的路径一律回落到 index.html
    target = join(WEB_ROOT, 'index.html')
    if (!existsSync(target)) {
      return fail(res, 404, '前端尚未构建（先跑 pnpm build）')
    }
  }
  try {
    const buf = readFileSync(target)
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    const headers: Record<string, string> = { 'content-type': type, 'content-length': String(buf.length) }
    // 带内容哈希的资源可长缓存；index.html 必须每次校验
    headers['cache-control'] = target.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=2592000'
    res.writeHead(200, headers)
    res.end(buf)
  } catch {
    fail(res, 500, '读取静态文件失败')
  }
}

// ── 服务 ──────────────────────────────────────────────

async function handleRequest(rawReq: IncomingMessage, res: ServerResponse): Promise<void> {
  const req = rawReq as Req
  // 开发期内测：允许任意来源，方便隧道与手机访问
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type, authorization')
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = new URL(req.url ?? '/', 'http://localhost')
  req.query = url.searchParams
  req.params = {}

  if (url.pathname === '/api/health') return json(res, 200, { ok: true, ts: nowIso() })

  // ── 管理后台 ──
  // 与用户接口走**完全独立**的分发路径：独立 token、独立中间件。
  // 用户 token 拿到这里一定解析不出管理员，反之亦然。
  if (url.pathname.startsWith('/api/admin')) {
    return handleAdmin(req, res, url.pathname)
  }

  // ── 静态前端 ──
  // 由后端一起托管前端，前后端同源：只需暴露一个端口、一条隧道，
  // 前端默认的 /api 就能直接用，也不用处理跨域。
  if (!url.pathname.startsWith('/api')) {
    return serveStatic(url.pathname, res)
  }

  const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname))
  if (!match) return fail(res, 404, `无此接口：${req.method} ${url.pathname}`)

  const m = match.re.exec(url.pathname)!
  match.keys.forEach((k, i) => (req.params[k] = decodeURIComponent(m[i + 1]!)))

  try {
    req.body = req.method === 'GET' ? {} : await readBody(req)
  } catch (e) {
    return fail(res, 400, (e as Error).message)
  }

  if (match.auth) {
    const u = currentUser(req)
    if (!u) return fail(res, 401, '未登录或登录已过期')
    req.code = u.code
    touchPresence(u.code)
  }

  await match.fn(req, res)
}

// 覆盖整条分发链路，包括 URL 解码、静态资源及独立的后台异步处理。
// http 的事件回调不会接管 Promise rejection，必须在这里显式捕获。
const server = createServer((req, res) => {
  void handleRequest(req, res).catch((e) => {
    const invalidUrl = e instanceof URIError
    if (!invalidUrl) console.error('[CDA] 请求异常', req.method, req.url, e)
    if (!res.headersSent) fail(res, invalidUrl ? 400 : 500, invalidUrl ? 'URL 编码不正确' : '服务器内部错误')
    else res.destroy()
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[CDA] 后端已启动 http://0.0.0.0:${PORT}  数据库 ${DB_PATH}`)
})
