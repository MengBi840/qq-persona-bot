// ============================================================================
// OneBot v11 客户端（连 NapCat）
//
// 这个文件负责「和 QQ 说话」，不理解任何业务逻辑。要做三件事：
//
// 1) 【长连接】用 WebSocket 连 NapCat 的「正向 WebSocket 服务器」（默认 127.0.0.1:3001）。
//    Token 是 NapCat 那边设的密码，走 Authorization: Bearer 头带过去。
//    断线自动重连，退避 1s→2s→5s→10s→20s→30s。
//
// 2) 【收消息】NapCat 推过来的报文长这样：
//      { post_type: 'message', message_type: 'group', group_id, user_id, sender, message: [...] }
//    其中 message 是「消息段数组」（消息格式要设成 array），例如：
//      [ { type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: '你好' } } ]
//    我们把它转成 'qq-message' 事件抛出去，交给 bot.js 处理。
//
// 3) 【发消息 / 调接口】OneBot 的每个接口调用都要带一个唯一的 echo 字段，
//    NapCat 回复时会原样带回来。所以这里维护一张 echo → Promise 的表，
//    收到带 echo 的回包就把对应的 Promise resolve/reject。
//    这就是下面那个 pending Map 的作用，别忘了它。
//
// 常用接口：
//   get_login_info        拿自己账号（判断有没有被 @ 需要它）
//   send_group_msg        发群消息
//   send_private_msg      发私聊消息
//   get_image             让 NapCat 把收到的图落到本地文件
// ============================================================================

import WebSocket from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { log } from './logger.js'
import { env } from './config.js'

// 重连退避表：第 n 次断线等 BACKOFF[n] 毫秒，最后固定 30 秒
const BACKOFF = [1000, 2000, 5000, 10000, 20000, 30000]

