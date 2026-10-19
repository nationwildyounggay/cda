import * as THREE from 'three'
import { buildArmSpecs, limbPointAt, limbRadiusAt, type BodyModel, type LimbSpec } from './body'
import type { BodySurface } from './mesh-body'
import type { GarmentSpec } from './garment'

export interface GarmentVertexParam {
  t: number
  /** Global body azimuth, including on sleeves. */
  theta: number
  /** The two coincident edges of a closed front must separate when opened. */
  openingSide?: number
}

const mix = THREE.MathUtils.lerp
const smooth = (t: number) => { t = THREE.MathUtils.clamp(t, 0, 1); return t * t * (3 - 2 * t) }
const vector = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z)

/**
 * Sew front/back panels to sleeve rings using shared indices. The shoulder edges
 * are shared too; only the neckline, hem, cuffs and optional front opening remain
 * boundaries. This avoids intersecting three independent open-ended cylinders.
 */
export function buildUpperGarment(
  model: BodyModel, surface: BodySurface, spec: GarmentSpec,
  fromT: number, offset: number,
): { geometry: THREE.BufferGeometry; params: GarmentVertexParam[]; closedFrontPairs: [number, number][] } {
  const sk = model.skeleton
  const H = sk.height
  const columns = 24, lowerRows = 16, upperRows = 12, sleeveRows = 18
  const neckColumn = 8
  const positions: number[] = [], indices: number[] = [], uvs: number[] = []
  const params: GarmentVertexParam[] = []
  const origins: (THREE.Vector3 | undefined)[] = []
  const shared = new Map<string, number>()
  const closedFrontPairs: [number, number][] = []
  const splitFront = (spec.fastenerTotal ?? 0) > 0
  const arms = buildArmSpecs(model)
  const rootDistances = arms.map(arm => Math.min(0.04, arm.segLen1 * 0.15))

  function outsideTorso(p: THREE.Vector3): THREE.Vector3 {
    // Keep the horizontal section's height fixed; moving it upwards along a
    // chest ray can invert rows at the armhole. Below the hips carry the section
    // down instead of sampling the empty
    // gap between the thighs and producing a spike at the shirt hem.
    const sampleY = Math.max(p.y, sk.hipY + 0.025)
    const origin = new THREE.Vector3(0, sampleY, 0)
    const direction = new THREE.Vector3(p.x, 0, p.z)
    const distance = direction.length()
    if (distance < 1e-8) return p
    direction.divideScalar(distance)
    let hit = surface.radiusAt(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, 0.65)
    if (p.y < sk.waistY + 0.08) {
      // An untucked shirt hangs from the widest hip section rather than shrinking
      // into the crotch or following each thigh independently.
      for (let i = 0; i <= 4; i++) {
        const y = mix(sk.hipY, sk.waistY, i / 4)
        const radius = surface.radiusAt(0, y, 0, direction.x, 0, direction.z, 0.5)
        if (radius !== null) hit = Math.max(hit ?? 0, radius * (1 - smooth((p.y - sk.waistY + 0.04) / 0.12)))
      }
    }
    const clearance = offset + (p.y < sk.waistY ? 0.006 : 0.003)
    if (hit !== null && hit + clearance > distance) p.addScaledVector(direction, hit + clearance - distance)
    return p
  }

  function vertex(key: string, p: THREE.Vector3, u: number, v: number, openingSide?: number, origin?: THREE.Vector3): number {
    const found = shared.get(key)
    if (found !== undefined) return found
    const index = positions.length / 3
    shared.set(key, index)
    positions.push(p.x, p.y, p.z)
    uvs.push(u, v)
    params.push({ t: p.y / H, theta: Math.atan2(p.z, p.x), openingSide })
    origins.push(origin)
    return index
  }
  function quad(a: number, b: number, c: number, d: number, flip = false) {
    if (flip) indices.push(a, c, b, a, d, c)
    else indices.push(a, b, c, a, c, d)
  }
  function frame(arm: LimbSpec, d: number) {
    const first = vector(arm.mid).sub(vector(arm.origin)).normalize()
    const second = vector(arm.end).sub(vector(arm.mid)).normalize()
    // Blend around the elbow; an abrupt frame change creates a circumferential crease.
    const tangent = first.lerp(second, smooth((d - arm.segLen1 + 0.035) / 0.07)).normalize()
    const up = new THREE.Vector3(0, 0, 1).cross(tangent).multiplyScalar(arm.side).normalize()
    const front = tangent.clone().cross(up).multiplyScalar(arm.side).normalize()
    return { up, front }
  }
  function section(arm: LimbSpec, d: number, angle: number) {
    const center = vector(limbPointAt(arm, d))
    const { up, front } = frame(arm, d)
    const direction = up.multiplyScalar(Math.cos(angle)).addScaledVector(front, Math.sin(angle))
    const fallback = limbRadiusAt(arm, Math.max(0, d))
    const hit = surface.radiusAt(center.x, center.y, center.z, direction.x, direction.y, direction.z, fallback * 2.2)
    return center.addScaledVector(direction, (hit ?? fallback) + offset)
  }
  const rawRoots = arms.map((arm, a) => Array.from({ length: upperRows * 2 }, (_, i) =>
    section(arm, rootDistances[a]!, i * Math.PI / upperRows)))
  const roots = arms.map((arm, a) => {
    const d = rootDistances[a]!
    const center = vector(limbPointAt(arm, d))
    const { up, front } = frame(arm, d)
    const radius = [0, upperRows / 2, upperRows, upperRows * 1.5].map(i => rawRoots[a]![i]!.distanceTo(center))
    return Array.from({ length: upperRows * 2 }, (_, i) => {
      const angle = i * Math.PI / upperRows
      return center.clone().addScaledVector(up, radius[Math.cos(angle) >= 0 ? 0 : 2]! * Math.cos(angle))
        .addScaledVector(front, radius[Math.sin(angle) >= 0 ? 1 : 3]! * Math.sin(angle))
    })
  })
  const left = arms.findIndex(arm => arm.side === -1), right = arms.findIndex(arm => arm.side === 1)
  const bottom = fromT * H
  const underarmY = Math.min(roots[left]![upperRows]!.y, roots[right]![upperRows]!.y)
  // Keep rows ordered even when supplied an unusually short cropped garment.
  const hemY = Math.min(bottom, underarmY - 0.025)
  const neckY = Math.min(sk.chinY - 0.015, sk.shoulderY + 0.035)
  const neckX = (surface.radiusAt(0, neckY, 0, 1, 0, 0, 0.2) ?? sk.neckR) + offset
  const neckFront = (surface.radiusAt(0, neckY, 0, 0, 0, 1, 0.2) ?? sk.neckR) + offset
  const neckBack = (surface.radiusAt(0, neckY, 0, 0, 0, -1, 0.2) ?? sk.neckR) + offset

  function top(c: number, front: number): THREE.Vector3 {
    if (c >= neckColumn && c <= columns - neckColumn) {
      const angle = Math.PI * (1 - (c - neckColumn) / (columns - 2 * neckColumn))
      const round = Math.sin(angle)
      return new THREE.Vector3(neckX * Math.cos(angle), neckY - round * (front > 0 ? 0.025 : 0.006),
        front * round * (front > 0 ? neckFront : neckBack))
    }
    const isLeft = c < neckColumn
    const tip = roots[isLeft ? left : right]![0]!
    const k = isLeft ? c / neckColumn : (columns - c) / neckColumn
    const x = mix(tip.x, isLeft ? -neckX : neckX, k)
    const y = mix(tip.y, neckY, k)
    const z = tip.z * (1 - k)
    // Shoulder ridge, measured upwards from inside the chest. At the sleeve root
    // keep the exact ring point so the shared corner never moves independently.
    const hit = surface.radiusAt(x, sk.chestY, z, 0, 1, 0, neckY - sk.chestY + 0.08)
    return new THREE.Vector3(x, mix(y, Math.max(y, sk.chestY + (hit ?? 0) + offset), Math.sin(k * Math.PI)), z)
  }

  function panelPoint(c: number, row: number, front: number): THREE.Vector3 {
    const angle = Math.PI * (1 - c / columns)
    const side = c < columns / 2 ? left : right
    const root = roots[side]!
    const low = root[upperRows]!
    const upper = row > lowerRows
    const k = upper ? (row - lowerRows) / upperRows : row / lowerRows
    const edge = upper ? root[front > 0 ? upperRows - (row - lowerRows) : (upperRows + row - lowerRows) % (2 * upperRows)]!
      : new THREE.Vector3(0, mix(hemY, underarmY, k), low.z * k)
    let y = edge.y
    const sampleY = Math.max(y, sk.hipY + 0.025)
    const radialWidth = (surface.radiusAt(0, sampleY, 0, arms[side]!.side, 0, 0, 0.5) ?? Math.abs(low.x)) + offset
    const width = upper ? Math.abs(edge.x) : mix(radialWidth, Math.abs(low.x), smooth((k - 0.6) / 0.4))
    let x = Math.cos(angle) * width
    let z = edge.z
    const roof = top(c, front)
    if (upper) {
      // Match the shoulder/neck pattern at the top, with the sleeve oval at each side.
      x = mix(x, roof.x, smooth(k))
      y = mix(underarmY, roof.y, k) + (edge.y - mix(underarmY, root[0]!.y, k)) * Math.abs(Math.cos(angle))
    }
    if (c === 0 || c === columns) {
      if (upper || row === lowerRows) return upper ? edge.clone() : low.clone()
      return outsideTorso(new THREE.Vector3(x, y, z))
    }
    const centerDepth = surface.radiusAt(0, sampleY, 0, 0, 0, front, 0.5) ?? sk.chest.d
    const hit = surface.radiusAt(x, sampleY, 0, 0, 0, front, 0.5)
    const ellipse = (centerDepth + offset) * Math.sin(angle)
    z = front * Math.max(ellipse, hit === null ? 0 : hit + offset)
    if (upper) {
      // Preserve the exact armhole contour; smoothly blend to the shoulder ridge.
      const edgeWeight = Math.abs(Math.cos(angle)) ** 6
      z = mix(z, edge.z, edgeWeight)
      z = mix(z, roof.z, smooth((k - 0.55) / 0.45))
    }
    return outsideTorso(new THREE.Vector3(x, y, z))
  }

  const rootIds: number[][] = arms.map(() => [])
  for (const front of [1, -1]) {
    const halves = front > 0 && splitFront ? [[0, columns / 2], [columns / 2, columns]] : [[0, columns]]
    for (let half = 0; half < halves.length; half++) {
      const [start, end] = halves[half]!
      const grid: number[][] = []
      for (let row = 0; row <= lowerRows + upperRows; row++) {
        const line: number[] = []
        for (let c = start!; c <= end!; c++) {
          let key = `panel:${front}:${row}:${c}`
          const isEdge = c === 0 || c === columns
          const isShoulder = row === lowerRows + upperRows && (c <= neckColumn || c >= columns - neckColumn)
          if ((isEdge && row <= lowerRows) || isShoulder) key = `sewn:${row}:${c}`
          const placket = front > 0 && splitFront && c === columns / 2
          if (placket) key += `:${half}`
          const id = vertex(key, panelPoint(c, row, front), c / columns, row / (lowerRows + upperRows),
            placket ? (half === 0 ? -1 : 1) : undefined,
            isEdge && row >= lowerRows ? vector(limbPointAt(arms[c === 0 ? left : right]!, rootDistances[c === 0 ? left : right]!)) : undefined)
          line.push(id)
          if (placket && half === 1) closedFrontPairs.push([shared.get(`panel:1:${row}:${c}:0`)!, id])
          if (isEdge && row >= lowerRows) {
            const ringIndex = front > 0 ? upperRows - row + lowerRows : (upperRows + row - lowerRows) % (2 * upperRows)
            rootIds[c === 0 ? left : right]![ringIndex] = id
          }
        }
        grid.push(line)
      }
      for (let r = 0; r < grid.length - 1; r++) for (let c = 0; c < grid[r]!.length - 1; c++) {
        quad(grid[r]![c]!, grid[r]![c + 1]!, grid[r + 1]![c + 1]!, grid[r + 1]![c]!, front < 0)
      }
    }
  }
  if (spec.sleeve) for (let a = 0; a < arms.length; a++) {
    const arm = arms[a]!
    const start = rootDistances[a]!
    const len = spec.dimensions?.sleeveCm
      ? Math.min(arm.length * 0.98, Math.max(0.01, spec.dimensions.sleeveCm / 100))
      : arm.length * (spec.sleeve === 'long' ? 0.95 : 0.36)
    let previous = rootIds[a]!
    for (let row = 1; row <= sleeveRows; row++) {
      const d = mix(start, Math.max(start + 0.01, len), row / sleeveRows)
      const ring = roots[a]!.map((root, c) => {
        const angle = c * Math.PI / upperRows
        const p = section(arm, d, angle)
        p.addScaledVector(root.clone().sub(rawRoots[a]![c]!), 1 - smooth(row / 5))
        return vertex(`sleeve:${a}:${row}:${c}`, p, c / (2 * upperRows), row / sleeveRows,
          undefined, vector(limbPointAt(arm, d)))
      })
      for (let c = 0; c < ring.length; c++) {
        const next = (c + 1) % ring.length
        quad(previous[c]!, previous[next]!, ring[next]!, ring[c]!, arm.side < 0)
      }
      previous = ring
    }
  }
  const geometry = new THREE.BufferGeometry()
  const neighbors = Array.from({ length: params.length }, () => new Set<number>())
  const edges = new Map<string, { a: number; b: number; count: number }>()
  for (let i = 0; i < indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = indices[i + j]!, b = indices[i + (j + 1) % 3]!
    neighbors[a]!.add(b); neighbors[b]!.add(a)
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`
    const edge = edges.get(key)
    if (edge) edge.count++
    else edges.set(key, { a, b, count: 1 })
  }
  const boundary = new Set<number>()
  for (const edge of edges.values()) if (edge.count === 1) { boundary.add(edge.a); boundary.add(edge.b) }
  // Remove ray-sampling ridges across the sewn shoulder/underarm, then constrain
  // vertices back outside the body. Cuffs, neckline and front opening stay fixed.
  let points = params.map((_, i) => new THREE.Vector3().fromArray(positions, i * 3))
  for (let pass = 0; pass < 8; pass++) {
    points = points.map((p, i) => {
      if (boundary.has(i)) return p
      const average = new THREE.Vector3()
      for (const n of neighbors[i]!) average.add(points[n]!)
      const next = p.clone().lerp(average.divideScalar(neighbors[i]!.size), 0.5)
      // Fit once after smoothing, rather than repeating BVH queries on every
      // smoothing pass (which made each slider update hundreds of milliseconds).
      if (pass < 7) return next
      const origin = origins[i]
      if (!origin) return outsideTorso(next)
      const dir = next.clone().sub(origin)
      const distance = dir.length()
      dir.divideScalar(distance)
      const hit = surface.radiusAt(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 0.25)
      return hit !== null && hit + offset > distance ? next.addScaledVector(dir, hit + offset - distance) : next
    })
  }
  points.forEach((p, i) => {
    p.toArray(positions, i * 3)
    params[i]!.t = p.y / H
    params[i]!.theta = Math.atan2(p.z, p.x)
  })
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  // A short inward return gives neck, cuffs, hem and placket a visible fabric edge
  // instead of an infinitely thin cut. It remains part of the same indexed mesh.
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute
  for (const [a, b] of closedFrontPairs) {
    const n = new THREE.Vector3().fromBufferAttribute(normals, a).add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize()
    normals.setXYZ(a, n.x, n.y, n.z); normals.setXYZ(b, n.x, n.y, n.z)
  }
  const inner = new Map<number, number>()
  const edgeDepth = Math.min(0.0025, Math.max(0.0012, (spec.dimensions?.thicknessMm ?? 0.6) / 1000))
  for (const id of boundary) {
    const p = points[id]!.clone().addScaledVector(new THREE.Vector3().fromBufferAttribute(normals, id), -edgeDepth)
    const inside = positions.length / 3
    inner.set(id, inside)
    positions.push(p.x, p.y, p.z)
    uvs.push(uvs[id * 2]!, uvs[id * 2 + 1]!)
    params.push({ ...params[id]! }) // Same displacement on both sides of the edge.
  }
  for (const { a, b, count } of edges.values()) if (count === 1) quad(b, a, inner.get(a)!, inner.get(b)!)
  for (const [a, b] of [...closedFrontPairs]) closedFrontPairs.push([inner.get(a)!, inner.get(b)!])
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return { geometry, params, closedFrontPairs }
}
