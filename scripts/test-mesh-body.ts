/** Real OBJ regression tests; no browser/GPU or network required. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from '../packages/tryon-engine/node_modules/three/build/three.module.js'
import { createBodyState, deriveProfile, setHeight, setFrame, setWeight, FRAME_KEYS, FRAME_RANGES } from '../packages/core/src/index'
import { MeshBody } from '../packages/tryon-engine/src/mesh-body'
import { buildSkeleton } from '../packages/tryon-engine/src/body'
import { TryonEngine } from '../packages/tryon-engine/src/engine'
import type { TryonPlatform } from '../packages/tryon-engine/src/platform'

let checks = 0
function check(condition: unknown, message: string) { checks++; assert.ok(condition, message) }
function near(actual: number, expected: number, message: string, tolerance = 1e-6) {
  check(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`)
}
const texts = Object.fromEntries(['female', 'male'].map(g => [g, readFileSync(`apps/client/src/static/models/${g}.obj`, 'utf8')]))
const make = (g: 'female' | 'male') => MeshBody.loadFromText(texts[g]!, deriveProfile(createBodyState(g)), g)

for (const gender of ['female', 'male'] as const) {
  const state = createBodyState(gender)
  const neutral = deriveProfile(state)
  const body = make(gender)
  const reference = body.getReference()
  const initial = body.getPositions().slice()
  let identityError = 0
  for (let i = 0; i < reference.length; i++) identityError = Math.max(identityError, Math.abs(initial[i]! - reference[i]! * neutral.heightCm / 100))
  near(identityError, 0, `${gender}: loader applies the neutral profile without changing the sculpture`)

  const profiles = [deriveProfile(setHeight(state, gender === 'male' ? 195 : 180)), deriveProfile(setWeight(state, 90))]
  for (const key of FRAME_KEYS) {
    for (const value of [FRAME_RANGES[key].min, FRAME_RANGES[key].max]) profiles.push(deriveProfile(setFrame(state, key, value)))
  }
  for (const profile of profiles) {
    body.setProfile(profile)
    const p = body.getPositions()
    let low = Infinity, high = -Infinity
    for (let i = 0; i < p.length; i += 3) {
      check(Number.isFinite(p[i]! + p[i + 1]! + p[i + 2]!), `${gender}: finite vertex`)
      low = Math.min(low, p[i + 1]!); high = Math.max(high, p[i + 1]!)
      if (reference[i + 1]! >= 0.89) {
        // Head dimensions cannot be driven by shoulder width, leg length or girth.
        near(p[i]! / profile.heightCm * 100, reference[i]!, `${gender}: head x`)
        near(p[i + 2]! / profile.heightCm * 100, reference[i + 2]!, `${gender}: head z`)
      }
    }
    near(low, 0, `${gender}: feet grounded`)
    near(high, profile.heightCm / 100, `${gender}: exact requested height`)
    const skeleton = buildSkeleton(profile)
    for (const leg of skeleton.legs) {
      near(leg.mid[1], skeleton.kneeY, 'SDF knee and leg chain agree')
      near(leg.end[1], skeleton.ankleY, 'SDF ankle and leg chain agree')
    }
  }
  body.setProfile(neutral)
  assert.deepEqual(body.getPositions(), initial, 'changing parameters then resetting has no accumulated drift')

  // Compare the accelerated surface query with THREE's independent triangle traversal,
  // after refits and with a translated/rotated/non-uniformly scaled parent.
  const mesh = body.object3D.children[0] as THREE.Mesh
  const raycaster = new THREE.Raycaster()
  const origin = new THREE.Vector3(), direction = new THREE.Vector3()
  let rayChecks = 0
  for (const transform of [false, true]) {
    if (transform) {
      body.object3D.position.set(0.1, 0.2, -0.15)
      body.object3D.rotation.y = 0.3
      body.object3D.scale.set(0.9, 1.1, 1.2)
    }
    body.setProfile(profiles[1]!)
    body.object3D.updateMatrixWorld(true)
    for (let y = 0; y < 12; y++) for (let angle = 0; angle < 16; angle++) {
      origin.set(0, y * 0.15, 0).applyMatrix4(mesh.matrixWorld)
      direction.set(Math.cos(angle), (angle % 3 - 1) * 0.1, Math.sin(angle)).normalize().transformDirection(mesh.matrixWorld)
      const maxDist = angle % 5 === 0 ? 0.02 : 0.8
      raycaster.set(origin, direction); raycaster.far = maxDist
      const expected = raycaster.intersectObject(mesh, false)[0]?.distance ?? null
      const actual = body.radiusAt(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, maxDist)
      if (expected === null) assert.equal(actual, null)
      else { assert.notEqual(actual, null); near(actual!, expected, 'BVH matches triangle raycaster') }
      rayChecks++
    }
  }
  assert.equal(body.radiusAt(0, 0, 0, 0, 0, 0, 1), null)
  body.dispose()
  console.log(`${gender}: neutral identity, ${profiles.length} profiles, head preservation, floor/height, ${rayChecks} ray comparisons passed`)
}

const renderer = { setSize() {}, setPixelRatio() {}, render() {}, dispose() { rendererDisposals++ } }
let rendererDisposals = 0
const platform: TryonPlatform = { name: 'h5', createRenderer: () => renderer, requestFrame: () => 1, cancelFrame() {}, getPixelRatio: () => 1, now: () => 0 }
const engine = new TryonEngine({ platform, canvas: { width: 600, height: 900 }, width: 600, height: 900,
  bodyProfile: deriveProfile(createBodyState('female')) })
const originalLoader = MeshBody.loadFromUrl
const pending = new Map<string, { resolve: (body: MeshBody) => void; reject: (error: Error) => void }>()
MeshBody.loadFromUrl = (url) => new Promise((resolve, reject) => pending.set(url, { resolve, reject }))
try {
  const first = engine.useMeshBody('first')
  engine.setBodyProfile(deriveProfile(createBodyState('male')))
  const second = engine.useMeshBody('second')
  const latest = make('male')
  pending.get('second')!.resolve(latest); await second
  const stale = make('female')
  let staleDisposals = 0
  ;(stale.object3D.children[0] as THREE.Mesh).geometry.addEventListener('dispose', () => staleDisposals++)
  pending.get('first')!.resolve(stale); await first
  check(engine.raw.world.children.includes(latest.object3D), 'newest mesh request wins')
  check(!engine.raw.world.children.includes(stale.object3D), 'stale mesh never enters scene')
  assert.equal(staleDisposals, 1)
  assert.equal(engine.getBodyProfile().gender, 'male')
  engine.setBodyProfile(deriveProfile(createBodyState('female')))
  const femaleLoad = engine.useMeshBody('female-again')
  // Changes made during download must be applied when the mesh is installed.
  engine.setBodyProfile(deriveProfile(setHeight(createBodyState('female'), 170)))
  const femaleAgain = make('female')
  pending.get('female-again')!.resolve(femaleAgain); await femaleLoad
  near(femaleAgain.currentProfile.heightCm, 170, 'latest slider values survive loading')

  const dimensions = { thicknessMm: 1, lengthCm: 62, sleeveCm: 50 }
  const original = engine.addGarment('p_white_shirt', 0x123456, dimensions)!
  engine.setWearMode('p_white_shirt', 'open'); engine.setFastenerClosed('p_white_shirt', 2)
  engine.setGarmentColor('p_white_shirt', 0x345678)
  const oldPositions = ((original.object3D.children[0] as THREE.Mesh).geometry.getAttribute('position').array as Float32Array).slice()
  engine.zoom(-100); engine.renderOnce()
  const cameraDistance = engine.raw.camera.position.distanceTo(new THREE.Vector3(0, engine.getBodyProfile().heightCm / 200, 0))
  const started = performance.now()
  engine.setBodyProfile(deriveProfile(setHeight(createBodyState('female'), 180)))
  console.log(`Mesh + dressed-shirt refit: ${(performance.now() - started).toFixed(1)} ms (Node, not mobile GPU)`)
  engine.renderOnce()
  const garment = engine.getGarment('p_white_shirt')!
  check(garment !== original, 'garment refitted after mesh shape changed')
  assert.equal(garment.wearMode, 'open'); assert.equal(garment.fastenerClosed, 2)
  assert.equal(garment.spec.color, 0x345678); assert.deepEqual(garment.spec.dimensions, dimensions)
  assert.notDeepEqual((garment.object3D.children[0] as THREE.Mesh).geometry.getAttribute('position').array, oldPositions)
  near(engine.raw.camera.position.distanceTo(new THREE.Vector3(0, 0.9, 0)), cameraDistance, 'body editing preserves zoom')

  const replacement = engine.useMeshBody('replacement')
  pending.get('replacement')!.resolve(make('female')); await replacement
  check(engine.getGarment('p_white_shirt') !== garment, 'new mesh refits existing garments')

  const failure = engine.useMeshBody('failed-old')
  const success = engine.useMeshBody('new')
  pending.get('failed-old')!.reject(new Error('obsolete network error')); await failure
  pending.get('new')!.resolve(make('female')); await success
  const finalLoad = engine.useMeshBody('after-dispose')
  const late = make('female')
  let lateDisposals = 0
  ;(late.object3D.children[0] as THREE.Mesh).geometry.addEventListener('dispose', () => lateDisposals++)
  engine.dispose(); engine.dispose()
  pending.get('after-dispose')!.resolve(late); await finalLoad
  assert.equal(lateDisposals, 1); assert.equal(rendererDisposals, 1)
  assert.equal(engine.raw.world.children.length, 0)
  console.log('Loading races, obsolete errors, garment refits/state, camera zoom and disposal passed')
} finally {
  MeshBody.loadFromUrl = originalLoader
  engine.dispose()
}
console.log(`Mesh regressions passed (${checks} vertex/numeric assertions plus state assertions)`)
