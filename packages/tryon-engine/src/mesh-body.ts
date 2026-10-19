/** Indexed MakeHuman A-pose mesh with cached, local deformation weights. */
import * as THREE from 'three'
import type { BodyModel } from './body'
import type { BodyProfile } from '@cda/core'
import { MeshDeformation } from './mesh-deformation'
import { MeshSurface } from './mesh-surface'

/**
 * 体表查询接口。
 *
 * 服装壳的拟合靠「从身体内部一点沿方向投射射线，求到体表的距离」。
 * 把这件能力抽成接口，SDF 人体与雕刻网格各实现一份，
 * 服装代码就不必知道身后是哪一种身体。
 */
export interface BodySurface {
  /**
   * 从内部一点 (ox,oy,oz) 沿单位方向 (dx,dy,dz) 找体表距离（米）。
   * 起点必须在体内；未命中返回 null。
   */
  radiusAt(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): number | null
}

/**
 * 把 OBJ 文本解析成**索引式**几何，并顺手构建与之一致的顶点邻接表。
 *
 * ── 为什么不能用 OBJLoader ──
 * OBJLoader 会把面展开成**非索引三角汤**（顶点数 = 面数 × 3）。这同时毁掉两件事：
 *
 *   1. **表面变成碎面。**
 *      `computeVertexNormals()` 在非索引几何上只能给出「每面一个法线」，
 *      于是整个身体呈现棱面状 —— 正是用户反馈的「身体会有凹陷、不够平滑」。
 *      实测几何本身在中性参数下位移为 0.00mm，**纯粹是着色问题**。
 *
 *   2. **权重扩散平滑被静默跳过。**
 *      `buildAdjacency` 按 OBJ 的顶点索引建表（13514），
 *      而几何顶点是 27024，于是 `adj.length === nV` 不成立，
 *      setProfile 里那段拓扑扩散**从来没有运行过**。
 *
 * 自己解析可以保证几何索引、邻接表、权重数组三者严格对齐。
 */
