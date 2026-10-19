import * as THREE from 'three'
import { buildLegSpecs, limbPointAt, limbRadiusAt, type BodyModel } from './body'
import type { BodySurface } from './mesh-body'
import type { GarmentVertexParam } from './garment-upper'

/** Waist tube branches into two legs along a shared, curved crotch seam. */
export function buildLowerGarment(model: BodyModel, surface: BodySurface, bottomY: number, topY: number, offset: number) {
  const sk = model.skeleton
  const positions: number[] = [], indices: number[] = [], uvs: number[] = []
  const params: GarmentVertexParam[] = []
  const add = (p: THREE.Vector3, u: number, v: number) => {
    const i = params.length
    positions.push(p.x, p.y, p.z); uvs.push(u, v)
    params.push({ t: p.y / sk.height, theta: Math.atan2(p.z, p.x) })
    return i
  }
  const point = (i: number) => new THREE.Vector3().fromArray(positions, i * 3)
  const quad = (a: number, b: number, c: number, d: number, flip = false) => {
    if (flip) indices.push(a, c, b, a, d, c)
    else indices.push(a, b, c, a, c, d)
  }
  const sectors = 32, bridgeSegments = 8, waistRows = 10, legRows = 24
  const branchY = Math.min(topY - 0.03, sk.hipY + 0.02)
  const waist: number[][] = []
  for (let row = 0; row <= waistRows; row++) {
    const y = THREE.MathUtils.lerp(topY, branchY, row / waistRows)
    const ring: number[] = []
    for (let c = 0; c < sectors; c++) {
      const angle = Math.PI / 2 - c * 2 * Math.PI / sectors
      const dx = Math.cos(angle), dz = Math.sin(angle)
      const hit = surface.radiusAt(0, y, 0, dx, 0, dz, 0.5)
      const fallback = 1 / Math.hypot(dx / sk.hip.w, dz / sk.hip.d)
      const radius = (hit ?? fallback) + offset
      ring.push(add(new THREE.Vector3(dx * radius, y, dz * radius), c / sectors, row / waistRows))
    }
    if (row) for (let c = 0; c < sectors; c++) {
      const next = (c + 1) % sectors
      quad(waist[row - 1]![c]!, waist[row - 1]![next]!, ring[next]!, ring[c]!)
    }
    waist.push(ring)
  }
  const root = waist[waistRows]!
  const front = point(root[0]!), back = point(root[sectors / 2]!)
  const insideY = sk.hipY + 0.04
  const crotch = surface.radiusAt(0, insideY, 0, 0, -1, 0, 0.25)
  const crotchY = Math.min(branchY - 0.035, crotch === null ? sk.hipY - 0.065 : insideY - crotch - offset)
  // Both leg loops reuse this bridge, with opposite winding. No overlapping
  // pelvic cylinders and no unstitched slit between the thighs.
  const bridge = [root[sectors / 2]!]
  for (let i = 1; i < bridgeSegments; i++) {
    const k = i / bridgeSegments
    const p = back.clone().lerp(front, k)
    p.y = THREE.MathUtils.lerp(branchY, crotchY, Math.sin(k * Math.PI))
    bridge.push(add(p, 0.5, k))
  }
  bridge.push(root[0]!)

  for (const leg of buildLegSpecs(model)) {
    const half = sectors / 2
    const loop = Array.from({ length: half + 1 }, (_, c) => root[(leg.side > 0 ? c : sectors - c) % sectors]!)
    loop.push(...bridge.slice(1, -1))
    const circumference = loop.length
    const angleAt = (c: number) => c <= half
      ? Math.PI / 2 - c * Math.PI / half
      : -Math.PI / 2 - (c - half) * Math.PI / bridgeSegments
    const section = (d: number, c: number) => {
      const center = limbPointAt(leg, d)
      const angle = angleAt(c)
      const dx = leg.side * Math.cos(angle), dz = Math.sin(angle)
      const fallback = limbRadiusAt(leg, d)
      const hit = surface.radiusAt(center.x, center.y, center.z, dx, 0, dz, fallback * 1.8)
      return new THREE.Vector3(center.x + dx * ((hit ?? fallback) + offset), center.y,
        center.z + dz * ((hit ?? fallback) + offset))
    }
    // Horizontal cuts respect the requested outseam and never extend into feet.
    const hem = Math.max(sk.ankleY, Math.min(branchY - 0.06, bottomY))
    const endDistance = leg.length * (leg.origin.y - hem) / (leg.origin.y - leg.end.y)
    const startDistance = Math.min(endDistance * 0.6, Math.max(0.10, leg.origin.y - crotchY + 0.04))
    const initial = loop.map((_, c) => section(startDistance, c))
    const outsideLeg = (p: THREE.Vector3) => {
      const d = p.y >= leg.mid.y
        ? leg.segLen1 * (leg.origin.y - p.y) / (leg.origin.y - leg.mid.y)
        : leg.segLen1 + leg.segLen2 * (leg.mid.y - p.y) / (leg.mid.y - leg.end.y)
      const center = limbPointAt(leg, d)
      const direction = new THREE.Vector3(p.x - center.x, 0, p.z - center.z)
      const length = direction.length()
      if (length < 1e-8) return p
      direction.divideScalar(length)
      const hit = surface.radiusAt(center.x, p.y, center.z, direction.x, 0, direction.z, limbRadiusAt(leg, d) * 2.2)
      if (hit !== null && hit + offset > length) p.addScaledVector(direction, hit + offset - length)
      return p
    }
    let previous = loop
    for (let row = 1; row <= legRows; row++) {
      const k = row / legRows
      const d = THREE.MathUtils.lerp(startDistance, endDistance, k)
      const blend = 1 - THREE.MathUtils.smoothstep(k, 0, 0.4)
      const ring = loop.map((id, c) => add(outsideLeg(section(d, c).addScaledVector(point(id).sub(initial[c]!), blend)), c / circumference, k))
      for (let c = 0; c < circumference; c++) {
        const next = (c + 1) % circumference
        quad(previous[c]!, previous[next]!, ring[next]!, ring[c]!, leg.side < 0)
      }
      previous = ring
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return { geometry, params }
}
