// ============================================================================
// 配置中心：环境变量、默认配置、config.json 读写
//
// 这个文件是整个程序的地基，有两件事必须搞清楚：
//
// 1) 【路径】程序既能用 `node src/index.js` 跑，也能被 esbuild 打包成单文件后
//    注入 Node 做成 qqbot.exe（Node SEA）。打包后 import.meta.dirname 不存在、
//    工作目录也不一定是 exe 所在目录，所以统一用 appDir() 来找 .env / persona.md /
//    config.json / assets。规则：exe 在跑就用 exe 所在目录，否则用当前工作目录。
//
// 2) 【config.json 只存差异】文件里只写「跟内置默认值不一样」的项。
//    这样以后升级内置规则（比如新增去八股正则）不会被用户旧文件里的过期默认值盖住。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 程序所在目录：打包成 exe 时是 exe 所在目录，源码运行时是当前工作目录 */
export function appDir() {
  const exe = process.execPath || ''
  if (exe && /\.exe$/i.test(exe) && !/[\\/]node\.exe$/i.test(exe)) {
    return path.dirname(exe)
  }
  return process.cwd()
}

/** 依次尝试：绝对路径 → appDir 下的相对路径 → 当前工作目录下的相对路径 */
export function resolvePath(p, { mustExist = false } = {}) {
  if (!p) return ''
  if (path.isAbsolute(p)) return p
  const cands = [path.join(appDir(), p), path.resolve(process.cwd(), p)]
  if (mustExist) {
    for (const c of cands) if (fs.existsSync(c)) return c
  }
  return cands[0]
}

/** 这些文件/目录允许用环境变量覆盖，且相对路径按 appDir 解析 */
const PATHS = {
  ROOT: appDir(),
  ENV_FILE: resolvePath(process.env.ENV_FILE || '.env'),
  PERSONA_FILE: resolvePath(process.env.PERSONA_FILE || 'persona.md'),
  CONFIG_FILE: resolvePath(process.env.CONFIG_FILE || 'config.json'),
  IMAGE_DIR: resolvePath(process.env.IMAGE_DIR || './assets/images'),
  TMP_DIR: resolvePath(process.env.TMP_DIR || './data/tmp'),
}
export { PATHS }

// 载入 .env。注意不能用 `import 'dotenv/config'`：
// 那种写法会用 .env 覆盖已有的环境变量，导致
// `set DEEPSEEK_BASE_URL=http://... && qqbot.exe` 这类临时覆盖失效。
const dotenvResult = dotenv.config({ path: PATHS.ENV_FILE, override: false })
export const ENV_FILE_LOADED = !dotenvResult.error
export const ROOT = PATHS.ROOT

// ---------------------------------------------------------------------------
// 给控制台看的说明文字
// ---------------------------------------------------------------------------

/** DeepSeek 官方口径见 https://api-docs.deepseek.com/guides/thinking_mode */
export const PARAM_NOTE = {
  thinking_on:
    'thinking 开着时：temperature / presence_penalty / frequency_penalty 全部无效，top_p 被抬到最低 0.95，且会多花思考 token、回复慢几秒。',
  thinking_off: 'thinking 关闭时：temperature 生效；top_p 被服务端固定为 1.0，你填的值会被忽略。',
  vision_forced_off: '收图理解那一次调用固定非思考模式，保证快、且参数可控。',
}

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

/** 只认命令行开关，不认 node 自己那串参数 */
const HAS = (flag) => process.argv.slice(2).includes(flag)

export const env = {
  deepseekKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-flash',

  wsUrl: process.env.OB_WS_URL || 'ws://127.0.0.1:3001',
  accessToken: process.env.OB_ACCESS_TOKEN || '',

  panelHost: process.env.PANEL_HOST || '127.0.0.1',
  panelPort: Number(process.env.PANEL_PORT || 8099),
  panelPassword: process.env.PANEL_PASSWORD || '',

  imageDir: PATHS.IMAGE_DIR,
  tmpDir: PATHS.TMP_DIR,
  logLevel: process.env.LOG_LEVEL || 'info',

  // --no-qq：只开本地控制台，不连 NapCat（调试面板用）
  noQQ: HAS('--no-qq') || HAS('--panel'),
  quiet: HAS('--quiet') || HAS('-q'),
}

/**
 * 判断某个值是不是「还没改的占位文字」。
 * 注意两点：
 *   1) 不能简单地把「带中文」当成占位符 —— 用户完全可能把控制台密码设成中文。
 *      但「改成你自己的密码」这种安装说明式措辞必须认出来。
 *   2) .env.example 里给的那几个示例值（my-panel-pass / my-token-123 / sk-REPLACE…）
 *      也要认出来，否则用户原样留着示例值，程序会以为填好了。
 */
