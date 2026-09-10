import { env } from './config.js'

const PASSWORD_HINT = env.panelPassword ? '已从 .env 读取 PANEL_PASSWORD' : '未设置 PANEL_PASSWORD'

export const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QQ 群 BOT 控制台</title>
<style>
  :root{
    --bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --line:#2a2f3a;
    --fg:#e7eaf0; --dim:#9aa3b2; --accent:#4c8dff; --ok:#37c47f; --warn:#ffb020; --bad:#ff5f56;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif}
  header{position:sticky;top:0;z-index:10;display:flex;gap:14px;align-items:center;
    padding:10px 18px;background:rgba(15,17,21,.92);border-bottom:1px solid var(--line);backdrop-filter:blur(6px)}
  header b{font-size:16px}
  header .sp{flex:1}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#666;margin-right:6px}
  .dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  .dot.off{background:var(--bad)}
  .dot.wait{background:var(--warn)}
  main{max-width:1180px;margin:18px auto 60px;padding:0 16px;display:flex;flex-direction:column;gap:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
  .card h2{margin:0 0 12px;font-size:14px;color:var(--dim);font-weight:600;letter-spacing:1px}
  label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px}
  input,textarea,select{width:100%;background:var(--panel2);color:var(--fg);border:1px solid var(--line);
    border-radius:8px;padding:7px 9px;font:13px/1.5 inherit;outline:none}
  input:focus,textarea:focus,select:focus{border-color:var(--accent)}
  textarea{resize:vertical;min-height:80px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
  .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
  .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  button{background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:8px;
    padding:7px 14px;cursor:pointer;font:13px inherit}
  button:hover{border-color:var(--accent)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.danger{border-color:#5a2a2a;color:#ffb3ad}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px}
  .kv span:nth-child(odd){color:var(--dim)}
  .hint{font-size:12px;color:var(--dim);margin-top:8px;line-height:1.7}
  .warnbox{background:#2a2113;border:1px solid #5a4520;color:#ffd79a;border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:10px}
  .chat{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;min-height:52px}
  .chat.me{border-color:#2b3a55}
  .tag{display:inline-block;background:#2a2f3a;border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dim);margin:2px 6px 2px 0}
  .tag.bad{background:#3a1f1f;color:#ffb3ad}
  .tag.ok{background:#16301f;color:#8ff0bb}
  pre{background:#0c0e12;border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;
    max-height:280px;font:12px/1.6 Consolas,monospace;white-space:pre-wrap}
  #logs{height:300px;overflow:auto;background:#0c0e12;border:1px solid var(--line);border-radius:8px;
    padding:8px;font:12px/1.7 Consolas,monospace}
  #logs div{white-space:pre-wrap;word-break:break-all}
  .lv-warn{color:var(--warn)} .lv-error{color:var(--bad)} .lv-debug{color:#7b8494}
  #gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;max-height:320px;overflow:auto}
  .gitem{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#0c0e12}
  .gitem img{width:100%;height:82px;object-fit:cover;display:block}
  .gitem .nm{font-size:10px;color:var(--dim);padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .gitem button{position:absolute;top:3px;right:3px;padding:1px 6px;font-size:11px;background:#000a;border-color:#0000}
  .gitem.sel{outline:2px solid var(--accent)}
  .toast{position:fixed;right:18px;bottom:18px;background:#111;border:1px solid var(--line);
    border-radius:8px;padding:10px 14px;opacity:0;transition:.25s;pointer-events:none}
  .toast.show{opacity:1}
  .login{max-width:340px;margin:14vh auto}
  .muted{color:var(--dim)}
  .tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
  .tabs button.active{border-color:var(--accent);color:#fff}
</style>
</head>
<body>
<div id="login" class="login card" style="display:none">
  <h2>登录控制台</h2>
  <label>密码（.env 里的 PANEL_PASSWORD）</label>
  <input id="pw" type="password" placeholder="${PASSWORD_HINT}" />
  <div class="btns"><button class="primary" onclick="doLogin()">进入</button></div>
  <div class="hint" id="loginmsg"></div>
</div>

<div id="app" style="display:none">
<header>
  <b>QQ 群 BOT</b>
  <span><span id="wsdot" class="dot wait"></span><span id="wstext">连接中…</span></span>
  <span class="muted" id="hdr-model"></span>
  <span class="sp"></span>
  <button onclick="pingLLM()">测 DeepSeek</button>
  <button onclick="logout()">退出</button>
</header>

<main>
  <div class="grid">
    <div class="card">
      <h2>运行状态</h2>
      <div class="kv" id="statuskv"></div>
      <div class="hint" id="wsHint"></div>
    </div>

    <div class="card">
      <h2>思考模式（重点）</h2>
      <div class="warnbox" id="paramnote"></div>
      <label>thinking</label>
      <select id="cfg-thinking">
        <option value="0">关闭 —— temperature 生效，快（推荐群聊）</option>
        <option value="1">开启 —— 更聪明，但 temperature/top_p 失效、变慢</option>
      </select>
      <div class="row" style="margin-top:10px">
        <div><label>思考强度（仅开启时有效）</label>
          <select id="cfg-thinkingEffort"><option>low</option><option>high</option><option>max</option></select></div>
        <div><label>流式停顿超时 ms</label><input id="cfg-streamIdleTimeoutMs" type="number" step="500" /></div>
      </div>
      <div class="hint">改完点下面「保存配置」即时生效，不用重启。</div>
    </div>

    <div class="card">
      <h2>回复参数</h2>
      <div class="row3">
        <div><label>temperature</label><input id="cfg-temperature" type="number" step="0.05" min="0" max="2" /></div>
        <div><label>top_p</label><input id="cfg-topP" type="number" step="0.05" min="0" max="1" /></div>
        <div><label>max_tokens</label><input id="cfg-maxTokens" type="number" step="10" /></div>
      </div>
      <div class="row3">
        <div><label>回复冷却 秒</label><input id="cfg-cooldownSec" type="number" step="1" /></div>
        <div><label>命中后重写次数</label><input id="cfg-maxRegenerate" type="number" min="0" max="3" /></div>
        <div><label>每人每日上限</label><input id="cfg-perUserDailyLimit" type="number" step="10" /></div>
      </div>
      <div class="row">
        <div><label>去八股硬过滤</label><select id="cfg-hardFilter"><option value="1">开（命中就重写）</option><option value="0">关</option></select></div>
        <div><label>上下文条数</label><input id="cfg-historyLimit" type="number" step="1" /></div>
      </div>
    </div>

    <div class="card">
      <h2>触发设置</h2>
      <div class="row">
        <div><label>需要 @ 才回</label><select id="cfg-requireAt"><option value="1">是</option><option value="0">否</option></select></div>
        <div><label>被回复我的消息时接话</label><select id="cfg-replyToBot"><option value="1">是</option><option value="0">否</option></select></div>
      </div>
      <label>关键词（逗号分隔）</label>
      <input id="cfg-keywords" placeholder="小助手,bot,机器人" />
      <div class="row" style="margin-top:10px">
        <div><label>随机插话</label><select id="cfg-interjectEnabled"><option value="1">开</option><option value="0">关</option></select></div>
        <div><label>插话概率 %</label><input id="cfg-interjectChancePct" type="number" step="1" min="0" max="100" /></div>
      </div>
      <div class="row">
        <div><label>插话冷却 秒</label><input id="cfg-interjectCooldownSec" type="number" step="10" /></div>
        <div><label>开图库发图</label><select id="cfg-allowModelImage"><option value="1">开</option><option value="0">关</option></select></div>
      </div>
      <div class="row">
        <div><label>发图冷却 秒</label><input id="cfg-imageCooldownSec" type="number" step="10" /></div>
        <div><label>收图理解（多模态）</label><select id="cfg-visionEnabled"><option value="1">开</option><option value="0">关</option></select></div>
      </div>
      <div class="btns">
        <button class="primary" onclick="saveConfig()">保存配置</button>
        <button onclick="loadAll()">重新载入</button>
        <button class="danger" onclick="resetConfigAll()">恢复默认</button>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>人设 persona.md</h2>
    <div class="hint" style="margin:0 0 8px">保存后立即生效；直接改文件也会自动热加载。</div>
    <textarea id="persona" style="min-height:340px;font-family:Consolas,monospace"></textarea>
    <div class="btns">
      <button class="primary" onclick="savePersona()">保存人设</button>
      <button onclick="loadPersona()">重新载入</button>
      <button class="danger" onclick="resetPersonaAll()">恢复模板</button>
      <span class="muted" id="personalen"></span>
    </div>
  </div>

  <div class="card">
    <h2>试聊（走和群里完全一样的过滤链路，不会发到 QQ）</h2>
    <textarea id="testText" style="min-height:70px" placeholder="打一句话，比如：今天好累啊"></textarea>
    <div class="btns">
      <button class="primary" onclick="runTest()">发送测试</button>
      <button onclick="runTest(true)">强制开启 thinking 测一次</button>
      <button onclick="clearTestHistory()">清空试聊上下文</button>
    </div>
    <div id="testOut" style="margin-top:12px;display:flex;flex-direction:column;gap:8px"></div>
  </div>

  <div class="card">
    <h2>图库（assets/images）</h2>
    <div class="hint" id="gdir"></div>
    <div class="btns" style="margin-bottom:10px">
      <input id="upfile" type="file" accept="image/*" style="width:auto" />
      <button onclick="uploadImg()">上传</button>
      <button onclick="pickOne()">随机挑一张预览</button>
    </div>
    <div id="pickOut" class="hint"></div>
    <div id="gallery"></div>
  </div>

  <div class="card">
    <h2>实时日志</h2>
    <div class="btns" style="margin-bottom:8px">
      <button onclick="document.getElementById('logs').innerHTML=''">清屏</button>
      <label style="display:inline;margin:0"><input type="checkbox" id="autoscroll" checked style="width:auto" /> 自动滚动</label>
    </div>
    <div id="logs"></div>
  </div>
</main>
</div>

<div id="toast" class="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value;
const num = (id) => Number($(id).value);
const bool = (id) => $(id).value === '1';
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.style.borderColor = bad ? 'var(--bad)' : 'var(--line)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
async function api(path, opt) {
  const r = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opt));
  if (r.status === 401) { showLogin(); throw new Error('未登录'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}
function showLogin() { $('login').style.display = 'block'; $('app').style.display = 'none'; }
function showApp() { $('login').style.display = 'none'; $('app').style.display = 'block'; }
async function doLogin() {
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: val('pw') }) });
    showApp(); loadAll(); connectLogs();
  } catch (e) { $('loginmsg').textContent = e.message; }
}
async function logout() { try { await api('/api/logout'); } catch (e) {} showLogin(); }
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

const F = {
  thinking: ['cfg-thinking', (c) => (c.reply.thinking ? '1' : '0'), (v) => v === '1'],
  thinkingEffort: ['cfg-thinkingEffort', (c) => c.reply.thinkingEffort, (v) => v],
  streamIdleTimeoutMs: ['cfg-streamIdleTimeoutMs', (c) => c.session.streamIdleTimeoutMs, num],
  temperature: ['cfg-temperature', (c) => c.reply.temperature, num],
  topP: ['cfg-topP', (c) => c.reply.topP, num],
  maxTokens: ['cfg-maxTokens', (c) => c.reply.maxTokens, num],
  cooldownSec: ['cfg-cooldownSec', (c) => c.reply.cooldownSec, num],
  maxRegenerate: ['cfg-maxRegenerate', (c) => c.reply.maxRegenerate, num],
  perUserDailyLimit: ['cfg-perUserDailyLimit', (c) => c.reply.perUserDailyLimit, num],
  hardFilter: ['cfg-hardFilter', (c) => (c.filter.hardFilter ? '1' : '0'), (v) => v === '1'],
  historyLimit: ['cfg-historyLimit', (c) => c.session.historyLimit, num],
  requireAt: ['cfg-requireAt', (c) => (c.trigger.requireAt ? '1' : '0'), (v) => v === '1'],
  replyToBot: ['cfg-replyToBot', (c) => (c.trigger.replyToBot ? '1' : '0'), (v) => v === '1'],
  interjectEnabled: ['cfg-interjectEnabled', (c) => (c.trigger.interjectEnabled ? '1' : '0'), (v) => v === '1'],
  interjectChancePct: ['cfg-interjectChancePct', (c) => Math.round((c.trigger.interjectChance || 0) * 100), num],
  interjectCooldownSec: ['cfg-interjectCooldownSec', (c) => c.trigger.interjectCooldownSec, num],
  allowModelImage: ['cfg-allowModelImage', (c) => (c.send.allowModelImage ? '1' : '0'), (v) => v === '1'],
  imageCooldownSec: ['cfg-imageCooldownSec', (c) => c.send.imageCooldownSec, num],
  visionEnabled: ['cfg-visionEnabled', (c) => (c.vision.enabled ? '1' : '0'), (v) => v === '1'],
};
const PATHS = {
  thinking: ['reply', 'thinking'],
  thinkingEffort: ['reply', 'thinkingEffort'],
  streamIdleTimeoutMs: ['session', 'streamIdleTimeoutMs'],
  temperature: ['reply', 'temperature'],
  topP: ['reply', 'topP'],
  maxTokens: ['reply', 'maxTokens'],
  cooldownSec: ['reply', 'cooldownSec'],
  maxRegenerate: ['reply', 'maxRegenerate'],
  perUserDailyLimit: ['reply', 'perUserDailyLimit'],
  hardFilter: ['filter', 'hardFilter'],
  historyLimit: ['session', 'historyLimit'],
  requireAt: ['trigger', 'requireAt'],
  replyToBot: ['trigger', 'replyToBot'],
  interjectEnabled: ['trigger', 'interjectEnabled'],
  interjectChancePct: ['trigger', 'interjectChance'],
  interjectCooldownSec: ['trigger', 'interjectCooldownSec'],
  allowModelImage: ['send', 'allowModelImage'],
  imageCooldownSec: ['send', 'imageCooldownSec'],
  visionEnabled: ['vision', 'enabled'],
};

async function loadConfig() {
  const d = await api('/api/config');
  const c = d.config;
  for (const k of Object.keys(F)) {
    const [id, get] = F[k];
    const el = $(id);
    if (el) el.value = get(c);
  }
  $('cfg-keywords').value = (c.trigger.keywords || []).join(',');
  $('paramnote').textContent = c.reply.thinking ? d.note.thinking_on : d.note.thinking_off;
  $('hdr-model').textContent = '模型 ' + (c.reply.thinking ? 'thinking' : '非思考');
  return c;
}

async function saveConfig() {
  const patch = {};
  for (const k of Object.keys(F)) {
    const [id, , parse] = F[k];
    if (!$(id)) continue;
    const [a, b] = PATHS[k];
    patch[a] = patch[a] || {};
    patch[a][b] = k === 'interjectChancePct' ? num(id) / 100 : parse($(id).value);
  }
  patch.trigger.keywords = val('cfg-keywords').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  await loadConfig();
  toast('配置已保存并生效');
}
async function resetConfigAll() {
  if (!confirm('把所有控制台配置恢复默认？')) return;
  await api('/api/config/reset', { method: 'POST' });
  await loadConfig();
  toast('已恢复默认');
}
async function pingLLM() {
  toast('正在请求 DeepSeek…');
  try { const d = await api('/api/ping-llm', { method: 'POST' }); toast('DeepSeek 正常：' + d.text + '（' + d.cost + 'ms）'); }
  catch (e) { toast('失败：' + e.message, true); }
}

async function loadPersona() { const d = await api('/api/persona'); $('persona').value = d.text; $('personalen').textContent = d.text.length + ' 字 · ' + d.path; }
async function savePersona() { const d = await api('/api/persona', { method: 'POST', body: JSON.stringify({ text: val('persona') }) }); toast('人设已保存（' + d.length + ' 字）'); loadPersona(); }
async function resetPersonaAll() { if (!confirm('把人设恢复成模板？')) return; const d = await api('/api/persona/reset', { method: 'POST' }); $('persona').value = d.text; toast('已恢复模板'); }
async function clearTestHistory() { await api('/api/history', { method: 'POST', body: JSON.stringify({ peer: 'panel:test' }) }); toast('试聊上下文已清空'); }

const picked = new Set();
async function loadGallery() {
  const d = await api('/api/gallery');
  $('gdir').textContent = '目录：' + d.dir + '　共 ' + d.list.length + ' 张　发图冷却 ' + d.cooldownSec + 's';
  $('gallery').innerHTML = d.list.map((f) =>
    '<div class="gitem' + (picked.has(f.name) ? ' sel' : '') + '" onclick="togglePick(\\'' + f.name + '\\')">' +
    '<img src="/api/gallery/file/' + encodeURIComponent(f.name) + '" loading="lazy" />' +
    '<div class="nm">' + f.name + '</div>' +
    '<button onclick="event.stopPropagation();delImg(\\'' + f.name + '\\')">×</button></div>').join('')
    || '<div class="muted">还没有图，先把图片丢进 assets/images 或上面上传。</div>';
}
function togglePick(name) { picked.has(name) ? picked.delete(name) : picked.add(name); loadGallery(); toast('试聊带图：' + ([...picked].join(', ') || '无')); }
async function uploadImg() {
  const f = $('upfile').files[0];
  if (!f) return toast('先选一张图', true);
  const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
  try { await api('/api/gallery/upload', { method: 'POST', body: JSON.stringify({ name: f.name, base64: b64 }) }); toast('已加入图库'); loadGallery(); }
  catch (e) { toast(e.message, true); }
}
async function delImg(name) { if (!confirm('删除 ' + name + '？')) return; await api('/api/gallery/delete', { method: 'POST', body: JSON.stringify({ name }) }); picked.delete(name); loadGallery(); }
async function pickOne() {
  const d = await api('/api/gallery/pick?peer=panel:test', { method: 'POST' });
  $('pickOut').innerHTML = d.file ? '这次会发：<b>' + d.file + '</b> <img src="/api/gallery/file/' + encodeURIComponent(d.file) + '" style="height:60px;vertical-align:middle;border-radius:6px" />' : '图库是空的';
}

async function runTest(forceThinking) {
  const out = $('testOut');
  out.innerHTML = '<div class="muted">生成中…</div>';
  try {
    const d = await api('/api/test', { method: 'POST', body: JSON.stringify({ text: val('testText'), images: [...picked], thinking: forceThinking ? true : undefined }) });
    const tags = [];
    tags.push('<span class="tag">thinking ' + (d.params.thinking === 'disabled' ? 'off' : d.params.thinking) + '</span>');
    tags.push('<span class="tag">' + d.cost + 'ms</span>');
    if (d.params.temperature !== undefined) tags.push('<span class="tag">temp ' + d.params.temperature + '</span>');
    if (d.params.top_p !== undefined) tags.push('<span class="tag">top_p ' + d.params.top_p + '</span>');
    tags.push(d.would_send_image ? '<span class="tag bad">会发图</span>' : '<span class="tag ok">不发图</span>');
    if (d.filtered_out && d.filtered_out.length) tags.push('<span class="tag bad">命中规则：' + d.filtered_out.join(' / ') + '</span>');
    else tags.push('<span class="tag ok">无八股命中</span>');

    out.innerHTML =
      '<div class="chat me">' + esc(d.reply) + '</div>' +
      '<div>' + tags.join('') + '</div>' +
      (d.reasoning ? '<details><summary class="muted">思考过程（' + d.reasoning.length + ' 字）</summary><pre>' + esc(d.reasoning) + '</pre></details>' : '') +
      '<details><summary class="muted">模型原始输出</summary><pre>' + esc(d.raw) + '</pre></details>' +
      '<details><summary class="muted">发给模型的上下文</summary><pre>' + esc(d.context_preview) + '</pre></details>';
  } catch (e) {
    out.innerHTML = '<div class="chat" style="border-color:#5a2a2a">' + esc(e.message) + '</div>';
  }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

async function pollStatus() {
  try {
    const d = await api('/api/status');
    const dot = $('wsdot');
    dot.className = 'dot ' + (d.ws === 'online' ? 'on' : d.ws === 'idle' ? 'wait' : 'off');
    $('wstext').textContent = d.noQQ ? '未连 QQ（--no-qq）' : d.ws === 'online' ? '已连 NapCat' : d.ws === 'reconnecting' ? '重连中…' : '未连接';
    $('wsHint').textContent = d.noQQ ? '当前只跑控制台，看不了群消息。' : 'WS ' + d.wsUrl + (d.selfId ? '　登录号 ' + d.selfId : '');
    $('statuskv').innerHTML = [
      ['DeepSeek', d.model + (d.vision ? '（支持看图）' : '（收图理解已关）')],
      ['URL', d.baseUrl],
      ['图库', d.galleryCount + ' 张'],
      ['收到消息', d.stats.messages + ' 条'],
      ['发出回复', d.stats.replies + ' 条 / 图 ' + d.stats.images + ' 张'],
      ['过滤触发', d.stats.filtered + ' 次 / 重写 ' + d.stats.regenerated + ' 次'],
      ['错误', d.stats.errors + (d.stats.lastError ? '（' + d.stats.lastError + '）' : '')],
    ].map(([k, v]) => '<span>' + k + '</span><span>' + esc(v) + '</span>').join('');
    if (d.paramNote) $('paramnote').textContent = d.paramNote;
  } catch (e) { /* 未登录时忽略 */ }
}

function connectLogs() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    const line = JSON.parse(e.data);
    const box = $('logs');
    const div = document.createElement('div');
    div.className = 'lv-' + line.level;
    div.textContent = '[' + line.time + '] ' + line.msg;
    box.appendChild(div);
    while (box.childNodes.length > 500) box.removeChild(box.firstChild);
    if ($('autoscroll').checked) box.scrollTop = box.scrollHeight;
  };
}

async function loadAll() {
  await Promise.all([loadConfig(), loadPersona(), loadGallery()]);
  await pollStatus();
}
(async function init() {
  try { await api('/api/status'); showApp(); await loadAll(); connectLogs(); setInterval(pollStatus, 3000); }
  catch (e) { showLogin(); }
})();
</script>
</body>
</html>
`
