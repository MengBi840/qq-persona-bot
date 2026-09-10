// ============================================================================
// 主逻辑：从「收到一条 QQ 消息」到「决定回不回、怎么回、发什么」
//
// 一条消息的完整旅程：
//
//   NapCat 推消息
//      → onMessage()          解析消息段、记进上下文
//      → decide()             四种触发判定（@我 / 关键词 / 回复我 / 随机插话）
//      → 队列 drain()         同一个群串行处理，避免并发抢上下文
//      → handle()
//           → toVisionImages()  图片下载并内联成 base64（给多模态）
//           → buildSystemPrompt / buildMessages  拼 prompt（人设 + 硬规则 + 上下文）
//           → generate()        问 DeepSeek（流式）
//           → filterReply()     去八股；命中结构问题就带提示重写一次
//           → 按 ||| 拆成两条短句发出去
//           → 需要的话从图库随机发一张图（有冷却）
//
// 几个设计取舍：
//   - 每个群/每个人一个独立上下文（peerId = group:123 / user:456），互不串味
//   - 同一会话串行处理（队列），不同会话并行
//   - 队列满了直接丢新消息，宁可少回一句，也不让机器人变成复读机
//   - 发图有冷却、挑图会避开最近发过的，所以不会刷屏
// ============================================================================

import { env, getConfig, PARAM_NOTE } from './config.js'
import { log } from './logger.js'
import { OneBot, toDataUrl, fileUri, downloadImage } from './onebot.js'
import { loadPersona } from './persona.js'
import { buildSystemPrompt, buildUserContent, buildMessages, renderHistory } from './prompt.js'
import { generate } from './llm.js'
import { filterReply, describeHits } from './filter.js'
import { pickImage, canSendImage, ensureImageDir, listGallery } from './image.js'

/** @type {OneBot|null} */
let ob = null
let started = false
let lastTest = null

/** 运行期状态，全在内存里，重启就清空（上下文只活一次运行周期） */
const state = {
  history: new Map(), // peerId -> [{t, role, speaker, userId, content}]
  lastMsgAt: new Map(), // peerId -> 最后一条入站消息时间
  lastBotReplyAt: new Map(), // peerId -> 最后一条回复时间（随机插话冷却用）
  lastInterjectAt: new Map(), // peerId -> 最后一次主动插话时间
  queue: new Map(), // peerId -> 待处理消息数组
}

/** 给控制台看的计数器 */
export const stats = {
  messages: 0,
  replies: 0,
  images: 0,
  filtered: 0,
  regenerated: 0,
  errors: 0,
  lastError: null,
}

export function getState() {
  return state
}

export function status() {
  const cfg = getConfig()
  return {
    started,
    noQQ: env.noQQ,
    ws: ob?.status || 'idle',
    wsUrl: env.wsUrl,
    selfId: ob?.selfId || null,
    model: env.deepseekModel,
    baseUrl: env.deepseekBaseUrl,
    vision: cfg.vision.enabled,
    galleryCount: listGallery().length,
    stats: { ...stats },
    transport: ob?.stats || null,
    paramNote: cfg.reply.thinking ? PARAM_NOTE.thinking_on : PARAM_NOTE.thinking_off,
    lastTest,
  }
}

// ---------------------------------------------------------------------------
// 消息解析
// ---------------------------------------------------------------------------

