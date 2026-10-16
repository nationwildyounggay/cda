/** Local-only regressions: each case owns a temporary database and server. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const results = []

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cda-regression-'))
  const web = join(dir, 'web')
  mkdirSync(web)
  writeFileSync(join(web, 'index.html'), '<html>CDA test</html>')
  writeFileSync(join(web, 'app.js'), '/* static asset */')
  mkdirSync(join(dir, 'web-private'))
  writeFileSync(join(dir, 'web-private', 'secret.txt'), 'private fixture')
  writeFileSync(join(dir, 'private.png'), 'private avatar fixture')
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((done) => listener.close(done))
  const child = spawn(process.execPath, ['src/index.ts'], {
    cwd: join(ROOT, 'apps/server'),
    env: {
      ...process.env, CDA_PORT: String(port), CDA_DB: join(dir, 'test.db'), CDA_WEB: web,
      CDA_INVITES: Array.from({ length: 12 }, (_, i) => `ZZTEST-REG-${i}`).join(','),
      CDA_ADMIN_USER: 'regression-admin', CDA_ADMIN_PASS: 'LocalTestPassword123',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const exited = once(child, 'exit')
  async function request(path, { token, body, raw, method = 'GET' } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(3000),
    })
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = null }
    return { status: response.status, headers: response.headers, text, data }
  }
  let next = 0
  async function register(extra = {}) {
    const i = next++
    const response = await request('/api/auth/register', { method: 'POST', body: {
      inviteCode: `ZZTEST-REG-${i}`, email: `user${i}@example.test`,
      password: 'LocalPassword123', nickname: `用户${i}`, ...extra,
    } })
    assert.equal(response.status, 200, response.text)
    return response.data
  }
  try {
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`)
      try { ready = (await request('/api/health')).status === 200 } catch {}
      if (ready) break
      await new Promise((done) => setTimeout(done, 30))
    }
    assert.ok(ready, `Server did not start: ${output}`)
    await run({ request, register, dir })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    rmSync(dir, { recursive: true, force: true })
  }
}

async function test(name, run) {
  try {
    await fixture(run)
    results.push(true)
    console.log(`✅ ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`❌ ${name}: ${error.message}`)
  }
}

await test('聊天默认返回最新 50 条；相同时间戳顺序稳定，旧页不重叠且只标记已返回消息', async ({ request, register, dir }) => {
  const sender = await register()
  const reader = await register()
  const ids = []
  for (let i = 0; i < 55; i++) {
    const sent = await request(`/api/conversations/${reader.user.code}/messages`, {
      token: sender.token, method: 'POST', body: { text: `message-${i}` },
    })
    assert.equal(sent.status, 200)
    ids.push(sent.data.message.id)
  }
  // Force timestamp collisions to exercise the pagination tie-breaker.
  const db = new DatabaseSync(join(dir, 'test.db'))
  try { db.prepare('UPDATE messages SET created_at = ?').run('2026-01-01T00:00:00.000Z') }
  finally { db.close() }
  const path = `/api/conversations/${sender.user.code}/messages?limit=50`
  const latest = await request(path, { token: reader.token })
  assert.equal(latest.status, 200)
  assert.deepEqual(latest.data.messages.map((m) => m.id), ids.slice(5))
  assert.equal(latest.data.hasMore, true)
  assert.equal(latest.data.nextOffset, 50)
  const inbox = await request('/api/conversations', { token: reader.token })
  assert.equal(inbox.data.conversations[0].unread, 5)
  const older = await request(`${path}&offset=50`, { token: reader.token })
  assert.deepEqual(older.data.messages.map((m) => m.id), ids.slice(0, 5))
  assert.equal(older.data.hasMore, false)
  assert.equal(older.data.nextOffset, null)
  const read = await request('/api/conversations', { token: reader.token })
  assert.equal(read.data.conversations[0].unread, 0)
})

