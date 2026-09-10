// 离线自检：不需要 NapCat、不需要 DeepSeek key、不联网。
// 运行： npm test
process.env.PANEL_PORT = process.env.PANEL_PORT || '18099'
process.env.PANEL_PASSWORD = 'itest-pass'
process.env.DEEPSEEK_API_KEY = 'sk-test-not-used'
process.env.LOG_LEVEL = 'warn'
if (!process.argv.includes('--no-qq')) process.argv.push('--no-qq')

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
  ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

function section(t) {
  console.log(`\n${t}`)
}

const { filterReply, scan, cleanText } = await import('../src/filter.js')
const { parseMessage, decide, accessAllowed, status } = await import('../src/bot.js')
const { loadPersona } = await import('../src/persona.js')
const { buildSystemPrompt, buildUserContent, buildMessages } = await import('../src/prompt.js')
const { getConfig, saveConfig } = await import('../src/config.js')
const { listGallery } = await import('../src/image.js')

section('零、配置路径自检（防“点错层”这类低级错误）')
{
  const { DEFAULTS, looksLikePlaceholder } = await import('../src/config.js')

  // 占位符识别：这一步错了会导致「用户没改 .env 也能启动」
  for (const bad of [
    '',
    'sk-REPLACE_WITH_YOUR_KEY',
    'sk-在这里粘贴你的key',
    '改成你自己的密码',
    '<your-key>',
    'changeme',
    'xxxxxx',
  ]) {
    ok(`占位符会被识破：${JSON.stringify(bad)}`, looksLikePlaceholder(bad) === true)
  }
  for (const good of [
    'sk-aCVaUETyJLY16xsV6wFE2UYaHRsu342X1qIi',
    'my-panel-pass',
    'MyS3cret!2026',
    '我的密码不是占位',
    'my-token-123',
  ]) {
    ok(`正常值不会被误杀：${JSON.stringify(good)}`, looksLikePlaceholder(good) === false)
  }

  const need = [
    'filter.hardFilter',
    'filter.banned',
    'filter.bannedStructure',
    'filter.hard',
    'filter.hardReplacement',
    'filter.removePhrases',
    'reply.thinking',
    'reply.thinkingEffort',
    'reply.temperature',
    'reply.topP',
    'reply.maxTokens',
    'reply.maxRegenerate',
    'reply.cooldownSec',
    'session.historyLimit',
    'session.idleResetSec',
    'session.maxQueue',
    'session.requestTimeoutMs',
    'session.streamIdleTimeoutMs',
    'trigger.requireAt',
    'trigger.keywords',
    'trigger.replyToBot',
    'trigger.interjectEnabled',
    'trigger.interjectChance',
    'trigger.interjectCooldownSec',
    'vision.enabled',
    'vision.maxPerMessage',
    'vision.needAtWhenImageOnly',
    'send.allowModelImage',
    'send.imageToken',
    'send.imageCooldownSec',
    'access.groupMode',
    'access.groupAllow',
    'access.groupDeny',
  ]
  const dig = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o)
  for (const p of need) {
    ok(`默认配置里有 ${p}`, dig(DEFAULTS, p) !== undefined)
    ok(`运行配置里有 ${p}`, dig(getConfig(), p) !== undefined)
  }
}

section('一、去八股过滤')
{
  const a = filterReply('首先，你今天吃了吗？其次，我想说你辛苦了。最后，早点休息。')
  ok('“首先/其次/最后”被记录成八股命中', a.hits.some((h) => h.type === 'phrase'))
  ok('没触发重写（只是语气词，可以直接删）', a.needRewrite === false, JSON.stringify(a.structHits))

  const b = filterReply('作为AI，我理解你的感受，希望能帮到你。')
  ok('“作为AI/我理解你的感受”被删掉（不需要重写）', !b.text.includes('作为AI') && !b.text.includes('我理解你的感受'), b.text)
  ok('“希望能帮到你”被直接删掉', !b.text.includes('希望能帮到你'), b.text)

  const c = filterReply('总的来说，今天挺开心的。')
  ok('“总的来说”被删掉', !c.text.includes('总的来说'), c.text)
  ok('删掉后还剩内容', c.text.length > 0, c.text)

  const d = filterReply('- 第一点\n- 第二点\n- 第三点')
  ok('多行列表结构会命中结构规则并重写', d.needRewrite === true)
  ok('单行以 - 开头不算结构问题', filterReply('- 行吧').needRewrite === false)

  const e = filterReply('这是**加粗**和 # 标题')
  ok('markdown 加粗/标题命中结构规则', e.hits.some((h) => h.type === 'structure'))
  ok('markdown 结构会触发重写', e.needRewrite === true)

  const f = filterReply('“今天天气不错啊”')
  eq('整体包裹的引号被去掉', f.text, '今天天气不错啊')

  const g = filterReply('  嗯，确实  ')
  ok('正常口语回复不触发重写', g.needRewrite === false, JSON.stringify(g.hard))

  const h = filterReply('')
  ok('空串不炸', typeof h.text === 'string')

  eq('cleanText 去掉 CQ 码', cleanText('[CQ:at,qq=123] 在吗'), '在吗')
  eq('cleanText 去掉 emoji 前缀', cleanText('😂😂在的'), '在的')

  // 关掉硬过滤后不应再要求重写
  saveConfig({ filter: { hardFilter: false } })
  const i = filterReply('首先，我要说，总的来说还行。')
  ok('hardFilter=false 时不重写', i.needRewrite === false)
  saveConfig({ filter: { hardFilter: true } })
}

