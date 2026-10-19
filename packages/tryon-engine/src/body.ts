/**
 * 参数化人体 —— 由身型数据生成连续肉体。
 *
 * 范式（参考逆水寒 / 燕云十六声那类角色创建器）：
 *   1. 身型数据 → **骨架**（各段长度、关节位置）
 *   2. 骨架 → **肉块列表**（变径胶囊链，中段半径隆起 = 肌肉）
 *   3. 肉块平滑并集 → **SDF**
 *   4. SDF → **Surface Nets 多边形化** → 网格
 *
 * 为什么不用显式的「躯干放样 + 圆柱四肢 + 球关节」：
 *   拼装件之间必然有接缝与硬过渡，而且圆柱半径沿轴线性变化，
 *   做不出肱二头肌那种中段鼓起的轮廓 —— 所以怎么调都像积木。
 *   SDF 的平滑并集让肉块真正「长在一起」，肌肉线条是自然涌现的。
 *
 * 关于私密部位：**刻意不做**。性别差异通过肩宽、腰臀比、胸廓、骨盆、
 * 四肢粗细这些体块轮廓来表达，不用生殖器 —— 这既是合规与观感考虑，
 * 也是服装展示人台的行业惯例。
 */
import * as THREE from 'three'
import type { BodyProfile, Gender } from '@cda/core'
import { findBuild, type BodyBuild } from '@cda/core'
import { polygonize } from './surface-nets'
import { blobsBounds, compileSdf, raySurface, type SdfBlob, type Vec3 } from './sdf'

// ────────────────────────────────────────────────────────────
// 几何辅助
// ────────────────────────────────────────────────────────────

/** 椭圆周长（Ramanujan 近似） */
function ellipsePerimeter(a: number, b: number): number {
  const h = ((a - b) / (a + b)) ** 2
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}

/**
 * 由围度反解椭圆半轴。
 * 围度是用户最容易量的数据，但它对应的是周长，需要解出横/纵半轴才能建模。
 * 给定深度比（b/a）后做一次二分即可。
 */
function semiAxes(C: number, depthRatio: number): { w: number; d: number } {
  let lo = (C / (2 * Math.PI)) * 0.6
  let hi = (C / (2 * Math.PI)) * 1.4
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) / 2
    if (ellipsePerimeter(mid, mid * depthRatio) < C) lo = mid
    else hi = mid
  }
  const a = (lo + hi) / 2
  return { w: a, d: a * depthRatio }
}

// ────────────────────────────────────────────────────────────
// 骨架
// ────────────────────────────────────────────────────────────

export interface LimbChain {
  side: -1 | 1
  /** 根部（肩 / 胯） */
  root: Vec3
  /** 中关节（肘 / 膝） */
  mid: Vec3
  /** 末端（腕 / 踝） */
  end: Vec3
  /** 根部半径 */
  rRoot: number
  /** 中关节半径 */
  rMid: number
  /** 末端半径 */
  rEnd: number
}

export interface BodySkeleton {
  gender: Gender
  /** 形体风格：决定肌肉隆起与脂肪堆积的强度 */
  build: BodyBuild
  /** 身高（米） */
  height: number
  /** 关键高度（米，y 从脚底起算） */
  ankleY: number
  kneeY: number
  hipY: number
  waistY: number
  chestY: number
  shoulderY: number
  chinY: number
  headTopY: number

  /** 胸腔半宽/半深 */
  chest: { w: number; d: number }
  /** 腰部 */
  waist: { w: number; d: number }
  /** 骨盆 */
  hip: { w: number; d: number }
  /** 肩半宽 */
  shoulderHalf: number

  arms: LimbChain[]
  legs: LimbChain[]

  /** 头大小 */
  head: { w: number; h: number; d: number }
  /** 颈半径 */
  neckR: number
  /** 脚踝半径 */
  ankleR: number
}

