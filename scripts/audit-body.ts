/**
 * 身型变形全组合审计。
 *
 * 目的：不再靠人眼看截图，而是**遍历所有参数组合**，用几何指标自动找出异常。
 *
 * 核心指标 —— **边拉伸率**：
 *   网格的每条边在变形前后的长度比。人偶被撕开、长出尖刺、局部塌陷，
 *   都会表现为个别边的拉伸率异常（远超 1 或远小于 1）。
 *   正常变形下绝大多数边的拉伸率应集中在 1 附近。
 *
 * 跑法：
 *   node_modules/.bin/esbuild scripts/audit-body.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/audit.mjs && node /tmp/audit.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createBodyState, deriveProfile, setHeight, setWeight, setGirth, setFrame,
  rangeOf, GIRTH_KEYS, FRAME_KEYS, FRAME_RANGES, HEIGHT_RANGE, WEIGHT_RANGE,
  type BodyState, type FrameKey, type GirthKey, type Gender,
} from '../packages/core/src/index'
import { MeshBody } from '../packages/tryon-engine/src/mesh-body'

/** 从 OBJ 文本里取出三角面，用于构建边表 */
function parseEdges(text: string): Array<[number, number]> {
  const edges = new Set<number>()
  const key = (a: number, b: number) => (a < b ? a * 1e7 + b : b * 1e7 + a)
  for (const line of text.split('\n')) {
    if (!line.startsWith('f ')) continue
    const idx = line.split(/\s+/).slice(1).map((t) => parseInt(t.split('/')[0]!, 10) - 1)
    for (let i = 1; i < idx.length - 1; i++) {
      const tri = [idx[0]!, idx[i]!, idx[i + 1]!]
      for (let k = 0; k < 3; k++) edges.add(key(tri[k]!, tri[(k + 1) % 3]!))
    }
  }
  return [...edges].map((v) => [Math.floor(v / 1e7), v % 1e7] as [number, number])
}

interface Audit {
  spots: number[][]
  maxStretch: number
  p999: number
  badEdges: number
  totalEdges: number
  worstAt: number
}

/**
 * 审计一个变形结果。
 *
 * ⚠️ 指标的选择很关键。最初用「边的伸缩比」直接判异常，但网格平均边长
 * 只有约 6mm，一次**平滑**的变形就能让 6mm 的边变成 9mm（比值 1.5），
 * 于是正常变形被大量误判。
 *
 * 正确指标是**局部离群**：平滑变形会让相邻边的伸缩程度彼此接近，
 * 只有撕裂、尖刺、塌陷才会让某条边明显偏离它的邻居。
 * 所以这里比较「这条边的伸缩」与「该边两端顶点所有邻边的平均伸缩」。
 */
function auditOnce(
  mb: MeshBody,
  ref: Float32Array,
  edges: Array<[number, number]>,
  heightM: number,
): Audit {
  const pos = mb.getPositions()
  const nVerts = ref.length / 3
  const logStr = new Float32Array(edges.length)
  const incSum = new Float64Array(nVerts)
  const incCnt = new Int32Array(nVerts)

  for (let e = 0; e < edges.length; e++) {
    const [a, b] = edges[e]!
    const rx = ref[a * 3]! - ref[b * 3]!
    const ry = ref[a * 3 + 1]! - ref[b * 3 + 1]!
    const rz = ref[a * 3 + 2]! - ref[b * 3 + 2]!
    const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) * heightM
    const px = pos[a * 3]! - pos[b * 3]!
    const py = pos[a * 3 + 1]! - pos[b * 3 + 1]!
    const pz = pos[a * 3 + 2]! - pos[b * 3 + 2]!
    const pl = Math.sqrt(px * px + py * py + pz * pz)
    const v = rl > 1e-7 ? Math.log(Math.max(pl / rl, 1e-6)) : 0
    logStr[e] = v
    incSum[a] += v
    incCnt[a]++
    incSum[b] += v
    incCnt[b]++
  }

  let maxOut = 0
  let worstAt = -1
  const worstSpots: number[][] = []
  let badEdges = 0
  const outs: number[] = []
  for (let e = 0; e < edges.length; e++) {
    const [a, b] = edges[e]!
    // 邻居基准：两端顶点各自的平均伸缩
    const ma = incCnt[a] ? incSum[a] / incCnt[a] : 0
    const mb = incCnt[b] ? incSum[b] / incCnt[b] : 0
    const base = (ma + mb) / 2
    const out = Math.abs(logStr[e]! - base)
    outs.push(out)
    if (out > maxOut) {
      maxOut = out
      worstAt = a
    }
    if (out > Math.log(2.5)) {
      // 记录位置（归一化单位），便于判断是哪一部位出的问题
      worstSpots.push([
        +(ref[a * 3]!).toFixed(3), +(ref[a * 3 + 1]!).toFixed(3), +(ref[a * 3 + 2]!).toFixed(3),
      ])
    }
    // 局部伸缩偏离邻居 1.8 倍以上 → 视为异常
    if (out > Math.log(1.8)) badEdges++
  }
  outs.sort((x, y) => x - y)
  return {
    spots: worstSpots.slice(0, 4),
    maxStretch: Math.exp(maxOut),
    p999: Math.exp(outs[Math.floor(outs.length * 0.999)] ?? 0),
    badEdges,
    totalEdges: edges.length,
    worstAt,
  }
}

const MESH: Record<Gender, string> = {
  male: 'apps/client/src/static/models/male.obj',
  female: 'apps/client/src/static/models/female.obj',
}

