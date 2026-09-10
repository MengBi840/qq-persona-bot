// ============================================================================
// 本地图库：随机发图 + 防刷屏
//
// 不做生图，就是「从你丢进 assets/images 的图里随机挑一张发」。
//
// 关键在「不刷屏」，三重限制：
//   1. 冷却：同一个群两次发图之间至少隔 imageCooldownSec 秒（默认 300）
//   2. 不重复：每个群记住最近发过哪些，挑图时优先挑没发过的
//   3. 洗牌袋：把候选图洗一遍随机取，取完再洗，避免「随机的总那几张」
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { env, getConfig } from './config.js'
import { log } from './logger.js'

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

/** 图库目录不存在就建一个，免得第一次用报错 */
export function ensureImageDir() {
  fs.mkdirSync(env.imageDir, { recursive: true })
  fs.mkdirSync(env.tmpDir, { recursive: true })
}

/** 列出图库里所有图片（给控制台用） */
export function listGallery() {
  ensureImageDir()
  let files = []
  try {
    files = fs.readdirSync(env.imageDir)
  } catch {
    return []
  }
  return files
    .filter((f) => IMG_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => {
      const p = path.join(env.imageDir, f)
      let size = 0
      try {
        size = fs.statSync(p).size
      } catch {
        /* ignore */
      }
      return { name: f, size }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 控制台上传图片（base64） */
export function saveGalleryImage(name, base64) {
  ensureImageDir()
  const ext = path.extname(name).toLowerCase()
  // 文件名里的非法字符换掉，避免路径穿越之类的问题
  const safeName =
    path.basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_') || `upload_${Date.now()}${ext || '.jpg'}`
  const finalName = IMG_EXT.has(ext) ? safeName : safeName + '.jpg'
  const buf = Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64')
  if (!buf.byteLength) throw new Error('空文件')
  fs.writeFileSync(path.join(env.imageDir, finalName), buf)
  return finalName
}

export function deleteGalleryImage(name) {
  const p = path.join(env.imageDir, path.basename(name))
  if (fs.existsSync(p)) fs.unlinkSync(p)
  return listGallery()
}

// ---------------------------------------------------------------------------
// 每个群（peerId）一套发图状态
// ---------------------------------------------------------------------------

/** 每个群最近发过的图，用来避开重复 */
const sentHistory = new Map()
/** 每个群最后一次发图时间，冷却用 */
const lastSentAt = new Map()
/** 洗牌袋：图库洗一遍放这儿，一张张取，取空了再洗 */
const rnd = new Map()

export function lastImageAt(key) {
  return lastSentAt.get(key) || 0
}

/** 冷却过了才允许发图 */
export function canSendImage(key) {
  const cfg = getConfig()
  if (!cfg.send.allowModelImage) return false
  const cd = (cfg.send.imageCooldownSec || 0) * 1000
  return Date.now() - lastImageAt(key) >= cd
}

/**
 * 挑一张图。
 * @param {string} key   群/会话标识，冷却和历史都按它分开记
 * @param {{force?:boolean}} opts force=true 时无视冷却（控制台预览用）
 * @returns {string|null} 绝对路径；冷却中或图库为空时返回 null
 */
export function pickImage(key = 'default', { force = false } = {}) {
  const cfg = getConfig()
  if (!force && !canSendImage(key)) return null

  const all = listGallery().map((f) => path.join(env.imageDir, f.name))
  if (!all.length) return null

  let bag = rnd.get(key)
  if (!bag || !bag.length) {
    // 优先放「最近没发过的」，实在不够就用全部
    const recent = new Set(sentHistory.get(key) || [])
    const fresh = all.filter((p) => !recent.has(p))
    bag = shuffle(fresh.length ? fresh : all)
    rnd.set(key, bag)
  }

  const picked = bag.pop()
  const hist = sentHistory.get(key) || []
  hist.push(picked)
  // 只记最近一部分，不然图库更新后老图永远进不了候选
  const keep = Math.max(3, Math.floor(all.length * 0.6))
  while (hist.length > keep) hist.shift()
  sentHistory.set(key, hist)
  lastSentAt.set(key, Date.now())
  log.debug(`图库挑图：${path.basename(picked)}（${key}）`)
  return picked
}

/** Fisher-Yates 洗牌 */
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

