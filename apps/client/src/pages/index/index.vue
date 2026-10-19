<template>
  <NavShell current="/pages/index/index">
  <view
    class="page"
    @touchmove="onDragMove"
    @touchend="onDragEnd"
    @touchcancel="onDragEnd"
  >
    <!-- ───────────── 头部 ───────────── -->
    <view class="header">
      <view class="brand-row">
        <text class="brand">搭</text>
        <text class="brand-en">CDA</text>
      </view>
      <text class="subtitle">身型 → 人偶 → 拖拽穿搭 → 精细穿法</text>
    </view>

    <!-- ───────────── 3D 舞台 ───────────── -->
    <view
      id="tryon-stage"
      class="stage"
      @touchstart="onStageTouchStart"
      @touchmove="onStageTouchMove"
      @touchend="onStageTouchEnd"
      @mousedown="onStageMouseDown"
    >
      <view class="stage-hint">
        <text class="hint-text">{{ stageHint }}</text>
      </view>
      <view class="stage-tools">
        <view class="tool-btn" @click="resetCamera"><text>重置视角</text></view>
        <view class="tool-btn" @click="clearAll"><text>全部脱下</text></view>
      </view>
    </view>

    <!-- ───────────── 我的人偶（低频入口）───────────── -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">我的人偶</text>
        <text class="card-note">{{ personaNote }}</text>
      </view>
      <view class="persona-entry" @click="goPersona">
        <view class="pe-left">
          <text class="pe-title">{{ store.personaCreated ? '修改身型数据' : '创建我的人偶' }}</text>
          <text class="pe-sub">身型只在创建与身体变化时调整，平时不用管</text>
        </view>
        <text class="pe-arrow">›</text>
      </view>
    </view>

    <!-- ───────────── 我的衣橱 ───────────── -->
    <view class="card">
      <view class="card-head">
        <text class="card-title">我的衣橱</text>
        <text class="card-note">按住拖到人偶上，或直接点击</text>
      </view>

      <view class="wardrobe">
        <view
          v-for="item in wardrobeView"
          :key="item.id"
          class="wardrobe-item"
          :class="{ worn: isWorn(item.productId) }"
          @touchstart="onItemTouchStart($event, item)"
          @click="onItemClick(item)"
        >
          <view class="swatch" :style="{ backgroundColor: item.colorHex }" />
          <text class="item-title">{{ item.product?.title }}</text>
          <text class="item-tag">{{ slotLabel(item.product?.category) }}</text>
          <text v-if="isWorn(item.productId)" class="worn-badge">已穿</text>
        </view>
      </view>
    </view>

    <!-- ───────────── 精细穿法 ───────────── -->
    <view v-if="selectedGarment" class="card">
      <view class="card-head">
        <text class="card-title">{{ selectedProductTitle }}</text>
        <view class="tool-btn small" @click="takeOff(selectedGarment)"><text>脱下</text></view>
      </view>

      <!-- 穿法 -->
      <text class="field-label">穿法</text>
      <view class="mode-row">
        <view
          v-for="mode in selectedModes"
          :key="mode"
          class="mode-chip"
          :class="{ active: currentMode === mode }"
          @click="setMode(mode)"
        >
          <text>{{ modeLabel(mode) }}</text>
        </view>
      </view>

      <!-- 扣子 -->
      <view v-if="fastenerTotal > 0" class="fastener">
        <view class="fastener-head">
          <text class="field-label">扣子</text>
          <text class="fastener-value">{{ fastenerClosed }} / {{ fastenerTotal }} 颗</text>
        </view>
        <slider
          :value="fastenerClosed"
          :min="0"
          :max="fastenerTotal"
          :step="1"
          activeColor="#1a1a1a"
          block-color="#1a1a1a"
          :block-size="16"
          @changing="(e: any) => setFastener(e.detail.value)"
          @change="(e: any) => setFastener(e.detail.value)"
        />
        <text class="fastener-hint">
          {{ fastenerClosed === fastenerTotal ? '全部扣上' : fastenerClosed === 0 ? '完全敞开' : `敞开 ${fastenerTotal - fastenerClosed} 颗` }}
        </text>
      </view>
    </view>

    <view class="footnote">
      <text>3D 人偶为程序化生成，服装采用分层刚性贴合 + 解析变形</text>
      <text>非真实布料物理 —— 这是业界当前可工程化的边界</text>
    </view>

    <!-- 拖拽跟随的幽灵元素 -->
    <view
      v-if="dragging"
      class="ghost"
      :style="{ left: ghostX + 'px', top: ghostY + 'px' }"
    >
      <text>{{ draggingTitle }}</text>
    </view>
  </view>
  </NavShell>
