const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const RING = 500
const ring = []
const subs = new Set()

let level = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info

export function setLevel(name) {
  level = LEVELS[name] ?? level
}

function ts() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function push(lv, args) {
  const msg = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : safe(a)))
    .join(' ')
  const line = { t: Date.now(), time: ts(), level: lv, msg }
  ring.push(line)
  if (ring.length > RING) ring.shift()
  for (const fn of subs) {
    try {
      fn(line)
    } catch {
      /* 忽略订阅者错误 */
    }
  }
  if (LEVELS[lv] >= level) {
    const out = lv === 'error' || lv === 'warn' ? console.error : console.log
    out(`[${line.time}] ${lv.toUpperCase().padEnd(5)} ${msg}`)
  }
}

function safe(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const log = {
  debug: (...a) => push('debug', a),
  info: (...a) => push('info', a),
  warn: (...a) => push('warn', a),
  error: (...a) => push('error', a),
}

export function tail(n = 200) {
  return ring.slice(-n)
}

export function subscribe(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}