export class OneBot extends WebSocket {
  /**
   * @param {string} url   形如 ws://127.0.0.1:3001
   * @param {string} token 和 NapCat 里填的一模一样
   */
  constructor(url, token) {
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    super(url, { headers, handshakeTimeout: 10000 })

    // 注意：ws 的 WebSocket 上 url 是只读 getter，不能写 this.url，否则启动直接 TypeError
    this.wsUrl = url
    this.token = token
    this.seq = 0 // echo 自增号
    /** @type {Map<string, {resolve:Function, reject:Function, timer:any}>} 等待回包的请求 */
    this.pending = new Map()
    this.selfId = null // 自己账号，get_login_info 之后才有
    this.status = 'connecting' // connecting | online | reconnecting | offline
    this.attempt = 0
    this.manualClose = false
    this.api = new Api(this)
    this.stats = { rx: 0, tx: 0, calls: 0, errors: 0, lastHeartbeat: 0 }

    this.on('open', () => {
      this.attempt = 0
      this.status = 'online'
      log.info('OneBot 已连上 NapCat：', url)
      // 连上就先问自己是谁（@ 判定要用 selfId）
      this.api.getLoginInfo().catch(() => {})
    })

    this.on('message', (raw) => {
      let p
      try {
        p = JSON.parse(raw.toString())
      } catch {
        return log.warn('收到非 JSON 报文，已忽略')
      }
      this.stats.rx++

      // 心跳包：只记时间，不当消息处理
      if (p.post_type === 'meta_event' && p.meta_event_type === 'heartbeat') {
        this.stats.lastHeartbeat = Date.now()
        return
      }

      // 带 echo 的是我们主动调接口的回包
      if (p.echo !== undefined) {
        const key = String(p.echo)
        const pnd = this.pending.get(key)
        if (pnd) {
          this.pending.delete(key)
          clearTimeout(pnd.timer)
          if (p.status === 'failed' || p.retcode !== 0) {
            pnd.reject(new Error(`API 失败 retcode=${p.retcode} ${p.message || p.wording || ''}`))
          } else {
            pnd.resolve(p.data)
          }
        }
        return
      }

      // 真正的业务事件
      if (p.post_type === 'message') this.emit('qq-message', p)
      else if (p.post_type === 'notice') this.emit('qq-notice', p)
    })

    this.on('error', (e) => {
      this.stats.errors++
      log.warn('OneBot 连接错误：', e.message)
    })

    this.on('close', (code) => {
      this.status = 'offline'
      // 断线时把所有等回包的请求都拒掉，不然它们会一直挂着
      for (const pnd of this.pending.values()) {
        clearTimeout(pnd.timer)
        pnd.reject(new Error('连接已断开'))
      }
      this.pending.clear()
      if (this.manualClose) return log.info('OneBot 连接已手动关闭')

      const wait = BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]
      this.status = 'reconnecting'
      log.warn(`OneBot 断开(code=${code})，${wait / 1000}s 后重连… 检查 NapCat 是否启动、Token 是否一致`)
      setTimeout(() => {
        if (!this.manualClose) this.reconnect()
      }, wait)
    })
  }

  /**
   * 调一个 OneBot 接口。
   * @param {string} action 接口名，如 send_group_msg
   * @param {object} params 参数
   * @param {number} timeoutMs 超时，默认 15 秒
   */
  call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.readyState !== WebSocket.OPEN) return reject(new Error('未连接到 NapCat，无法调用 ' + action))
      const echo = `e${++this.seq}_${Date.now()}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`调用 ${action} 超时`))
      }, timeoutMs)
      // 超时/回包都会走到这里清理
      this.pending.set(echo, { resolve, reject, timer })
      this.stats.tx++
      this.stats.calls++
      this.send(JSON.stringify({ action, params, echo }))
    })
  }

  /** 主动关闭（不再自动重连） */
  close() {
    this.manualClose = true
    try {
      super.close()
    } catch {
      /* ignore */
    }
  }
}

/** 接口的语义化封装，外面用这个，不用记 action 名字 */
class Api {
  constructor(ob) {
    this.ob = ob
  }

  async getLoginInfo() {
    const d = await this.ob.call('get_login_info')
    this.ob.selfId = d?.user_id ?? null
    log.info(`登录账号：${d?.nickname || '?'} (${d?.user_id})`)
    return d
  }

  sendGroupMsg(groupId, message) {
    return this.ob.call('send_group_msg', { group_id: Number(groupId), message }, 20000)
  }

  sendPrivateMsg(userId, message) {
    return this.ob.call('send_private_msg', { user_id: Number(userId), message }, 20000)
  }

  /** 按事件来源自动选群聊/私聊 */
  async sendTo(ev, message) {
    if (ev.message_type === 'group') return this.sendGroupMsg(ev.group_id, message)
    return this.sendPrivateMsg(ev.user_id, message)
  }

  async getGroupMemberInfo(groupId, userId) {
    try {
      return await this.ob.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: false,
      })
    } catch {
      return null
    }
  }

  async getGroupInfo(groupId) {
    try {
      return await this.ob.call('get_group_info', { group_id: Number(groupId) })
    } catch {
      return null
    }
  }

  /** NapCat 的 get_image 会返回本地缓存文件；失败就退回自己下载 URL */
  async fetchImageFile(file, url) {
    if (file && fs.existsSync(file)) return file
    try {
      const d = await this.ob.call('get_image', { file }, 15000)
      if (d?.file && fs.existsSync(d.file)) return d.file
    } catch (e) {
      log.debug('get_image 失败，改用下载：', e.message)
    }
    if (url) {
      const p = await downloadImage(url)
      if (p) return p
    }
    return null
  }
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

/**
 * 把网上的图片下载到临时目录。
 * 为什么不让模型直接看图链？因为 QQ 的图片直链经常带鉴权参数、还会过期，
 * DeepSeek 那边不一定拉得到，所以统一先落到本地再内联成 base64。
 */
export async function downloadImage(url, { maxMB = 8, timeoutMs = 15000 } = {}) {
  if (typeof fetch !== 'function') throw new Error('Node 版本过低，需要 Node 18+ 才有 fetch')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim()
    const ext = EXT_BY_MIME[mime] || '.jpg'
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0) throw new Error('空文件')
    if (buf.byteLength > maxMB * 1024 * 1024) throw new Error(`超过 ${maxMB}MB`)
    fs.mkdirSync(env.tmpDir, { recursive: true })
    const p = path.join(env.tmpDir, `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`)
    fs.writeFileSync(p, buf)
    return p
  } catch (e) {
    log.warn(`下载图片失败：${e.message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 本地文件 → data URL，给多模态请求用 */
export function toDataUrl(file) {
  const ext = path.extname(file).toLowerCase()
  const mime =
    ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

/**
 * 本地文件 → file:// 形式。
 * NapCat 收 file:// 时读的是「NapCat 所在机器」的路径；本机跑所以没问题，
 * 如果以后 NapCat 跑到别的机器上，这里要改成 base64 上传。
 */
export function fileUri(file) {
  return 'file:///' + path.resolve(file).replace(/\\/g, '/')
}