const texts: Record<string, string> = {}
const edgesCache: Record<string, Array<[number, number]>> = {}
for (const g of ['male', 'female'] as const) {
  texts[g] = readFileSync(MESH[g], 'utf8')
  edgesCache[g] = parseEdges(texts[g])
  console.log(`${g}: ${edgesCache[g]!.length} 条边`)
}

interface Case {
  label: string
  gender: Gender
  apply: (s: BodyState) => BodyState
}

const cases: Case[] = []
for (const gender of ['male', 'female'] as const) {
  const base = createBodyState(gender)
  // 每个参数取两端
  cases.push({ label: `${gender} 身高min`, gender, apply: (s) => setHeight(s, HEIGHT_RANGE[gender].min) })
  cases.push({ label: `${gender} 身高max`, gender, apply: (s) => setHeight(s, HEIGHT_RANGE[gender].max) })
  const wAbs = WEIGHT_RANGE[gender]
  const wDer = rangeOf(base, 'weightKg')
  cases.push({ label: `${gender} 体重min`, gender, apply: (s) => setWeight(s, Math.max(wAbs.min, wDer.min)) })
  cases.push({ label: `${gender} 体重max`, gender, apply: (s) => setWeight(s, Math.min(wAbs.max, wDer.max)) })
  for (const k of GIRTH_KEYS) {
    const r = rangeOf(base, k)
    cases.push({ label: `${gender} ${k}=min`, gender, apply: (s) => setGirth(s, k as GirthKey, r.min) })
    cases.push({ label: `${gender} ${k}=max`, gender, apply: (s) => setGirth(s, k as GirthKey, r.max) })
  }
  for (const k of FRAME_KEYS) {
    cases.push({ label: `${gender} ${k}=min`, gender, apply: (s) => setFrame(s, k, FRAME_RANGES[k].min) })
    cases.push({ label: `${gender} ${k}=max`, gender, apply: (s) => setFrame(s, k, FRAME_RANGES[k].max) })
  }
  // 全参数同时拉到两端 —— 最容易暴露问题的组合
  cases.push({
    label: `${gender} 全部最小`,
    gender,
    apply: (s) => {
      let n = setHeight(s, HEIGHT_RANGE[gender].min)
      n = setFrame(n, 'shoulderWidthCm', FRAME_RANGES.shoulderWidthCm.min)
      n = setFrame(n, 'neckLengthCm', FRAME_RANGES.neckLengthCm.min)
      n = setFrame(n, 'torsoLengthCm', FRAME_RANGES.torsoLengthCm.min)
      n = setFrame(n, 'upperArmCm', FRAME_RANGES.upperArmCm.min)
      n = setFrame(n, 'forearmCm', FRAME_RANGES.forearmCm.min)
      n = setFrame(n, 'thighCm', FRAME_RANGES.thighCm.min)
      n = setFrame(n, 'calfCm', FRAME_RANGES.calfCm.min)
      return setWeight(n, Math.max(wAbs.min, wDer.min))
    },
  })
  cases.push({
    label: `${gender} 全部最大`,
    gender,
    apply: (s) => {
      let n = setHeight(s, HEIGHT_RANGE[gender].max)
      n = setFrame(n, 'shoulderWidthCm', FRAME_RANGES.shoulderWidthCm.max)
      n = setFrame(n, 'neckLengthCm', FRAME_RANGES.neckLengthCm.max)
      n = setFrame(n, 'torsoLengthCm', FRAME_RANGES.torsoLengthCm.max)
      n = setFrame(n, 'upperArmCm', FRAME_RANGES.upperArmCm.max)
      n = setFrame(n, 'forearmCm', FRAME_RANGES.forearmCm.max)
      n = setFrame(n, 'thighCm', FRAME_RANGES.thighCm.max)
      n = setFrame(n, 'calfCm', FRAME_RANGES.calfCm.max)
      return setWeight(n, Math.min(wAbs.max, wDer.max))
    },
  })
}

const bodies: Record<string, MeshBody> = {}
for (const g of ['male', 'female'] as const) {
  bodies[g] = MeshBody.loadFromText(texts[g]!, deriveProfile(createBodyState(g)), g)
}

console.log(`\n共 ${cases.length} 个用例\n`)
const results: Array<{ label: string; a: Audit }> = []
for (const c of cases) {
  const st = c.apply(createBodyState(c.gender))
  const prof = deriveProfile(st)
  const mb = bodies[c.gender]!
  mb.setProfile(prof)
  const a = auditOnce(mb, mb.getReference(), edgesCache[c.gender]!, prof.heightCm / 100)
  results.push({ label: c.label, a })
}

results.sort((x, y) => y.a.maxStretch - x.a.maxStretch)
console.log('最严重的 12 个用例（maxStretch 越大越异常，正常应接近 1）')
console.log('  用例                          局部离群  99.9分位  异常边/总边')
for (const r of results.slice(0, 12)) {
  console.log(
    `  ${r.label.padEnd(28)} ${r.a.maxStretch.toFixed(3).padStart(8)}  ${r.a.p999.toFixed(3).padStart(8)}  ${String(r.a.badEdges).padStart(6)}/${r.a.totalEdges}  位置 ${(r.a.spots[0] ?? []).join(',')}`,
  )
}
const worst = results[0]!
console.log(`\n全局最差：${worst.label}  maxStretch=${worst.a.maxStretch.toFixed(3)}  顶点 ${worst.a.worstAt}`)

for (const result of results) {
  assert.equal(result.a.badEdges, 0, `${result.label}: locally distorted edges`)
}
for (const body of Object.values(bodies)) body.dispose()
console.log(`PASS: ${cases.length} parameter-boundary cases, no local edge outliers above 1.8x`)
