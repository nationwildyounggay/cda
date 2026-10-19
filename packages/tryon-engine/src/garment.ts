/**
 * 服装壳层 + 精细穿法 —— 亮点2 Step1/Step2 的实现。
 *
 * 核心策略（对应项目计划里的「降级方案」）：
 *   当前版本采用参数化衣片拟合，未运行真实布料物理
 *   ✅ 分层贴合 —— 连续衣片按体表拟合；不等同于布料碰撞求解
 *   ✅ 顶点解析变形 —— 「扣几颗扣子 / 披 / 围 / 系」用解析位移表达
 *
 * 为什么用「直接顶点变形」而不是 Three.js 的 morph target：
 *   morph target 适合离散的、数量固定的姿态；而「扣子扣几颗」是**连续量**
 *   （0..N 颗），做成 N 个 morph 会爆炸。直接按状态重算顶点更简单也更灵活。
 *   穿法直接更新已有顶点；体型变化时才重新拟合衣片。
 */
import * as THREE from 'three'
import type { BodySlot, GarmentDimensions, WearMode } from '@cda/core'
import type { BodySurface } from './mesh-body'
import { buildUpperGarment, type GarmentVertexParam } from './garment-upper'
import type { BodyModel } from './body'
import { buildLowerGarment } from './garment-lower'

/** 各挂载部位的基准外扩量（cm）—— 布料本身撑在皮肤之外的那点空隙 */
const SLOT_BASE_OFFSET_CM: Record<BodySlot, number> = {
  upper: 1.0,
  outer: 1.6,
  lower: 1.1,
  neck: 1.8,
  waist: 1.5,
  head: 0.8,
}

/**
 * 由面料厚度推导外扩量。
 *
 * 厚度必须真正参与建模，否则衣服之间只是「两层壳叠着」，
 * 看不出牛仔比雪纺厚。这里用 **厚度(mm) × 0.25** 放大到可视尺度 ——
 * 真实厚度只有零点几毫米，直接换算成厘米在屏幕上完全看不出来。
 */
function offsetFromThickness(slot: BodySlot, thicknessMm?: number): number {
  const base = SLOT_BASE_OFFSET_CM[slot]
  if (!thicknessMm || thicknessMm <= 0) return base
  return base + thicknessMm * 0.25
}

/** 一件单品在 3D 人偶上的挂载描述 */
export interface GarmentSpec {
  id: string
  productId: string
  bodySlot: BodySlot
  /** 覆盖的高度区间（归一化 t）。**仅作为尺寸数据缺失时的回退** */
  fromT: number
  toT: number
  /** 相对身体表面的向外偏移，单位 cm。**仅作为尺寸数据缺失时的回退** */
  offsetCm: number
  /** 颜色 */
  color: number
  /** 扣子总数；有扣件的单品才有 */
  fastenerTotal?: number
  /** 该单品支持的穿法 */
  allowedModes: WearMode[]
  /** 袖长：不填表示无袖。袖子与手臂共用 limb specs，保证严格对齐 */
  sleeve?: 'short' | 'long'
  /** 成衣实测尺寸。有它就按它建模，没有才回退到上面的常数 */
  dimensions?: GarmentDimensions
}

/**
 * 单品 3D 描述注册表。
 * demo 阶段按 productId 硬编码；后续应由后台的商品 3D 资产接口返回。
 */
export const GARMENT_REGISTRY: Record<string, Omit<GarmentSpec, 'id' | 'productId'>> = {
  // 白衬衫：上装，长袖，有 5 颗扣子，可正常穿 / 敞开 / 披肩
  p_white_shirt: {
    bodySlot: 'upper',
    fromT: 0.60,
    toT: 0.835,
    offsetCm: 1.4,
    color: 0xf2f2f0,
    fastenerTotal: 5,
    allowedModes: ['worn', 'open', 'draped'],
    sleeve: 'long',
  },
  // 牛仔外套：更厚、松量更大，长袖，同样有扣件
  p_denim_jacket: {
    bodySlot: 'outer',
    fromT: 0.575,
    toT: 0.845,
    offsetCm: 3.0,
    color: 0x8fb4d9,
    fastenerTotal: 4,
    allowedModes: ['worn', 'open', 'draped'],
    sleeve: 'long',
  },
  // 阔腿西裤：下装，无扣件，只能正常穿
  p_wide_trousers: {
    bodySlot: 'lower',
    fromT: 0.10,
    toT: 0.635,
    offsetCm: 2.2,
    color: 0xd9cdbb,
    allowedModes: ['worn'],
  },
  // 围巾：配饰，可围在脖子上 / 披着 / 系在腰上
  p_knit_scarf: {
    bodySlot: 'neck',
    fromT: 0.815,
    toT: 0.885,
    offsetCm: 3.2,
    color: 0xc19a6b,
    allowedModes: ['wrapped', 'draped', 'tied'],
  },
}

