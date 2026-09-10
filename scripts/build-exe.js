// ============================================================================
// 打包成单文件 exe（免安装 Node）
//
// 原理（Node 官方的 SEA：Single Executable Application）：
//   1. esbuild 把 src/ 下所有代码 + 依赖（ws/openai/dotenv）压成一个 CJS 文件
//   2. node --experimental-sea-config 把它做成一个「准备块」sea-prep.blob
//   3. 复制一份 node.exe，用 postject 把 blob 注入进去 → 得到一个自带运行时的 exe
//
// 注意：
//   - 不能打包成 32 位或跨平台，exe 的架构跟着本机 node 走
//   - 注入后代码签名会失效（日志里那句 "signature seems corrupted" 是正常的）
//   - NapCat 是独立的 QQ 注入程序，包不进这个 exe，它是单独一个进程
//
// 用法： npm run build:exe
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
const OUT_DIR = path.join(DIST, 'qqbot')
const BUNDLE = path.join(DIST, 'qqbot.cjs')
const BLOB = path.join(DIST, 'sea-prep.blob')
const EXE = path.join(OUT_DIR, 'qqbot.exe')
const SEA_CONFIG = path.join(DIST, 'sea-config.json')

// 这个 fuse 字符串是 Node 固定的，不能改
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const step = (n, msg) => console.log(`\n[${n}/5] ${msg}`)
const ok = (msg) => console.log(`      ✓ ${msg}`)

fs.mkdirSync(DIST, { recursive: true })

// ---------------------------------------------------------------------------
step(1, 'esbuild 打包源码')
{
  const r = await build({
    entryPoints: [path.join(ROOT, 'src', 'index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: BUNDLE,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    // 这些是 node 内置模块，不打进去
    external: ['node:*'],
    banner: { js: '/* qq-persona-bot · NapCat + DeepSeek 群聊机器人 · 打包产物 */' },
  })
  if (r.errors?.length) {
    console.error(r.errors)
    process.exit(1)
  }
  ok(`bundle: ${path.relative(ROOT, BUNDLE)}  ${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB`)
}

// ---------------------------------------------------------------------------
step(2, '生成 SEA 准备块')
{
  fs.writeFileSync(
    SEA_CONFIG,
    JSON.stringify(
      {
        main: path.relative(DIST, BUNDLE).replace(/\\/g, '/'),
        output: path.relative(DIST, BLOB).replace(/\\/g, '/'),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    ),
    'utf8',
  )
  const r = spawnSync(process.execPath, ['--experimental-sea-config', path.basename(SEA_CONFIG)], {
    cwd: DIST,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('生成 blob 失败')
    process.exit(1)
  }
  ok(`blob: ${(fs.statSync(BLOB).size / 1024).toFixed(0)} KB`)
}

// ---------------------------------------------------------------------------
step(3, '复制 node.exe 作为宿主')
{
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.copyFileSync(process.execPath, EXE)
  ok(`宿主: ${path.relative(ROOT, EXE)}  ${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB`)
}

// ---------------------------------------------------------------------------
step(4, '注入（postject）')
{
  const postjectCli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js')
  if (!fs.existsSync(postjectCli)) {
    console.error('找不到 postject，先执行： npm install')
    process.exit(1)
  }
  const r = spawnSync(
    process.execPath,
    [postjectCli, EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', SENTINEL, '--macho-segment-name', 'NODE_SEA'],
    { cwd: ROOT, stdio: 'inherit' },
  )
  if (r.status !== 0) {
    console.error('注入失败')
    process.exit(1)
  }
  ok(`exe: ${path.relative(ROOT, EXE)}  ${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB`)
}

// ---------------------------------------------------------------------------
step(5, '把运行需要的文件摆到 exe 旁边')
{
  // exe 运行时会找同目录下的这些文件（见 src/config.js 的 appDir/resolvePath）
  const copyIfExists = (from, to) => {
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, to)
      return true
    }
    return false
  }

  const copied = []
  if (copyIfExists(path.join(ROOT, 'persona.md'), path.join(OUT_DIR, 'persona.md'))) copied.push('persona.md')
  if (copyIfExists(path.join(ROOT, '.env.example'), path.join(OUT_DIR, '.env.example'))) copied.push('.env.example')
  if (copyIfExists(path.join(ROOT, '启动.bat'), path.join(OUT_DIR, '启动.bat'))) copied.push('启动.bat')
  if (copyIfExists(path.join(ROOT, '使用教程.md'), path.join(OUT_DIR, '使用教程.md'))) copied.push('使用教程.md')

  fs.mkdirSync(path.join(OUT_DIR, 'assets', 'images'), { recursive: true })
  fs.mkdirSync(path.join(OUT_DIR, 'data', 'tmp'), { recursive: true })
  copied.push('assets/images/', 'data/tmp/')

  ok(`一起放过去的：${copied.join('、')}`)
  console.log(`\n完成。产物目录：${path.relative(ROOT, OUT_DIR)}`)
  console.log('把整个 qqbot 文件夹拷给别人，双击 启动.bat 就能用（对方不用装 Node）。')
  console.log('注意：NapCat 要另外装（见 使用教程.md 第 2 步）。')
}
