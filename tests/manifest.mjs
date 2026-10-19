/**
 * 测试清单。
 *
 * 每个测试文件在这里登记：级别、模块、覆盖点、**影响点标签**。
 * 影响点标签是这套体系的核心 —— 改了一处代码后，
 * 用 `node tests/run.mjs --impact <标签>` 就能只跑受影响的用例。
 *
 * ── 级别定义 ──
 *   L0 基础功能   页面能打开、接口能通、字段有值。**改动后必跑，快。**
 *   L1 核心功能   注册、登录、发帖、私聊等主流程真的走通。
 *   L2 安全设计   越权、注入、限流、隐私、会话失效。
 *   L3 性能体验   加载耗时、并发、体积、边界值。
 *   L4 复杂场景   多状态转换：被拉黑后、禁用后、跨版本升级、
 *                 并发操作、数据一致性。
 */

export const LEVELS = {
  L0: { name: '基础功能', desc: '页面可打开、接口可通、字段有值' },
  L1: { name: '核心功能', desc: '主流程端到端走通' },
  L2: { name: '安全设计', desc: '越权、限流、隐私、会话失效' },
  L3: { name: '性能体验', desc: '耗时、并发、体积、边界值' },
  L4: { name: '复杂场景', desc: '多状态转换与数据一致性' },
}

/**
 * 测试登记表。
 *
 * file        测试脚本路径（相对仓库根）
 * level       L0~L4
 * module      所属功能模块
 * runner      'api' = 需要后端；'browser' = 需要后端托管前端
 * covers      覆盖点（给人看的）
 * impacts     **影响点标签** —— 改了这些地方就该跑它
 */