/** 每种穿法在 UI 上的中文名 */
export const WEAR_MODE_LABEL: Record<WearMode, string> = {
  worn: '正常穿',
  open: '敞开',
  draped: '披着',
  wrapped: '围起来',
  tied: '系在腰上',
}

type VertexParam = GarmentVertexParam

/**
 * 一个可变的服装图层。
 * 持有基准顶点，按 (wearMode, fastenerClosed) 解析计算出当前顶点。
 */
export class Garment {
  readonly object3D: THREE.Object3D
  readonly spec: GarmentSpec

  private readonly meshes: THREE.Mesh[] = []
  /** 每个 mesh 的基准顶点与顶点参数 */
  private readonly bases: { mesh: THREE.Mesh; base: Float32Array; params: VertexParam[]; closedFrontPairs?: [number, number][] }[] = []

  private _wearMode: WearMode
  private _fastenerClosed: number

  /** 实际外扩量（cm）：有面料厚度就由厚度推导，否则用 spec 的常数 */
  private readonly offsetCm: number
  /** 实际覆盖区间（归一化高度）：有衣长数据就由数据推导 */
  private readonly range: { fromT: number; toT: number }

  /**
   * 体表查询。默认用 SDF 模型自己的求交，
   * 身体换成雕刻网格后由引擎注入网格的 raycast ——
   * 否则衣服会照着**另一具体型不同、姿势也不同的**身体来计算。
   */
  private readonly surface: BodySurface

  constructor(
    private readonly model: BodyModel,
    spec: GarmentSpec,
    surface?: BodySurface,
  ) {
    this.surface =
      surface ??
      ({
        radiusAt: (ox, oy, oz, dx, dy, dz, maxDist) =>
          model.surfaceRadius(ox, oy, oz, dx, dy, dz, maxDist),
      } satisfies BodySurface)
    this.spec = spec
    this._wearMode = spec.allowedModes[0] ?? 'worn'
    this._fastenerClosed = spec.fastenerTotal ?? 0
    this.offsetCm = spec.dimensions?.thicknessMm
      ? offsetFromThickness(spec.bodySlot, spec.dimensions.thicknessMm)
      : spec.offsetCm
    this.range = this.computeRange()
    this.object3D = this.build()
  }

  /**
   * 由成衣实测长度推导覆盖区间。
   *
   * 这一步是「服装数据库驱动建模」真正落地的地方：
   * 不是给每件衣服写死一个高度范围，而是读它的衣长/裤长算出来。
   * 于是同一件衣服穿在 155cm 和 185cm 的人身上，下摆位置自动不同。
   */
  private computeRange(): { fromT: number; toT: number } {
    const sk = this.model.skeleton
    const H = sk.height
    const dims = this.spec.dimensions
    if (!dims) return { fromT: this.spec.fromT, toT: this.spec.toT }

    // 配饰（围巾等）的「长度」含义不同，仍用 spec 的区间
    if (this.spec.bodySlot === 'neck' || this.spec.bodySlot === 'waist') {
      return { fromT: this.spec.fromT, toT: this.spec.toT }
    }

    if (this.spec.bodySlot === 'lower') {
      const outseam = (dims.outseamCm ?? dims.inseamCm ?? 100) / 100
      const topY = sk.waistY + 0.03
      const bottomY = Math.max(H * 0.03, topY - outseam)
      return { fromT: bottomY / H, toT: topY / H }
    }

    // 上装 / 外套：从肩线略上方往下量一个衣长
    const len = (dims.lengthCm ?? 62) / 100
    const topY = sk.shoulderY + 0.015
    const bottomY = topY - len
    return { fromT: Math.max(0.04, bottomY / H), toT: topY / H }
  }

  get wearMode(): WearMode {
    return this._wearMode
  }

  get fastenerClosed(): number {
    return this._fastenerClosed
  }

  setWearMode(mode: WearMode): void {
    if (!this.spec.allowedModes.includes(mode)) return
    this._wearMode = mode
    this.update()
  }

  setFastenerClosed(n: number): void {
    if (!this.spec.fastenerTotal) return
    this._fastenerClosed = Math.max(0, Math.min(this.spec.fastenerTotal, Math.round(n)))
    this.update()
  }