section('二、消息解析')
{
  const { __setSelfIdForTest } = await import('../src/bot.js')
  __setSelfIdForTest('12345')
  const ev = [
    { type: 'at', data: { qq: '12345' } },
    { type: 'text', data: { text: ' 帮我看看这个 ' } },
    { type: 'image', data: { file: 'abc.jpg', url: 'http://x/y.jpg' } },
    { type: 'face', data: { id: '1' } },
  ]
  const p = parseMessage(ev)
  eq('@ 自己被识别', p.atMe, true)
  ok('文本里没有 @残留', !p.text.includes('CQ') && p.text.includes('帮我看看这个'), p.text)
  eq('图片数量', p.images.length, 1)
  eq('图片 url', p.images[0].url, 'http://x/y.jpg')
  ok('没有 reply 段时不误判', p.replyToBot === false)

  const p2 = parseMessage([{ type: 'at', data: { qq: '999' } }])
  eq('@ 别人不算 @我', p2.atMe, false)
  eq('@全体算 @我', parseMessage([{ type: 'at', data: { qq: 'all' } }]).atMe, true)
  __setSelfIdForTest(null)
}

section('三、触发判定')
{
  saveConfig({
    trigger: { requireAt: true, keywords: ['小助手'], interjectEnabled: false, interjectChance: 0 },
    access: { groupMode: 'open', groupAllow: [], groupDeny: [] },
  })
  const base = { message_type: 'group', group_id: 111, user_id: 222, sender: { nickname: '阿三' } }

  eq('@我 -> 回', decide(base, parseMessage([{ type: 'at', data: { qq: '12345' } }])).reply, false) // selfId 未知时不算
  eq('关键词 -> 回', decide(base, parseMessage([{ type: 'text', data: { text: '小助手在吗' } }])).reply, true)
  eq('普通闲聊 -> 不回', decide(base, parseMessage([{ type: 'text', data: { text: '今天吃啥' } }])).reply, false)
  eq('私聊 -> 总回', decide({ ...base, message_type: 'private' }, parseMessage([{ type: 'text', data: { text: 'hi' } }])).reply, true)

  saveConfig({ trigger: { keywords: ['喵'] } })
  eq('换关键词后按新词命中', decide(base, parseMessage([{ type: 'text', data: { text: '喵一个' } }])).reply, true)

  saveConfig({ trigger: { interjectEnabled: true, interjectChance: 1, interjectCooldownSec: 0 } })
  eq('插话概率 100% -> 回', decide(base, parseMessage([{ type: 'text', data: { text: '随便聊聊' } }])).reply, true)
  saveConfig({ trigger: { interjectEnabled: false, interjectChance: 0, keywords: ['小助手'], requireAt: true } })

  saveConfig({ access: { groupMode: 'allowlist', groupAllow: ['999'] } })
  eq('allowlist 外 -> 拦', accessAllowed(base), false)
  eq('allowlist 内 -> 放', accessAllowed({ ...base, group_id: 999 }), true)
  saveConfig({ access: { groupMode: 'open', groupAllow: [] } })
}

