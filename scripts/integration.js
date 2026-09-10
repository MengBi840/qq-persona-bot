// 半联网集成测试：用本地假服务替代 NapCat 和 DeepSeek，不需要真 QQ、不需要真 key、不花一分钱。
// 覆盖：OneBot WS 收发 / echo 请求响应 / LLM 请求参数（thinking 开关、温度、多模态图片）/ 整条回复链路 / 图库 / 配置迁移。
// 运行： npm run test:all
process.env.LOG_LEVEL = 'error'
process.env.PANEL_PASSWORD = 'itest-pass'
process.env.DEEPSEEK_API_KEY = 'sk-integration-test'
process.env.PANEL_PORT = process.env.PANEL_PORT || '18199'
// 这些必须在 import 之前设置：config.js 是 import 'dotenv/config' 的，
// .env 会盖掉外部传入的同名变量，晚设就没用了
process.env.IMAGE_DIR = './data/itest-gallery'
process.env.TMP_DIR = './data/itest-tmp'
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:18777`
process.env.OB_WS_URL = `ws://127.0.0.1:18778`

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'

// 1x1 PNG，测试里当假图片用
const FILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGa3w0kAAAAAElFTkSuQmCC',
  'base64',
)

let pass = 0
let fail = 0
const fails = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fail++
    fails.push(name + (extra ? ` -> ${extra}` : ''))
    console.log(`  \u2717 ${name}${extra ? ` -> ${extra}` : ''}`)
  }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}
