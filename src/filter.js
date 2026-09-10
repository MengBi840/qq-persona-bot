// ============================================================================
// 去八股过滤器
//
// 「八股」指 AI 腔：作为AI、首先/其次/最后、总的来说、分点列条、markdown 标题……
// 群聊里出现这些一眼就假。这里用三层处理，从轻到重：
//
//   第一层【直接删】removePhrases（固定短语）+ hardReplacement（带标点的正则变体）
//                 —— 「希望能帮到你。」这种整句废话，删掉就行，不用麻烦模型。
//   第二层【要求重写】bannedStructure 命中（markdown 列表/标题/加粗/代码块）
//                 —— 结构问题删不干净，只能让模型用口语重说一遍。
//   第三层【压平兜底】flattenStructure
//                 —— 模型重写后还是分点，就把「- 第一点 / - 第二点」合并成一句话，
//                    宁可句子怪一点，也绝不把markdown 发进群。
//
// banned 只是「记录用」的清单：命中了写日志、控制台试聊里能看到，不参与删除。
// 这样你能知道模型到底在犯哪些毛病，再决定要不要补规则。
// ============================================================================

import { getConfig } from './config.js'

const SAFE = /[\u200B-\u200D\uFEFF]/g
const EMOJI_HEAD = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u

/** 编译正则，编译不了就返回 null（用户在控制台填了错的正则不能把程序搞崩） */
function rx(pattern, flags = 'g') {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/** 去掉 @、CQ 码残留、零宽字符、emoji 前缀、被整体包裹的引号 */
export function cleanText(s) {
  let t = String(s ?? '')
    .replace(SAFE, '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/^[\s@,\u3000]+/, '')
    .replace(/[\s\u3000]+$/, '')
  t = t.replace(EMOJI_HEAD, '')
  if (t.length > 1) {
    const a = t[0]
    const b = t[t.length - 1]
    if ((a === '“' && b === '”') || (a === '‘' && b === '’') || (a === '"' && b === '"')) t = t.slice(1, -1).trim()
  }
  // 去掉行首的列表符号（- * 1. 之类）
  t = t.replace(/^[-*+>]\s+/, '').replace(/^\d+[.、)]\s+/, '')
  return t.trim()
}

/** 第一层：按配置里的规则把八股直接抠掉 */
function applyReplacements(text) {
  const cfg = getConfig().filter
  let out = text

  // 带标点的变体用正则替换
  for (const [pat, rep] of Object.entries(cfg.hardReplacement || {})) {
    const r = rx(pat)
    if (r) out = out.replace(r, rep ?? '')
  }
  // 固定短语直接删（比正则好维护，用户也能自己加）
  for (const phrase of cfg.removePhrases || []) {
    if (phrase) out = out.split(phrase).join('')
  }

  // 收尾：删完之后可能留下孤零零的标点和空行，顺手清掉
  return out
    .split('\n')
    .map((l) => l.replace(/^[\s，,。、；;：:]+/, '').replace(/[\s\u3000]+$/, ''))
    .filter((l) => l.trim() !== '')
    .join('\n')
    .trim()
}

function joinLines(t) {
  return t
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 第三层：把还残留的 markdown 结构压平成一两句人话 */
export function flattenStructure(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // 只有一行：去掉标题/加粗/反引号就行
  if (lines.length <= 1) {
    return joinLines(
      String(text ?? '')
        .replace(/^#{1,6}\s*/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`+/g, ''),
    )
  }

  // 多行：把列表项合并成「甲，乙，丙」这种一口气说完的样子
  const items = lines.map((l) =>
    l
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[-*+]|\d{1,2}[.、)])\s*/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`+/g, '')
      .replace(/[。；;]$/, '')
      .trim(),
  )
  const joined = items.slice(0, 4).join('，')
  return joinLines(joined + (items.length > 4 ? ' 这些' : ''))
}

/** 扫一遍，返回命中的规则（用于日志和软判定） */
export function scan(text, { structureToo = true } = {}) {
  const cfg = getConfig().filter
  const hits = []
  for (const pat of cfg.banned || []) {
    const r = rx(pat)
    if (r && r.test(text)) hits.push({ type: 'phrase', pattern: pat })
  }
  if (structureToo) {
    for (const pat of cfg.bannedStructure || []) {
      const r = rx(pat, 'm')
      if (r && r.test(text)) hits.push({ type: 'structure', pattern: pat })
    }
  }
  return hits
}

function analyzeText(text) {
  const cfg = getConfig().filter
  const structHits = cfg.bannedStructure
    .map((pat) => {
      const r = rx(pat, 'm')
      return r && r.test(text) ? { type: 'structure', pattern: pat } : null
    })
    .filter(Boolean)
  return { structHits }
}

/**
 * 过滤一条回复。
 *
 * hardFilter 打开（默认）：先删八股，再判断要不要让模型重写，最后一定把结构压平。
 * hardFilter 关闭：一个字都不改，只报告命中了什么（调试用）。
 *
 * @returns {{text:string, hard:string[], hits:object[], structHits:object[], needRewrite:boolean, raw:string}}
 */
export function filterReply(raw) {
  const cfg = getConfig().filter
  const original = String(raw ?? '')
  const hitsOnRaw = scan(original)

  // 调试模式：原样返回，只报告
  if (!cfg.hardFilter) {
    return {
      text: cleanText(original),
      hard: [],
      hits: hitsOnRaw,
      structHits: hitsOnRaw.filter((h) => h.type === 'structure'),
      needRewrite: false,
      raw: original,
    }
  }

  // ---- 第一层：直接删 ----
  let after = applyReplacements(original)
  // 删完还能扫到 hard 里的东西，说明这段规则没被覆盖
  const hard = (cfg.hard || []).filter((pat) => {
    const r = rx(pat)
    return r && r.test(after)
  })
  after = cleanText(after)

  if (hard.length) {
    // 再来一轮，还不行就交给上层重写
    const fixed = applyReplacements(after)
    const hardAfter = (cfg.hard || []).filter((pat) => {
      const r = rx(pat)
      return r && r.test(fixed)
    })
    const structHits = analyzeText(fixed).structHits
    return {
      text: flattenStructure(fixed),
      hard: hardAfter,
      hits: [...scan(fixed, { structureToo: false }), ...structHits],
      structHits,
      needRewrite: hardAfter.length > 0 || structHits.length > 0,
      raw: original,
    }
  }

  // ---- 第二层：结构问题必须在「压平之前」判断 ----
  // 不然多行列表已经被合并成一行了，规则就永远匹配不上
  const { structHits } = analyzeText(after)
  return {
    // ---- 第三层：无论如何都压平一次再发出去 ----
    text: flattenStructure(after),
    hard: [],
    hits: [...hitsOnRaw, ...structHits],
    structHits,
    needRewrite: structHits.length > 0,
    raw: original,
  }
}

export function describeHits(hits) {
  return hits.map((h) => `${h.type === 'structure' ? '结构' : '八股'}:${h.pattern}`).join(' ')
}

/** 兜底回复：所有重写都失败时用（截断，免得又发一大段） */
export function fallbackReply(text) {
  const s = cleanText(String(text ?? ''))
  if (!s) return '这我真接不上'
  return s.length > 30 ? s.slice(0, 30) : s
}