section('四、人设与上下文')
{
  const persona = loadPersona()
  ok('persona.md 能加载', persona.length > 50, `${persona.length} 字`)
  const sys = buildSystemPrompt(persona)
  ok('system prompt 含人设内容', sys.includes('身份') || sys.includes('小助手'))
  ok('system prompt 含去八股规则', sys.includes('不用列表'))
  ok('system prompt 不含未替换占位符', !sys.includes('undefined'))

  const ev = { message_type: 'group', group_id: 1, user_id: 2, sender: { nickname: '阿三' } }
  const plain = buildUserContent(ev, '在吗', [])
  ok('无图时 userContent 是字符串', typeof plain === 'string' && plain.includes('阿三'), JSON.stringify(plain))

  saveConfig({ vision: { enabled: true } })
  const withImg = buildUserContent(ev, '你看这个', [{ url: 'data:image/png;base64,AAA' }])
  ok('有图时 userContent 是数组', Array.isArray(withImg))
  ok('数组里有 image_url block', Array.isArray(withImg) && withImg.some((b) => b.type === 'image_url'))

  const { userContent } = buildMessages(ev, [{ t: Date.now(), role: 'user', speaker: '阿三', content: '前面聊了游戏' }], plain)
  ok('上下文里带上了最近记录', userContent.includes('前面聊了游戏'))
  ok('上下文结尾是本次消息', String(userContent).trim().endsWith('在吗'))

  // 带图时上下文必须是 block 数组，且不能把数组拼成 [object Object]
  const withImgCtx = buildMessages(ev, [], withImg).userContent
  ok('带图时返回 block 数组', Array.isArray(withImgCtx))
  const imgText = withImgCtx.find((b) => b.type === 'text').text
  ok('带图时文字部分正常没被弄坏', imgText.includes('你看这个') && !imgText.includes('[object Object]'), imgText)
  ok('带图时图片 block 还在', withImgCtx.some((b) => b.type === 'image_url'))
  ok('带图时也带上了群上下文提示', imgText.includes('最近群里的聊天记录') || imgText.includes('轮到你了'))
}

section('五、图库与统计')
{
  const g = listGallery()
  ok('图库能列目录（空也可以）', Array.isArray(g), String(g.length))
  const s = status()
  ok('status() 字段齐全', s.model && s.stats && typeof s.galleryCount === 'number')
  ok('默认只绑本机', getConfig().access !== undefined)
}

section('六、本地控制台 HTTP')
{
  const { startPanel } = await import('../src/panel.js')
  const server = startPanel()
  await new Promise((r) => setTimeout(r, 400))
  const base = `http://127.0.0.1:${process.env.PANEL_PORT}`

  const r1 = await fetch(`${base}/`)
  eq('首页返回 200', r1.status, 200)
  const html = await r1.text()
  ok('首页是控制台页面', html.includes('QQ 群 BOT 控制台') && html.includes('思考模式'))

  const r2 = await fetch(`${base}/api/status`)
  eq('未登录访问 API 被拒', r2.status, 401)

  const r3 = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  })
  eq('错密码被拒', r3.status, 401)

  const r4 = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'itest-pass' }),
  })
  eq('对密码放行', r4.status, 200)
  const cookie = (r4.headers.get('set-cookie') || '').split(';')[0]
  ok('下发了会话 cookie', cookie.startsWith('dshbot_sid='))

  const H = { 'content-type': 'application/json', cookie }
  const r5 = await fetch(`${base}/api/status`, { headers: H })
  eq('登录后能读状态', r5.status, 200)
  const st = await r5.json()
  ok('状态里带 thinking 参数说明', typeof st.paramNote === 'string' && st.paramNote.length > 10)

  const r6 = await fetch(`${base}/api/config`, { headers: H })
  const cfg0 = (await r6.json()).config
  eq('默认 temperature', cfg0.reply.temperature, 0.85)
  eq('默认 max_tokens', cfg0.reply.maxTokens, 200)
  eq('默认 thinking 关闭', cfg0.reply.thinking, false)

  const r7 = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ reply: { thinking: true, maxTokens: 120 } }),
  })
  const cfg1 = (await r7.json()).config
  eq('面板能改 thinking', cfg1.reply.thinking, true)
  eq('面板能改 max_tokens', cfg1.reply.maxTokens, 120)
  await fetch(`${base}/api/config`, { method: 'POST', headers: H, body: JSON.stringify({ reply: { thinking: false, maxTokens: 200 } }) })

  const r8 = await fetch(`${base}/api/persona`, { headers: H })
  const per = await r8.json()
  ok('能读 persona', per.text.length > 50)

  const r9 = await fetch(`${base}/api/gallery`, { headers: H })
  const gal = await r9.json()
  ok('能读图库', Array.isArray(gal.list))

  const r10 = await fetch(`${base}/api/logs`, { headers: H })
  ok('能读日志', Array.isArray((await r10.json()).list))

  server.close()
}

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  console.log('失败项：')
  for (const f of fails) console.log('  - ' + f)
}
// 自检过程会改配置，跑完把 config.json 删掉，保证你第一次启动就是默认配置
try {
  const { ROOT } = await import('../src/config.js')
  const p = (await import('node:path')).join(ROOT, 'config.json')
  if ((await import('node:fs')).existsSync(p)) (await import('node:fs')).unlinkSync(p)
} catch {
  /* ignore */
}
process.exit(fail ? 1 : 0)