export function buildSkeleton(profile: BodyProfile): BodySkeleton {
  const male = profile.gender === 'male'
  const H = profile.heightCm / 100

  // ── 纵向分段先归一化，保证各段之和恰好等于身高 ──
  // 用户给的数据常常不自洽（比如各段加起来不等于身高），
  // 直接照用会让人偶比例崩掉。这里统一按比例缩放，既不丢失用户意图，
  // 又保证模型一定站得完整。
  const rawAnkle = 0.045 * H
  const rawHead = 0.13 * H
  const rawCalf = profile.calfCm / 100
  const rawThigh = profile.thighCm / 100
  const rawTorso = profile.torsoLengthCm / 100
  const rawNeck = profile.neckLengthCm / 100
  const total = rawAnkle + rawCalf + rawThigh + rawTorso + rawNeck + rawHead
  const k = total > 0 ? H / total : 1

  const ankleY = rawAnkle * k
  const kneeY = ankleY + rawCalf * k
  const hipY = kneeY + rawThigh * k
  const shoulderY = hipY + rawTorso * k
  const chinY = shoulderY + rawNeck * k
  const headTopY = chinY + rawHead * k

  // ── 横断面 ──
  const chest = semiAxes(profile.chestCm / 100, male ? 0.8 : 0.74)
  const waist = semiAxes(profile.waistCm / 100, male ? 0.82 : 0.78)
  const hip = semiAxes(profile.hipCm / 100, male ? 0.78 : 0.76)
  const shoulderHalf = profile.shoulderWidthCm / 200

  const waistY = hipY + (shoulderY - hipY) * 0.26
  const chestY = hipY + (shoulderY - hipY) * 0.74

  // ── 四肢 ──
  const upperArmR = semiAxes(profile.upperArmCircCm / 100, 0.94).w
  const thighR = semiAxes(profile.thighCircCm / 100, 0.95).w
  /**
   * 手臂倾角。**必须与雕刻网格的站姿一致** ——
   * 网格是 A 字（约 45°），而这里原本只有 8–10°，
   * 于是衣服袖子照着近乎垂直的手臂建出来，
   * 飘在网格实际手臂旁边的空气里（实测：点击穿上完全不贴合）。
   */
  const armTilt = 0.80
  const upperLen = profile.upperArmCm / 100
  const foreLen = profile.forearmCm / 100

  const arms: LimbChain[] = ([-1, 1] as const).map((side) => {
    const rootX = side * shoulderHalf * 0.86
    const root: Vec3 = [rootX, shoulderY - 0.012, 0]
    const elbowX = rootX + side * Math.sin(armTilt) * upperLen
    const elbow: Vec3 = [elbowX, root[1] - Math.cos(armTilt) * upperLen, 0.012 * upperLen]
    const wristX = elbowX + side * Math.sin(armTilt * 0.95) * foreLen
    const wrist: Vec3 = [wristX, elbow[1] - Math.cos(armTilt * 0.95) * foreLen, elbow[2] + 0.01]
    // 半径系数必须让**上臂中段真正达到实测围度**。
    // 原先 rRoot 0.92 / rMid 0.82，等于系统性地比实测细一成 ——
    // 这正是「手臂太细」的直接来源。
    const rMid = upperArmR * 0.92
    return {
      side, root, mid: elbow, end: wrist,
      rRoot: upperArmR * 1.02,
      rMid,
      rEnd: upperArmR * 0.62,
    }
  })

  const legs: LimbChain[] = ([-1, 1] as const).map((side) => {
    const rootX = side * hip.w * 0.48
    const root: Vec3 = [rootX, hipY, 0]
    const kneeX = side * hip.w * 0.44
    const knee: Vec3 = [kneeX, kneeY, 0.008]
    const ankleX = side * hip.w * 0.4
    const ankle: Vec3 = [ankleX, ankleY, 0]
    return {
      side, root, mid: knee, end: ankle,
      rRoot: thighR * 1.0,
      // 膝盖约 0.64 倍大腿半径、脚踝约 0.40 —— 按实际人体测量取，
      // 原先的 0.6 / 0.34 让小腿偏细
      rMid: thighR * 0.64,
      rEnd: thighR * 0.4,
    }
  })

  return {
    gender: profile.gender,
    build: findBuild(profile.build),
    height: H,
    ankleY, kneeY, hipY, waistY, chestY, shoulderY, chinY, headTopY,
    chest, waist, hip, shoulderHalf,
    arms, legs,
    head: { w: 0.092 * H, h: 0.134 * H, d: 0.108 * H },
    neckR: Math.max(0.042, chest.w * 0.3),
    ankleR: legs[0]!.rEnd,
  }
}

// ────────────────────────────────────────────────────────────
// 肉块
// ────────────────────────────────────────────────────────────

/**
 * 由骨架生成肉块。
 *
 * 肌肉的做法：每个肢体段先放一根**变径胶囊**作为核心，
 * 再在肌肉隆起处加一颗球 —— 平滑并集会自动把它揉成一个鼓包，
 * 于是肱二头肌与小腿肚就出来了，不需要手工雕网格。
 */
/**
 * 一块肌腹。
 *
 * 肌肉的解剖事实（这也是之前做错的地方）：
 *   1. 形状是**纺锤形** —— 中间粗、两端连腱变细，不是一个球
 *   2. 长在肢体的**特定方位**上 —— 肱二头肌在前侧、腘绳肌在后侧、
 *      股四头肌在前侧、腓肠肌在后侧偏上
 * 之前直接把球放在肢体轴心上，出来就是「肢体上长了个球」，而且方位全错。
 *
 * 这里用沿肢体轴向拉长的椭球，并按解剖方位偏移到前/后/侧。
 */
