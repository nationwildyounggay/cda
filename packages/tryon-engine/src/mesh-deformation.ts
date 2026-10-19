/** Reference-space deformation for the bundled MakeHuman A-pose meshes. */
import * as THREE from 'three'
import type { BodySkeleton, LimbChain } from './body'
import { createBodyState, deriveProfile, type BodyProfile } from '@cda/core'

const clamp = (t: number) => Math.max(0, Math.min(1, t))
function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
function curve(x: number, points: number[][]): number {
  for (let i = 1; i < points.length; i++) {
    const [a, va] = points[i - 1]!
    const [b, vb] = points[i]!
    if (x <= b!) return va! + (vb! - va!) * smooth(a!, b!, x)
  }
  return points[points.length - 1]![1]!
}

export class MeshDeformation {
  landmarks!: Pick<BodySkeleton, 'ankleY' | 'kneeY' | 'hipY' | 'waistY' | 'chestY' | 'shoulderY' | 'chinY' | 'headTopY' | 'arms' | 'legs'>
  private readonly armWeights: Float32Array
  private readonly shoulder: THREE.Vector3
  private readonly elbow: THREE.Vector3
  private readonly wrist: THREE.Vector3
  private readonly armDir: THREE.Vector3
  private readonly armLength: number
  private readonly hip: THREE.Vector3
  private readonly ankle: THREE.Vector3