</template>

<script setup lang="ts">
import NavShell from '@/components/NavShell.vue'
import { onBeforeUnmount, onMounted, nextTick, ref, reactive, computed } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import {
  findProduct, CATEGORY_LABEL, BODY_BUILDS,
  createBodyState, deriveProfile, weightAt, girthAt, rangeOf,
  setHeight, setWeight, setGirth, setFrame, setGender as setGenderState,
  healthMetrics, GIRTH_KEYS, FRAME_RANGES, HEIGHT_RANGE, WEIGHT_RANGE,
  type BodyBuildId, type BodyState, type Category, type FrameKey,
  type GirthKey, type WearMode,
} from '@cda/core'
import { TryonEngine, createH5Platform, WEAR_MODE_LABEL, GARMENT_REGISTRY } from '@cda/tryon-engine'
import { mountStage, type StageHost } from '@/platform/stage'
import { store } from '@/store/app-store'

// ───────────────────────────── 状态

let engine: TryonEngine | null = null
let stage: StageHost | null = null

const stageHint = ref('按住可旋转人偶')

/**
 * 身型状态。
 *
 * 注意这里存的是 **BodyState 而不是直接存围度** ——
 * 围度由潜在因子（体脂水平）派生，所以拖动任何一项都会牵动全身。
 * 详见 packages/core/src/body-model.ts。
 */
// 身型状态来自共享 store —— 编辑已搬到「个人主页 → 我的人偶」，
// 首页只负责展示与人偶 + 衣橱，不再有滑杆
const state = reactive<BodyState>({ ...store.bodyState, frame: { ...store.bodyState.frame } })
const personaNote = computed(() => (store.personaCreated ? '拖动人偶可旋转' : '尚未创建'))
const profile = computed(() => deriveProfile(state))
const metrics = computed(() => healthMetrics(profile.value))

/** 滑杆字段的种类决定它走哪条耦合路径 */
type FieldKey = 'heightCm' | 'weightKg' | GirthKey | FrameKey

interface MeasureField {
  key: FieldKey
  label: string
  unit: string
}

// 骨骼维度与身高体重范围统一由 @cda/core 提供 —— UI 与模型必须共用同一份，
// 否则模型夹紧用的范围与滑杆显示的范围会不一致（越界 bug 的成因）

const girthSet = new Set<string>(GIRTH_KEYS)

/** 分区建模：按游戏捏人的习惯分段，而不是一次给一长条滑杆 */
type StageId = 'head' | 'upper' | 'lower'

const stages: Array<{ id: StageId; name: string }> = [
  { id: 'head', name: '头颈' },
  { id: 'upper', name: '上半身' },
  { id: 'lower', name: '下半身' },
]

const activeStage = ref<StageId>('upper')

const genders = [
  { value: 'female' as const, label: '女性' },
  { value: 'male' as const, label: '男性' },
]

const basicFields: MeasureField[] = [
  { key: 'heightCm', label: '身高', unit: 'cm' },
  { key: 'weightKg', label: '体重', unit: 'kg' },
]

const stageFields: Record<StageId, MeasureField[]> = {
  head: [{ key: 'neckLengthCm', label: '颈长', unit: 'cm' }],
  upper: [
    { key: 'shoulderWidthCm', label: '肩宽', unit: 'cm' },
    { key: 'chestCm', label: '胸围', unit: 'cm' },
    { key: 'waistCm', label: '腰围', unit: 'cm' },
    { key: 'torsoLengthCm', label: '上身长', unit: 'cm' },
    { key: 'upperArmCircCm', label: '大臂围', unit: 'cm' },
    { key: 'forearmCircCm', label: '小臂围', unit: 'cm' },
    { key: 'upperArmCm', label: '大臂长', unit: 'cm' },
    { key: 'forearmCm', label: '小臂长', unit: 'cm' },
  ],
  lower: [
    { key: 'hipCm', label: '臀围', unit: 'cm' },
    { key: 'thighCircCm', label: '大腿围', unit: 'cm' },
    { key: 'calfCircCm', label: '小腿围', unit: 'cm' },
    { key: 'thighCm', label: '大腿长', unit: 'cm' },
    { key: 'calfCm', label: '小腿长', unit: 'cm' },
  ],
}