function muscleBelly(
  a: Vec3,
  b: Vec3,
  centerT: number,
  radiusAcross: number,
  halfLengthAlong: number,
  offX: number,
  offY: number,
  offZ: number,
): SdfBlob {
  return {
    kind: 'ellipsoid',
    c: [
      a[0] + (b[0] - a[0]) * centerT + offX,
      a[1] + (b[1] - a[1]) * centerT + offY,
      a[2] + (b[2] - a[2]) * centerT + offZ,
    ],
    r: [radiusAcross, halfLengthAlong, radiusAcross],
  }
}

function dist3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** 由骨架生成肉块。见文件头对「骨架→肉块→SDF」管线的说明。 */
function buildBlobs(s: BodySkeleton): SdfBlob[] {
  const blobs: SdfBlob[] = []
  const male = s.gender === 'male'
  const span = s.shoulderY - s.hipY
  const mf = s.build.muscleFactor
  const ff = s.build.fatFactor

  // ── 躯干：沿脊柱扫掠的变截面体 ──
  // 一个图元搞定，截面在 胯 → 腰 → 胸 → 肩 之间**连续**变化。
  // 早先用三个独立椭球拼，竖向不重叠，中间塌出了夸张的蜂腰。
  blobs.push({
    kind: 'loft',
    stations: [
      { y: s.hipY - span * 0.2, w: s.hip.w * 0.3, d: s.hip.d * 0.3 },
      { y: s.hipY - span * 0.12, w: s.hip.w * 0.62, d: s.hip.d * 0.58 },
      { y: s.hipY - span * 0.05, w: s.hip.w * 0.92, d: s.hip.d * 0.88 },
      { y: s.hipY, w: s.hip.w, d: s.hip.d },
      { y: s.waistY, w: s.waist.w, d: s.waist.d },
      {
        y: s.chestY,
        // 男性：胸廓更宽、更平；女性：胸量用更饱满的截面深度表达，
        // 刻意不加两颗球 —— 那会变成突兀的疙瘩，作为人台很不体面
        w: s.chest.w * (male ? 1.08 : 0.98),
        d: s.chest.d * (male ? 1.0 : 1.24),
      },
      // 肩部这一段要**多给一个中间站位**：否则肩线以上收得太急，
      // 三角肌无处融合，会变成两块像肩垫一样独立的凸起。
      // 这个中间站就是斜方肌的坡度。
      { y: s.shoulderY - span * 0.04, w: s.shoulderHalf * 0.98, d: s.chest.d * 0.92 },
      { y: s.shoulderY + span * 0.02, w: s.shoulderHalf * 0.74, d: s.chest.d * 0.72 },
      { y: s.shoulderY + span * 0.09, w: s.neckR * 1.4, d: s.neckR * 1.3 },
    ],
  })

  // ── 臀大肌：向后偏、上下略扁的软组织，不是球。脂肪型更饱满 ──
  const gluteR = s.hip.w * (male ? 0.4 : 0.44) * (1 + ff * 0.45)
  for (const side of [-1, 1] as const) {
    blobs.push({
      kind: 'ellipsoid',
      c: [side * s.hip.w * 0.38, s.hipY - span * 0.03, -s.hip.d * (male ? 0.58 : 0.64)],
      r: [gluteR, gluteR * 0.85, gluteR * 0.82],
    })
  }

  // ── 脂肪：腹部 + 腰侧。真人脂肪优先堆在这两处，而不是均匀变胖 ──
  if (ff > 0.12) {
    blobs.push({
      kind: 'ellipsoid',
      c: [0, s.waistY - span * 0.05, s.waist.d * (0.4 + ff * 0.45)],
      r: [s.waist.w * (0.5 + ff * 0.32), span * 0.15, s.waist.d * (0.5 + ff * 0.4)],
    })
    for (const side of [-1, 1] as const) {
      blobs.push({
        kind: 'ellipsoid',
        c: [side * s.waist.w * 0.82, s.waistY - span * 0.02, 0],
        r: [s.waist.w * 0.22 * ff, span * 0.11, s.waist.d * 0.5],
      })
    }
  }

  // ── 胸大肌：只在肌肉型且男性时做出明显胸肌分界；
  //    女性的胸量仍由躯干截面的饱满度表达 ──
  if (male && mf > 1.1) {
    for (const side of [-1, 1] as const) {
      blobs.push({
        kind: 'ellipsoid',
        c: [side * s.chest.w * 0.42, s.chestY - span * 0.02, s.chest.d * (0.46 + mf * 0.08)],
        r: [s.chest.w * 0.3, span * 0.1, s.chest.d * 0.2],
      })
    }
  }

  // ── 颈 ──
  blobs.push({
    kind: 'capsule',
    a: [0, s.shoulderY - 0.01, 0],
    b: [0, s.chinY, 0.006],
    r: s.neckR,
  })

  // ── 头：颅 + 下颌两段椭球 ──
  blobs.push({
    kind: 'ellipsoid',
    c: [0, s.chinY + s.head.h * 0.62, 0],
    r: [s.head.w * 0.52, s.head.h * 0.44, s.head.d * 0.55],
  })
  blobs.push({
    kind: 'ellipsoid',
    c: [0, s.chinY + s.head.h * 0.22, s.head.d * 0.06],
    r: [s.head.w * 0.42, s.head.h * 0.26, s.head.d * 0.46],
  })

  // 肌腹相对肢体半径的比例：muscleFactor=1 约 0.66，肌肉型约 0.86，脂肪型约 0.53
  const mu = 0.42 + 0.24 * mf

  // ── 上肢 ──
  for (const arm of s.arms) {
    blobs.push({ kind: 'roundcone', a: arm.root, b: arm.mid, r1: arm.rRoot, r2: arm.rMid })
    blobs.push({ kind: 'roundcone', a: arm.mid, b: arm.end, r1: arm.rMid, r2: arm.rEnd })

    const upperLen = dist3(arm.root, arm.mid)
    const foreLen = dist3(arm.mid, arm.end)
    const R = arm.rRoot

    // 三角肌：盖住肩头、略偏外侧，让肩呈圆润的坡度而不是直角
    blobs.push(muscleBelly(arm.root, arm.mid, 0.08, R * mu * 1.15, R * 0.78,
      arm.side * R * 0.2, R * 0.34, 0))
    // 肱二头肌：**前侧**
    blobs.push(muscleBelly(arm.root, arm.mid, 0.45, R * mu, upperLen * 0.28, 0, 0, R * 0.42))
    // 肱三头肌：**后侧**
    blobs.push(muscleBelly(arm.root, arm.mid, 0.5, R * mu * 0.92, upperLen * 0.3, 0, 0, -R * 0.4))
    // 前臂肌群：靠肘部
    blobs.push(muscleBelly(arm.mid, arm.end, 0.28, arm.rMid * mu * 0.85, foreLen * 0.3, 0, 0, -arm.rMid * 0.3))
    // 上臂后侧脂肪（脂肪型才有）
    if (ff > 0.5) {
      blobs.push(muscleBelly(arm.root, arm.mid, 0.5, R * 0.3 * ff, upperLen * 0.3, 0, 0, -R * 0.5))
    }
    // 手
    blobs.push({
      kind: 'ellipsoid',
      c: [arm.end[0], arm.end[1] - arm.rEnd * 1.5, arm.end[2]],
      r: [arm.rEnd * 1.15, arm.rEnd * 2.1, arm.rEnd * 0.72],
    })
  }

  // ── 下肢 ──
  for (const leg of s.legs) {
    blobs.push({ kind: 'roundcone', a: leg.root, b: leg.mid, r1: leg.rRoot, r2: leg.rMid })
    blobs.push({ kind: 'roundcone', a: leg.mid, b: leg.end, r1: leg.rMid, r2: leg.rEnd })

    const thighLen = dist3(leg.root, leg.mid)
    const calfLen = dist3(leg.mid, leg.end)
    const R = leg.rRoot

    // 股四头肌：**前侧**
    blobs.push(muscleBelly(leg.root, leg.mid, 0.32, R * mu, thighLen * 0.32, 0, 0, R * 0.42))
    // 腘绳肌：**后侧**
    blobs.push(muscleBelly(leg.root, leg.mid, 0.42, R * mu * 0.9, thighLen * 0.3, 0, 0, -R * 0.36))
    // 腓肠肌：小腿**后侧偏上** —— 这就是小腿肚
    blobs.push(muscleBelly(leg.mid, leg.end, 0.26, leg.rMid * mu * 1.06, calfLen * 0.26, 0, 0, -leg.rMid * 0.4))
    // 大腿脂肪：外侧 + 内侧
    if (ff > 0.5) {
      blobs.push(muscleBelly(leg.root, leg.mid, 0.4, R * 0.34 * ff, thighLen * 0.34, -leg.side * R * 0.45, 0, 0))
      blobs.push(muscleBelly(leg.root, leg.mid, 0.35, R * 0.28 * ff, thighLen * 0.3, leg.side * R * 0.4, 0, 0))
    }
    // 脚
    const soleR = s.ankleR * 0.95
    blobs.push({
      kind: 'capsule',
      a: [leg.end[0], soleR, leg.end[2] - soleR * 0.6],
      b: [leg.end[0], soleR, leg.end[2] + s.height * 0.11],
      r: soleR,
    })
  }

  return blobs
}