await test('隐藏用户先过滤再分页，所有可见用户均能遍历', async ({ request, register }) => {
  const viewer = await register()
  const visible = []
  for (let i = 0; i < 6; i++) {
    const hide = [0, 1, 3].includes(i)
    const user = await register({ nickname: `分页用户${i}`, privacy: { hideFromSearch: hide } })
    if (!hide) visible.push(user.user.code)
  }
  const found = []
  let offset = 0
  do {
    const result = await request(`/api/users?q=${encodeURIComponent('分页用户')}&limit=1&offset=${offset}`, { token: viewer.token })
    assert.equal(result.status, 200)
    assert.equal(result.data.users.length, 1)
    found.push(result.data.users[0].code)
    offset = result.data.nextOffset
    assert.equal(result.data.hasMore, offset !== null)
  } while (offset !== null && found.length < 10)
  assert.deepEqual(found, visible)
})

await test('分页的小数、Infinity、NaN 和越界值不会触发 SQLite 500', async ({ request, register }) => {
  const user = await register()
  const token = user.token
  for (let i = 0; i < 3; i++) {
    assert.equal((await request('/api/posts', { token, method: 'POST', body: { title: `post-${i}` } })).status, 200)
  }
  const fractional = await request('/api/posts?limit=1.9&offset=1.2', { token })
  assert.equal(fractional.status, 200, fractional.text)
  assert.equal(fractional.data.posts.length, 1)
  assert.equal(fractional.data.nextOffset, 2)
  for (const query of ['limit=NaN&offset=Infinity', 'limit=Infinity&offset=-1', 'limit=-2&offset=NaN', 'limit=2&offset=1e100']) {
    const result = await request(`/api/posts?${query}`, { token })
    assert.equal(result.status, 200, `${query}: ${result.text}`)
  }
})

await test('静态文件不能越界读取同前缀目录，正常资源与 hash 路由仍可用', async ({ request }) => {
  const escaped = await request('/%2e%2e%2fweb-private%2fsecret.txt')
  assert.equal(escaped.status, 403)
  assert.ok(!escaped.text.includes('private fixture'))
  assert.equal((await request('/app.js')).text, '/* static asset */')
  assert.equal((await request('/missing-route')).text, '<html>CDA test</html>')
})

await test('头像路径参数不能读取 avatars 目录之外的图片', async ({ request, dir }) => {
  mkdirSync(join(dir, 'avatars'))
  const escaped = await request('/api/avatar/..%2fprivate')
  assert.equal(escaped.status, 400)
  assert.ok(!escaped.text.includes('private avatar fixture'))
})

for (const path of ['/%E0%A4%A', '/api/avatar/%E0%A4%A', '/api/admin/invites/%E0%A4%A']) {
  await test(`非法 URL 编码返回 400 且进程继续服务：${path}`, async ({ request }) => {
    let token
    let method = 'GET'
    if (path.startsWith('/api/admin/')) {
      const login = await request('/api/admin/auth/login', { method: 'POST', body: {
        username: 'regression-admin', password: 'LocalTestPassword123',
      } })
      assert.equal(login.status, 200)
      token = login.data.token
      method = 'DELETE'
    }
    const bad = await request(path, { token, method })
    assert.equal(bad.status, 400)
    assert.equal((await request('/api/health')).status, 200)
  })
}

await test('用户与后台接口拒绝非对象 JSON，后续请求仍可正常处理', async ({ request }) => {
  for (const path of ['/api/auth/login', '/api/admin/auth/login']) {
    for (const raw of ['null', '[]', '42', '"text"', '{']) {
      const result = await request(path, { method: 'POST', raw })
      assert.equal(result.status, 400, `${path}: ${raw}`)
      assert.equal((await request('/api/health')).status, 200)
    }
  }
})

console.log(`\n通过 ${results.filter(Boolean).length}/${results.length}`)
process.exitCode = results.every(Boolean) ? 0 : 1