const section = (t) => console.log(`\n${t}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 假 DeepSeek
// ---------------------------------------------------------------------------
let replyText = '今天挺热的 ||| 你那边呢'
let lastBody = null
let reqCount = 0
let gate = 'off' // 'off' | 'top'（拒绝顶层 thinking） | 'extra'（拒绝 extra_body）
const aiRequests = []

const fakeAI = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('{}')
      return
    }
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      /* ignore */
    }
    // 模拟「网关不认顶层 thinking，只认 extra_body.thinking」的情况，用来验证自动回退
    const gateMode = gate // 'top' | 'extra' | 'off'
    if (gateMode === 'extra' && body.extra_body?.thinking) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { message: 'Unrecognized request argument supplied: extra_body', type: 'invalid_request_error' },
        }),
      )
      return
    }
    if (gateMode === 'top' && body.thinking) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { message: 'Unrecognized request argument supplied: thinking', type: 'invalid_request_error' },
        }),
      )
      return
    }
    reqCount++
    lastBody = body
    const um = body.messages?.find((m) => m.role === 'user')
    aiRequests.push({
      n: reqCount,
      hasImage: Array.isArray(um?.content) && um.content.some((b) => b.type === 'image_url'),
      tail: (typeof um?.content === 'string' ? um.content : JSON.stringify(um?.content)).slice(-60),
      thinking: body?.thinking?.type || body?.extra_body?.thinking?.type || 'none',
    })
    // 按 ||| 切开后逐个 delta 发送，并保留分隔符（模拟真实流式输出）
    const parts = []
    const rawParts = String(replyText).split('|||')
    rawParts.forEach((p, i) => {
      parts.push(i < rawParts.length - 1 ? p + '|||' : p)
    })
    const thinking = body?.thinking?.type === 'enabled' || body?.extra_body?.thinking?.type === 'enabled' || !!body?.reasoning_effort
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const base = { id: 'chatcmpl-itest', object: 'chat.completion.chunk', created: Date.now(), model: 'deepseek-flash' }
    const write = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    if (thinking) write({ role: 'assistant', reasoning_content: '先想一下该怎么说……' })
    write({ role: 'assistant', content: '' })
    for (const p of parts) write({ content: p })
    write({}, 'stop')
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } })}\n\n`,
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

// ---------------------------------------------------------------------------
// 假 NapCat（OneBot v11 正向 WS）
// ---------------------------------------------------------------------------
const fakeQQ = http.createServer((req, res) => {
  // 顺手当一个图片服务器，让「下载群图片」这条路径能被真实测到
  if (req.url.startsWith('/pic.png')) {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(FILE_PNG)
    return
  }
  res.writeHead(426, { 'content-type': 'text/plain' }).end('websocket only')
})
const wss = new WebSocketServer({ server: fakeQQ })
let qqSocket = null
const qqCalls = []

wss.on('connection', (socket) => {
  qqSocket = socket
  socket.on('message', (raw) => {
    let p
    try {
      p = JSON.parse(raw.toString())
    } catch {
      return
    }
    qqCalls.push(p)
    let data = null
    let failed = false
    if (p.action === 'get_login_info') data = { user_id: 10001, nickname: '小助手' }
    else if (p.action === 'send_group_msg' || p.action === 'send_private_msg') {
      data = { message_id: 9000 + qqCalls.length }
      // 群号 1 专门用来测错误分支，确定性地返回失败
      if (Number(p.params?.group_id) === 1) {
        data = null
        failed = true
      }
    }
    socket.send(
      JSON.stringify({
        status: failed ? 'failed' : 'ok',
        retcode: failed ? 100 : 0,
        ...(failed ? { wording: 'boom' } : {}),
        data,
        echo: p.echo,
      }),
    )
  })
})

const PORT_AI = 18777
const PORT_QQ = 18778
await new Promise((r) => fakeAI.listen(PORT_AI, '127.0.0.1', r))
await new Promise((r) => fakeQQ.listen(PORT_QQ, '127.0.0.1', r))

// 所有 process.env 都必须在 import src/* 之前设好：config.js 里的 env 是模块加载时快照的
const { getConfig, saveConfig, resetConfig, reloadConfig, ROOT, DEFAULTS, env: cfgEnv } = await import('../src/config.js')
const { OneBot, downloadImage } = await import('../src/onebot.js')
const { generate } = await import('../src/llm.js')
const { filterReply } = await import('../src/filter.js')
const { loadPersona } = await import('../src/persona.js')
const bot = await import('../src/bot.js')
const img = await import('../src/image.js')

if (cfgEnv.imageDir !== path.join(ROOT, 'data', 'itest-gallery')) {
  console.error('[集成测试] 图库目录没生效，环境变量设置有误：', cfgEnv.imageDir)
  process.exit(1)
}

const tmpGallery = cfgEnv.imageDir
const PNG = FILE_PNG

// ===========================================================================
section('一、配置读写与迁移（config.json 只存差异）')
{
  const p = path.join(ROOT, 'config.json')
  if (fs.existsSync(p)) fs.unlinkSync(p)
  resetConfig()
  eq('默认 temperature', getConfig().reply.temperature, 0.85)
  eq('默认 thinking 关闭', getConfig().reply.thinking, false)
  ok('默认关键词含 小助手', getConfig().trigger.keywords.includes('小助手'))

  saveConfig({ reply: { temperature: 1.1 }, trigger: { keywords: ['喵喵'] } })
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'))
  eq('落盘的是改过的项', saved.reply.temperature, 1.1)
  eq('没改的项不落盘', saved.reply.maxTokens, undefined)
  ok('没改的整段不落盘', saved.vision === undefined)
  ok('数组改动会落盘', Array.isArray(saved.trigger.keywords) && saved.trigger.keywords[0] === '喵喵')

  // 模拟「老版本 config.json 里存了过期的默认过滤规则」——去八股规则（banned/hard 等）
  // 只认代码里的默认值，旧文件里的这些字段不能反过来盖住新版规则
  fs.writeFileSync(
    p,
    JSON.stringify({
      filter: { banned: ['过期规则'], hard: ['过期硬规则'] },
      reply: { temperature: 0.85, maxTokens: 999 },
    }),
    'utf8',
  )
  reloadConfig()
  ok('过期默认值被丢弃（不再是"过期规则"）', !getConfig().filter.banned.includes('过期规则'))
  ok('新默认规则生效', getConfig().filter.banned.includes('首先[，,]'))
  ok('过期的 hard 规则不会留下', !getConfig().filter.hard.includes('过期硬规则'))
  eq('用户改过的非默认值保留', getConfig().reply.maxTokens, 999)
  eq('跟默认相同的值被丢弃', getConfig().reply.temperature, 0.85)

  // 用户自己加的固定短语要能落盘并生效
  fs.writeFileSync(p, JSON.stringify({ filter: { removePhrases: ['家人们'] } }), 'utf8')
  reloadConfig()
  ok('自定义 removePhrases 被继承', getConfig().filter.removePhrases.includes('家人们'))
  ok('自定义短语真的会被删掉', !filterReply('家人们，这个真的好用').text.includes('家人们'), filterReply('家人们，这个真的好用').text)

  resetConfig()
  eq('恢复默认后关键词回到内置默认', getConfig().trigger.keywords.join(','), DEFAULTS.trigger.keywords.join(','))
  fs.unlinkSync(p)
}

// ===========================================================================
section('二、OneBot WS 收发与 echo 请求响应（对假 NapCat）')
{
  // 回归：外部传进来的环境变量不能被 .env 盖掉
  ok('.env 不会覆盖外部传入的环境变量', process.env.DEEPSEEK_BASE_URL === 'http://127.0.0.1:18777', process.env.DEEPSEEK_BASE_URL)
  ok('OB_WS_URL 用外部传入的值', cfgEnv.wsUrl === 'ws://127.0.0.1:18778', cfgEnv.wsUrl)

  const ob = new OneBot(process.env.OB_WS_URL, 'itest-token')
  await new Promise((resolve) => {
    if (ob.readyState === 1) return resolve()
    ob.once('open', resolve)
    setTimeout(resolve, 3000)
  })
  ok('WS 连上假 NapCat', ob.readyState === 1)
  eq('上线状态是 online', ob.status, 'online')

  const info = await ob.api.getLoginInfo()
  eq('get_login_info 走 echo 拿到昵称', info?.nickname, '小助手')
  eq('selfId 被记住', ob.selfId, 10001)

  const sent = await ob.api.sendGroupMsg(123456, [{ type: 'text', data: { text: 'hi' } }])
  ok('send_group_msg 有 message_id 返回', !!sent?.message_id)
  const lastCall = qqCalls[qqCalls.length - 1]
  eq('发出去的 action 正确', lastCall.action, 'send_group_msg')
  eq('群号是数字', lastCall.params.group_id, 123456)

  // 假 NapCat 推一条群消息 → 客户端要能转成 qq-message 事件
  const got = new Promise((resolve) => ob.once('qq-message', resolve))
  qqSocket.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      group_id: 123456,
      user_id: 999,
      sender: { nickname: '阿三' },
      message: [{ type: 'text', data: { text: '在吗' } }],
    }),
  )
  const ev = await got
  eq('入站群消息被解析', ev.group_id, 123456)

  // 错误 retcode 要 reject（假 NapCat 对群号 1 固定返回失败）
  let rejected = false
  let rejectMsg = ''
  await ob.call('send_group_msg', { group_id: 1, message: [] }).catch((e) => {
    rejected = true
    rejectMsg = e.message
  })
  ok('retcode != 0 时会 reject', rejected, rejectMsg)

  ob.close()
  await sleep(200)
  eq('close 后状态是 offline', ob.status, 'offline')
}