// ────────────────────────────────────────────────────────────
// 身体模型
// ────────────────────────────────────────────────────────────

export interface BodyModel {
  profile: BodyProfile
  skeleton: BodySkeleton
  blobs: SdfBlob[]
  /** 隐式曲面求值 */
  sdf: (x: number, y: number, z: number) => number
  /**
   * 从体内一点沿方向找到表面距离（米）。
   * 超出 maxDist 仍未命中则返回 null —— 调用方据此回退到解析半径。
   * 这是服装贴合肉体的关键：不再假设身体是椭圆环，而是直接问 SDF。
   */
  surfaceRadius(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): number | null
  bounds: { min: Vec3; max: Vec3 }
}


// ────────────────────────────────────────────────────────────
// 解剖细节
// ────────────────────────────────────────────────────────────

type SdfFn = (x: number, y: number, z: number) => number

/**
 * 解剖细节层开关。
 *
 * ⚠️ 当前**关闭** —— 实现会把肢体切断，人偶变成碎块。
 * 根因（已定位，非参数问题）：
 *   凹槽/隆起用的是**球**，半径按「平坦表面」公式反推。
 *   要做出 30mm 宽、4mm 浅的沟，球半径需 30mm，而手臂半径本身只有 40mm ——
 *   球比肢体还粗，会绕过去把整条手臂切断。
 *   加「宽度 ≤ 局部半径 × 0.7」的上限并未解决，说明还有别的机制
 *   （长胶囊切割器跨越距离过长、平滑减法在大切割器下移除过量等）。
 *
 * 正确的做法是用**沿表面法向压扁的切割器**（圆角盒 / 扁椭球），
 * 而不是球 —— 扁切割器不会绕到背面去。这是下一步要做的。
 */
