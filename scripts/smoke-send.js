// 故障排查用：真的连 NapCat、真的发消息，群里会看到这条消息。
// 用法：node scripts/smoke-send.js 群号 "要发的内容"     —— 发文本
//       node scripts/smoke-send.js 群号 --img 图片路径  —— 发图
const args = process.argv.slice(2)
const groupId = Number(args[0])
let text = args.slice(1).filter((a) => a !== '--img').join(' ')
const imgAt = args.indexOf('--img')
const imgPath = imgAt !== -1 ? args[imgAt + 1] : ''
if (imgAt !== -1) text = args.slice(1, imgAt).join(' ')

if (!groupId) {
  console.error('用法：node scripts/smoke-send.js <群号> "内容"   或   node scripts/smoke-send.js <群号> --img <图片路径>')
  process.exit(1)
}

const { OneBot, fileUri } = await import('../src/onebot.js')
const { env } = await import('../src/config.js')
const fs = await import('node:fs')
const path = await import('node:path')

const ob = new OneBot(env.wsUrl, env.accessToken)

function done(code) {
  ob.close()
  setTimeout(() => process.exit(code), 200)
}

ob.on('open', async () => {
  try {
    const me = await ob.api.getLoginInfo()
    console.log(`已连上，登录号 ${me?.nickname}(${me?.user_id})`)
    if (imgPath) {
      const abs = path.resolve(imgPath)
      if (!fs.existsSync(abs)) throw new Error(`找不到图片：${abs}`)
      const r = await ob.api.sendGroupMsg(groupId, [{ type: 'image', data: { file: fileUri(abs) } }])
      console.log(`已发图到群 ${groupId}，message_id=${r?.message_id}`)
    } else {
      if (!text) throw new Error('没有要发的内容')
      const r = await ob.api.sendGroupMsg(groupId, [{ type: 'text', data: { text } }])
      console.log(`已发文本到群 ${groupId}，message_id=${r?.message_id}`)
    }
    done(0)
  } catch (e) {
    console.error('发送失败：' + e.message)
    done(1)
  }
})

ob.on('error', (e) => {
  console.error('连接错误：' + e.message)
  done(1)
})

setTimeout(() => {
  console.error('10 秒内没连上，检查 NapCat 是否启动、端口/Token 是否一致')
  done(1)
}, 10000)