export function looksLikePlaceholder(v) {
  const s = String(v || '').trim()
  if (!s) return true
  if (/^sk-(REPLACE|YOUR|TEST|XXX|CHANGE|TODO|PLACEHOLDER)/i.test(s)) return true
  if (/[<>{}]/.test(s)) return true // 形如 <your-key>
  if (/(你的|改成|填入|粘贴|在这里|自己的|自己定|定一个)/.test(s)) return true
  if (/(REPLACE|CHANGEME|CHANGE_ME|PLACEHOLDER|YOUR_KEY|YOURKEY|TODO|DUMMY|EXAMPLE)/i.test(s)) return true
  if (/my-panel-pass|my-token-123|panel-pass|token-123/i.test(s)) return true // .env.example 里的示例值
  if (/x{6,}/i.test(s)) return true // 一串 x 当占位
  return false
}

/** 把密钥打码后再显示，避免截图/贴日志时泄漏 */
function mask(v) {
  const s = String(v || '')
  if (!s) return '(空)'
  if (s.length <= 8) return s[0] + '***'
  return `${s.slice(0, 3)}***${s.slice(-3)}（共 ${s.length} 位）`
}

/**
 * 自检报告：`qqbot.exe --check`
 * 给「双击一闪就没了 / 不知道卡在哪」的人用，把所有关键状态一次打清楚。
 */
export function preflightReport() {
  const line = (s = '') => console.log(s)
  const mark = (ok) => (ok ? '[OK]  ' : '[!!]  ')
  const exists = (p) => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  }

  line('')
  line('========== QQ 群 BOT 自检 ==========')
  line('')

  line('【1】路径')
  line(`      程序目录     ${PATHS.ROOT}`)
  line(`      .env         ${PATHS.ENV_FILE}${exists(PATHS.ENV_FILE) ? '' : '   <-- 不存在'}`)
  line(`      persona.md   ${PATHS.PERSONA_FILE}${exists(PATHS.PERSONA_FILE) ? '' : '   <-- 不存在，会用内置兜底人设'}`)
  line(`      config.json  ${PATHS.CONFIG_FILE}${exists(PATHS.CONFIG_FILE) ? '' : '   （还没生成，正常）'}`)
  line(`      图库目录     ${PATHS.IMAGE_DIR}${exists(PATHS.IMAGE_DIR) ? '' : '   <-- 不存在'}`)
  line('')

  line('【2】.env 读到了什么（密钥已打码）')
  line(`      ${mark(ENV_FILE_LOADED)} .env 文件${ENV_FILE_LOADED ? '已载入' : '没读到'}`)

  // 这里标记和【3】用同一套规则，避免出现「上面 OK 下面 !!」这种自相矛盾
  const keyOk = !!env.deepseekKey && !looksLikePlaceholder(env.deepseekKey) && /^sk-.{8,}$/.test(env.deepseekKey)
  const pwOk = !!env.panelPassword && !looksLikePlaceholder(env.panelPassword)
  const tokenOk = !!env.accessToken && !looksLikePlaceholder(env.accessToken)

  line(`      ${mark(keyOk)} DEEPSEEK_API_KEY    ${mask(env.deepseekKey)}`)
  line(`      ${mark(pwOk)} PANEL_PASSWORD      ${mask(env.panelPassword)}`)
  line(`      ${mark(env.noQQ || tokenOk)} OB_ACCESS_TOKEN     ${mask(env.accessToken)}`)
  line(`           DEEPSEEK_MODEL    ${env.deepseekModel}`)
  line(`           OB_WS_URL         ${env.wsUrl}`)
  line(`           控制台地址        http://${env.panelHost}:${env.panelPort}`)
  line('')

  line('【3】必填项检查')
  const problems = []
  if (!keyOk) {
    problems.push('DEEPSEEK_API_KEY：没填、填的还是占位文字，或者格式不像真 key（应该 sk- 开头一长串）')
  }
  if (!pwOk) {
    problems.push('PANEL_PASSWORD：没填，或填的还是示例文字（比如 my-panel-pass / 改成你自己的密码）')
  }
  if (!env.noQQ && !tokenOk) {
    problems.push('OB_ACCESS_TOKEN：没填，或填的还是示例文字（要和 NapCat 里那个 Token 一致）')
  }
  if (problems.length) {
    for (const p of problems) line(`      ${mark(false)} ${p}`)
  } else {
    line(`      ${mark(true)} 必填项都填好了`)
  }
  line('')

  line('【4】人设')
  try {
    const raw = fs.readFileSync(PATHS.PERSONA_FILE, 'utf8')
    line(`      ${mark(true)} persona.md 可读，${raw.length} 字`)
  } catch (e) {
    line(`      ${mark(false)} persona.md 读不到：${e.message}`)
    line('             （这不会让程序崩，会自动用内置兜底人设）')
  }
  line('')

  line('【5】下一步怎么做')
  if (!ENV_FILE_LOADED || problems.length) {
    line('      1) 用记事本打开这个文件：')
    line(`         ${PATHS.ENV_FILE}`)
    line('         （如果它不存在，把同目录的 .env.example 复制一份改名成 .env）')
    line('      2) 把 DEEPSEEK_API_KEY / PANEL_PASSWORD / OB_ACCESS_TOKEN 三行改成你自己的值')
    line('         DeepSeek key 申请： https://platform.deepseek.com/api_keys')
    line('      3) 保存后重新跑一次自检，全 [OK] 了再启动')
    line('')
    line('      只想先看看界面、暂时不连 QQ：  qqbot.exe --no-qq')
  } else {
    line('      .env 没问题了。接下来：')
    line('      1) 确认 NapCat 已启动、扫码登录，并在它的 WebUI 里开了 WebSocket 服务器')
    line('         （默认 127.0.0.1:3001，Token 必须和 OB_ACCESS_TOKEN 一模一样）')
    line(`      2) 启动：  ${path.basename(process.execPath)}`)
    line(`         浏览器打开  http://${env.panelHost}:${env.panelPort}  用 PANEL_PASSWORD 登录`)
    line('')
    line('      想确认 NapCat 通不通：先启动机器人，看日志里有没有「OneBot 已连上 NapCat」')
  }
  line('')
  line('====================================')
  line('')
  return problems.length === 0 && ENV_FILE_LOADED
}