const ENABLE_ANATOMICAL_DETAILS = false

/** 把一个解剖点投影到当前体表。inset<0 表示切入体内，>0 表示浮出体表 */
function onSurface(sdf: SdfFn, from: Vec3, dir: Vec3, inset = 0): [number, number, number] {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1
  const dx = dir[0] / len
  const dy = dir[1] / len
  const dz = dir[2] / len
  const hit = raySurface(sdf, from[0], from[1], from[2], dx, dy, dz, 0.6)
  const t = (hit ?? 0.12) + inset
  return [from[0] + dx * t, from[1] + dy * t, from[2] + dz * t]
}

/**
 * 解剖细节层。
 *
 * 人体表面的「精细度」大半来自两类结构：
 *   **加性** —— 皮下骨顶出的棱与隆起（锁骨、肩胛冈、髌骨、内外踝、鹰嘴）
 *   **减性** —— 肌间沟与窝（三角肌胸大肌沟、腹直肌外侧缘、股四头肌纵沟、
 *              腘窝、肚脐、胸骨上窝）
 *
 * ── 两个必须遵守的尺度约束（都是实测踩坑得来的）──
 *
 * **1. 参数化用「宽度 + 起伏量」，不用半径。**
 * 半径不是人能直观判断的量。给定期望的开口宽度 W 与起伏高度 H，
 * 球半径由 `r = (W²/4 + H²) / (2H)` 反推。
 *
 * **2. 特征必须大于 3 个体素，且宽深比 ≥ 5:1。**
 * 当前体素约 10.9mm。早先的细节只有 0.2–0.5 个体素深，
 * Surface Nets 在这个尺度下无法表达平滑的沟 —— 只能「这格挖、那格不挖」，
 * 出来就是一身锯齿状的坑。**体素化本来就不该用来表达亚体素级细节**，
 * 所以只能把细节放大到可分辨尺度，代价是形态偏柔。
 *
 * 所有点位用射线投影到当前体表，体型变化时细节会跟着走。
 */
