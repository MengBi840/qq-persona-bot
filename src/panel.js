// ============================================================================
// 本地 Web 控制台（HTTP + SSE）
//
// 只绑 127.0.0.1，外面访问不到。安全措施：
//   - 必须用 .env 里的 PANEL_PASSWORD 登录，登录后发一个 HttpOnly 的会话 Cookie
//   - 同一 IP 连错 5 次封 30 秒（防暴力猜密码）
//   - 所有 /api/* 都要求已登录
//
// 接口一览（都在 src/page.js 里被前端调用）：
//   POST /api/login          登录
//   GET  /api/status         运行状态、统计、参数说明
//   GET  /api/config         读配置（含默认值，方便对比）
//   POST /api/config         改配置（合并写入，立即生效）
//   POST /api/config/reset   恢复默认
//   GET  /api/persona        读人设
//   POST /api/persona        存人设（立即热加载）
//   POST /api/test           试聊：走完整 prompt + 过滤链路，但不发 QQ
//   GET  /api/gallery        图库列表
//   POST /api/gallery/upload 上传图片
//   POST /api/gallery/delete 删除图片
//   GET  /api/stream         实时日志（SSE）
//   POST /api/ping-llm       测 DeepSeek 连通性
// ============================================================================

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { env, getConfig, saveConfig, resetConfig, DEFAULTS, PARAM_NOTE } from './config.js'
import { log, tail, subscribe } from './logger.js'
import { PAGE } from './page.js'
import { loadPersona, savePersona, resetPersona, PERSONA_PATH } from './persona.js'
import { status, testReply, clearHistory, historySnapshot, stats } from './bot.js'
import {
  listGallery,
  saveGalleryImage,
  deleteGalleryImage,
  ensureImageDir,
  pickImage,
  canSendImage,
  lastImageAt,
} from './image.js'
import { ping } from './llm.js'

const sessions = new Set()
const loginFails = new Map()

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const buf = await readBody(req)
  if (!buf.length) return {}
  return JSON.parse(buf.toString('utf8'))
}

function json(res, code, data) {
  const body = JSON.stringify(data ?? {})
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function cookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function authed(req) {
  const sid = cookies(req).dshbot_sid
  return !!sid && sessions.has(sid)
}

export function startPanel() {
  ensureImageDir()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    const p = url.pathname

    try {
      if (p === '/favicon.ico') return res.writeHead(204).end()

      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(PAGE)
      }

      if (p === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress || 'x'
        const rec = loginFails.get(ip) || { n: 0, until: 0 }
        if (rec.until > Date.now()) return json(res, 429, { error: '试太多次了，等 30 秒' })
        const { password } = await readJson(req)
        if (String(password || '') !== env.panelPassword) {
          rec.n++
          if (rec.n >= 5) {
            rec.until = Date.now() + 30000
            rec.n = 0
          }
          loginFails.set(ip, rec)
          return json(res, 401, { error: '密码不对' })
        }
        const sid = crypto.randomBytes(24).toString('hex')
        sessions.add(sid)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': `dshbot_sid=${sid}; HttpOnly; SameSite=Strict; Path=/`,
        })
        log.info('控制台登录成功')
        return res.end(JSON.stringify({ ok: true }))
      }

      if (p === '/api/logout') {
        sessions.delete(cookies(req).dshbot_sid)
        res.writeHead(200, { 'set-cookie': 'dshbot_sid=; Max-Age=0; Path=/' })
        return res.end('{"ok":true}')
      }

      // 图库图片不需要登录也能看？不，仍然要登录
      if (p.startsWith('/api/gallery/file/')) {
        if (!authed(req)) return json(res, 401, { error: '未登录' })
        const name = path.basename(decodeURIComponent(p.slice('/api/gallery/file/'.length)))
        const file = path.join(env.imageDir, name)
        if (!fs.existsSync(file)) return json(res, 404, { error: '没有这张图' })
        const ext = path.extname(file).toLowerCase()
        const mime =
          ext === '.png'
            ? 'image/png'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.webp'
                ? 'image/webp'
                : 'image/jpeg'
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'max-age=60' })
        return fs.createReadStream(file).pipe(res)
      }

      if (p.startsWith('/api/')) {
        if (!authed(req)) return json(res, 401, { error: '未登录' })
        return await api(p, req, res, url)
      }

      json(res, 404, { error: 'not found' })
    } catch (e) {
      log.error(`控制台 ${p} 出错：`, e.message)
      json(res, 500, { error: e.message })
    }
  })

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log.error(`端口 ${env.panelPort} 被占用，改 .env 里的 PANEL_PORT`)
    } else {
      log.error('控制台启动失败：', e.message)
    }
  })

  // 只绑本机回环地址
  server.listen(env.panelPort, env.panelHost, () => {
    log.info(`本地控制台：http://${env.panelHost}:${env.panelPort}  （只绑本机，密码来自 PANEL_PASSWORD）`)
  })
  return server
}