  setColor(hex: number): void {
    this.spec.color = hex
    for (const m of this.meshes) {
      ;(m.material as THREE.MeshStandardMaterial).color.setHex(hex)
    }
  }

  private material(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: this.spec.color,
      // 接近纯哑光：与人台的亮面树脂形成质感区分，
      // 否则白色衣服贴在白色人台上会分不出边界
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.DoubleSide,
    })
  }

  // ---------------------------------------------------------------- 构建

  private build(): THREE.Object3D {
    const group = new THREE.Group()
    group.name = `garment:${this.spec.productId}`

    if (this.spec.bodySlot === 'lower') {
      this.buildLegs(group)
    } else if (this.spec.bodySlot === 'neck' || this.spec.bodySlot === 'waist') {
      this.buildBand(group)
    } else {
      this.buildUpper(group)
    }

    this.update()
    return group
  }

  /** 衣身、肩部和袖子共用边界顶点，穿法变化时保持连接。 */
  private buildUpper(group: THREE.Group): void {
    const { geometry, params, closedFrontPairs } = buildUpperGarment(
      this.model, this.surface, this.spec, this.range.fromT, this.offsetCm * 0.01,
    )
    const mesh = new THREE.Mesh(geometry, this.material())
    mesh.name = this.spec.productId
    group.add(mesh)
    this.meshes.push(mesh)
    const base = new Float32Array(geometry.getAttribute('position').array)
    this.bases.push({ mesh, base, params, closedFrontPairs })
  }

  /** 腰部、两条裤腿与裆部共用连接边。 */
  private buildLegs(group: THREE.Group): void {
    const H = this.model.skeleton.height
    const { geometry, params } = buildLowerGarment(this.model, this.surface,
      this.range.fromT * H, this.range.toT * H, this.offsetCm * 0.01)
    const mesh = new THREE.Mesh(geometry, this.material())
    mesh.name = this.spec.productId
    group.add(mesh)
    this.meshes.push(mesh)
    this.bases.push({ mesh, base: new Float32Array(geometry.getAttribute('position').array), params })
  }

  /** 配饰：围在脖子/腰上的环带。半径同样向 SDF 求，贴合颈/腰的真实轮廓 */
  private buildBand(group: THREE.Group): void {
    const H = this.model.skeleton.height
    const off = this.offsetCm * 0.01
    const segs = 64
    const rows = 6
    const positions: number[] = []
    const uvs: number[] = []
    const params: VertexParam[] = []
    const indices: number[] = []
    const lastRadius = new Array<number>(segs).fill(0.08)

    for (let r = 0; r <= rows; r++) {
      const t = this.range.fromT + ((this.range.toT - this.range.fromT) * r) / rows
      const y = t * H
      // 环带比身体略粗，形成蓬松的围巾感
      const bulge = r === 0 || r === rows ? 0 : Math.sin((r / rows) * Math.PI) * 0.012
      for (let c = 0; c < segs; c++) {
        const theta = (c / segs) * Math.PI * 2
        const dirX = Math.cos(theta)
        const dirZ = Math.sin(theta)
        const hit = this.surface.radiusAt(0, y, 0, dirX, 0, dirZ, 0.5)
        let base = hit
        if (base === null) base = lastRadius[c]!
        else lastRadius[c] = base
        const rad = base + off + bulge
        positions.push(dirX * rad, y, dirZ * rad)
        uvs.push(c / segs, r / rows)
        params.push({ t, theta })
      }
    }

    const rowIdx = (r: number, c: number) => r * segs + c % segs
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < segs; c++) {
        const a = rowIdx(r, c)
        const b = rowIdx(r, c + 1)
        const cc = rowIdx(r + 1, c + 1)
        const d = rowIdx(r + 1, c)
        indices.push(a, d, b, b, d, cc)
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geo.setIndex(indices)
    geo.computeVertexNormals()

    const mesh = new THREE.Mesh(geo, this.material())
    mesh.name = this.spec.productId
    group.add(mesh)
    this.meshes.push(mesh)
    this.bases.push({ mesh, base: new Float32Array(positions), params })
  }

  // ---------------------------------------------------------------- 变形

  /**
   * 按当前 (wearMode, fastenerClosed) 重算顶点。
   *
   * 位移全部是解析式，语义如下：
   *   - 张开程度由 wearMode 与扣子状态共同决定
   *   - 扣子越少 / 敞开模式 -> 前襟张开越大
   *   - 披着 -> 整体上移并后仰
   *   - 围起来 -> 向颈部聚拢
   *   - 系在腰上 -> 整体下移到腰部并收紧
   */
  update(): void {
    for (const { mesh, base, params, closedFrontPairs } of this.bases) {
      const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = position.array as Float32Array

      for (let i = 0; i < params.length; i++) {
        const p = params[i]!
        const ix = i * 3
        const bx = base[ix]!
        const by = base[ix + 1]!
        const bz = base[ix + 2]!

        const d = this.displacement(p, bx, by, bz)

        arr[ix] = bx + d.x
        arr[ix + 1] = by + d.y
        arr[ix + 2] = bz + d.z
      }

      position.needsUpdate = true
      mesh.geometry.computeVertexNormals()
      // The front edges coincide when buttoned. Share shading across that seam,
      // while retaining two indices so unbuttoning can create an actual opening.
      if (closedFrontPairs) {
        const normals = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute
        for (const [a, b] of closedFrontPairs) {
          if (Math.hypot(arr[a * 3]! - arr[b * 3]!, arr[a * 3 + 1]! - arr[b * 3 + 1]!, arr[a * 3 + 2]! - arr[b * 3 + 2]!) > 1e-6) continue
          const n = new THREE.Vector3().fromBufferAttribute(normals, a).add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize()
          normals.setXYZ(a, n.x, n.y, n.z); normals.setXYZ(b, n.x, n.y, n.z)
        }
        normals.needsUpdate = true
      }
      mesh.geometry.computeBoundingBox()
      mesh.geometry.computeBoundingSphere()
    }
  }

  /** 计算单个顶点的位移（单位：米） */
  private displacement(p: VertexParam, bx: number, by: number, bz: number): { x: number; y: number; z: number } {
    const mode = this._wearMode
    const total = this.spec.fastenerTotal ?? 0
    const closed = this._fastenerClosed

    // 张开程度 0..1：敞开模式直接全开；否则由未扣的扣子比例决定
    let opening = 0
    if (mode === 'open') opening = 1
    else if (total > 0) opening = 1 - closed / total

    // 正前方的权重。
    // 注意参数化是 x=cos(θ), z=sin(θ)，所以 **正前方(+Z)对应 θ=π/2**，
    // 用 cos(θ) 会把"前襟"开到侧面去（曾因此导致敞开模式几乎看不出效果）。
    const front = Math.max(0, Math.sin(p.theta))
    // 越靠上、越靠前，张开越明显（模拟衣襟从上往下敞开）
    const heightK = total > 0 ? THREE.MathUtils.clamp((p.t - this.range.fromT) / Math.max(1e-6, this.range.toT - this.range.fromT), 0, 1) : 0

    let dx = 0
    let dy = 0
    let dz = 0

    // --- 前襟张开 ---
    if (opening > 0.001 && front > 0.001) {
      const amount = opening * Math.pow(front, 1.4) * (0.35 + 0.65 * heightK)
      dx += (p.openingSide ?? Math.sign(bx)) * amount * 0.035
      dz += amount * 0.045
    }

    // --- 披着：整体上移 + 后仰 + 略微放松 ---
    if (mode === 'draped') {
      const k = (p.t - this.range.fromT) / Math.max(1e-6, this.range.toT - this.range.fromT)
      dy += 0.045 + k * 0.02
      dz -= 0.03 * k
      dx += bx * 0.06
    }

    // --- 围起来：向颈部聚拢 ---
    if (mode === 'wrapped') {
      const neckY = this.model.skeleton.shoulderY
      dy += (neckY - by) * 0.75
      dx += bx * -0.1
      dz += bz * -0.1
    }

    // --- 系在腰上：下移到腰部并收紧 ---
    if (mode === 'tied') {
      const waistY = this.model.skeleton.waistY
      dy += (waistY - by) * 0.9
      dx += bx * -0.18
      dz += bz * -0.18
    }

    return { x: dx, y: dy, z: dz }
  }
}

/** 便捷工厂 */
export function createGarment(
  model: BodyModel,
  productId: string,
  colorHex?: number,
  dimensions?: GarmentDimensions,
  surface?: BodySurface,
): Garment | null {
  const reg = GARMENT_REGISTRY[productId]
  if (!reg) return null
  const spec: GarmentSpec = {
    id: `g_${productId}`,
    productId,
    ...reg,
    color: reg.color,
    dimensions,
  }
  const g = new Garment(model, spec, surface)
  if (colorHex !== undefined) g.setColor(colorHex)
  return g
}
