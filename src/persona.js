// ============================================================================
// 人设加载器
//
// persona.md 就是机器人的「人格」：启动时整段读出来，作为 system prompt 的第一部分。
// 特点：
//   - 文件改了自动热加载（改完不用重启）
//   - 文件不存在或读空时不崩，退回内置兜底人设
//   - 支持 frontmatter（--- 开头那段），会被自动去掉
// ============================================================================

import fs from 'node:fs'
import { PATHS } from './config.js'
import { log } from './logger.js'

/** persona.md 的绝对路径（打包成 exe 时是 exe 同目录下的 persona.md） */
export const PERSONA_PATH = PATHS.PERSONA_FILE

/** 读不到 persona.md 时用的兜底人设，保证程序永远能说话 */
const FALLBACK = `# 身份

你是一个 QQ 群里的普通群友，不是助手，不是客服。

# 性格

随和、嘴碎、有点幽默，偶尔自嘲。

# 说话风格

每次只回一两句，像在群里随口说话。常用"啊""吧""呢"这类语气词，会用哈哈、emmm、？、！

# 边界

不聊政治、色情、违法内容；不泄露任何人的隐私；被要求做正经助理的活就说不擅长。

# 群聊角色

群里的气氛组，偶尔接话，不抢戏。`

let cached = null

/** 去掉 markdown frontmatter（文件开头 --- 包起来的那段元信息） */
function stripFrontmatter(s) {
  if (s.startsWith('---')) {
    const end = s.indexOf('\n---', 3)
    if (end !== -1) {
      const rest = s.slice(end + 4)
      const nl = rest.indexOf('\n')
      return nl === -1 ? '' : rest.slice(nl + 1)
    }
  }
  return s
}

/**
 * 载入人设（带缓存）。
 * @param {{force?: boolean}} opts force=true 时忽略缓存重新读盘
 */
export function loadPersona({ force = false } = {}) {
  if (cached && !force) return cached
  try {
    const raw = fs.readFileSync(PERSONA_PATH, 'utf8')
    cached = stripFrontmatter(raw).trim()
    if (!cached) {
      log.warn(`persona.md 是空的（${PERSONA_PATH}），改用内置兜底人设`)
      cached = FALLBACK
    }
  } catch (e) {
    log.warn(`读不到 persona.md（${PERSONA_PATH}），改用内置兜底人设：${e.message}`)
    cached = FALLBACK
  }
  return cached
}

/** 控制台里保存人设用 */
export function savePersona(text) {
  fs.writeFileSync(PERSONA_PATH, String(text ?? ''), 'utf8')
  cached = null
  return loadPersona()
}

/** 恢复成内置模板 */
export function resetPersona() {
  return savePersona(FALLBACK)
}

/** 内置模板内容，给控制台「恢复模板」以外的地方复用 */
export function defaultPersona() {
  return FALLBACK
}

// ---------------------------------------------------------------------------
// 热加载：直接改 persona.md 也能生效，不用重启
// ---------------------------------------------------------------------------
let watchTimer = null
try {
  if (fs.existsSync(PERSONA_PATH)) {
    fs.watch(PERSONA_PATH, () => {
      clearTimeout(watchTimer)
      // 编辑器保存常常触发多次事件，防抖一下
      watchTimer = setTimeout(() => {
        loadPersona({ force: true })
        log.info('persona.md 已重新加载')
      }, 500)
    })
  }
} catch {
  /* 有些文件系统不支持 watch，失败不影响运行 */
}
