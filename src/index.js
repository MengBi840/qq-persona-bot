// ============================================================================
// 程序入口
//
// 两种跑法都走这里：
//   node src/index.js            源码运行（开发用）
//   qqbot.exe                    打包后的单文件 exe（双击 启动.bat 也行）
//
// 命令行参数：
//   （无）        连 NapCat + 开本地控制台
//   --check      只做自检并把报告打出来，不启动（排查「启动不了」用这个）
//   --no-qq      只开控制台，不连 QQ（调面板/改人设用）
//   --help       看帮助
//   --version    看版本
//   --quiet      少打日志
// ============================================================================

import { env, assertEnv, getConfig, PARAM_NOTE, PATHS, ENV_FILE_LOADED, ensureDirs, preflightReport } from './config.js'
import { log, setLevel } from './logger.js'
import { start, stop } from './bot.js'
import { startPanel } from './panel.js'

const VERSION = '1.0.0'

// 只看我们自己认的参数
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)

function printHelp() {
  const line = (s = '') => console.log(s)
  line('')
  line('  QQ 群 BOT（NapCat + DeepSeek）')
  line('')
  line('  用法：')
  line('    qqbot.exe --check        先做自检，看配置/路径/人设对不对（启动不了就敲这个）')
  line('    qqbot.exe                连 NapCat 并开启本地控制台')
  line('    qqbot.exe --no-qq        只开控制台，不连 QQ（调试界面用）')
  line('    qqbot.exe --quiet        少打日志')
  line('    qqbot.exe --help         显示这段帮助')
  line('    qqbot.exe --version      显示版本号')
  line('')
  line('  源码运行：node src/index.js [同样的参数]')
  line('')
  line('  启动前需要准备：')
  line('    1) .env 里填好 DEEPSEEK_API_KEY / PANEL_PASSWORD / OB_ACCESS_TOKEN')
  line('    2) NapCat 已扫码登录，并在 WebUI 里开了 127.0.0.1:3001 的 WebSocket 服务')
  line('    3) persona.md 是人设，随便改，改完自动生效')
  line('')
  line('  当前解析到的路径：')
  line(`    工作目录   ${PATHS.ROOT}`)
  line(`    .env       ${PATHS.ENV_FILE}${ENV_FILE_LOADED ? '' : '  (不存在)'}`)
  line(`    persona.md ${PATHS.PERSONA_FILE}`)
  line(`    config.json ${PATHS.CONFIG_FILE}`)
  line(`    图库       ${PATHS.IMAGE_DIR}`)
  line('')
  line('  控制台地址：http://127.0.0.1:8099 （密码是 .env 里的 PANEL_PASSWORD）')
  line('')
}

function printVersion() {
  console.log(`qq-persona-bot v${VERSION}  (node ${process.version})`)
}

if (has('--help') || has('-h')) {
  printHelp()
  process.exit(0)
}
if (has('--version') || has('-v')) {
  printVersion()
  process.exit(0)
}
// 自检模式：不管配置对不对都打印报告，方便排查；配置有问题就返回退出码 1
if (has('--check')) {
  const fine = preflightReport()
  process.exit(fine ? 0 : 1)
}

if (env.quiet) setLevel('warn')

// ---- 启动前检查 ----------------------------------------------------------
assertEnv()
ensureDirs()

if (!ENV_FILE_LOADED) {
  log.warn(`没找到 .env（${PATHS.ENV_FILE}），现在用的是系统环境变量或默认值`)
}
if (!env.noQQ && !env.accessToken) {
  log.warn('OB_ACCESS_TOKEN 是空的；NapCat 那边如果设了 Token，这里必须一模一样，否则连不上')
}
if (env.panelHost !== '127.0.0.1' && env.panelHost !== 'localhost') {
  log.warn(`PANEL_HOST 是 ${env.panelHost}，控制台会暴露到本机以外，建议改回 127.0.0.1`)
}

// ---- 开跑 ----------------------------------------------------------------
start()
startPanel()

const cfg = getConfig()
log.info(
  `已启动：thinking=${cfg.reply.thinking ? '开' : '关'}　temperature=${cfg.reply.temperature}　max_tokens=${cfg.reply.maxTokens}　触发=@/关键词/回复/随机插话`,
)
log.info(`提示：${cfg.reply.thinking ? PARAM_NOTE.thinking_on : PARAM_NOTE.thinking_off}`)

// ---- 优雅退出 ------------------------------------------------------------
let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return
    closing = true
    log.info('正在退出…')
    stop()
    setTimeout(() => process.exit(0), 300)
  })
}
process.on('unhandledRejection', (e) => log.error('未捕获的 Promise 异常：', e?.message || e))
process.on('uncaughtException', (e) => log.error('未捕获异常：', e?.stack || e?.message || e))

// 打包后的 exe 双击运行时，工作目录可能是 system32 之类的地方，
// 这里把关键路径打出来，出问题好排查
if (!env.quiet) {
  log.debug(`工作目录 ${process.cwd()}　程序目录 ${PATHS.ROOT}　exe ${process.execPath}`)
}