/** 启动前检查必填项，缺了就给出人话提示直接退出 */
export function assertEnv() {
  const bad = []
  const hint = {}
  if (!env.deepseekKey) {
    bad.push('DEEPSEEK_API_KEY')
    hint.DEEPSEEK_API_KEY = '去 https://platform.deepseek.com/api_keys 申请，形如 sk-xxxxxxxx'
  } else if (!/^sk-.{8,}$/.test(env.deepseekKey) || looksLikePlaceholder(env.deepseekKey)) {
    bad.push('DEEPSEEK_API_KEY')
    hint.DEEPSEEK_API_KEY = '看起来还不是真的 key（应该是 sk- 开头、后面一长串随机字符）'
  }
  if (!env.panelPassword || looksLikePlaceholder(env.panelPassword)) {
    bad.push('PANEL_PASSWORD')
    hint.PANEL_PASSWORD = '控制台的登录密码，自己定一个，别用中文占位文字'
  }
  if (!env.noQQ && looksLikePlaceholder(env.accessToken)) {
    bad.push('OB_ACCESS_TOKEN')
    hint.OB_ACCESS_TOKEN = '要和 NapCat 的 WebSocket 服务里填的 Token 一模一样'
  }
  if (!bad.length) return true

  console.error('')
  console.error('  [配置没填完] 下面这些还不能用：')
  for (const k of bad) console.error(`    - ${k}：${hint[k] || ''}`)
  console.error('')
  console.error(`  要改的文件：${PATHS.ENV_FILE}`)
  if (!ENV_FILE_LOADED) {
    console.error(`  它还不存在，把 ${path.join(PATHS.ROOT, '.env.example')} 复制成 .env 再改。`)
  }
  console.error('')
  console.error('  想看完整自检报告（推荐）：')
  console.error(`    ${path.basename(process.execPath)} --check`)
  console.error('  想先只开控制台、不连 QQ：')
  console.error(`    ${path.basename(process.execPath)} --no-qq`)
  console.error('')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 默认配置（控制台里能改的所有项都在这里）
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  // ---- 触发方式 ----
  trigger: {
    requireAt: true, // 群里必须 @ 机器人才回
    keywords: ['小助手', 'bot', '机器人'], // 命中任意一个也回
    replyToBot: true, // 有人回复机器人上一条消息时继续接话
    interjectEnabled: true, // 随机插话开关
    interjectChance: 0.05, // 插话概率（0.05 = 5%）
    interjectCooldownSec: 180, // 插话冷却，避免刷屏
  },

  // ---- 回复生成 ----
  reply: {
    thinking: false, // 默认关思考：这样 temperature 才生效、回复才快
    thinkingEffort: 'low', // 开思考时的强度 low/high/max
    temperature: 0.85, // 群聊要的随机感主要靠它
    topP: 0.9, // 注意：非思考模式下服务端固定 1.0，填了没用
    maxTokens: 200, // 短句，别让它写作文
    maxRegenerate: 1, // 命中结构问题后最多重写几次
    cooldownSec: 3, // 同一会话回复冷却
    perUserDailyLimit: 200, // 每人每天最多回多少条
  },

  // ---- 收图理解（deepseek-flash 原生多模态）----
  vision: {
    enabled: true,
    maxMB: 8, // 单张图上限
    maxPerMessage: 2, // 一条消息最多带几张给模型
    needAtWhenImageOnly: true, // 只发图没 @ 就不接话
  },

  // ---- 本地图库发图 ----
  send: {
    allowModelImage: true, // 允许模型在回复里用 [img] 要求发图
    imageToken: '[img]', // 发图指令标记
    imageCooldownSec: 300, // 同一群发图冷却，防刷屏
    imageChanceCap: 1, // 命中标记时的实际发出概率
    fallbackOnKeyword: false, // 预留：按关键词触发发图
  },

  // ---- 上下文与会话 ----
  session: {
    historyLimit: 12, // 每次带给模型的最近聊天条数
    idleResetSec: 1800, // 闲置这么久就忘记上下文
    maxQueue: 4, // 同一会话排队上限
    requestTimeoutMs: 60000, // 单次请求硬超时
    streamIdleTimeoutMs: 8000, // 流式输出停顿超过这么久就掐断
  },

  // ---- 访问控制 ----
  access: {
    groupMode: 'open', // open | allowlist
    groupAllow: [], // allowlist 模式下生效的群号
    groupDeny: [], // 黑名单群号
  },

  // ---- 去八股规则（正则字符串，控制台/文件里都能改）----
  filter: {
    hardFilter: true,

    // 记录用：命中了会写进日志、控制台试聊里能看到，属于「提示」性质
    banned: [
      '首先[，,]',
      '其次[，,]',
      '再次[，,]',
      '最后[，,]',
      '第一[，,、]',
      '第二[，,、]',
      '第三[，,、]',
      '值得注意的是',
      '总的来说',
      '综上所述',
      '总而言之',
      '需要注意的是',
      '需要指出的是',
      '不是[^。！？\\n]{1,12}而是',
      '并非[^。！？\\n]{1,12}而是',
      '与其说[^。！？\\n]{1,12}不如说',
      '作为(一个)?(AI|人工智能|语言模型|助手)',
      '我是(一个)?(AI|人工智能|语言模型|助手)',
      '我理解你的感受',
      '我明白你的感受',
      '希望能帮到你',
      '希望对你有所帮助',
      '如有(任何)?(疑问|问题)',
      '欢迎随时(提问|问我)',
      '简单来说[，,]',
      '换句话说[，,]',
      '总结一下[，,:：]',
      '让我们',
      '让我们来',
      '下面(我)?(来)?(说|讲|介绍)',
      '以下几点',
      '几个方面',
      '建议如下',
      '步骤如下',
      '分[两三四五六七八九]点',
    ],

    // 结构问题：列表 / 标题 / 加粗 / 代码块，命中就带提示重写一次
    bannedStructure: [
      '#{1,6}\\s*\\S',
      '```',
      '\\*\\*[^*]+\\*\\*',
      '^\\s*(?:[-*+]|\\d{1,2}[.、)])\\s+\\S[\\s\\S]*\\n\\s*(?:[-*+]|\\d{1,2}[.、)])\\s+\\S',
    ],

    // 必须消掉的高危八股：删不掉就重写
    hard: [
      '作为(一个)?(AI|人工智能|语言模型|助手)',
      '我是(一个)?(AI|人工智能|语言模型)',
      '我(理解|明白)你的感受',
      '希望(能)?(对你)?(有所帮助|帮到你|有启发)',
      '综上所述',
      '总的来说',
      '总而言之',
    ],

    // 按正则替换删除
    hardReplacement: {
      '总的来说[，,]?': '',
      '综上所述[，,]?': '',
      '值得注意的是[，,]?': '',
      '简单来说[，,]?': '',
      '换句话说[，,]?': '',
      '希望(能)?(对你)?(有所帮助|帮到你)[。！!]?': '',
      '如有(任何)?(疑问|问题)[^。！？\\n]{0,20}[。！!]?': '',
    },

    // 固定短语直接删。想加就自己往数组里加，比如 '家人们'
    removePhrases: [
      '作为AI',
      '作为一个AI',
      '作为人工智能',
      '作为一个助手',
      '作为助手',
      '作为语言模型',
      '我理解你的感受',
      '我明白你的感受',
      '希望能帮到你',
      '希望对你有所帮助',
      '综上所述',
      '总的来说',
      '总而言之',
      '值得注意的是',
      '需要注意的是',
    ],
  },
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o)