export function parseMessage(raw) {
  const textParts = []
  const images = []
  let atMe = false
  let replyToBot = false

  for (const seg of raw || []) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text') textParts.push(seg.data?.text ?? '')
    else if (seg.type === 'image') images.push({ file: seg.data?.file || '', url: seg.data?.url || '' })
    else if (seg.type === 'at') {
      const t = String(seg.data?.qq ?? '')
      if (t === 'all' || (myId() && t === myId())) atMe = true
    } else if (seg.type === 'reply') {
      const target = String(seg.data?.id ?? '')
      if (target && recentBotMsgIds.has(target)) replyToBot = true
    } else if (seg.type === 'face') textParts.push('[表情]')
  }

  const text = textParts
    .join('')
    .replace(/\[CQ:at,[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { text, images, atMe, replyToBot }
}

const recentBotMsgIds = new Set()
function rememberBotMsg(id) {
  if (!id) return
  recentBotMsgIds.add(String(id))
  if (recentBotMsgIds.size > 100) {
    const first = recentBotMsgIds.values().next().value
    recentBotMsgIds.delete(first)
  }
}

// ---------------------------------------------------------------------------
// 触发判定
// ---------------------------------------------------------------------------

/**
 * 触发判定：这条消息要不要理？
 * 顺序就是优先级：@我 > 回复我的消息 > 关键词 > 随机插话。
 * 随机插话额外受冷却限制，不然它会变成话痨。
 * @returns {{reply:boolean, why:string}} why 会写进日志，方便你判断为什么没回
 */
export function decide(ev, parsed) {
  const cfg = getConfig()
  // 私聊一律回（私聊场景没有「@」这个动作）
  if (ev.message_type !== 'group') return { reply: true, why: '私聊' }

  if (cfg.trigger.requireAt && parsed.atMe) return { reply: true, why: '@我' }
  if (cfg.trigger.replyToBot && parsed.replyToBot) return { reply: true, why: '回复我的消息' }

  const text = parsed.text || ''
  if (text) {
    for (const kw of cfg.trigger.keywords || []) {
      if (kw && text.includes(kw)) return { reply: true, why: `关键词「${kw}」` }
    }
  }

  if (cfg.trigger.interjectEnabled) {
    const peer = peerId(ev)
    // 距上次「机器人说话」够久 + 掷骰子通过，才插话
    const lastBot = Math.max(state.lastBotReplyAt.get(peer) || 0, state.lastInterjectAt.get(peer) || 0)
    const cd = (cfg.trigger.interjectCooldownSec || 0) * 1000
    const quietLongEnough = Date.now() - lastBot >= cd
    if (quietLongEnough && Math.random() < (cfg.trigger.interjectChance || 0)) {
      return { reply: true, why: `随机插话(${Math.round(cfg.trigger.interjectChance * 100)}%)` }
    }
  }

  return { reply: false, why: '' }
}

export function accessAllowed(ev) {
  const cfg = getConfig()
  if (ev.message_type !== 'group') return true
  const gid = String(ev.group_id)
  if ((cfg.access.groupDeny || []).map(String).includes(gid)) return false
  if (cfg.access.groupMode === 'allowlist') return (cfg.access.groupAllow || []).map(String).includes(gid)
  return true
}

function peerId(ev) {
  return ev.message_type === 'group' ? `group:${ev.group_id}` : `user:${ev.user_id}`
}

function speakerOf(ev) {
  return ev.sender?.card || ev.sender?.nickname || String(ev.user_id ?? '某人')
}

function remember(peer, entry) {
  const cfg = getConfig()
  const arr = state.history.get(peer) || []
  arr.push(entry)
  const cap = Math.max(10, (cfg.session.historyLimit || 12) * 3)
  while (arr.length > cap) arr.shift()
  state.history.set(peer, arr)
}

function historyFor(peer) {
  const cfg = getConfig()
  const arr = state.history.get(peer) || []
  const last = arr.length ? arr[arr.length - 1].t : 0
  if (last && Date.now() - last > (cfg.session.idleResetSec || 1800) * 1000) {
    state.history.set(peer, [])
    return []
  }
  return arr
}

export function clearHistory(peer) {
  if (peer) state.history.delete(peer)
  else state.history.clear()
}

export function historySnapshot(peer) {
  return (state.history.get(peer) || []).slice(-30)
}

// ---------------------------------------------------------------------------
// 入站
// ---------------------------------------------------------------------------

/**
 * 入站消息总入口（NapCat 推一条就走这里一次）。
 * 注意这个方法可能会 await 很久（要等模型回复），所以调用方不能阻塞事件循环。
 */
async function onMessage(ev) {
  stats.messages++
  if (!accessAllowed(ev)) {
    return log.debug(`群 ${ev.group_id} 不在白名单，跳过`)
  }
  const parsed = parseMessage(ev.message)
  const peer = peerId(ev)
  state.lastMsgAt.set(peer, Date.now())

  // 先记进上下文：即使这条不回，后面接话时也能看到它说过什么
  const hadHistory = (state.history.get(peer) || []).length > 0
  remember(peer, {
    t: Date.now(),
    role: 'user',
    speaker: speakerOf(ev),
    userId: ev.user_id,
    content: parsed.text || (parsed.images.length ? '[图片]' : '[消息]'),
    images: parsed.images.length,
  })
  if (!hadHistory) log.info(`新会话 ${peer}`)

  const d = decide(ev, parsed)
  if (!d.reply) return log.debug(`不回复（${peer}）：${parsed.text.slice(0, 20)}`)

  // 同一个会话串行处理；已经在处理就排队
  const cfg = getConfig()
  const q = state.queue
  if (q.has(peer)) {
    if (q.get(peer).length >= (cfg.session.maxQueue || 4)) {
      // 队列满了宁可丢掉这条，也不要让它落后地回一堆过时的话
      log.warn(`队列已满，丢弃一条消息（${peer}）`)
      return
    }
    q.get(peer).push({ ev, parsed, why: d.why })
  } else {
    q.set(peer, [])
    await drain(peer, { ev, parsed, why: d.why })
  }
}

/**
 * 串行消费某个会话的队列。
 * 为什么必须串行：并发生成会让两条回复都基于同一份旧上下文，还可能在群里乱序。
 * 某个群卡住不影响别的群 —— 不同 peer 是各自独立的 drain。
 */
async function drain(peer, first) {
  const q = state.queue
  const list = q.get(peer) || []
  let item = first
  while (item) {
    try {
      await handle(peer, item)
    } catch (e) {
      stats.errors++
      stats.lastError = `${new Date().toLocaleTimeString()} ${e.message}`
      log.error(`处理失败（${peer}）：`, e.message)
    }
    item = list.shift()
  }
  q.delete(peer)
}

// ---------------------------------------------------------------------------
// 生成回复
// ---------------------------------------------------------------------------

async function toVisionImages(parsed) {
  const cfg = getConfig()
  if (!cfg.vision.enabled || !parsed.images.length) return []
  const out = []
  for (const im of parsed.images.slice(0, cfg.vision.maxPerMessage)) {
    const src = /^https?:/i.test(im.file || '') ? im.file : /^https?:/i.test(im.url || '') ? im.url : ''
    // 优先下载到本地再内联成 base64：QQ 的图片直链经常带鉴权/过期参数，模型那边不一定拉得到
    if (src) {
      const local = await downloadImage(src, { maxMB: cfg.vision.maxMB })
      if (local) {
        out.push({ url: toDataUrl(local), via: 'base64', local })
        continue
      }
      out.push({ url: src, via: 'url' })
      continue
    }
    const local = await ob?.api.fetchImageFile(im.file, im.url)
    if (local) out.push({ url: toDataUrl(local), via: 'base64', local })
  }
  if (out.length) log.debug(`本次带 ${out.length} 张图（${out.map((o) => o.via).join(',')}）`)
  return out
}

function stripImageToken(text, token) {
  const t = token || '[img]'
  const hit = text.includes(t) || /\[(img|image|图片)\]/i.test(text)
  return { text: text.replace(/\[(img|image|图片)\]/gi, '').trim(), hit }
}

async function oneShot({ system, userContent, onDelta, thinking }) {
  return generate({
    system,
    userContent,
    thinking,
    signal: undefined,
    onDelta,
  })
}

/**
 * 单条消息的完整处理：拼 prompt → 生成 → 过滤 → 发送 → 可能发图。
 * 出错由 drain() 兜住，不会把整个进程带崩。
 */
async function handle(peer, { ev, parsed, why }) {
  const cfg = getConfig()
  const persona = loadPersona()
  const system = buildSystemPrompt(persona)
  const images = await toVisionImages(parsed)

  // 「只发图、没 @ 我」默认不接话，免得群里刷图时它跟着插嘴
  if (cfg.vision.needAtWhenImageOnly && !parsed.text && images.length && ev.message_type === 'group' && !parsed.atMe) {
    log.debug('纯图片且没 @我，跳过')
    return
  }

  const userContent = buildUserContent(ev, parsed.text, images)
  const { userContent: withCtx } = buildMessages(ev, historyFor(peer), userContent)

  // 先丢个表情回应，让人知道它在打字的路上（失败也无所谓）
  const emoji = [{ type: 'face', data: { id: '212' } }]
  try {
    await ob?.api.sendTo(ev, emoji)
  } catch {
    /* 表情回应失败不影响 */
  }

  const t0 = Date.now()
  log.info(
    `回复「${speakerOf(ev)}」[${why}]${images.length ? ` +${images.length}图` : ''}：${(parsed.text || '[图片]').slice(0, 40)}`,
  )

  // ---- 生成 + 过滤（必要时带提示重写一次）----
  let r = await oneShot({ system, userContent: withCtx, thinking: cfg.reply.thinking })
  let f = filterReply(r.content)
  let tries = 0
  while (f.needRewrite && tries < (cfg.reply.maxRegenerate || 0)) {
    tries++
    stats.regenerated++
    log.warn(
      `命中八股/结构规则，重写第 ${tries} 次：${describeHits([...f.hard.map((p) => ({ type: 'phrase', pattern: p })), ...f.structHits])}`,
    )
    // 把「你刚才犯了什么错」直接怼给模型，比在 system 里泛泛要求有效得多
    const harsh =
      system +
      `\n\n【这次特别注意】彻底删掉这些表达：${[...f.hard, ...f.structHits.map((h) => h.pattern)].join(' / ')}。重写，更短更口语，别分点。`
    r = await oneShot({ system: harsh, userContent: withCtx, thinking: cfg.reply.thinking })
    f = filterReply(r.content)
  }
  if (f.hard.length || f.structHits.length) stats.filtered++

  let text = f.text
  const { text: noToken, hit: wantImage } = stripImageToken(text, cfg.send.imageToken)
  text = noToken

  const parts = text
    .split('|||')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2)
  if (!parts.length) parts.push('……')

  let sentIds = []
  for (const part of parts) {
    try {
      const res = await ob?.api.sendTo(ev, [{ type: 'text', data: { text: part } }])
      if (res?.message_id) sentIds.push(res.message_id)
      // 第一次发完做个随机短延迟，像真人打字
      if (parts.length > 1) await sleep(400 + Math.random() * 600)
    } catch (e) {
      stats.errors++
      log.error('发送失败：', e.message)
    }
  }
  for (const id of sentIds) rememberBotMsg(id)
  stats.replies++

  // 发图：按冷却 + 概率，不刷屏
  if (wantImage && canSendImage(peer)) {
    const chance = Math.random()
    if (chance <= (cfg.send.imageChanceCap ?? 1)) {
      const p = pickImage(peer)
      if (p) {
        try {
          await ob?.api.sendTo(ev, [{ type: 'image', data: { file: fileUri(p) } }])
          stats.images++
          log.info(`发图：${p.split(/[\\/]/).pop()}（下次最早 ${cfg.send.imageCooldownSec}s 后）`)
        } catch (e) {
          stats.errors++
          log.warn('发图失败：', e.message)
        }
        await sleep(500)
      }
    }
  }

  const cost = Date.now() - t0
  state.lastBotReplyAt.set(peer, Date.now())
  if (why.startsWith('随机插话')) state.lastInterjectAt.set(peer, Date.now())
  remember(peer, { t: Date.now(), role: 'bot', speaker: '我', content: parts.join(' / ') })

  lastTest = { at: Date.now(), prompt: parsed.text || '[图片]', reply: parts.join(' ||| '), cost, params: r.params }
  log.info(`发出（${cost}ms，thinking=${r.params.thinking ? 'on' : 'off'}）：${parts.join(' ||| ')}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 启动 / 供控制台复用
// ---------------------------------------------------------------------------

export function start() {
  if (!ob && !env.noQQ) {
    ob = new OneBot(env.wsUrl, env.accessToken)
    ob.on('qq-message', onMessage)
  }
  if (started) return ob
  ensureImageDir()
  started = true
  loadPersona()
  log.info(`人设已加载，模型 ${env.deepseekModel}，thinking=${getConfig().reply.thinking ? '开' : '关'}`)
  if (env.noQQ) {
    log.warn('--no-qq 模式：不连 NapCat，只开本地控制台')
    return null
  }
  return ob
}

export function stop() {
  ob?.close()
  started = false
}

/** 只给测试用：塞一个假的 OneBot 客户端（记录发了什么），并清空运行时状态 */
export function __setClientForTest(fake) {
  ob = fake
  started = !!fake
  state.history.clear()
  state.lastMsgAt.clear()
  state.lastBotReplyAt.clear()
  state.lastInterjectAt.clear()
  state.queue.clear()
  recentBotMsgIds.clear()
}

/** 测试用：走完整的入站链路（触发判定 → 队列 → 生成 → 过滤 → 发送） */
export function __runMessageForTest(ev) {
  return onMessage(ev)
}

/** 控制台「试聊」：走和群里完全相同的过滤链路，但不发 QQ */
export async function testReply({ text = '', images = [], thinking } = {}) {
  const cfg = getConfig()
  const persona = loadPersona()
  const system = buildSystemPrompt(persona)
  const ev = { message_type: 'group', group_id: 0, user_id: 10000, sender: { nickname: '控制台' } }
  const visionImages = images.map((p) => ({ url: toDataUrl(p), via: 'base64', local: p }))
  const userContent = buildUserContent(ev, text, cfg.vision.enabled ? visionImages : [])
  const history = state.history.get('panel:test') || []
  const { userContent: withCtx } = buildMessages(ev, history, userContent)
  const useThinking = thinking === undefined ? cfg.reply.thinking : !!thinking

  const t0 = Date.now()
  const r = await generate({ system, userContent: withCtx, thinking: useThinking })
  const f = filterReply(r.content)
  const { text: cleaned, hit } = stripImageToken(f.text, cfg.send.imageToken)
  const parts = cleaned
    .split('|||')
    .map((s) => s.trim())
    .filter(Boolean)

  remember('panel:test', { t: Date.now(), role: 'user', speaker: '控制台', content: text || '[图片]' })
  remember('panel:test', { t: Date.now(), role: 'bot', speaker: '我', content: parts.join(' / ') })

  return {
    reply: parts.join('\n') || '(空)',
    parts,
    would_send_image: hit,
    filtered_out: f.hard.concat(f.structHits.map((h) => h.pattern)),
    hits: f.hits,
    cost: Date.now() - t0,
    params: r.params,
    reasoning: r.reasoning,
    raw: r.content,
    context_preview: `[system ${system.length} 字]\n${withCtx}`,
    history_preview: renderHistory(history, cfg.session.historyLimit),
  }
}

export function wsClient() {
  return ob
}

/** 只给离线自检用：伪造登录号，让 @ 判定可测 */
export function __setSelfIdForTest(id) {
  selfIdOverride = id === null ? null : String(id)
}

let selfIdOverride = null
function myId() {
  return selfIdOverride || (ob?.selfId ? String(ob.selfId) : '')
}
