// ============================================================================
// DeepSeek 调用层
//
// 这个文件只管「把话问出去、把话收回来」，不管怎么发到 QQ。
//
// 四个坑，都在这里处理掉了：
//
// 1) 【thinking 参数放哪儿】openai SDK 各版本行为不一致：
//      旧版（4.104 这种）：顶层未知参数原样发出去；extra_body 反而被当成一个普通字段
//      新版：extra_body 会被展开；顶层未知参数被直接丢掉
//    没有任何一种写法能同时兼容，所以先按顶层发，遇到「参数不认」的 400
//    自动换成 extra_body 再试，最后再退化成完全不传 thinking。
//    写错这一处的后果很隐蔽：参数被静默丢掉，你以为关了思考其实一直在烧思考 token。
//
// 2) 【timeout:0 不是「不限时」】SDK 会把它当成「立刻超时」，请求必然失败。
//    所以给一个大值，真正的超时靠 AbortController 和「流式停顿计时器」。
//
// 3) 【流式停顿】模型偶尔吐一半卡住。这里每收到一个 chunk 就重置计时器，
//    超过 streamIdleTimeoutMs 没动静就掐断；已经吐出来的内容照样用。
//
// 4) 【图片位置】图片只能放在 user 消息里，放 system 会 400。
//    拼接逻辑在 prompt.js，这里只负责把数组传下去。
// ============================================================================

import OpenAI from 'openai'
import { env, getConfig } from './config.js'
import { log } from './logger.js'

let client = null
let clientKey = ''
/** 复用客户端；baseURL/key 变了（比如测试里改了环境变量）就重建 */
export function getClient() {
  const key = `${env.deepseekBaseUrl}|${env.deepseekKey}`
  if (!client || clientKey !== key) {
    client = new OpenAI({
      apiKey: env.deepseekKey,
      baseURL: env.deepseekBaseUrl,
      // 注意：SDK 里 timeout:0 会被当成「立刻超时」，这里给个大值，
      // 真正的超时由下面的 AbortController + 流式停顿计时器控制
      timeout: 300000,
      maxRetries: 1,
    })
    clientKey = key
  }
  return client
}

/** 模型吐一半卡住时抛这个，上层可以决定用已经吐出来的部分 */
export class IdleTimeout extends Error {
  constructor(msg = '模型太久没吐字，中断了') {
    super(msg)
    this.name = 'IdleTimeout'
  }
}

/**
 * 生成一次回复。
 *
 * @param {object} o
 * @param {string} o.system        人设 + 硬规则（system prompt）
 * @param {string|Array} o.userContent 本次内容；带图时是 block 数组
 * @param {boolean} o.thinking     要不要开思考模式
 * @param {string} o.thinkingEffort 思考强度 low/high/max
 * @param {AbortSignal} o.signal   外部中断（比如用户点了停止）
 * @param {(d:{content:string,reasoning:string,delta:string})=>void} o.onDelta 流式回调
 * @returns {Promise<{content:string, reasoning:string, usage:object|null, params:object}>}
 */