/** 深合并；数组是整体替换而不是拼接，避免出现「旧值 + 新值」的怪结果 */
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base }
  if (!isPlain(patch)) return out
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v)) out[k] = [...v]
    else if (isPlain(v) && isPlain(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out
}

function safeRead(p) {
  try {
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`[配置] ${p} 解析失败，改用默认值：${e.message}`)
    return {}
  }
}

function dropUndefined(o) {
  if (Array.isArray(o)) return o
  const out = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue
    out[k] = isPlain(v) ? dropUndefined(v) : v
  }
  return out
}

// 这些规则是代码资产，不允许被 config.json 里的旧值覆盖
const CODE_OWNED = new Set(['banned', 'bannedStructure', 'hard', 'hardReplacement'])

/**
 * 把 config.json 精简成「差异」。
 * 段里多出来的自由项：对象/数组自动继承（比如自定义 removePhrases）；
 * 标量则丢弃（多半是老版本写下的过期默认值）。
 */
function migrateSection(saved, d) {
  const sub = {}
  for (const k of Object.keys(saved)) {
    const v = saved[k]
    if (CODE_OWNED.has(k)) continue
    if (!(k in d)) {
      if (isPlain(v) || Array.isArray(v)) sub[k] = v
      continue
    }
    if (isPlain(v) && isPlain(d[k])) {
      const s2 = migrateSection(v, d[k])
      if (Object.keys(s2).length) sub[k] = s2
      continue
    }
    if (JSON.stringify(v) !== JSON.stringify(d[k])) sub[k] = v
  }
  return sub
}

