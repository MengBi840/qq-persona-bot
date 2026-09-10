// 离线试聊：走和群里完全一样的 prompt + 过滤链路，但不连 QQ。
// 用法：
//   node scripts/simulate.js "今天好累啊"
//   node scripts/simulate.js --thinking "帮我分析下这个方案"
//   node scripts/simulate.js --img assets/images/a.jpg "你看这图"
// 不传参数就进交互模式，输入 exit 退出。
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'info'
if (!process.argv.includes('--no-qq')) process.argv.push('--no-qq')

const { testReply } = await import('../src/bot.js')
const { env } = await import('../src/config.js')
const readline = await import('node:readline/promises')

const argv = process.argv.slice(2)
const thinking = argv.includes('--thinking')
const imgIdx = argv.indexOf('--img')
const images = []
if (imgIdx !== -1) {
  const p = argv[imgIdx + 1]
  if (p) images.push(p)
  argv.splice(imgIdx, 2)
}
const text = argv.filter((a) => a !== '--thinking').join(' ').trim()

if (!env.deepseekKey || env.deepseekKey.includes('在这')) {
  console.error('先在 .env 里填 DEEPSEEK_API_KEY')
  process.exit(1)
}

async function once(t) {
  process.stdout.write('\n你 > ' + t + '\n')
  const t0 = Date.now()
  try {
    const r = await testReply({ text: t, images, thinking })
    console.log('TA > ' + r.parts.join('  |||  '))
    const tags = [
      `thinking=${r.params.thinking}`,
      `${Date.now() - t0}ms`,
      r.filtered_out.length ? `命中规则并重写: ${r.filtered_out.join(' / ')}` : '无八股命中',
      r.would_send_image ? '这次会发一张图' : '不发图',
    ]
    console.log('    [' + tags.join(' | ') + ']')
    if (r.reasoning) console.log('    思考: ' + r.reasoning.slice(0, 200).replace(/\n/g, ' ') + '…')
  } catch (e) {
    console.error('出错：' + e.message)
  }
}

if (text) {
  await once(text)
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
console.log('离线试聊模式（同一个 prompt、同一套过滤，不会发到 QQ）。输入 exit 退出。')
for (;;) {
  let line = ''
  try {
    line = await rl.question('\n你 > ')
  } catch {
    break
  }
  const t = line.trim()
  if (!t) continue
  if (t === 'exit' || t === 'quit') break
  await once(t)
}
rl.close()
process.exit(0)
