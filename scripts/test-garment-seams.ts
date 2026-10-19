/** Structural regressions on real meshes; no renderer, browser or network. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as THREE from '../packages/tryon-engine/node_modules/three/build/three.module.js'
import { createBodyState, deriveProfile, setFrame, setHeight, setWeight, FRAME_RANGES, type FrameKey } from '../packages/core/src/index'
import { createBodyModel, buildLegSpecs, limbPointAt } from '../packages/tryon-engine/src/body'
import { MeshBody } from '../packages/tryon-engine/src/mesh-body'
import { createGarment, Garment, GARMENT_REGISTRY } from '../packages/tryon-engine/src/garment'

let cases = 0
let clearanceRays = 0
let legRays = 0
function topology(garment: Garment, boundaryLoops: number) {
  assert.equal(garment.object3D.children.length, 1, 'body and sleeves are one mesh')
  const mesh = garment.object3D.children[0] as THREE.Mesh
  const geo = mesh.geometry
  const pos = geo.getAttribute('position'), normals = geo.getAttribute('normal')
  const index = geo.getIndex()!
  const edges = new Map<string, { a: number; b: number; count: number; winding: number }>()
  const neighbors = Array.from({ length: pos.count }, () => new Set<number>())
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(normals, i)
    assert.ok(Number.isFinite(a.x + a.y + a.z + b.x + b.y + b.z), 'finite geometry')
    assert.ok(b.length() > 0.9, 'nonzero unit normal')
    assert.ok(geo.boundingBox!.containsPoint(a), 'refreshed bounding box contains every vertex')
  }
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
    a.fromBufferAttribute(pos, ids[0]!); b.fromBufferAttribute(pos, ids[1]!); c.fromBufferAttribute(pos, ids[2]!)
    assert.ok(b.sub(a).cross(c.sub(a)).length() > 1e-10, 'no collapsed triangle')
    for (let j = 0; j < 3; j++) {
      const from = ids[j]!, to = ids[(j + 1) % 3]!
      neighbors[from]!.add(to); neighbors[to]!.add(from)
      const key = `${Math.min(from, to)}:${Math.max(from, to)}`
      const edge = edges.get(key) ?? { a: from, b: to, count: 0, winding: 0 }
      edge.count++; edge.winding += from < to ? 1 : -1; edges.set(key, edge)
    }
  }
  function components(graph: Map<number, Set<number>>) {
    const seen = new Set<number>()
    let count = 0
    for (const start of graph.keys()) {
      if (seen.has(start)) continue
      count++; const stack = [start]; seen.add(start)
      while (stack.length) for (const next of graph.get(stack.pop()!)!) {
        if (!seen.has(next)) { seen.add(next); stack.push(next) }
      }
    }
    return count
  }
  assert.equal(components(new Map(neighbors.map((ns, i) => [i, ns]))), 1, 'no floating sleeves/panels')
  const boundary = new Map<number, Set<number>>()
  for (const edge of edges.values()) {
    assert.ok(edge.count <= 2, 'manifold seam: at most two faces per edge')
    if (edge.count === 2) assert.equal(edge.winding, 0, 'sewn faces have consistent winding')
    else {
      if (!boundary.has(edge.a)) boundary.set(edge.a, new Set())
      if (!boundary.has(edge.b)) boundary.set(edge.b, new Set())
      boundary.get(edge.a)!.add(edge.b); boundary.get(edge.b)!.add(edge.a)
    }
  }
  for (const adjacent of boundary.values()) assert.equal(adjacent.size, 2, 'openings are closed boundary loops')
  assert.equal(components(boundary), boundaryLoops, 'only designed openings remain; no armhole/shoulder cracks')
  cases++
}

function release(garment: Garment) {
  garment.object3D.traverse((o: any) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose() } })
}
for (const gender of ['female', 'male'] as const) {
  const state = createBodyState(gender)
  const states = [state, setHeight(state, 150), setHeight(state, 195), setWeight(state, 90)]
  for (const key of ['shoulderWidthCm', 'torsoLengthCm', 'upperArmCm', 'forearmCm'] as FrameKey[]) {
    states.push(setFrame(state, key, FRAME_RANGES[key].min), setFrame(state, key, FRAME_RANGES[key].max))
  }
  const text = readFileSync(`apps/client/src/static/models/${gender}.obj`, 'utf8')
  for (const [s, current] of states.entries()) {
    const profile = deriveProfile(current)
    const body = MeshBody.loadFromText(text, profile, gender)
    const model = body.fittingModel(createBodyModel(profile))
    const trousers = createGarment(model, 'p_wide_trousers', undefined, { outseamCm: 100 }, body)!
    topology(trousers, 3)
    if (s === 0) {
      const mesh = trousers.object3D.children[0] as THREE.Mesh
      trousers.object3D.updateMatrixWorld(true)
      const ray = new THREE.Raycaster()
      for (const leg of buildLegSpecs(model)) for (let row = 0; row < 6; row++) for (let angle = 0; angle < 16; angle++) {
        const p = limbPointAt(leg, leg.length * (0.28 + row * 0.12))
        const dir = new THREE.Vector3(Math.cos(angle * Math.PI / 8), 0, Math.sin(angle * Math.PI / 8))
        const skin = body.radiusAt(p.x, p.y, p.z, dir.x, 0, dir.z, 0.3)
        if (skin === null) continue
        ray.set(new THREE.Vector3(p.x, p.y, p.z), dir)
        const cloth = ray.intersectObject(mesh, false)[0]?.distance
        assert.ok(cloth !== undefined && cloth >= skin - 0.001, `${gender}: trouser triangle remains outside skin`)
        legRays++
      }
      const shorts = createGarment(model, 'p_wide_trousers', undefined, { outseamCm: 50 }, body)!
      topology(shorts, 3)
      assert.ok((shorts.object3D.children[0] as THREE.Mesh).geometry.boundingBox!.min.y > mesh.geometry.boundingBox!.min.y + 0.2, 'outseam changes the trouser hem')
      release(shorts)
    }
    release(trousers)
    if (s === 0) {
      const band = createGarment(model, 'p_knit_scarf', undefined, undefined, body)!
      for (const mode of ['wrapped', 'draped', 'tied'] as const) { band.setWearMode(mode); topology(band, 2) }
      release(band)
    }
    for (const product of ['p_white_shirt', 'p_denim_jacket']) {
      const g = createGarment(model, product, undefined, { lengthCm: s % 2 ? 45 : 62, sleeveCm: s % 2 ? 20 : 50 }, body)!
      topology(g, 3) // Two cuffs; neckline/front slit/hem form one boundary.
      const geo = (g.object3D.children[0] as THREE.Mesh).geometry
      const closed = (geo.getAttribute('position').array as Float32Array).slice()
      const frontPairs: [number, number][] = []
      const coincident = new Map<string, number>()
      for (let i = 0; i < closed.length / 3; i++) {
        if (Math.abs(closed[i * 3]!) > 1e-6 || closed[i * 3 + 2]! <= 0) continue
        const key = Array.from(closed.slice(i * 3, i * 3 + 3)).join(',')
        const first = coincident.get(key)
        if (first !== undefined) frontPairs.push([first, i])
        else coincident.set(key, i)
      }
      assert.ok(frontPairs.length >= 20, 'closed placket has two coincident edges')
      g.setWearMode('open')
      const opened = geo.getAttribute('position')
      for (const [a, b] of frontPairs) assert.ok(Math.abs(opened.getX(a) - opened.getX(b)) > 0.02, 'front opens instead of stretching a face across the gap')
      g.setWearMode('worn')
      if (s === 0 && product === 'p_white_shirt') {
        const mesh = g.object3D.children[0] as THREE.Mesh
        g.object3D.updateMatrixWorld(true)
        const ray = new THREE.Raycaster()
        const low = Math.max(geo.boundingBox!.min.y + 0.03, model.skeleton.hipY + 0.03)
        for (let row = 0; row < 8; row++) for (let angle = 0; angle < 16; angle++) {
          const y = low + (model.skeleton.chestY - low) * row / 7
          const theta = angle * 2 * Math.PI / 16
          const dir = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta))
          const skin = body.radiusAt(0, y, 0, dir.x, 0, dir.z, 0.5)
          if (skin === null) continue
          ray.set(new THREE.Vector3(0, y, 0), dir)
          const cloth = ray.intersectObject(mesh, false)[0]?.distance
          assert.ok(cloth !== undefined && cloth >= skin - 0.001, `${gender}: torso triangle remains outside skin`)
          clearanceRays++
        }
      }
      for (const mode of ['open', 'draped', 'worn'] as const) { g.setWearMode(mode); topology(g, 3) }
      assert.deepEqual(geo.getAttribute('position').array, closed, 'wear modes reset without seam drift')
      g.setFastenerClosed(0); topology(g, 3)
      assert.notDeepEqual(geo.getAttribute('position').array, closed, 'unbuttoning changes geometry')
      g.setFastenerClosed(g.spec.fastenerTotal!); assert.deepEqual(geo.getAttribute('position').array, closed)
      release(g)
    }
    // No-fastener and sleeveless tops have separate neck/hem/arm openings.
    if (s === 0) for (const sleeve of [undefined, 'short', 'long'] as const) {
      const g = new Garment(model, { ...GARMENT_REGISTRY.p_white_shirt!, id: 'test', productId: 'test', sleeve,
        fastenerTotal: undefined, allowedModes: ['worn'] }, body)
      topology(g, 4); release(g)
    }
    body.dispose()
  }
  const g = createGarment(createBodyModel(deriveProfile(state)), 'p_white_shirt')!
  topology(g, 3); release(g)
  const pants = createGarment(createBodyModel(deriveProfile(state)), 'p_wide_trousers')!
  topology(pants, 3); release(pants)
  for (const key of ['thighCm', 'calfCm'] as FrameKey[]) for (const value of [FRAME_RANGES[key].min, FRAME_RANGES[key].max]) {
    const profile = deriveProfile(setFrame(state, key, value))
    const body = MeshBody.loadFromText(text, profile, gender)
    const pants = createGarment(body.fittingModel(createBodyModel(profile)), 'p_wide_trousers', undefined, undefined, body)!
    topology(pants, 3); release(pants); body.dispose()
  }
}
console.log(`${cases} garment topology/state cases; ${clearanceRays} torso and ${legRays} leg clearance rays passed (real male/female OBJ and SDF fallback)`)