function migrate(saved) {
  if (!isPlain(saved)) return {}
  const out = {}
  for (const k of Object.keys(saved)) {
    const v = saved[k]
    const d = DEFAULTS[k]
    if (d === undefined) continue
    if (isPlain(v)) {
      if (!isPlain(d)) continue
      const sub = migrateSection(v, d)
      if (Object.keys(sub).length) out[k] = sub
      continue
    }
    if (JSON.stringify(v) !== JSON.stringify(d)) out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// 运行时状态与读写接口
// ---------------------------------------------------------------------------

let cfg = deepMerge(DEFAULTS, migrate(safeRead(PATHS.CONFIG_FILE)))
const listeners = new Set()

/** 把当前配置（只写差异）落盘 */
function writeConfigFile() {
  const diff = dropUndefined(migrate(cfg))
  const body = Object.keys(diff).length
    ? JSON.stringify(diff, null, 2)
    : '{\n  "_说明": "这里只存你在控制台改过的项；删掉本文件会回到内置默认值"\n}\n'
  try {
    fs.mkdirSync(path.dirname(PATHS.CONFIG_FILE), { recursive: true })
    fs.writeFileSync(PATHS.CONFIG_FILE, body, 'utf8')
  } catch (e) {
    console.error(`[配置] 写 ${PATHS.CONFIG_FILE} 失败（不影响运行）：${e.message}`)
  }
}

export function getConfig() {
  return cfg
}

export function saveConfig(patch) {
  cfg = deepMerge(cfg, patch ?? {})
  writeConfigFile()
  for (const fn of listeners) fn(cfg)
  return cfg
}

export function resetConfig() {
  cfg = JSON.parse(JSON.stringify(DEFAULTS))
  writeConfigFile()
  for (const fn of listeners) fn(cfg)
  return cfg
}

export function onConfigChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 外部手改了 config.json 之后重新读一遍 */
export function reloadConfig() {
  cfg = deepMerge(DEFAULTS, migrate(safeRead(PATHS.CONFIG_FILE)))
  for (const fn of listeners) fn(cfg)
  return cfg
}

/** 首次启动时把工作目录建好（图库、临时目录） */
export function ensureDirs() {
  for (const d of [env.imageDir, env.tmpDir]) {
    try {
      fs.mkdirSync(d, { recursive: true })
    } catch (e) {
      console.error(`[配置] 建目录失败 ${d}：${e.message}`)
    }
  }
}
