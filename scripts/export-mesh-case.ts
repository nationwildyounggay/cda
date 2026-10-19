/** Export a parameterized body for scripts/render-mesh.py, without WebGL. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createBodyState, deriveProfile, setFrame, FRAME_KEYS, type FrameKey } from '../packages/core/src/index'
import { MeshBody } from '../packages/tryon-engine/src/mesh-body'

const [gender, key, rawValue, output] = process.argv.slice(2)
if ((gender !== 'female' && gender !== 'male') || !FRAME_KEYS.includes(key as FrameKey) || !Number.isFinite(Number(rawValue)) || !output) {
  throw new Error('Usage: export-mesh-case <female|male> <frame key> <cm> <output.obj>')
}
const text = readFileSync(`apps/client/src/static/models/${gender}.obj`, 'utf8')
const profile = deriveProfile(setFrame(createBodyState(gender), key as FrameKey, Number(rawValue)))
const body = MeshBody.loadFromText(text, profile, gender)
body.setProfile(profile) // Also works with the previous loader, which did not initialize positions.
const positions = body.getPositions()
const lines = Array.from({ length: positions.length / 3 }, (_, i) =>
  `v ${positions[i * 3]} ${positions[i * 3 + 1]} ${positions[i * 3 + 2]}`)
lines.push(...text.split('\n').filter(line => line.startsWith('f ')))
writeFileSync(output, lines.join('\n') + '\n')
body.dispose()
console.log(`Exported ${gender} ${key}=${rawValue} to ${output}`)