function buildAnatomicalDetails(s: BodySkeleton, baseSdf: SdfFn): { adds: SdfBlob[]; subs: SdfBlob[] } {
  const adds: SdfBlob[] = []
  const subs: SdfBlob[] = []
  const span = s.shoulderY - s.hipY

  /** 由宽度与起伏量反推球半径（按平坦表面推导） */
  const radiusFor = (width: number, relief: number) =>
    (width * width) / 4 / (2 * relief) + relief / 2

  /**
   * ⚠️ 必须按局部曲率半径限制特征宽度。
   *
   * 上面那个半径公式是按**平坦表面**推导的。当特征宽度接近局部曲率半径时
   * 它彻底失效：要做出 30mm 宽、4mm 浅的沟，球半径要 30mm，
   * 而**手臂半径本身只有 40mm** —— 球比肢体还粗，会绕过去把手臂整条切断
   * （实际踩到过：人偶被切成碎块）。
   *
   * 所以宽度上限取局部半径的 0.7 倍。代价是大腿、躯干上能做宽沟，
   * 手臂、小腿上只能做窄沟 —— 这符合解剖实际，肢体本来就细。
   */
  const capWidth = (from: Vec3, dir: Vec3, width: number) => {
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1
    const hit = raySurface(baseSdf, from[0], from[1], from[2], dir[0] / len, dir[1] / len, dir[2] / len, 0.6)
    const localR = hit ?? 0.1
    return Math.min(width, localR * 0.7)
  }

  /** 凸起：宽度与高度以米计 */
  const bump = (from: Vec3, dir: Vec3, width: number, height: number) => {
    const r = radiusFor(capWidth(from, dir, width), height)
    return { c: onSurface(baseSdf, from, dir, -(r - height)), r }
  }
  /** 凹陷：宽度与深度以米计 */
  const groove = (from: Vec3, dir: Vec3, width: number, depth: number) => {
    const r = radiusFor(capWidth(from, dir, width), depth)
    return { c: onSurface(baseSdf, from, dir, -(r - depth)), r }
  }

  // ── 锁骨：宽而浅的棱（34mm 宽 / 5mm 高）──
  const clavY = s.shoulderY + span * 0.015
  const clavInner = bump([0, clavY, 0], [0, 0.35, 1], 0.034, 0.005)
  const clavOuter = bump([0, clavY - span * 0.015, 0], [0.85, 0.1, 0.5], 0.034, 0.005)
  for (const side of [-1, 1] as const) {
    adds.push({ kind: 'capsule', a: clavInner.c, b: [side * clavOuter.c[0], clavOuter.c[1], clavOuter.c[2]], r: clavInner.r })
  }
  // 胸骨上窝
  const notch = groove([0, clavY + span * 0.01, 0], [0, 0.25, 1], 0.03, 0.005)
  subs.push({ kind: 'sphere', c: notch.c, r: notch.r })

  // ── 三角肌–胸大肌沟（40mm 宽 / 6mm 深）──
  const dpTop = groove([0, s.chestY + span * 0.1, 0], [0.5, 0.2, 0.85], 0.04, 0.006)
  const dpBottom = groove([0, s.chestY - span * 0.06, 0], [0.8, -0.15, 0.55], 0.04, 0.006)
  for (const side of [-1, 1] as const) {
    subs.push({
      kind: 'capsule',
      a: [side * dpTop.c[0], dpTop.c[1], dpTop.c[2]],
      b: [side * dpBottom.c[0], dpBottom.c[1], dpBottom.c[2]],
      r: dpTop.r,
    })
  }

  // ── 肩胛冈 ──
  const scapY = s.chestY + span * 0.1
  const scapInner = bump([0, scapY, 0], [0, 0, -1], 0.032, 0.004)
  const scapOuter = bump([0, scapY - span * 0.02, 0], [0.7, 0, -0.72], 0.032, 0.004)
  for (const side of [-1, 1] as const) {
    adds.push({
      kind: 'capsule',
      a: [side * scapInner.c[0] * 0.3, scapInner.c[1], scapInner.c[2]],
      b: [side * scapOuter.c[0], scapOuter.c[1], scapOuter.c[2]],
      r: scapInner.r,
    })
  }

  // ── 肚脐 ──
  const navel = groove([0, s.waistY - span * 0.03, 0], [0, -0.1, 1], 0.028, 0.005)
  subs.push({ kind: 'sphere', c: navel.c, r: navel.r })

  // ── 腹直肌外侧缘 ──
  const abTop = groove([0, s.chestY - span * 0.12, 0], [0.45, 0, 0.9], 0.028, 0.004)
  const abBottom = groove([0, s.hipY + span * 0.12, 0], [0.45, 0, 0.9], 0.028, 0.004)
  for (const side of [-1, 1] as const) {
    subs.push({
      kind: 'capsule',
      a: [side * abTop.c[0], abTop.c[1], abTop.c[2]],
      b: [side * abBottom.c[0], abBottom.c[1], abBottom.c[2]],
      r: abTop.r,
    })
  }

  // ── 上肢 ──
  for (const arm of s.arms) {
    const gTopY = arm.root[1] - span * 0.02
    const gBottomY = arm.mid[1] + span * 0.02
    for (const sign of [-1, 1] as const) {
      const g1 = groove([arm.root[0], gTopY, 0], [sign * arm.side, 0, -0.3], 0.03, 0.004)
      const g2 = groove([arm.mid[0], gBottomY, 0], [sign * arm.side, 0, -0.3], 0.03, 0.004)
      subs.push({ kind: 'capsule', a: g1.c, b: g2.c, r: g1.r })
    }
    const olecranon = bump([arm.mid[0], arm.mid[1], 0], [0, -0.15, -1], 0.03, 0.006)
    adds.push({ kind: 'sphere', c: olecranon.c, r: olecranon.r })
    const cubital = groove([arm.mid[0], arm.mid[1] - 0.012, 0], [0, 0, 1], 0.034, 0.005)
    subs.push({ kind: 'sphere', c: cubital.c, r: cubital.r })
  }

  // ── 下肢 ──
  for (const leg of s.legs) {
    // 髌骨：宽而扁的隆起，不是球
    const patella = bump([leg.mid[0], leg.mid[1] + span * 0.012, 0], [0, 0, 1], 0.055, 0.007)
    adds.push({ kind: 'ellipsoid', c: patella.c, r: [patella.r * 0.6, patella.r * 0.72, patella.r * 0.42] })

    const popliteal = groove([leg.mid[0], leg.mid[1] - span * 0.01, 0], [0, 0, -1], 0.046, 0.005)
    subs.push({ kind: 'sphere', c: popliteal.c, r: popliteal.r })

    for (const sign of [-1, 1] as const) {
      const mall = bump([leg.end[0], leg.end[1] + 0.016, 0], [sign, 0, 0], 0.026, 0.006)
      adds.push({ kind: 'sphere', c: mall.c, r: mall.r })
    }

    // 股四头肌纵沟：只从大腿中段到膝上，**不要顶到胯部**
    // （早先起点太高，在胯下留了一道横线）
    const q1 = groove([leg.root[0], leg.root[1] - span * 0.12, 0], [0, 0, 1], 0.03, 0.004)
    const q2 = groove([leg.mid[0], leg.mid[1] + span * 0.05, 0], [0, 0, 1], 0.03, 0.004)
    subs.push({ kind: 'capsule', a: q1.c, b: q2.c, r: q1.r })
  }

  return { adds, subs }
}