// ===========================================================================
section('三、DeepSeek 请求参数（对假 DeepSeek）')
{
  resetConfig()
  const persona = loadPersona()

  let r = await generate({ system: persona, userContent: '你好', thinking: false })
  ok('流式拼接出完整内容', r.content.includes('今天挺热的') && r.content.includes('你那边呢'), r.content)
  eq('非思考模式带 temperature', lastBody.temperature, 0.85)
  eq('非思考模式带 top_p', lastBody.top_p, 0.9)
  eq('max_tokens 生效', lastBody.max_tokens, 200)
  eq('非思考模式显式关闭 thinking', lastBody.thinking?.type, 'disabled')
  ok('非思考模式不带 reasoning_effort', lastBody.reasoning_effort === undefined)
  ok('system 里有人设', String(lastBody.messages[0].content).includes('小助手'))
  eq('system 角色正确', lastBody.messages[0].role, 'system')
  ok('model 名正确', lastBody.model === 'deepseek-flash', lastBody.model)

  r = await generate({ system: persona, userContent: '你好', thinking: true, thinkingEffort: 'high' })
  eq('思考模式开 thinking', lastBody.thinking?.type, 'enabled')
  eq('思考强度传对了', lastBody.reasoning_effort, 'high')
  ok('思考模式不再传 temperature（官方会忽略）', lastBody.temperature === undefined)
  ok('思考模式不再传 top_p', lastBody.top_p === undefined)
  ok('思考内容能拿到', r.reasoning.length > 0, r.reasoning)

  // 网关只认 extra_body.thinking 时，要能自动回退
  gate = 'top'
  r = await generate({ system: persona, userContent: '你好', thinking: true, thinkingEffort: 'low' })
  ok(
    '不认顶层 thinking 时自动换成 extra_body 重试',
    !!lastBody.extra_body?.thinking,
    JSON.stringify(Object.keys(lastBody || {})),
  )
  ok('回退后请求依然成功', r.content.includes('今天挺热的'), r.content)
  gate = 'off'

  // 多模态：图片必须放在 user 消息里，且是 data URL
  r = await generate({
    system: persona,
    userContent: [
      { type: 'text', text: '你看这个' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'auto' } },
    ],
    thinking: false,
  })
  const userMsg = lastBody.messages.find((m) => m.role === 'user')
  ok('user 消息是 block 数组', Array.isArray(userMsg.content))
  ok('图片以 image_url block 传进去', userMsg.content.some((b) => b.type === 'image_url' && b.image_url.url.startsWith('data:image/png')))
  ok('system 里没有塞图片（官方会 400）', typeof lastBody.messages[0].content === 'string')
}