async function api(p, req, res, url) {
  const method = req.method || 'GET'

  switch (p) {
    case '/api/status':
      return json(res, 200, status())

    case '/api/config':
      if (method === 'GET') return json(res, 200, { config: getConfig(), defaults: DEFAULTS, note: PARAM_NOTE })
      if (method === 'POST') {
        const patch = await readJson(req)
        const before = getConfig().reply.thinking
        const cfg = saveConfig(patch)
        if (before !== cfg.reply.thinking) log.info(`思考模式已切换为：${cfg.reply.thinking ? '开' : '关'}`)
        return json(res, 200, { ok: true, config: cfg })
      }
      break

    case '/api/config/reset':
      log.warn('配置已恢复默认')
      return json(res, 200, { ok: true, config: resetConfig() })

    case '/api/persona':
      if (method === 'GET') return json(res, 200, { text: loadPersona(), path: PERSONA_PATH })
      if (method === 'POST') {
        const { text } = await readJson(req)
        const saved = savePersona(text)
        log.info(`人设已保存（${saved.length} 字）`)
        return json(res, 200, { ok: true, length: saved.length })
      }
      break

    case '/api/persona/reset':
      resetPersona()
      log.warn('人设已恢复模板')
      return json(res, 200, { ok: true, text: loadPersona() })

    case '/api/test': {
      const body = await readJson(req)
      const images = []
      for (const name of body.images || []) {
        const f = path.join(env.imageDir, path.basename(String(name)))
        if (fs.existsSync(f)) images.push(f)
      }
      const r = await testReply({ text: body.text || '', images, thinking: body.thinking })
      return json(res, 200, r)
    }

    case '/api/history':
      if (method === 'POST') {
        const { peer } = await readJson(req)
        clearHistory(peer || undefined)
        return json(res, 200, { ok: true })
      }
      return json(res, 200, { list: historySnapshot(url.searchParams.get('peer')) })

    case '/api/gallery':
      if (method === 'GET')
        return json(res, 200, {
          dir: env.imageDir,
          list: listGallery(),
          cooldownSec: getConfig().send.imageCooldownSec,
        })
      break

    case '/api/gallery/upload': {
      const { name, base64 } = await readJson(req)
      const saved = saveGalleryImage(name, base64)
      log.info(`图库新增：${saved}`)
      return json(res, 200, { ok: true, name: saved, list: listGallery() })
    }

    case '/api/gallery/delete': {
      const { name } = await readJson(req)
      deleteGalleryImage(name)
      log.info(`图库删除：${name}`)
      return json(res, 200, { ok: true, list: listGallery() })
    }

    case '/api/gallery/pick': {
      const peer = url.searchParams.get('peer') || 'panel:test'
      const file = pickImage(peer, { force: true })
      return json(res, 200, { file: file ? path.basename(file) : null, nextAllowedIn: 0 })
    }

    case '/api/ping-llm': {
      const t0 = Date.now()
      const text = await ping()
      return json(res, 200, { ok: true, text, cost: Date.now() - t0 })
    }

    case '/api/logs':
      return json(res, 200, { list: tail(300) })

    case '/api/stream': {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const send = (line) => {
        try {
          res.write(`data: ${JSON.stringify(line)}\n\n`)
        } catch {
          /* 客户端断了 */
        }
      }
      for (const line of tail(120)) send(line)
      const un = subscribe(send)
      const hb = setInterval(() => {
        try {
          res.write(': hb\n\n')
        } catch {
          /* ignore */
        }
      }, 15000)
      req.on('close', () => {
        clearInterval(hb)
        un()
      })
      return
    }

    case '/api/stats':
      return json(res, 200, { stats: { ...stats }, lastImage: lastImageAt('panel:test'), canSend: canSendImage('panel:test') })
  }

  return json(res, 404, { error: `未知接口 ${p}` })
}