function parseIndexedObj(text: string): { geometry: THREE.BufferGeometry; adj: number[][] } {
  const verts: number[] = []
  const tris: number[] = []
  const sets: Array<Set<number> | undefined> = []

  const link = (a: number, b: number) => {
    ;(sets[a] ??= new Set()).add(b)
    ;(sets[b] ??= new Set()).add(a)
  }

  for (const line of text.split('\n')) {
    if (line.length < 2) continue
    const c0 = line.charCodeAt(0)
    if (c0 === 118 /* v */) {
      // 跳过 vn / vt：它们也以 v 开头，但第二个字符不是空格
      if (line.charCodeAt(1) !== 32 && line.charCodeAt(1) !== 9) continue
      const p = line.split(/\s+/)
      verts.push(Number(p[1]), Number(p[2]), Number(p[3]))
    } else if (c0 === 102 /* f */) {
      const p = line.split(/\s+/)
      const idx: number[] = []
      for (let i = 1; i < p.length; i++) {
        const t = p[i]
        if (!t) continue
        const slash = t.indexOf('/')
        idx.push(parseInt(slash < 0 ? t : t.slice(0, slash), 10) - 1)
      }
      // 扇形三角化，同时建邻接（与几何用的是同一份面数据）
      for (let i = 1; i < idx.length - 1; i++) {
        const a = idx[0]!
        const b = idx[i]!
        const c = idx[i + 1]!
        tris.push(a, b, c)
        link(a, b)
        link(b, c)
        link(a, c)
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geometry.setIndex(tris)

  /*
   * 邻接表长度必须**严格等于**顶点数。
   * sets 是稀疏数组，末尾若有没有被任何面引用的孤立顶点，
   * sets.length 会短于顶点数 —— 那样 `adj.length === nV` 又会不成立，
   * 扩散会被再次静默跳过。这里显式补齐，把这个隐患从根上掐掉。
   */
  const nV = verts.length / 3
  const adj: number[][] = new Array(nV)
  for (let i = 0; i < nV; i++) adj[i] = sets[i] ? [...sets[i]!] : []

  return { geometry, adj }
}

export interface MeshBodySpec {
  url: string
  gender: 'male' | 'female'
}

export class MeshBody implements BodySurface {
  readonly object3D: THREE.Object3D
  private readonly mesh: THREE.Mesh
  private readonly geo: THREE.BufferGeometry
  /** 归一化后的原始顶点（身高 1.0），每次重拟合都从这里出发，避免累积误差 */
  private readonly base: Float32Array
  /** Cached reference-space weights and connected joint transforms. */
  private readonly deformation: MeshDeformation
  private profile: BodyProfile

  /** Acceleration structure refitted when vertices move. */
  private surface?: MeshSurface

  private constructor(
    obj: THREE.Object3D,
    profile: BodyProfile,
    adj: number[][] = [],
  ) {
    this.profile = profile
    // 取第一个网格
    let found: THREE.Mesh | null = null
    obj.traverse((o) => {
      if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh
    })
    if (!found) throw new Error('[CDA] OBJ 里没有网格')
    this.mesh = found
    this.geo = this.mesh.geometry

    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute

    // ── 归一化：按包围盒**中心**平移（不能用 min，那会把中轴推歪），
    //    再缩放到身高 1.0、脚底 y=0 ──
    const box = new THREE.Box3().setFromBufferAttribute(pos)
    const cx = (box.min.x + box.max.x) / 2
    const rawH = box.max.y - box.min.y
    const base = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      base[i * 3] = (pos.getX(i) - cx) / rawH
      base[i * 3 + 1] = (pos.getY(i) - box.min.y) / rawH
      base[i * 3 + 2] = pos.getZ(i) / rawH
    }
    // Bundled OBJ assets are the original A-pose meshes. Do not bake them again.
    this.base = base
    this.deformation = new MeshDeformation(base, adj)

    // 白模材质
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xece8e3,
      roughness: 0.34,
      clearcoat: 0.4,
      clearcoatRoughness: 0.4,
      metalness: 0,
      // ⚠️ 必须双面。Raycaster 默认只命中正面三角形，
      // 而服装求交是**从身体内部向外**投射的，打到的是体表三角形的**背面**——
      // 单面时会全部落空（实测三个高度里两个返回 null）。
      side: THREE.DoubleSide,
    })
    this.mesh.material = mat
    this.geo.computeVertexNormals()
    this.object3D = new THREE.Group()
    this.object3D.add(this.mesh)
    this.setProfile(profile)
    this.surface = new MeshSurface(this.mesh)
  }

  /** 从 OBJ 文本构建（H5 下用 fetch 取文本，小程序需要换成平台读取） */
  static async loadFromUrl(url: string, profile: BodyProfile, gender: 'male' | 'female'): Promise<MeshBody> {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`[CDA] 网格加载失败 ${res.status}: ${url}`)
    const text = await res.text()
    // 索引式几何：既保证平滑法线，也让邻接表与顶点数对齐
    const { geometry, adj } = parseIndexedObj(text)
    return new MeshBody(new THREE.Mesh(geometry), profile, adj)
  }

  setProfile(profile: BodyProfile): void {
    this.profile = profile
    const position = this.geo.getAttribute('position') as THREE.BufferAttribute
    this.deformation.fit(profile, position.array as Float32Array)
    position.needsUpdate = true
    this.geo.computeVertexNormals()
    this.geo.computeBoundingBox()
    this.geo.computeBoundingSphere()
    this.surface?.refit()
  }

  /** 从 OBJ 文本构建（审计脚本在 Node 里用，避免依赖 fetch 与浏览器） */
  static loadFromText(text: string, profile: BodyProfile, gender: 'male' | 'female'): MeshBody {
    const { geometry, adj } = parseIndexedObj(text)
    return new MeshBody(new THREE.Mesh(geometry), profile, adj)
  }

  /** 变形后的顶点坐标（审计脚本用来做几何检测） */
  getPositions(): Float32Array {
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute
    return pos.array as Float32Array
  }

  /** 未经任何变形的参考顶点（归一化单位） */
  getReference(): Float32Array {
    return this.base
  }

  /** Geometry and clothing share the same joints after every refit. */
  fittingModel(model: BodyModel): BodyModel {
    return { ...model, skeleton: { ...model.skeleton, ...this.deformation.landmarks } }
  }

  get currentProfile(): BodyProfile {
    return this.profile
  }

  /**
   * 体表查询：对网格做 raycast。
   *
   * 这是 SDF 射线步进的替代品 —— 身体换成雕刻网格后，
   * 服装壳必须按**网格的实际表面**求交，否则衣服会照着另一具身体计算。
   *
   * 注意：Raycaster 用的是世界坐标，所以必须先 updateMatrixWorld。
   */
  radiusAt(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): number | null {
    return this.surface?.radiusAt(ox, oy, oz, dx, dy, dz, maxDist) ?? null
  }

  dispose(): void {
    this.geo.dispose()
    const m = this.mesh.material
    if (Array.isArray(m)) m.forEach((x) => x.dispose())
    else m.dispose()
  }
}