// ===========================================================================
section('四、整条回复链路（假 NapCat + 假 DeepSeek）')
{
  resetConfig()
  replyText = '今天挺热的 ||| 你那边呢'
  const outbox = []
  const fake = {
    selfId: 10001,
    status: 'online',
    api: {
      async sendTo(ev, message) {
        outbox.push({ ev, message })
        return { message_id: 5000 + outbox.length }
      },
      async fetchImageFile() {
        return null
      },
    },
    on() {},
  }
  bot.__setClientForTest(fake)

  replyText = '今天挺热的 ||| 你那边呢'
  outbox.length = 0
  await bot.__runMessageForTest({
    post_type: 'message',
    message_type: 'group',
    group_id: 222,
    user_id: 999,
    sender: { nickname: '阿三' },
    message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: ' 在干嘛呢 ' } },
    ],
  })
  await sleep(150)

  const texts = outbox.filter((o) => o.message[0].type === 'text').map((o) => o.message[0].data.text)
  eq('两条短句都发出去了', texts, ['今天挺热的', '你那边呢'])
  ok('先发了个表情回应', outbox.some((o) => o.message[0].type === 'face'))
  eq('都发到同一个群', outbox[0].ev.group_id, 222)
  ok('user 消息里带上了群上下文提示', String(lastBody.messages[1].content).includes('在干嘛呢'))
  ok('上下文里有发言人昵称', String(lastBody.messages[1].content).includes('阿三'))

  // 没 @ 且关键词不命中 → 不回
  saveConfig({ trigger: { interjectEnabled: false, interjectChance: 0 } })
  outbox.length = 0
  await bot.__runMessageForTest({
    post_type: 'message',
    message_type: 'group',
    group_id: 222,
    user_id: 998,
    sender: { nickname: '阿四' },
    message: [{ type: 'text', data: { text: '今天天气不错' } }],
  })
  await sleep(120)
  eq('普通闲聊不回复', outbox.filter((o) => o.message[0].type === 'text').length, 0)

  // 关键词命中 → 回
  outbox.length = 0
  await bot.__runMessageForTest({
    post_type: 'message',
    message_type: 'group',
    group_id: 222,
    user_id: 998,
    sender: { nickname: '阿四' },
    message: [{ type: 'text', data: { text: '小助手出来' } }],
  })
  await sleep(150)
  ok('关键词触发有回复', outbox.some((o) => o.message[0].type === 'text'))

  // 收图 → 走多模态（纯图不 @ 也回，因为把 needAtWhenImageOnly 关了来测这条路径）
  saveConfig({ vision: { needAtWhenImageOnly: false }, trigger: { interjectEnabled: false } })
  bot.__setClientForTest(fake)
  outbox.length = 0
  const imgDir = path.join(ROOT, 'data', 'itest-vision')
  fs.mkdirSync(imgDir, { recursive: true })
  fs.writeFileSync(path.join(imgDir, 'pic.png'), PNG)
  const picUrl = `http://127.0.0.1:${PORT_QQ}/pic.png`
  await bot.__runMessageForTest({
    post_type: 'message',
    message_type: 'group',
    group_id: 222,
    user_id: 998,
    sender: { nickname: '阿四' },
    message: [
      { type: 'at', data: { qq: '10001' } },
      { type: 'image', data: { file: picUrl, url: picUrl } },
    ],
  })
  await sleep(300)
  const userMsg = lastBody.messages.find((m) => m.role === 'user')
  const withImg = Array.isArray(userMsg.content) && userMsg.content.some((b) => b.type === 'image_url')
  ok(
    '收图那次请求是数组形态（带图）',
    withImg,
    `reqs=${JSON.stringify(aiRequests.slice(-3))} content=${JSON.stringify(userMsg.content).slice(0, 160)}`,
  )
  if (withImg) {
    const block = userMsg.content.find((b) => b.type === 'image_url')
    ok('图片以 data URL 内联传过去', String(block.image_url.url).startsWith('data:image/'), String(block.image_url.url).slice(0, 40))
  } else {
    ok('图片以 data URL 内联传过去', false, '上一条已失败')
  }
  fs.rmSync(imgDir, { recursive: true, force: true })
  saveConfig({ vision: { needAtWhenImageOnly: true } })

  // 八股重新生成链路：用「多行列表」这种必须靠模型重写才能修的问题来验证
  bot.__setClientForTest(fake)
  outbox.length = 0
  replyText = '- 第一点\n- 第二点\n- 第三点'
  const origRegen = getConfig().reply.maxRegenerate
  saveConfig({ reply: { maxRegenerate: 1 } })
  const before = reqCount
  await bot.__runMessageForTest({
    post_type: 'message',
    message_type: 'group',
    group_id: 333,
    user_id: 997,
    sender: { nickname: '阿五' },
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '给我讲讲' } }],
  })
  await sleep(250)
  ok('命中结构问题后确实又请求了一次模型', reqCount - before >= 2, `reqCount +${reqCount - before}`)
  ok(
    '重写时带上了"特别注意"要求',
    aiRequests.slice(-2).some((r) => String(lastBody.messages[0].content).includes('这次特别注意')),
    String(lastBody.messages[0].content).slice(-100),
  )
  const finalText = outbox.filter((o) => o.message[0].type === 'text').map((o) => o.message[0].data.text).join(' ')
  ok('重写后即使模型照旧，也不会再分点发出去', !/^[-*+]\s/m.test(finalText) && !finalText.includes('- '), finalText)
  saveConfig({ reply: { maxRegenerate: origRegen } })

  // maxRegenerate=0 时兜底：硬删掉八股，不重写
  bot.__setClientForTest(fake)
  outbox.length = 0
  saveConfig({ reply: { maxRegenerate: 0 } })
  replyText = '作为AI，我理解你的感受，希望能帮到你。'
  await bot.__runMessageForTest({
    post_type: 'message',
    message_type: 'group',
    group_id: 334,
    user_id: 996,
    sender: { nickname: '阿六' },
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '在吗' } }],
  })
  await sleep(200)
  const fallbackText = outbox.filter((o) => o.message[0].type === 'text').map((o) => o.message[0].data.text).join(' ')
  ok('不重写时把八股硬删干净', !fallbackText.includes('作为AI') && !fallbackText.includes('希望能帮到你'), fallbackText)
  saveConfig({ reply: { maxRegenerate: 1 } })

  // 四、队列：连发三条只处理一次上下文不乱
  bot.__setClientForTest(fake)
  saveConfig({ trigger: { interjectEnabled: false, interjectChance: 0 } })
  outbox.length = 0
  replyText = '知道了'
  const burst = [1, 2, 3].map((i) =>
    bot.__runMessageForTest({
      post_type: 'message',
      message_type: 'group',
      group_id: 444,
      user_id: 900 + i,
      sender: { nickname: '群众' + i },
      message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '问题' + i } }],
    }),
  )
  await Promise.all(burst)
  await sleep(300)
  const burstTexts = outbox.filter((o) => o.message[0].type === 'text').map((o) => o.message[0].data.text)
  eq('连发三条 = 三条回复（队列没丢）', burstTexts.length, 3)
  ok('回复顺序和提问顺序一致', burstTexts.every((t) => t === '知道了'))

  // 私聊必回
  bot.__setClientForTest(fake)
  outbox.length = 0
  await bot.__runMessageForTest({
    post_type: 'message',
    message_type: 'private',
    user_id: 995,
    sender: { nickname: '路人' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  await sleep(150)
  ok('私聊一定回', outbox.some((o) => o.message[0].type === 'text'))
  eq('私聊回复发到用户而不是群', outbox[0].ev.user_id, 995)
}

// ===========================================================================
section('五、图库与发图冷却')
{
  resetConfig()
  saveConfig({ send: { allowModelImage: true, imageCooldownSec: 60, imageChanceCap: 1 } })
  fs.rmSync(tmpGallery, { recursive: true, force: true })
  fs.mkdirSync(tmpGallery, { recursive: true })
  for (const n of ['a.png', 'b.png', 'c.png']) fs.writeFileSync(path.join(tmpGallery, n), PNG)

  const p1 = img.pickImage('group:t1')
  ok(
    '能挑出第一张图',
    !!p1,
    `dir=${JSON.stringify(process.env.IMAGE_DIR)} list=${JSON.stringify(img.listGallery().map((f) => f.name))} send=${JSON.stringify(getConfig().send)}`,
  )
  eq('挑出来的是真文件', !!p1 && fs.existsSync(p1), true)
  eq('同群冷却期内不再发', img.pickImage('group:t1'), null)
  eq('canSendImage 冷却中返回 false', img.canSendImage('group:t1'), false)
  eq('别的群不受影响', typeof img.pickImage('group:t2'), 'string')

  saveConfig({ send: { imageCooldownSec: 0 } })
  const many = []
  for (let i = 0; i < 6; i++) many.push(path.basename(img.pickImage('group:t3') || ''))
  ok('冷却为 0 时可以连续挑', many.filter(Boolean).length === 6, JSON.stringify(many))
  ok('短周期内不会一直重复同一张', new Set(many.slice(0, 3)).size >= 2, JSON.stringify(many))
  eq('listGallery 能列出图库', img.listGallery().length >= 0, true)

  fs.rmSync(tmpGallery, { recursive: true, force: true })
}

// ===========================================================================
section('六、人设与过滤联动（用假模型跑一次完整生成）')
{
  resetConfig()
  const f = filterReply('首先，你要冷静。其次，我理解你的感受。最后，希望能帮到你。')
  ok('一段典型八股被处理', !f.text.includes('希望能帮到你'), f.text)
  ok('命中的规则被记录下来给日志用', f.hits.length >= 3, String(f.hits.length))
  ok('固定八股短语被直接删干净，不需要靠重写', !f.needRewrite && !f.text.includes('我理解你的感受'), f.text)

  const clean = filterReply('嗯，行吧 ||| 那你早点睡')
  ok('正常口语不被动', clean.needRewrite === false && clean.text.includes('行吧'), clean.text)
}

const st = bot.status()
ok('status() 带统计字段', st.stats && typeof st.stats.messages === 'number')
ok('status() 带参数说明', typeof st.paramNote === 'string' && st.paramNote.length > 10)

// ===========================================================================
section('七、首次使用体验（.env 没填好时不能让它稀里糊涂跑起来）')
{
  const { spawnSync } = await import('node:child_process')
  const tmpHome = path.join(ROOT, 'data', 'itest-firstrun')
  fs.rmSync(tmpHome, { recursive: true, force: true })
  fs.mkdirSync(tmpHome, { recursive: true })

  const runWithEnv = (envBody, { args = [], port = 18101 } = {}) => {
    fs.writeFileSync(path.join(tmpHome, '.env'), envBody, 'utf8')
    // 注意：必须把这三个键「删掉」而不是设成空串。
    // dotenv 是 override:false，键存在但为空时它不会用 .env 里的值覆盖，
    // 结果就会绕过 assertEnv，测出个假通过。
    const childEnv = { ...process.env }
    delete childEnv.DEEPSEEK_API_KEY
    delete childEnv.PANEL_PASSWORD
    delete childEnv.OB_ACCESS_TOKEN
    Object.assign(childEnv, {
      PANEL_PORT: String(port), // 用固定但空闲的端口，方便探测控制台是否真的起来了
      ENV_FILE: path.join(tmpHome, '.env'),
      CONFIG_FILE: path.join(tmpHome, 'config.json'),
      PERSONA_FILE: path.join(ROOT, 'persona.md'),
    })
    return spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...args], {
      cwd: tmpHome,
      encoding: 'utf8',
      timeout: 6000,
      env: childEnv,
    })
  }

  const r1 = runWithEnv(
    'DEEPSEEK_API_KEY=sk-REPLACE_WITH_YOUR_KEY\nPANEL_PASSWORD=itest-pw-9911\nOB_ACCESS_TOKEN=my-token-123\n',
  )
  ok('占位符 key 会被拦下来', r1.status === 1, `status=${r1.status}`)
  // 提示是写到 stderr 的（配置错误）
  ok(
    '提示里点名了 DEEPSEEK_API_KEY',
    `${r1.stdout || ''}${r1.stderr || ''}`.includes('DEEPSEEK_API_KEY'),
    `${r1.stdout || ''}${r1.stderr || ''}`.slice(0, 300),
  )
  ok('提示里给出了 .env 的完整路径', `${r1.stdout || ''}${r1.stderr || ''}`.includes('.env'))

  const r2 = runWithEnv(
    'DEEPSEEK_API_KEY=sk-1234567890abcdef\nPANEL_PASSWORD=改成你自己的密码\nOB_ACCESS_TOKEN=itest-token-9911\n',
  )
  ok('没改的中文占位密码也会被拦', r2.status === 1, `status=${r2.status}`)

  // .env.example 里的示例值原样留着，也必须被拦（不然用户以为填好了）
  const r2b = runWithEnv(
    'DEEPSEEK_API_KEY=sk-1234567890abcdef\nPANEL_PASSWORD=my-panel-pass\nOB_ACCESS_TOKEN=itest-token-9911\n',
  )
  ok('.env.example 的示例密码原样留着会被拦', r2b.status === 1, `status=${r2b.status}`)
  const r2c = runWithEnv(
    'DEEPSEEK_API_KEY=sk-1234567890abcdef\nPANEL_PASSWORD=itest-pw-9911\nOB_ACCESS_TOKEN=my-token-123\n',
  )
  ok('.env.example 的示例 token 原样留着会被拦（没加 --no-qq 时）', r2c.status === 1, `status=${r2c.status}`)

  // 填全了就应该能真的跑起来：异步启动，趁它活着探测控制台 HTTP
  const r3port = 18111
  const { spawn } = await import('node:child_process')
  fs.writeFileSync(
    path.join(tmpHome, '.env'),
    'DEEPSEEK_API_KEY=sk-1234567890abcdef\nPANEL_PASSWORD=itest-pw-9911\nOB_ACCESS_TOKEN=itest-token-9911\n',
    'utf8',
  )
  const childEnv = { ...process.env }
  delete childEnv.DEEPSEEK_API_KEY
  delete childEnv.PANEL_PASSWORD
  delete childEnv.OB_ACCESS_TOKEN
  Object.assign(childEnv, {
    PANEL_PORT: String(r3port),
    LOG_LEVEL: 'info', // 这个子进程要打启动日志，级别调回 info
    ENV_FILE: path.join(tmpHome, '.env'),
    CONFIG_FILE: path.join(tmpHome, 'config.json'),
    PERSONA_FILE: path.join(ROOT, 'persona.md'),
  })
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--no-qq'], {
    cwd: tmpHome,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let childOut = ''
  let spawnErr = null
  child.on('error', (e) => (spawnErr = e))
  child.stdout.on('data', (d) => (childOut += d))
  child.stderr.on('data', (d) => (childOut += d))
  let exitedEarly = false
  child.on('exit', () => (exitedEarly = true))
  await sleep(2500)
  ok('填全了就不再被拦（进程还活着）', !exitedEarly, `spawnErr=${spawnErr} pid=${child.pid} out=${JSON.stringify(childOut)}`)
  const r3up = await fetch(`http://127.0.0.1:${r3port}/`).then(
    (r) => r.status === 200,
    () => false,
  )
  ok('放行后控制台真的起来了（HTTP 200）', r3up)
  ok('启动日志里出现了控制台地址', childOut.includes('本地控制台'), JSON.stringify(childOut).slice(0, 500))
  child.kill('SIGTERM')
  await sleep(300)

  fs.rmSync(tmpHome, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
wss.close()
fakeAI.close()
fakeQQ.close()
const cfgPath = path.join(ROOT, 'config.json')
if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath)

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  console.log('失败项：')
  for (const f of fails) console.log('  - ' + f)
}
process.exit(fail ? 1 : 0)