export const TESTS = [
  {
    file: 'scripts/test-garment-seams.ts', level: 'L1', module: '服装接缝回归', runner: 'none',
    covers: ['衣身与袖子连通', '肩缝/腋下流形与法线方向', '领口/袖口/衣摆边界', '裤装裆缝与裤长', '围巾环带闭合', '男女体型边界', '敞开/披着/扣子切换无接缝漂移', 'SDF 回退'],
    impacts: ['body', 'tryon', 'mesh', 'garment'],
  },
  {
    file: 'scripts/test-mesh-body.ts', level: 'L1', module: '3D 网格回归', runner: 'none',
    covers: ['真实 OBJ 身高/落地/头部保护', '体表查询与 Three.js 对照', '加载竞态与释放', '服装随体型更新并保留状态', '缩放不重置'],
    impacts: ['body', 'tryon', 'mesh'],
  },
  {
    file: 'scripts/audit-body.ts', level: 'L3', module: '3D 网格回归', runner: 'none',
    covers: ['男女 68 组参数边界', '相邻边拉伸离群检测，异常时退出失败'],
    impacts: ['body', 'tryon', 'mesh'],
  },
  // ── L0 基础功能 ──
  {
    file: 'scripts/test-pages.mjs',
    level: 'L0',
    module: '页面',
    runner: 'browser',
    covers: ['10 个用户端页面能打开', '关键元素存在', '无运行时报错'],
    impacts: ['page', 'ui', 'frontend'],
  },
  {
    file: 'scripts/test-api.mjs',
    level: 'L0',
    module: '接口',
    runner: 'api',
    covers: [
      '注册/登录/登出可用', '发帖/点赞/评论/收藏可用',
      '消息收发可用', '地址与衣橱 CRUD 可用',
    ],
    impacts: ['api', 'backend', 'db', 'auth', 'post', 'message', 'address', 'wardrobe'],
  },

  // ── L1 核心功能 ──
  {
    file: 'scripts/test-e2e-register.mjs',
    level: 'L1',
    module: '注册+社区',
    runner: 'browser',
    covers: [
      '浏览器完成注册并落库',
      '另一个账号能搜到该用户',
      '跨用户发消息、发帖、评论、点赞',
      '首页信息流显示他人帖子',
    ],
    impacts: ['register', 'auth', 'api', 'post', 'message', 'frontend', 'page'],
  },
  {
    file: 'scripts/test-full-register.mjs',
    level: 'L1',
    module: '注册',
    runner: 'browser',
    covers: ['6 步注册全流程', '验证码输入', '各步准入校验', '完成跳转'],
    impacts: ['register', 'frontend', 'page'],
  },
  {
    file: 'scripts/test-round3.mjs',
    level: 'L1',
    module: '注册+人偶',
    runner: 'browser',
    covers: ['品牌步骤可跳过', '三围按身高体重估算', '已穿衣服点击脱下'],
    impacts: ['register', 'body', 'tryon', 'frontend'],
  },

  {
    file: 'scripts/test-v101.mjs',
    level: 'L1',
    module: 'v1.0.1',
    runner: 'api',
    covers: [
      '注册时生日/身型/品牌可跳过',
      '我的资料可补填身型（含 0.5 精度）并落库',
      '头像上传成功、可取回、带缓存',
      '头像非图片格式被拒、超 500KB 被拒、未登录不能传',
      '穿搭/闲置分栏筛选正确且无交集',
      '非法 kind 被规整',
    ],
    impacts: ['register', 'profile', 'avatar', 'post', 'api', 'security'],
  },

  {
    file: 'scripts/test-body-proportion.ts',
    level: 'L1',
    module: '照片估算',
    runner: 'none',
    covers: [
      '关键点比例换算（肩宽/躯干/四肢，误差 <8%）',
      '尺度无关：人物远近不影响结果',
      '拒绝类：无人 / 多人 / 人太小 / 身高越界',
      '告警类：侧身 / 手臂贴身',
      '超范围值被夹紧并下调置信度',
      '应用时只改 frame，不动体脂与形体风格',
      '低置信字段保留原值（不覆盖用户设置）',
    ],
    impacts: ['body', 'photo', 'core'],
  },
  {
    file: 'scripts/test-photo-proportion.mjs',
    level: 'L3',
    module: '照片估算-端侧',
    runner: 'browser',
    covers: [
      '页面可打开、隐私提示与能力边界在首屏',
      '身高越界有明确提示',
      'WASM 同源编译（MIME 正确）',
      '模型加载并对真实照片产出 33 个关键点与分割掩膜',
      '推理耗时在可接受范围',
    ],
    impacts: ['photo', 'page', 'frontend', 'perf'],
  },

  {
    file: 'scripts/test-account-check.mjs',
    level: 'L2',
    module: '注册前置检查',
    runner: 'api',
    covers: [
      '已注册的手机号 / 邮箱 → available=false',
      '未注册的手机号 / 邮箱 → available=true（不能误拦新用户）',
      '响应只含 ok/available，不泄露昵称或用户码（防枚举升级为隐私泄露）',
      '手机号 / 邮箱格式非法、kind 非法、缺参、超长 → 400',
      '连续查询超过阈值 → 429（防批量枚举）',
    ],
    impacts: ['api', 'auth', 'register', 'security', 'frontend'],
  },

  {
    file: 'scripts/test-register-duplicate.mjs',
    level: 'L1',
    module: '注册前置检查-UI',
    runner: 'browser',
    covers: [
      '已注册手机号点「获取验证码」→ 当场提示，且不进入验证码步骤',
      '未注册手机号 → 正常进入验证码步骤（不误拦新用户）',
      '全程无运行时报错',
    ],
    impacts: ['register', 'frontend', 'page', 'auth'],
  },

  // ── L2 安全设计 ──
  {
    file: 'scripts/test-server-regressions.mjs',
    level: 'L2',
    module: '后端边界回归',
    // 脚本自行创建临时库与独立服务，退出时清理，不使用运行器的共享数据目录。
    runner: 'none',
    covers: [
      '聊天读取最新一页、时间戳并列顺序、分页与已读范围',
      '搜索隐私过滤先于分页',
      '异常分页参数不产生 SQLite 500',
      '静态文件与头像的目录边界',
      '用户端、后台及静态路由的非法 URL 不导致进程退出',
      '用户与后台请求体必须是 JSON 对象',
    ],
    impacts: ['api', 'backend', 'security', 'message', 'admin', 'avatar', 'page'],
  },
  {
    file: 'scripts/test-admin.mjs',
    level: 'L2',
    module: '管理后台',
    runner: 'api',
    covers: [
      '用户 token 与后台 token 双向隔离',
      '三级角色权限边界',
      '禁用必须填原因',
      '禁用即踢下线',
      '后台登录限流（5 次锁 30 分钟）',
      '审计日志记录操作与原因',
    ],
    impacts: ['admin', 'auth', 'security', 'db'],
  },
  {
    file: 'scripts/test-auth-and-register.mjs',
    level: 'L2',
    module: '鉴权',
    runner: 'browser',
    covers: [
      '未登录访问主页面被引导到登录页',
      '手机号格式校验（11 位）',
      '非法手机号被拦截',
    ],
    impacts: ['auth', 'register', 'security', 'frontend'],
  },

  // ── L3 性能体验 ──
  {
    file: 'scripts/test-perf.mjs',
    level: 'L3',
    module: '性能',
    runner: 'api',
    covers: [
      '接口响应耗时',
      '分页正确性',
      '静态资源 gzip 生效',
      '数据库体积增长合理',
    ],
    impacts: ['perf', 'api', 'db'],
  },

  // ── L4 复杂场景 ──
  {
    file: 'scripts/test-scenarios.mjs',
    level: 'L4',
    module: '多状态',
    runner: 'api',
    covers: [
      '被拉黑者的全部行为受限',
      '禁用→启用→再登录的状态流转',
      '账号删除后关联数据一并清理',
      '邀请码一次性与并发注册',
      '隐私设置切换后搜索可见性变化',
    ],
    impacts: ['db', 'api', 'auth', 'security', 'admin'],
  },
  {
    file: 'scripts/test-v1-features.mjs',
    level: 'L4',
    module: '版本与聊天',
    runner: 'browser',
    covers: [
      '聊天历史持久化（刷新后仍在）',
      '版本更新弹窗只在版本变化时出现',
      '跨版本升级展示多条更新说明',
    ],
    impacts: ['message', 'version', 'frontend'],
  },
  {
    file: 'scripts/test-ui-fixes.mjs',
    level: 'L4',
    module: '交互回归',
    runner: 'browser',
    covers: [
      '注册页按钮常驻可见（无需滚动到底）',
      '消息页有导航',
      '会话头部可进他人主页',
      '设置入口在右上角',
    ],
    impacts: ['ui', 'frontend', 'page'],
  },
]

/** 从影响点标签反查要跑哪些用例 */
export function testsForImpacts(tags) {
  const set = new Set(tags)
  return TESTS.filter((t) => t.impacts.some((i) => set.has(i)))
}

/** 按级别取用例 */
export function testsForLevels(levels) {
  const set = new Set(levels.map((l) => l.toUpperCase()))
  return TESTS.filter((t) => set.has(t.level))
}
