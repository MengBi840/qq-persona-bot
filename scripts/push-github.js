// ============================================================================
// 把项目上传到 GitHub（不需要装 git，直接走 REST API）
//
// 为什么要有这个脚本：构建机上没有 git，也没有 gh CLI。GitHub 的 REST API
// 足够完成「建仓库 + 提交内容」，所以这里用 fetch 直接推。
//
// 令牌从哪来（按顺序找）：
//   1. 环境变量 GITHUB_TOKEN
//   2. 项目上一级目录的 .gh_token 文件（一行纯文本）
// 令牌只会出现在请求头里，不会被打印、不会写进项目文件。
//
// 用法：
//   node scripts/push-github.js                # 用默认仓库名
//   node scripts/push-github.js --repo 我的名字 # 换个仓库名
//   node scripts/push-github.js --private      # 建私有仓库
//
// 重复运行是安全的：已存在的文件会被更新（内容没变就跳过），不会重复建仓库。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const argOf = (flag, def) => {
  const i = argv.indexOf(flag)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def
}
const REPO_NAME = argOf('--repo', 'qq-persona-bot')
const PRIVATE = argv.includes('--private')
const BRANCH = argOf('--branch', 'main')
const COMMIT_MSG = argOf('--message', 'feat: QQ 群人格 BOT（NapCat + OneBot v11 + DeepSeek）')

// 这些永远不上传（和 .gitignore 保持一致，再补几个）
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data', '__pycache__'])
const SKIP_FILES = new Set(['.env', 'config.json'])
const SKIP_EXT = new Set(['.log', '.zip', '.exe', '.blob'])

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const p = path.join(ROOT, '..', '.gh_token')
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim()
  throw new Error('找不到令牌：设环境变量 GITHUB_TOKEN，或把令牌放到 ' + p)
}

const TOKEN = readToken()
const API = 'https://api.github.com'

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qq-persona-bot-push',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { raw: text }
  }
  return { ok: res.ok, status: res.status, data }
}

/** 收集要上传的文件（相对路径 → 绝对路径），额外内容放 extra */
function collect(dir = ROOT, rel = '') {
  const out = new Map()
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      for (const [k, v] of collect(path.join(dir, entry.name), relPath)) out.set(k, v)
      continue
    }
    if (SKIP_FILES.has(entry.name)) continue
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue
    // 占位用的 .gitkeep 要留着（图库目录靠它存在）
    out.set(relPath, path.join(dir, entry.name))
  }
  return out
}

const step = (msg) => console.log(`\n${msg}`)

// ---------------------------------------------------------------------------
step('[1/4] 确认身份与仓库')
const me = await api('/user')
if (!me.ok) {
  console.error(`令牌不可用（HTTP ${me.status}）：${me.data?.message || ''}`)
  process.exit(1)
}
const owner = me.data.login
console.log(`      登录身份：${owner}（token 前 7 位 ${TOKEN.slice(0, 7)}…）`)

const full = `${owner}/${REPO_NAME}`
let repo = await api(`/repos/${full}`)
if (repo.ok) {
  console.log(`      仓库已存在，直接更新内容：${full}`)
} else if (repo.status === 404) {
  console.log(`      仓库不存在，创建${PRIVATE ? '私有' : '公开'}仓库 ${full}`)
  const created = await api('/user/repos', {
    method: 'POST',
    body: {
      name: REPO_NAME,
      private: PRIVATE,
      description:
        'QQ 群人格 BOT：NapCat(OneBot v11) + DeepSeek，口语短句、去八股、收图多模态、本地图库发图，只绑 127.0.0.1 的 Web 控制台，可打包成单文件 exe',
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    },
  })
  if (!created.ok) {
    console.error(`创建失败（HTTP ${created.status}）：${created.data?.message || ''}`)
    if (JSON.stringify(created.data).includes('scope')) console.error('  令牌缺少 repo 权限')
    process.exit(1)
  }
  repo = created
} else {
  console.error(`查询仓库失败（HTTP ${repo.status}）：${repo.data?.message || ''}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
step('[2/4] 收集要上传的文件')
const files = collect()
console.log(`      共 ${files.size} 个文件：`)
for (const rel of [...files.keys()].sort()) console.log(`        ${rel}`)

// ---------------------------------------------------------------------------
step('[3/4] 逐个提交')
let branchExists = false
let parentSha = null
{
  const r = await api(`/repos/${full}/git/ref/heads/${BRANCH}`)
  if (r.ok) {
    branchExists = true
    parentSha = r.data.object.sha
    console.log(`      ${BRANCH} 已存在，本次为增量提交`)
  } else {
    console.log(`      ${BRANCH} 还不存在，本次是首次提交`)
  }
}

let done = 0
let skipped = 0
const failed = []

for (const [rel, abs] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const content = fs.readFileSync(abs).toString('base64')

  // 内容没变就跳过（增量推送时省时间）
  if (branchExists) {
    const cur = await api(`/repos/${full}/contents/${encodeURI(rel)}?ref=${BRANCH}`)
    if (cur.ok && cur.data?.sha) {
      const same = await api(`/repos/${full}/git/blobs/${cur.data.sha}`)
      if (same.ok && same.data?.content?.replace(/\n/g, '') === content) {
        skipped++
        continue
      }
    }
  }

  const body = {
    message: `${COMMIT_MSG}\n\n${rel}`,
    content,
    branch: BRANCH,
  }
  // 已存在的文件必须带上它当前的 blob sha，否则 GitHub 会拒绝
  if (branchExists) {
    const cur = await api(`/repos/${full}/contents/${encodeURI(rel)}?ref=${BRANCH}`)
    if (cur.ok && cur.data?.sha) body.sha = cur.data.sha
  }

  let res = await api(`/repos/${full}/contents/${encodeURI(rel)}`, { method: 'PUT', body })

  // 父提交过期（并发/重跑）就刷新一次再试
  if (!res.ok && /does not match|not a fast forward|409|422/i.test(JSON.stringify(res.data))) {
    const r2 = await api(`/repos/${full}/git/ref/heads/${BRANCH}`)
    if (r2.ok) {
      const cur = await api(`/repos/${full}/contents/${encodeURI(rel)}?ref=${BRANCH}`)
      if (cur.ok && cur.data?.sha) body.sha = cur.data.sha
      res = await api(`/repos/${full}/contents/${encodeURI(rel)}`, { method: 'PUT', body })
    }
  }

  if (res.ok) {
    done++
    branchExists = true
    console.log(`      ✓ ${rel}`)
  } else {
    failed.push(rel)
    console.error(`      ✗ ${rel}  HTTP ${res.status} ${res.data?.message || ''}`)
  }
}

// ---------------------------------------------------------------------------
step('[4/4] 结果')
console.log(`      提交 ${done} 个，跳过（内容相同）${skipped} 个，失败 ${failed.length} 个`)
if (failed.length) {
  console.error('      失败清单：')
  for (const f of failed) console.error(`        ${f}`)
  process.exit(1)
}
console.log(`\n仓库地址：${repo.data.html_url || `https://github.com/${full}`}`)