  constructor(private readonly base: Float32Array, adj: number[][]) {
    const n = base.length / 3
    if (adj.length !== n) throw new Error('[CDA] Mesh adjacency does not match vertices')
    // Measure only the positive limb; reflection keeps left/right behavior identical.
    const at = (y: number, minX: number) => {
      const p = new THREE.Vector3()
      let count = 0
      for (let i = 0; i < n; i++) {
        if (base[3 * i]! <= minX || Math.abs(base[3 * i + 1]! - y) > 0.02) continue
        p.add(new THREE.Vector3(base[3 * i], base[3 * i + 1], base[3 * i + 2]))
        count++
      }
      if (!count) throw new Error('[CDA] Mesh is not a supported A-pose body')
      return p.divideScalar(count)
    }
    this.shoulder = at(0.80, 0.09)
    // Hands occupy y≈0.57; the wrist is above them. Do not use the hand centroid as a wrist.
    this.elbow = at(0.70, 0.16)
    this.wrist = at(0.62, 0.20)
    this.armDir = this.wrist.clone().sub(this.shoulder).normalize()
    this.armLength = this.wrist.distanceTo(this.shoulder)
    this.hip = at(0.47, 0)
    this.ankle = at(0.085, 0)

    // Local support is essential: an infinite torso/leg axis also passes through the
    // face. Radius estimates containing the opposite limb previously assigned the
    // head and fingers to unrelated bones. Blend only at the actual shoulder joint.
    let weights = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = Math.abs(base[i * 3]!)
      const y = base[i * 3 + 1]!
      const boundary = 0.105 + (0.80 - y) * 0.22
      weights[i] = smooth(boundary, boundary + 0.05, x)
        * (1 - smooth(0.82, 0.87, y)) * smooth(0.46, 0.52, y)
    }
    // Cache the reference weights, rather than recomputing them on every slider event.
    // No threshold mask after diffusion: that would reintroduce hard seams.
    for (let pass = 0; pass < 8; pass++) {
      const next = weights.slice()
      for (let i = 0; i < n; i++) {
        const neighbors = adj[i]!
        if (neighbors.length) next[i] = weights[i]! * 0.5
          + neighbors.reduce((sum, j) => sum + weights[j]!, 0) * 0.5 / neighbors.length
      }
      weights = next
    }
    this.armWeights = weights
  }

  fit(profile: BodyProfile, out: Float32Array): void {
    const H = profile.heightCm / 100
    // Measurements already grow with height in core. Compare at the SAME height,
    // then apply meters once; otherwise both bone length and girth scale twice.
    const neutral = deriveProfile(createBodyState(profile.gender, 'average', profile.heightCm))
    const ratio = (a: number, b: number) => a / b
    const hipGain = ratio(profile.hipCm, neutral.hipCm)
    const waistGain = ratio(profile.waistCm, neutral.waistCm)
    const chestGain = ratio(profile.chestCm, neutral.chestCm)
    const shoulderGain = ratio(profile.shoulderWidthCm, neutral.shoulderWidthCm)
    const thighGain = ratio(profile.thighCircCm, neutral.thighCircCm)
    const calfGain = ratio(profile.calfCircCm, neutral.calfCircCm)
    const upperGain = ratio(profile.upperArmCircCm, neutral.upperArmCircCm)
    const foreGain = ratio(profile.forearmCircCm, neutral.forearmCircCm)
    const upperScale = ratio(profile.upperArmCm, neutral.upperArmCm)
    const foreScale = ratio(profile.forearmCm, neutral.forearmCm)

    // Connected ankle→knee→hip→shoulder→chin chain, anchored at the floor.
    // Conflicting measurements change proportions while preserving requested height.
    // Head and feet retain their shape instead of being stretched by leg/neck sliders.
    const ys = [0.075, 0.28, 0.50, 0.82, 0.87]
    const lengths = [
      0.205 * ratio(profile.calfCm, neutral.calfCm),
      0.22 * ratio(profile.thighCm, neutral.thighCm),
      0.32 * ratio(profile.torsoLengthCm, neutral.torsoLengthCm),
      0.05 * ratio(profile.neckLengthCm, neutral.neckLengthCm),
    ]
    const scale = (0.87 - 0.075) / lengths.reduce((a, b) => a + b, 0)
    const target = [ys[0]!]
    for (const length of lengths) target.push(target[target.length - 1]! + length * scale)
    const mapY = (y: number) => {
      if (y <= ys[0]!) return y
      for (let i = 1; i < ys.length; i++) {
        if (y <= ys[i]!) return target[i - 1]! + (y - ys[i - 1]!)
          * (target[i]! - target[i - 1]!) / (ys[i]! - ys[i - 1]!)
      }
      return y + target[4]! - ys[4]!
    }
    const shoulderY = mapY(this.shoulder.y)
    const elbow = this.armLength * 0.53
    const wrist = this.armLength
    const armDistance = (d: number) => d <= elbow ? d * upperScale
      : elbow * upperScale + Math.min(d - elbow, wrist - elbow) * foreScale + Math.max(0, d - wrist)
    const torsoPoints = [[0.50, hipGain], [0.60, waistGain], [0.72, chestGain], [0.82, 1], [0.86, 1]]
    const legPoints = [[0.075, 1], [0.16, calfGain], [0.28, (thighGain + calfGain) / 2], [0.39, thighGain], [0.52, hipGain]]
    const armPoints = [[0, 1], [0.28, upperGain], [0.53, (upperGain + foreGain) / 2], [0.72, foreGain], [1, 1]]

    // Garments must use these same transformed axes, not the unrelated SDF pose.
    const arms: LimbChain[] = ([-1, 1] as const).map(side => {
      const point = (reference: THREE.Vector3): [number, number, number] => {
        const relative = reference.clone().sub(this.shoulder)
        const d = relative.dot(this.armDir)
        const perpendicular = relative.addScaledVector(this.armDir, -d)
        const gain = curve(d / this.armLength, armPoints)
        return [
          side * (this.shoulder.x * shoulderGain + this.armDir.x * armDistance(d) + perpendicular.x * gain) * H,
          (shoulderY + this.armDir.y * armDistance(d) + perpendicular.y * gain) * H,
          (this.shoulder.z + this.armDir.z * armDistance(d) + perpendicular.z * gain) * H,
        ]
      }
      return { side, root: point(this.shoulder), mid: point(this.elbow), end: point(this.wrist),
        rRoot: profile.upperArmCircCm / 100 / (2 * Math.PI),
        rMid: profile.forearmCircCm / 100 / (2 * Math.PI), rEnd: 0.018 * H }
    })
    const legs: LimbChain[] = ([-1, 1] as const).map(side => {
      const point = (y: number): [number, number, number] => {
        const t = clamp((y - this.ankle.y) / (this.hip.y - this.ankle.y))
        return [side * (this.ankle.x + (this.hip.x - this.ankle.x) * t) * H,
          mapY(y) * H, (this.ankle.z + (this.hip.z - this.ankle.z) * t) * H]
      }
      return { side, root: point(0.50), mid: point(0.28), end: point(0.075),
        rRoot: profile.thighCircCm / 100 / (2 * Math.PI),
        rMid: profile.calfCircCm / 100 / (2 * Math.PI), rEnd: 0.023 * H }
    })
    this.landmarks = { ankleY: mapY(0.075) * H, kneeY: mapY(0.28) * H,
      hipY: mapY(0.50) * H, waistY: mapY(0.60) * H, chestY: mapY(0.72) * H,
      shoulderY: mapY(0.82) * H, chinY: mapY(0.87) * H, headTopY: H, arms, legs }

    for (let i = 0; i < this.base.length / 3; i++) {
      const x = this.base[i * 3]!
      const y = this.base[i * 3 + 1]!
      const z = this.base[i * 3 + 2]!
      const side = x < 0 ? -1 : 1
      const torsoGain = curve(y, torsoPoints)
      const shoulderInfluence = smooth(0.68, 0.80, y) * (1 - smooth(0.82, 0.87, y))
      let bx = x * torsoGain * (1 + (shoulderGain - 1) * shoulderInfluence)
      let bz = z * torsoGain
      let by = mapY(y)
      const legWeight = 1 - smooth(0.43, 0.53, y)
      if (legWeight > 0) {
        const t = clamp((y - this.ankle.y) / (this.hip.y - this.ankle.y))
        // Fade the signed axis to zero at the crotch seam, keeping the field continuous.
        const cx = side * (this.ankle.x + (this.hip.x - this.ankle.x) * t) * smooth(0, 0.035, Math.abs(x))
        const cz = this.ankle.z + (this.hip.z - this.ankle.z) * t
        const gain = curve(y, legPoints)
        const lx = cx + (x - cx) * gain
        const lz = cz + (z - cz) * gain
        bx += (lx - bx) * legWeight
        bz += (lz - bz) * legWeight
      }
      const w = this.armWeights[i]!
      if (w > 0) {
        const rx = Math.abs(x) - this.shoulder.x
        const ry = y - this.shoulder.y
        const rz = z - this.shoulder.z
        const dir = this.armDir
        const d = rx * dir.x + ry * dir.y + rz * dir.z
        const gain = curve(d / this.armLength, armPoints)
        const along = armDistance(d)
        const ax = side * (this.shoulder.x * shoulderGain + dir.x * along + (rx - dir.x * d) * gain)
        const ay = shoulderY + dir.y * along + (ry - dir.y * d) * gain
        const az = this.shoulder.z + dir.z * along + (rz - dir.z * d) * gain
        bx += (ax - bx) * w
        by += (ay - by) * w
        bz += (az - bz) * w
      }
      out[i * 3] = bx * H
      out[i * 3 + 1] = by * H
      out[i * 3 + 2] = bz * H
    }
  }
}