export async function generate({
  system,
  userContent,
  persona,
  thinking,
  thinkingEffort,
  signal,
  onDelta,
} = {}) {
  const cfg = getConfig()
  const effort = thinkingEffort || cfg.reply.thinkingEffort || 'low'
  const params = { model: env.deepseekModel }

  // thinking / reasoning_effort 的放法在 openai SDK 各版本之间不一样：
  //   旧版（如 4.104）：顶层未知参数原样发出去，extra_body 反而被当成一个普通字段
  //   新版：extra_body 会被展开、顶层未知参数被丢掉
  // 所以先按顶层写（本机实测的版本），服务端如果报参数不认，再自动换成 extra_body 重试一次。
  if (thinking) {
    // thinking 模式：temperature / penalty 无效，top_p 会被抬到 ≥0.95，所以干脆不给
    params.thinking = { type: 'enabled' }
    params.reasoning_effort = effort
  } else {
    params.temperature = cfg.reply.temperature
    params.top_p = cfg.reply.topP
    params.thinking = { type: 'disabled' }
  }
  params.max_tokens = cfg.reply.maxTokens

  const messages = [
    { role: 'system', content: system || persona || '' },
    { role: 'user', content: userContent ?? '' },
  ]

  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (signal) {
    if (signal.aborted) ac.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  let idleTimer = null
  let idleHit = false
  const armIdle = () => {
    clearTimeout(idleTimer)
    const ms = cfg.session.streamIdleTimeoutMs || 8000
    idleTimer = setTimeout(() => {
      idleHit = true
      ac.abort()
    }, ms)
  }
  const hardTimer = setTimeout(() => ac.abort(), cfg.session.requestTimeoutMs || 60000)

  let content = ''
  let reasoning = ''
  let usage = null

  try {
    armIdle()
    const stream = await openStream(params, messages, ac.signal)
    for await (const chunk of stream) {
      armIdle()
      const d = chunk.choices?.[0]?.delta
      if (d?.reasoning_content) reasoning += d.reasoning_content
      if (d?.content) {
        content += d.content
        if (onDelta) {
          try {
            onDelta({ content, reasoning, delta: d.content })
          } catch {
            /* 面板断线等，忽略 */
          }
        }
      }
      if (chunk.usage) usage = chunk.usage
    }
  } catch (e) {
    if (idleHit) {
      log.warn('流式输出停顿过久，已中断')
      if (!content) throw new IdleTimeout()
    } else if (ac.signal.aborted && !signal?.aborted) {
      log.warn('请求超时被中断')
      if (!content) throw new Error('请求超时')
    } else {
      throw e
    }
  } finally {
    clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  return { content: content.trim(), reasoning: reasoning.trim(), usage, params: brief(params) }
}

const THINKING_KEYS = ['thinking', 'reasoning_effort']

function isUnknownParamError(e) {
  const msg = `${e?.message || ''} ${e?.error?.message || ''}`.toLowerCase()
  return (
    e?.status === 400 &&
    THINKING_KEYS.some((k) => msg.includes(k)) &&
    /unknown|unexpected|unsupported|not support|invalid|extra|additional/i.test(msg)
  )
}

/** 发请求；如果服务端/网关不认 thinking 这种参数，就退回 extra_body 再试一次 */
async function openStream(params, messages, signal) {
  const body = { ...params, messages, stream: true, stream_options: { include_usage: true } }
  try {
    return await getClient().chat.completions.create(body, { signal })
  } catch (e) {
    if (signal?.aborted) throw e
    const extra = {}
    for (const k of THINKING_KEYS) {
      if (params[k] !== undefined) extra[k] = params[k]
    }
    const retryBody = { ...params, messages, stream: true, stream_options: { include_usage: true } }
    for (const k of THINKING_KEYS) delete retryBody[k]
    retryBody.extra_body = extra
    try {
      return await getClient().chat.completions.create(retryBody, { signal })
    } catch (e2) {
      if (isUnknownParamError(e) || isUnknownParamError(e2)) {
        log.warn('服务端不认 thinking 参数，已按不带 thinking 重试：', (e2.message || '').slice(0, 120))
        const plain = { ...retryBody }
        delete plain.extra_body
        return await getClient().chat.completions.create(plain, { signal })
      }
      throw e2
    }
  }
}

function brief(p) {
  const o = { model: p.model, max_tokens: p.max_tokens }
  const t = p.thinking?.type || p.extra_body?.thinking?.type
  if (t === 'enabled') o.thinking = `enabled(${p.reasoning_effort || o.thinking || 'default'})`
  else o.thinking = 'disabled'
  if (p.temperature !== undefined) o.temperature = p.temperature
  if (p.top_p !== undefined) o.top_p = p.top_p
  return o
}

/** 给控制台「测试连通性」用 */
export async function ping() {
  const r = await getClient().chat.completions.create({
    model: env.deepseekModel,
    messages: [{ role: 'user', content: '回复两个字：在的' }],
    temperature: 0.5,
    max_tokens: 16,
    thinking: { type: 'disabled' },
  })
  return r.choices?.[0]?.message?.content || ''
}