/** 取某项的当前值 */
function fieldValue(key: FieldKey): number {
  if (key === 'heightCm') return state.heightCm
  if (key === 'weightKg') return Math.round(weightAt(state) * 10) / 10
  if (girthSet.has(key)) return Math.round(girthAt(state, key as GirthKey))
  return Math.round(state.frame[key as FrameKey] * 10) / 10
}

/** 取某项的可拖范围。围度与体重的范围是**派生**的，不是写死的 */
function fieldRange(key: FieldKey): { min: number; max: number } {
  if (key === 'heightCm') return HEIGHT_RANGE[state.gender]
  if (key === 'weightKg') {
    // BMI 导出的范围 ∩ 绝对值范围，两者都要满足
    const w = rangeOf(state, 'weightKg')
    const abs = WEIGHT_RANGE[state.gender]
    return { min: Math.max(w.min, abs.min), max: Math.min(w.max, abs.max) }
  }
  if (girthSet.has(key)) return rangeOf(state, key as GirthKey)
  return FRAME_RANGES[key as FrameKey]
}

/** 形体风格：定「偏肌肉还是偏脂肪」，具体维度仍由上面的数据决定 */
const builds = BODY_BUILDS
const activeBuildDesc = computed(
  () => builds.find((b) => b.id === state.build)?.description ?? '',
)

/**
 * 各分段之和 vs 身高。
 * 用户填的数据常常不自洽，引擎会自动按比例归一 —— 这里把它显示出来，
 * 避免用户以为是自己填错了。
 */

const worn = ref<string[]>([])
const selectedGarment = ref<string | null>(null)

const dragging = ref(false)
const draggingTitle = ref('')
const ghostX = ref(0)
const ghostY = ref(0)
let draggingProductId: string | null = null

// ───────────────────────────── 派生数据

const wardrobeView = computed(() =>
  store.wardrobe.map((w) => {
    const product = findProduct(w.productId)
    const color = product?.colors.find((c) => c.id === w.colorId)
    return {
      id: w.id,
      productId: w.productId,
      product,
      colorHex: color?.hex ?? '#cccccc',
    }
  }),
)

const selectedProductTitle = computed(() => {
  if (!selectedGarment.value) return ''
  return findProduct(selectedGarment.value)?.title ?? selectedGarment.value
})

const selectedModes = computed<WearMode[]>(() => {
  if (!selectedGarment.value) return []
  return GARMENT_REGISTRY[selectedGarment.value]?.allowedModes ?? []
})

const currentMode = ref<WearMode>('worn')
const fastenerTotal = computed(() => GARMENT_REGISTRY[selectedGarment.value ?? '']?.fastenerTotal ?? 0)
const fastenerClosed = ref(0)

// ───────────────────────────── 生命周期

onMounted(async () => {
  await nextTick()
  // 给布局一帧时间，确保容器尺寸可测
  setTimeout(initEngine, 60)
})

onBeforeUnmount(() => {
  engine?.dispose()
  stage?.dispose()
})

function initEngine() {
  try {
    stage = mountStage('tryon-stage')
  } catch (err) {
    stageHint.value = `舞台初始化失败：${String(err)}`
    return
  }

  engine = new TryonEngine({
    platform: createH5Platform(),
    canvas: stage.canvas,
    width: stage.width,
    height: stage.height,
    bodyProfile: deriveProfile(state),
  })

  stage.onResize((w, h) => engine?.resize(w, h))
  engine.start()
  stageHint.value = '按住可旋转人偶'
  // 先应用 URL 里的体型参数，再加载网格 ——
  // 顺序反了的话，网格下载期间就用了旧档案（见 useMeshBody 的注释）
  applyBodyFromQuery()
  void loadMesh()
  applyPoseFromQuery()
  applyPendingOutfit()
}

/**
 * 调试 / 截图用体型预设：`?m=height:178,waist:95,hip:105`
 *
 * 用于精确复现某个体型，不必手动拖滑杆（拖滑杆无法自动化验证）。
 * 走的是与滑杆**完全相同**的耦合路径，所以验证结果对真实操作有效。
 */