// ────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────
// 身体模型
// ────────────────────────────────────────────────────────────

export function createBodyModel(profile: BodyProfile): BodyModel {
  const skeleton = buildSkeleton(profile)
  const blobs = buildBlobs(skeleton)
  // 平滑系数：偏小则肉块交界处会露出硬棱，偏大则会把交界「吹胖」——
  // 胯部那圈裙边感就是吹胖造成的，所以取偏小的 0.02。
  const K = 0.02

  // 两遍编译：先用基础形体求出体表，才能把解剖细节**投影**到正确位置。
  // 否则细节是死的坐标，体型一变就飘出体外或埋进肉里。
  const baseSdf = compileSdf(blobs, K)
  const details = ENABLE_ANATOMICAL_DETAILS
    ? buildAnatomicalDetails(skeleton, baseSdf)
    : { adds: [] as SdfBlob[], subs: [] as SdfBlob[] }

  // 挖沟用更小的平滑系数：沟要清晰，糊了就看不出结构
  const sdf = compileSdf([...blobs, ...details.adds], K, details.subs, 0.016)

  const surfaceRadius: BodyModel['surfaceRadius'] = (ox, oy, oz, dx, dy, dz, maxDist) => {
    if (sdf(ox, oy, oz) > 0) return null // 起点已在体外，无法内往外找
    const steps = 56
    const dt = maxDist / steps
    let prevT = 0
    for (let i = 1; i <= steps; i++) {
      const t = i * dt
      if (sdf(ox + dx * t, oy + dy * t, oz + dz * t) >= 0) {
        // 命中，二分细化到亚毫米
        let lo = prevT
        let hi = t
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) / 2
          if (sdf(ox + dx * mid, oy + dy * mid, oz + dz * mid) < 0) lo = mid
          else hi = mid
        }
        return (lo + hi) / 2
      }
      prevT = t
    }
    return null
  }

  return {
    profile,
    skeleton,
    blobs: [...blobs, ...details.adds],
    sdf,
    surfaceRadius,
    bounds: blobsBounds([...blobs, ...details.adds]),
  }
}

// ────────────────────────────────────────────────────────────
// 网格
// ────────────────────────────────────────────────────────────

function mannequinMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xece8e3,
    roughness: 0.34,
    metalness: 0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.4,
  })
}

