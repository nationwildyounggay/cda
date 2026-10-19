/** Export the actual fitted meshes for offline seam inspection (no WebGL). */
import { readFileSync, writeFileSync } from 'node:fs'
import { createBodyState, deriveProfile, setFrame, FRAME_KEYS, type FrameKey, type WearMode } from '../packages/core/src/index'
import { createBodyModel } from '../packages/tryon-engine/src/body'
import { MeshBody } from '../packages/tryon-engine/src/mesh-body'
import { createGarment } from '../packages/tryon-engine/src/garment'

const [gender = 'female', mode = 'worn', output = '/tmp/cda-garment.json', key, value, product = 'p_white_shirt'] = process.argv.slice(2)
if (gender !== 'female' && gender !== 'male') throw new Error('Expected female or male')
let state = createBodyState(gender)
if (key && key !== '-') {
  if (!FRAME_KEYS.includes(key as FrameKey) || !Number.isFinite(Number(value))) throw new Error('Invalid frame key/value')
  state = setFrame(state, key as FrameKey, Number(value))
}
const profile = deriveProfile(state)
const body = MeshBody.loadFromText(readFileSync(`apps/client/src/static/models/${gender}.obj`, 'utf8'), profile, gender)
const model = body.fittingModel(createBodyModel(profile))
const garment = createGarment(model, product, 0x477baf, { lengthCm: 62, sleeveCm: 50, outseamCm: 100 }, body)!
garment.setWearMode(mode as WearMode)
const meshes: unknown[] = []
for (const [group, color] of [[body.object3D, [0.80, 0.77, 0.73]], [garment.object3D, [0.26, 0.48, 0.72]]] as const) {
  group.traverse((object: any) => {
    if (!object.isMesh) return
    const geo = object.geometry
    meshes.push({ name: object.name, positions: Array.from(geo.attributes.position.array),
      normals: Array.from(geo.attributes.normal.array), indices: Array.from(geo.index.array), color })
  })
}
writeFileSync(output, JSON.stringify(meshes))
console.log(`Exported ${gender} ${mode} to ${output}`)
body.dispose()