function applyBodyFromQuery() {
  // #ifdef H5
  if (typeof window === 'undefined') return
  const qs = new URLSearchParams(window.location.search)
  // 性别也可以从 URL 指定，便于自动化测试男女两套
  const gq = qs.get('g')
  if (gq === 'male' || gq === 'female') {
    if (state.gender !== gq) Object.assign(state, setGenderState(state, gq))
  }
  const spec = qs.get('m')
  if (!spec) {
    Object.assign(store.body, currentProfile())
    engine?.setBodyProfile(currentProfile(), 'final')
    return
  }
  const map: Record<string, 'height' | 'weight' | 'girth' | 'frame'> = {
    height: 'height', weight: 'weight',
    chest: 'girth', waist: 'girth', hip: 'girth', thigh: 'girth', arm: 'girth',
    shoulder: 'frame', torso: 'frame', neck: 'frame', upperArm: 'frame',
    forearm: 'frame', thighLen: 'frame', calf: 'frame',
  }
  const keyOf: Record<string, string> = {
    height: 'heightCm', weight: 'weightKg',
    chest: 'chestCm', waist: 'waistCm', hip: 'hipCm', thigh: 'thighCircCm', arm: 'upperArmCircCm',
    shoulder: 'shoulderWidthCm', torso: 'torsoLengthCm', neck: 'neckLengthCm',
    upperArm: 'upperArmCm', forearm: 'forearmCm', thighLen: 'thighCm', calf: 'calfCm',
  }
  for (const part of spec.split(',')) {
    const [rawK, rawV] = part.split(':')
    const kind = map[rawK ?? '']
    const v = Number(rawV)
    if (!kind || !Number.isFinite(v)) continue
    let next: BodyState = state
    if (kind === 'height') next = setHeight(state, v)
    else if (kind === 'weight') next = setWeight(state, v)
    else if (kind === 'girth') next = setGirth(state, keyOf[rawK!] as GirthKey, v)
    else next = setFrame(state, keyOf[rawK!] as FrameKey, v)
    Object.assign(state, next)
  }
  Object.assign(store.body, currentProfile())
  engine?.setBodyProfile(currentProfile(), 'final')
  // #endif
}

/**
 * 调试 / 截图用姿势预设：`?pose=all|open|drape|scarf`
 * 快速把 demo 摆到某个状态，便于回归对比与出图。仅 H5 生效。
 */
function applyPoseFromQuery() {
  // #ifdef H5
  if (typeof window === 'undefined' || !engine) return
  const pose = new URLSearchParams(window.location.search).get('pose')
  if (!pose) return

  const ALL = ['p_white_shirt', 'p_denim_jacket', 'p_wide_trousers', 'p_knit_scarf']

  if (pose === 'all' || pose === 'open' || pose === 'drape') {
    for (const id of ALL) wear(id)
  }

  if (pose === 'open') {
    engine.setWearMode('p_denim_jacket', 'open')
    engine.setFastenerClosed('p_denim_jacket', 1)
    selectGarment('p_denim_jacket')
  } else if (pose === 'drape') {
    engine.setWearMode('p_white_shirt', 'draped')
    selectGarment('p_white_shirt')
  } else if (pose === 'scarf') {
    wear('p_knit_scarf')
    engine.setWearMode('p_knit_scarf', 'wrapped')
    selectGarment('p_knit_scarf')
  } else if (pose === 'all') {
    selectGarment('p_white_shirt')
  }

  syncPanelFromEngine()
  // #endif
}

/** 引擎需要的是展开后的完整身型数据 */
/**
 * 是否使用雕刻网格人体。
 *
 * 网格的解剖细节来自 MakeHuman 的 CC0 雕刻，体型由耦合模型重拟合 ——
 * 见 packages/tryon-engine/src/mesh-body.ts。
 * SDF 人体同时保留（服装壳的射线求交依赖它），两者由同一份身型数据驱动。
 */
const useMesh = ref(true)
const meshLoading = ref(false)
const meshError = ref('')
let meshRequest = 0

async function loadMesh() {
  if (!engine) return
  const currentEngine = engine
  const request = ++meshRequest
  meshLoading.value = true
  meshError.value = ''
  try {
    await currentEngine.useMeshBody(`/static/models/${state.gender}.obj`)
    if (request !== meshRequest || engine !== currentEngine) return
    useMesh.value = currentEngine.usingMeshBody
  } catch (err) {
    if (request !== meshRequest || engine !== currentEngine) return
    meshError.value = String(err)
    console.error('[CDA] 雕刻网格加载失败:', err)
  } finally {
    if (request === meshRequest) meshLoading.value = false
  }
}