export type MannequinQuality = 'preview' | 'final'

/**
 * 生成人台网格。
 * preview 用更粗的体素 —— 拖滑杆时实时重建靠它，
 * 松手后再用 final 精度重算。
 */
export function buildMannequin(model: BodyModel, quality: MannequinQuality = 'final'): THREE.Group {
  const group = new THREE.Group()
  const { bounds } = model
  const margin = 0.03
  const voxel = (model.skeleton.height / 152) * (quality === 'preview' ? 2.2 : 1)

  const geometry = polygonize(model.sdf, {
    bounds: {
      min: [bounds.min[0] - margin, bounds.min[1] - margin, bounds.min[2] - margin],
      max: [bounds.max[0] + margin, bounds.max[1] + margin, bounds.max[2] + margin],
    },
    voxel,
  })

  const mesh = new THREE.Mesh(geometry, mannequinMaterial())
  mesh.name = 'body'
  group.add(mesh)
  return group
}

// ────────────────────────────────────────────────────────────
// 肢体描述（供服装使用）
// ────────────────────────────────────────────────────────────

/**
 * 肢体参数。
 * 服装的袖子/裤腿沿用它定位轴向，再向 SDF 求表面半径做贴合。
 *
 * 注意存的是**分段路径长度**（root→mid、mid→end），不是直线距离 ——
 * 手臂有肘部转折，用直线距离做插值会让袖子在中段跑偏。
 */
export interface LimbSpec {
  side: -1 | 1
  origin: { x: number; y: number; z: number }
  mid: { x: number; y: number; z: number }
  end: { x: number; y: number; z: number }
  /** root -> mid 的长度 */
  segLen1: number
  /** mid -> end 的长度 */
  segLen2: number
  /** 路径总长 */
  length: number
  radiusTop: number
  radiusMid: number
  radiusBottom: number
}

function vec(v: Vec3): { x: number; y: number; z: number } {
  return { x: v[0], y: v[1], z: v[2] }
}

function segLength(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function makeLimbSpec(chain: LimbChain, rotationZ: number): LimbSpec {
  const origin = vec(chain.root)
  const mid = vec(chain.mid)
  const end = vec(chain.end)
  const segLen1 = segLength(origin, mid)
  const segLen2 = segLength(mid, end)
  return {
    side: chain.side,
    origin, mid, end,
    segLen1,
    segLen2,
    length: segLen1 + segLen2,
    // 表面半径取略大于骨架半径：SDF 平滑并集会把形体略微「鼓」出来，
    // 取小了袖子会切进手臂
    radiusTop: chain.rRoot * 1.06,
    radiusMid: chain.rMid * 1.1,
    radiusBottom: chain.rEnd * 1.08,
  }
}

export function buildArmSpecs(model: BodyModel): LimbSpec[] {
  return model.skeleton.arms.map((arm) => makeLimbSpec(arm, arm.side * 0.06))
}

export function buildLegSpecs(model: BodyModel): LimbSpec[] {
  return model.skeleton.legs.map((leg) => makeLimbSpec(leg, 0))
}

/**
 * 沿肢体路径、距根部 d 米处的中心点。
 * d 允许为负或超过总长 —— 用于裤腰向上外推、袖口略微超出腕部。
 */
export function limbPointAt(limb: LimbSpec, d: number): { x: number; y: number; z: number } {
  if (d <= limb.segLen1) {
    const t = limb.segLen1 > 1e-9 ? d / limb.segLen1 : 0
    return {
      x: limb.origin.x + (limb.mid.x - limb.origin.x) * t,
      y: limb.origin.y + (limb.mid.y - limb.origin.y) * t,
      z: limb.origin.z + (limb.mid.z - limb.origin.z) * t,
    }
  }
  const t = limb.segLen2 > 1e-9 ? (d - limb.segLen1) / limb.segLen2 : 0
  return {
    x: limb.mid.x + (limb.end.x - limb.mid.x) * t,
    y: limb.mid.y + (limb.end.y - limb.mid.y) * t,
    z: limb.mid.z + (limb.end.z - limb.mid.z) * t,
  }
}

/** 沿肢体路径的半径（分段线性，含中关节） */
export function limbRadiusAt(limb: LimbSpec, d: number): number {
  if (d <= limb.segLen1) {
    const t = limb.segLen1 > 1e-9 ? d / limb.segLen1 : 0
    return limb.radiusTop + (limb.radiusMid - limb.radiusTop) * t
  }
  const t = limb.segLen2 > 1e-9 ? (d - limb.segLen1) / limb.segLen2 : 0
  return limb.radiusMid + (limb.radiusBottom - limb.radiusMid) * t
}