/**
 * SDF 人体已下线，雕刻网格是唯一的身体。
 * 不再提供开关 —— 两具身体并存只会让人分不清哪个是真的。
 */

function currentProfile() {
  return deriveProfile(state)
}

/**
 * 拖动过程中的重算合并到下一帧。
 * 每收到一次 changing 就重建一次会拖死主线程 —— 人体网格是多边形化出来的，
 * 单次重建几十毫秒，必须限流。
 */
let previewScheduled = false

function schedulePreview() {
  if (previewScheduled) return
  previewScheduled = true
  const run = () => {
    previewScheduled = false
    engine?.setBodyProfile(currentProfile(), 'preview')
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

/**
 * 改一项数据。
 *
 * 关键：这里**不是**把某个几何参数改掉，而是把它换算成潜在因子（体脂水平），
 * 再由潜在因子重算全身 —— 所以拖臀围时腰围、大腿围、体重会一起变，
 * 用户感受到的是「人在变」，而不是「一个球在胀」。
 */
function onFieldChange(key: FieldKey, value: number, phase: 'changing' | 'change' = 'change') {
  let next: BodyState = state
  if (key === 'heightCm') next = setHeight(state, value)
  else if (key === 'weightKg') next = setWeight(state, value)
  else if (girthSet.has(key)) next = setGirth(state, key as GirthKey, value)
  else next = setFrame(state, key as FrameKey, value)

  Object.assign(state, next)
  Object.assign(store.body, currentProfile())

  if (phase === 'changing') schedulePreview()
  else engine?.setBodyProfile(currentProfile(), 'final')
}

/** 切换性别：保留体脂水平与身高，骨骼维度按新性别重建 */
function setGender(gender: 'male' | 'female') {
  if (state.gender === gender) return
  Object.assign(state, setGenderState(state, gender))
  Object.assign(store.body, currentProfile())
  engine?.setBodyProfile(currentProfile(), 'final')
  // 网格已开启时必须换网格，否则会一直是上一个性别的身体
  if (useMesh.value) void loadMesh()
}

/**
 * 切换形体风格。
 * 只改变形体语言（肌肉隆起、脂肪堆积），**不动任何尺寸数字**。
 */
function setBuild(id: BodyBuildId) {
  if (state.build === id) return
  state.build = id
  Object.assign(store.body, currentProfile())
  engine?.setBodyProfile(currentProfile(), 'final')
}

// ───────────────────────────── 穿脱

function isWorn(productId: string) {
  return worn.value.includes(productId)
}

function wear(productId: string) {
  if (!engine) return
  // 单件单品出问题不应该让整条链路中断（曾经因为围巾的一个 bug
  // 导致后续所有逻辑静默失效，排查了很久）
  try {
    const product = findProduct(productId)
    // 把成衣实测尺寸交给引擎 —— 衣长、袖长、面料厚度都由它推导
    const g = engine.addGarment(productId, undefined, product?.dimensions)
    if (!g) {
      stageHint.value = '该单品暂无 3D 描述'
      return
    }
    if (!worn.value.includes(productId)) worn.value.push(productId)
    selectGarment(productId)
  } catch (err) {
    console.error('[CDA] 穿上单品失败:', productId, err)
    stageHint.value = `「${findProduct(productId)?.title ?? productId}」渲染失败`
  }
}

function takeOff(productId: string) {
  engine?.removeGarment(productId)
  worn.value = worn.value.filter((id) => id !== productId)
  if (selectedGarment.value === productId) {
    selectedGarment.value = worn.value[0] ?? null
    syncPanelFromEngine()
  }
}

function clearAll() {
  engine?.clearGarments()
  worn.value = []
  selectedGarment.value = null
}

function selectGarment(productId: string) {
  selectedGarment.value = productId
  syncPanelFromEngine()
}

function syncPanelFromEngine() {
  if (!selectedGarment.value || !engine) return
  const g = engine.getGarment(selectedGarment.value)
  if (!g) return
  currentMode.value = g.wearMode
  fastenerClosed.value = g.fastenerClosed
}

// ───────────────────────────── 穿法 / 扣子

function setMode(mode: WearMode) {
  if (!selectedGarment.value) return
  engine?.setWearMode(selectedGarment.value, mode)
  currentMode.value = mode
}

function setFastener(n: number) {
  if (!selectedGarment.value) return
  engine?.setFastenerClosed(selectedGarment.value, n)
  fastenerClosed.value = Math.round(n)
}

function modeLabel(mode: WearMode) {
  return WEAR_MODE_LABEL[mode] ?? mode
}

function slotLabel(category?: Category) {
  return category ? CATEGORY_LABEL[category] : ''
}

// ───────────────────────────── 舞台相机交互

let lastStagePoint: { x: number; y: number } | null = null

function onStageTouchStart(e: any) {
  const t = e.touches?.[0]
  if (!t) return
  // 记录起点，供轻点拾取判断是否发生了拖动
  tapStart = { x: t.clientX, y: t.clientY, t: Date.now() }
  lastStagePoint = { x: t.clientX, y: t.clientY }
}

function onStageTouchMove(e: any) {
  if (dragging.value) return
  const t = e.touches?.[0]
  if (!t || !lastStagePoint) return
  engine?.orbit(t.clientX - lastStagePoint.x, t.clientY - lastStagePoint.y)
  lastStagePoint = { x: t.clientX, y: t.clientY }
}

/*
 * 舞台轻点拾取：点中哪件衣服就脱哪件。
 *
 * 必须与「拖动旋转」区分开 —— 判据是位移小于 8px 且时长小于 350ms，
 * 否则用户每次转视角都会误脱衣服。
 */
let tapStart: { x: number; y: number; t: number } | null = null
const TAP_MOVE = 8
const TAP_MS = 350

function pickOffAt(clientX: number, clientY: number): void {
  if (!engine || !worn.value.length) return
  // 画布位置：跨端用 createSelectorQuery，避免依赖 DOM
  uni
    .createSelectorQuery()
    .select('#tryon-stage')
    .boundingClientRect((rect) => {
      const r = rect as { left: number; top: number; width: number; height: number } | null
      if (!r?.width) return
      const hit = engine?.pickGarment(clientX, clientY, r) ?? null
      if (hit) {
        takeOff(hit)
        stageHint.value = `已脱下「${findProduct(hit)?.title ?? hit}」`
      }
    })
    .exec()
}

function onStageTouchEnd(e: any) {
  const t = e?.changedTouches?.[0] ?? e?.touches?.[0]
  if (tapStart && t) {
    const dx = t.clientX - tapStart.x
    const dy = t.clientY - tapStart.y
    if (Math.sqrt(dx * dx + dy * dy) < TAP_MOVE && Date.now() - tapStart.t < TAP_MS) {
      pickOffAt(t.clientX, t.clientY)
    }
  }
  tapStart = null
  lastStagePoint = null
}

function onStageMouseDown(e: any) {
  // 桌面端：按住拖动旋转
  const startX = e.clientX as number
  const startY = e.clientY as number
  let px = startX
  let py = startY

  const move = (ev: MouseEvent) => {
    engine?.orbit(ev.clientX - px, ev.clientY - py)
    px = ev.clientX
    py = ev.clientY
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function resetCamera() {
  engine?.resetCamera()
}

function goTryOn() {
  uni.navigateTo({ url: '/pages/tryon/tryon' })
}

function goPersona(): void {
  uni.navigateTo({ url: '/pages/persona/persona' })
}

function goProfile(): void {
  uni.navigateTo({ url: '/pages/profile/profile' })
}

function goWardrobe() {
  uni.navigateTo({ url: '/pages/wardrobe/wardrobe' })
}

function goOutfit() {
  uni.navigateTo({ url: '/pages/outfit/outfit' })
}

function goImport() {
  uni.navigateTo({ url: '/pages/import/import' })
}

/**
 * 消费「穿搭建议」页写入的 pendingOutfit。
 * uni-app 的 onShow 会早于引擎初始化触发，所以引擎未就绪时不能清空标记，
 * 留到 initEngine 之后再消费。
 */
function applyPendingOutfit() {
  if (!engine || !store.pendingOutfit) return
  clearAll()
  for (const productId of store.pendingOutfit) wear(productId)
  store.pendingOutfit = null
}

onShow(() => {
  applyPendingOutfit()
})

// ───────────────────────────── 拖拽穿单品

function onItemTouchStart(e: any, item: { productId: string; product?: { title: string } }) {
  const t = e.touches?.[0]
  if (!t) return
  dragging.value = true
  draggingProductId = item.productId
  draggingTitle.value = item.product?.title ?? ''
  ghostX.value = t.clientX
  ghostY.value = t.clientY
}

function onDragMove(e: any) {
  if (!dragging.value) return
  const t = e.touches?.[0]
  if (!t) return
  ghostX.value = t.clientX
  ghostY.value = t.clientY
}

function onDragEnd(e: any) {
  if (!dragging.value) return
  const t = e.changedTouches?.[0] ?? e.touches?.[0]
  dragging.value = false

  if (t && stage) {
    const r = stage.getRect()
    const inside =
      t.clientX >= r.left && t.clientX <= r.left + r.width && t.clientY >= r.top && t.clientY <= r.top + r.height
    if (inside && draggingProductId) {
      wear(draggingProductId)
      draggingProductId = null
      return
    }
  }
  draggingProductId = null
}

function onItemClick(item: { productId: string }) {
  // 点击直接穿上（触摸设备上比拖拽更省力）；
  // **已穿的再点一下就是脱下** —— 省得为了脱一件而「全部脱下」
  if (isWorn(item.productId)) takeOff(item.productId)
  else wear(item.productId)
}
</script>

<style scoped>
.page {
  min-height: 100vh;
  padding: 48px 16px 40px;
  box-sizing: border-box;
  background: #f5f5f7;
}

/* ---------- 头部 ---------- */
.header {
  margin-bottom: 18px;
  padding: 0 4px;
}
.brand-row {
  display: flex;
  align-items: baseline;
}
.brand {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 6px;
}
.brand-en {
  font-size: 12px;
  letter-spacing: 5px;
  color: #9a9a9a;
  margin-left: 10px;
}
.subtitle {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  color: #8a8a8a;
}
.entry-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.entry-btn {
  width: calc(50% - 4px);
  box-sizing: border-box;
  padding: 9px 0;
  border-radius: 999px;
  background: #1a1a1a;
  text-align: center;
}
.entry-btn text {
  font-size: 12px;
  color: #ffffff;
}

/* ---------- 3D 舞台 ---------- */
.stage {
  position: relative;
  width: 100%;
  height: 46vh;
  min-height: 320px;
  border-radius: 20px;
  overflow: hidden;
  /* 刻意用较深的暖灰：白色单品在浅背景上会「消失」，深一档才有对比 */
  background: linear-gradient(170deg, #cfc9c2 0%, #bdb6ae 55%, #a9a29a 100%);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.1);
}
.stage-hint {
  position: absolute;
  left: 14px;
  top: 12px;
  z-index: 2;
}
.hint-text {
  font-size: 11px;
  color: #5d574f;
}
.stage-tools {
  position: absolute;
  right: 12px;
  top: 10px;
  z-index: 2;
  display: flex;
  gap: 8px;
}
.tool-btn {
  padding: 5px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  font-size: 11px;
  color: #444;
}
.tool-btn.small {
  padding: 4px 10px;
}

/* ---------- 卡片 ---------- */
.card {
  margin-top: 14px;
  background: #ffffff;
  border-radius: 18px;
  padding: 16px;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.05);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
}
.card-note {
  font-size: 11px;
  color: #a0a0a0;
}

.tool-btn.on {
  background: #1a1a1a;
}
.tool-btn.on text {
  color: #ffffff;
}
.stage-hint.err {
  color: #c0504d;
}

/* ---------- 滑杆 ---------- */
.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.preset-chip {
  padding: 6px 12px;
  border-radius: 999px;
  background: #f2f2f2;
}
.preset-chip text {
  font-size: 12px;
  color: #555;
}
.preset-chip.active {
  background: #1a1a1a;
}
.preset-chip.active text {
  color: #ffffff;
}
.preset-desc {
  display: block;
  font-size: 10.5px;
  color: #a8a8a8;
  line-height: 16px;
  margin-bottom: 14px;
}

.gender-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.gender-chip {
  flex: 1;
  height: 36px;
  border-radius: 10px;
  background: #f2f2f2;
  display: flex;
  align-items: center;
  justify-content: center;
}
.gender-chip text {
  font-size: 13px;
  color: #555;
}
.gender-chip.active {
  background: #1a1a1a;
}
.gender-chip.active text {
  color: #ffffff;
}

.measure-group {
  margin-bottom: 10px;
}
.stage-row {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.stage-chip {
  flex: 1;
  height: 34px;
  border-radius: 10px;
  background: #f5f5f5;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid transparent;
}
.stage-chip text {
  font-size: 12px;
  color: #555;
}
.stage-chip.active {
  border-color: #1a1a1a;
  background: #ffffff;
}
.stage-chip.active text {
  color: #1a1a1a;
  font-weight: 600;
}
.group-title {
  display: block;
  font-size: 11px;
  color: #a0a0a0;
  letter-spacing: 1px;
  margin: 6px 0 4px;
}
.health-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.health-item {
  flex: 1;
  padding: 9px 8px;
  border-radius: 12px;
  background: #f5f5f5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 3px solid #c8c8c8;
}
.health-item.good {
  background: #eef7ee;
  border-left-color: #4a9d4a;
}
.health-item.watch {
  background: #fdf6e8;
  border-left-color: #d9a441;
}
.health-item.risk {
  background: #fdecec;
  border-left-color: #c0504d;
}
.health-label {
  font-size: 10px;
  color: #8a8a8a;
}
.health-value {
  font-size: 15px;
  font-weight: 600;
}
.health-note {
  font-size: 9.5px;
  color: #9a9a9a;
  line-height: 13px;
}
.persona-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #f7f5f2;
  border-radius: 12px;
}
.pe-left {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pe-title {
  font-size: 14px;
  font-weight: 600;
}
.pe-sub {
  font-size: 10.5px;
  color: #a0a0a0;
}
.pe-arrow {
  font-size: 20px;
  color: #c8c8c8;
}
.health-tip {
  display: block;
  font-size: 10.5px;
  color: #b0b0b0;
  line-height: 16px;
}

.normalize-hint {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #f2f2f2;
}
.normalize-hint text {
  font-size: 10.5px;
  color: #b0b0b0;
  line-height: 16px;
}

.slider-row {
  display: flex;
  align-items: center;
  margin-bottom: 2px;
}
.slider-label {
  width: 40px;
  font-size: 12px;
  color: #6a6a6a;
  flex-shrink: 0;
}
.slider {
  flex: 1;
  margin: 0 6px;
}
.slider-value {
  width: 56px;
  text-align: right;
  font-size: 12px;
  color: #1a1a1a;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* ---------- 衣橱 ---------- */
.wardrobe {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.wardrobe-item {
  position: relative;
  width: calc(50% - 5px);
  box-sizing: border-box;
  padding: 12px;
  border-radius: 14px;
  background: #fafafa;
  border: 1.5px solid transparent;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wardrobe-item.worn {
  border-color: #1a1a1a;
  background: #f2f2f0;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.item-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 18px;
}
.item-tag {
  font-size: 11px;
  color: #9a9a9a;
}
.worn-badge {
  position: absolute;
  right: 10px;
  top: 10px;
  font-size: 10px;
  color: #ffffff;
  background: #1a1a1a;
  border-radius: 999px;
  padding: 2px 7px;
}

/* ---------- 穿法面板 ---------- */
.field-label {
  font-size: 12px;
  color: #6a6a6a;
  display: block;
  margin-bottom: 8px;
}
.mode-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.mode-chip {
  padding: 7px 14px;
  border-radius: 999px;
  background: #f2f2f2;
  font-size: 12px;
  color: #555;
}
.mode-chip.active {
  background: #1a1a1a;
  color: #ffffff;
}
.fastener {
  border-top: 1px solid #f0f0f0;
  padding-top: 14px;
}
.fastener-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.fastener-value {
  font-size: 12px;
  color: #1a1a1a;
  font-variant-numeric: tabular-nums;
}
.fastener-hint {
  display: block;
  font-size: 11px;
  color: #a0a0a0;
  margin-top: 2px;
}

/* ---------- 其他 ---------- */
.footnote {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 6px;
}
.footnote text {
  font-size: 10.5px;
  color: #b0b0b0;
  line-height: 16px;
}
.ghost {
  position: fixed;
  z-index: 99;
  transform: translate(-50%, -50%);
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(26, 26, 26, 0.9);
  color: #ffffff;
  font-size: 12px;
  pointer-events: none;
}
</style>
