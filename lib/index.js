// 虚拟机控制（纯 adb）：面板里填 adb 端口，插件直接 adb 驱动 AndVM 虚拟机。
//
// 不再需要装在虚拟机里的 App。链路：
//   [插件] --adb (fork-server 127.0.0.1:5037)--> 127.0.0.1:<面板里填的端口> --> guest adbd
//
// 端口每次重启 AndVM 都会变：看 AndVM → 调试 → 「本机地址 127.0.0.1:NNNNN」，填进面板点「连接并保存」。
// 所有操作都走 `adb -s 127.0.0.1:PORT shell ...`，虚拟机里有 Magisk，`su -c` 就是 root。
//
// 截图例外：虚拟机里 gralloc mapper 缺失，screencap 一律 Aborted（root 也一样）。
// 所以截图靠一个小 App（Shot，插件目录里自带 Shot.apk）用无障碍 takeScreenshot() 出图，
// 触发方式是广播 `am broadcast -a com.dsh.shot.SHOT -p com.dsh.shot`。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'

export const name = 'local-vmbridge'

// cordis 靠这个数组把服务注入进 apply 的 ctx；不写就拿不到 ctx.tools
export const inject = ['tools']

const DIR = process.env.VMBRIDGE_DIR || '/root/.dsh/dsh-go/plugins/local-vmbridge'
const STATE = path.join(DIR, '.state.json')
const ADB = process.env.ADB_BIN || 'adb'

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch {}
}

const _st = loadState()
let serial = _st.serial || ''   // 例如 127.0.0.1:56103

// ---------------------------------------------------------------- adb

function adbEnv() {
  const e = { ...process.env, ADB_MDNS: '0' }
  if (!e.HOME) e.HOME = '/root'
  if (!e.ANDROID_SDK_ROOT && !e.ANDROID_HOME) e.ANDROID_SDK_ROOT = '/root/android-sdk'
  return e
}

/** 同步跑 adb，永不抛 */
function adb(args, timeoutSec = 30) {
  try {
    const out = execFileSync(ADB, args, {
      timeout: timeoutSec * 1000, encoding: 'utf8', env: adbEnv(),
      maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out: String(out || ''), code: 0 }
  } catch (e) {
    return {
      ok: false,
      out: String((e && e.stdout) || ''),
      err: String((e && e.stderr) || (e && e.message) || e),
      code: e && typeof e.status === 'number' ? e.status : -1,
    }
  }
}

function adbAsync(args, timeoutSec = 60) {
  return new Promise((res) => {
    execFile(ADB, args, {
      timeout: timeoutSec * 1000, encoding: 'utf8', env: adbEnv(),
      maxBuffer: 64 * 1024 * 1024,
    }, (e, stdout, stderr) => res({
      ok: !e,
      out: String(stdout || ''),
      err: String(stderr || (e && e.message) || ''),
      code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
    }))
  })
}

function devicesAny() {
  const r = adb(['devices'])
  const list = []
  for (const line of String(r.out || '').split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)$/)
    if (m) list.push({ serial: m[1], state: m[2] })
  }
  return list
}

/** 确保 serial 可用；不可用就试着连一次 */
async function ensure() {
  if (!serial) {
    const dev = devicesAny().find((d) => d.state === 'device')
    if (dev) { serial = dev.serial; saveState({ ...loadState(), serial }) }
  }
  if (!serial) throw new Error('还没设置 adb 端口。面板里填 AndVM → 调试 → 本机地址的端口（例如 56103），点「连接并保存」。')
  const cur = devicesAny().find((d) => d.serial === serial)
  if (cur && cur.state === 'device') return serial
  adb(['connect', serial], 15)
  await new Promise((r) => setTimeout(r, 1200))
  const again = devicesAny().find((d) => d.serial === serial)
  if (again && again.state === 'device') return serial
  if (again && again.state === 'unauthorized') {
    throw new Error(`${serial} 还没授权：在 AndVM 的画面里点「允许 USB 调试」（勾一律允许）`)
  }
  if (again && again.state === 'offline') {
    adb(['disconnect', serial], 8)
    await new Promise((r) => setTimeout(r, 400))
    adb(['connect', serial], 15)
    await new Promise((r) => setTimeout(r, 1500))
    const third = devicesAny().find((d) => d.serial === serial)
    if (third && third.state === 'device') return serial
    throw new Error(`${serial} 是 offline：AndVM 里把「启用 ADB」关掉再开，端口可能变，重填一次`)
  }
  throw new Error(`连不上 ${serial}：检查 AndVM → 调试 → 本机地址的端口是否变了`)
}

try { fs.mkdirSync(path.join(os.tmpdir(), 'vmbridge'), { recursive: true }) } catch {}

// ---------------------------------------------------------------- shell

function quote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

async function shellOf(sh, timeoutSec = 60) {
  const s = await ensure()
  const r = await adbAsync(['-s', s, 'shell', sh], timeoutSec)
  return { out: r.out, err: r.err, code: r.ok ? 0 : (r.code || 1), su: false }
}

/** 用 root 跑（Magisk）；su 不通就退回普通 shell */
async function root(sh, timeoutSec = 60) {
  const s = await ensure()
  const r = await adbAsync(['-s', s, 'shell', `su -c ${quote(sh)}`], timeoutSec)
  const all = (r.out || '') + (r.err || '')
  if (r.ok || !/inaccessible|not found|Permission denied|su: /i.test(all)) {
    return { out: r.out, err: r.err, code: r.ok ? 0 : (r.code || 1), su: true }
  }
  const p = await adbAsync(['-s', s, 'shell', sh], timeoutSec)
  return { out: p.out, err: p.err, code: p.ok ? 0 : (p.code || 1), su: false }
}

/** 扫本机 32768-60999，找正在听 TCP 的端口，逐个试 adb connect */
async function scanAdb() {
  const net = await import('node:net')
  const probe = (port, ms = 60) => new Promise((res) => {
    const sock = new net.Socket()
    let done = false
    const fin = (ok) => { if (done) return; done = true; sock.destroy(); res(ok) }
    sock.setTimeout(ms)
    sock.once('connect', () => fin(true))
    sock.once('timeout', () => fin(false))
    sock.once('error', () => fin(false))
    sock.connect(port, '127.0.0.1')
  })
  const ports = []
  for (let p = 32768; p <= 60999; p++) ports.push(p)
  let i = 0
  const listening = []
  await Promise.all(Array.from({ length: 1000 }, async () => {
    while (i < ports.length) {
      const p = ports[i++]
      if (await probe(p)) listening.push(p)
    }
  }))
  const hits = []
  for (const p of listening) {
    const addr = `127.0.0.1:${p}`
    if (devicesAny().some((d) => d.serial === addr && d.state === 'device')) { hits.push(addr); continue }
    const c = adb(['connect', addr], 8)
    if (/connected to/i.test(String(c.out || '') + String(c.err || ''))) hits.push(addr)
    else adb(['disconnect', addr], 4)
  }
  const withDevice = hits.filter((a) => {
    const d = devicesAny().find((x) => x.serial === a)
    return d && d.state !== 'absent'
  })
  return withDevice.length ? withDevice : hits
}

// ---------------------------------------------------------------- 截图（Shot App）

// 虚拟机里 gralloc mapper 缺失，shell/root 的 screencap 一律 Aborted。
// 只能让装好的 Shot App 用 AccessibilityService.takeScreenshot() 出图：
//   am broadcast -a com.dsh.shot.SHOT -p com.dsh.shot --es path <私有目录>/shot.png
// 截完它写私有目录（/data/local/tmp 对 app 是不可写的），root 再 cp 到 /data/local/tmp 供 pull。
const SHOT_PKG = 'com.dsh.shot'
const SHOT_SVC = 'com.dsh.shot/com.dsh.shot.ShotService'
const SHOT_PRIV = '/data/user/0/com.dsh.shot/files/shot.png'

let shotReady = null   // null=未知 true=可用 false=不可用

const SHOT_APK = path.join(DIR, 'Shot.apk')

/** 装上 Shot（插件目录里带了一份） */
async function installShot() {
  if (!fs.existsSync(SHOT_APK)) return { ok: false, err: '插件目录里没有 Shot.apk' }
  const s = await ensure()
  const remote = '/data/local/tmp/Shot.apk'
  const push = await adbAsync(['-s', s, 'push', SHOT_APK, remote], 120)
  if (!push.ok) return { ok: false, err: 'push 失败 ' + (push.err || '') }
  const r = await root(`pm install -r -g ${remote}`, 180)
  const all = ((r.out || '') + (r.err || '')).trim()
  return { ok: /Success/.test(all), out: all }
}

/** 确认 Shot 装好且无障碍已连上；缺了自动装、没连上自动启用 */
async function ensureShot(force = false) {
  if (!force && shotReady === true) return true
  const p = await root(`pm list packages ${SHOT_PKG}`, 30)
  if (!String(p.out || '').includes(SHOT_PKG)) {
    const ins = await installShot()
    if (!ins.ok) { shotReady = false; return false }
    await new Promise((r) => setTimeout(r, 1500))
  }
  const d = await root('dumpsys accessibility | grep -A2 "Bound services"', 30)
  const bound = String(d.out || '')
  if (!bound.includes(SHOT_PKG)) {
    await root(`settings put secure enabled_accessibility_services ${SHOT_SVC}; `
      + 'settings put secure accessibility_enabled 1', 30)
    await new Promise((r) => setTimeout(r, 2500))
    const d2 = await root('dumpsys accessibility | grep -A2 "Bound services"', 30)
    if (!String(d2.out || '').includes(SHOT_PKG)) { shotReady = false; return false }
  }
  shotReady = true
  return true
}

/** 让 Shot 截一张，返回 { ok, size, ms, err } */
async function takeShot(timeoutMs = 25000) {
  const ok = await ensureShot()
  if (!ok) return { ok: false, err: 'Shot App 没装或无障碍没启用（vm_shell 里装 Shot.apk 并开无障碍）' }
  await root(`rm -f ${SHOT_PRIV}`, 20)
  const t0 = Date.now()
  await root(`am broadcast -a com.dsh.shot.SHOT -p ${SHOT_PKG} --es path ${SHOT_PRIV}`, 30)
  let size = 0
  while (Date.now() - t0 < timeoutMs) {
    const r = await root(`stat -c %s ${SHOT_PRIV} 2>/dev/null`, 15)
    const n = parseInt(String(r.out || '').trim(), 10)
    if (n > 1000) { size = n; break }
    await new Promise((r2) => setTimeout(r2, 250))
  }
  if (!size) return { ok: false, ms: Date.now() - t0, err: '等不到截图（Shot 的无障碍可能被系统回收了）' }
  return { ok: true, size, ms: Date.now() - t0 }
}

// ---------------------------------------------------------------- 屏幕

let lastScreenW = 0
let lastScreenH = 0
let lastNodes = []

function unesc(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function currentFocus() {
  const r = adb(['-s', serial, 'shell',
    'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"'], 20)
  const t = String(r.out || '')
  const m = t.match(/mCurrentFocus=Window\{[0-9a-f]+ u\d+ ([\w.]+)\/([\w.$]+)/)
  return { raw: t.trim(), pkg: m ? m[1] : '', activity: m ? m[2] : '' }
}

/** 读 UI 树：uiautomator dump（root 跑最稳） */
function dumpUi(limit = 150) {
  const remote = '/data/local/tmp/vm-ui.xml'
  let xml = ''
  const tries = [
    `su -c 'uiautomator dump ${remote} >/dev/null 2>&1; cat ${remote}'`,
    `uiautomator dump ${remote} >/dev/null 2>&1; cat ${remote}`,
  ]
  for (const cmd of tries) {
    const r = adb(['-s', serial, 'shell', cmd], 45)
    xml = String(r.out || '')
    if (xml.includes('<hierarchy')) break
  }
  if (!xml.includes('<hierarchy')) return { nodes: [], via: 'none', w: lastScreenW, h: lastScreenH }
  const nodes = []
  const re = /<node\b([^>]*)\/?>/g
  let m
  while ((m = re.exec(xml)) && nodes.length < limit) {
    const a = m[1]
    const get = (k) => {
      const mm = a.match(new RegExp(k + '="([^"]*)"'))
      return mm ? mm[1] : ''
    }
    const text = unesc(get('text'))
    const desc = unesc(get('content-desc'))
    const cls = get('class')
    const id = get('resource-id')
    const clickable = get('clickable') === 'true'
    if (!text && !desc && !clickable && !id) continue
    nodes.push({
      text, desc, id: id.split('/').pop(), cls: cls.split('.').pop(),
      bounds: get('bounds'), clickable,
      enabled: get('enabled') !== 'false',
    })
  }
  // 从所有 bounds 推屏幕尺寸
  let w = 0, h = 0
  const bre = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g
  let b
  while ((b = bre.exec(xml))) {
    w = Math.max(w, +b[3]); h = Math.max(h, +b[4])
  }
  if (w) { lastScreenW = w; lastScreenH = h }
  return { nodes, via: 'uiautomator', w: lastScreenW, h: lastScreenH }
}

function fmtNode(n, i) {
  const label = (n.text || n.desc || '').replace(/\s+/g, ' ').trim()
  const parts = [`[${i}]`]
  if (label) parts.push(label.length > 24 ? label.slice(0, 24) + '…' : label)
  else if (n.id) parts.push(`#${n.id}`)
  else parts.push(n.cls || '?')
  if (n.clickable) parts.push('可点')
  const m = String(n.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
  if (m) parts.push(`@${Math.round((+m[1] + +m[3]) / 2)},${Math.round((+m[2] + +m[4]) / 2)}`)
  return parts.join(' ')
}

function renderScreen(ui, cur) {
  const nodes = (ui && ui.nodes) || []
  const lines = []
  const dim = ui && ui.w ? `${ui.w}x${ui.h}` : ''
  lines.push(`屏幕${dim ? ' ' + dim : ''}${cur && cur.pkg ? '  ' + cur.pkg + '/' + cur.activity : ''}（via ${(ui && ui.via) || '?'}）`)
  let n = 0
  const kept = []
  for (const node of nodes) {
    lines.push(fmtNode(node, ++n))
    kept.push(node)
  }
  lastNodes = kept
  if (!n) lines.push('（这一屏没有可读元素）')
  return lines.join('\n')
}

async function afterAction(extra) {
  try {
    const ui = dumpUi(150)
    const cur = currentFocus()
    return { ...extra, screen: renderScreen(ui, cur) }
  } catch (e) {
    return { ...extra, screen_note: `读屏失败: ${(e && e.message) || e}` }
  }
}

// ---------------------------------------------------------------- 工具

const objSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    out: { type: 'string' },
    err: { type: 'string' },
    screen: { type: 'string' },
    error: { type: 'string' },
  },
  additionalProperties: true,
}

function render(args, v) {
  const parts = []
  if (v && v.screen) parts.push(String(v.screen))
  if (v && v.screen_note) parts.push('⚠ ' + v.screen_note)
  if (v && v.error) parts.push('✗ ' + v.error)
  for (const k of ['out', 'err', 'detail', 'file', 'apps', 'hint', 'note', 'guest_hint', 'launched', 'raw']) {
    const x = v && v[k]
    if (x === undefined || x === null || x === '') continue
    parts.push(typeof x === 'string' ? x : JSON.stringify(x, null, 1))
  }
  if (!parts.length) parts.push(JSON.stringify(v, null, 1))
  return [{ type: 'text', text: parts.join('\n').slice(0, 8000) }]
}

const dbgFile = '/tmp/vmbridge-boot.log'
function dbg(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try { fs.appendFileSync(dbgFile, line) } catch {}
}

function makeTools(ctx, defineTool) {
  const reg = (t) => { ctx.tools.register(t) }

  reg(defineTool({
    name: 'vm_status',
    description: '查看虚拟机 adb 状态：当前端口、device/offline/unauthorized、guest 系统版本、su root 有没有。第一次用 vm_* 前先调它。',
    parameters: {},
    output: { schema: objSchema, render },
    timeoutMs: 60000,
    execute: async () => {
      const dev = devicesAny()
      let ver = null, rootOk = null, err = null
      try {
        await ensure()
        ver = adb(['-s', serial, 'shell', 'getprop ro.build.version.release'], 15).out.trim()
        rootOk = /uid=0/.test(adb(['-s', serial, 'shell', 'su -c id'], 15).out || '')
      } catch (e) { err = e.message }
      const out = {
        ok: !err, serial: serial || '', root: rootOk, release: ver || '',
        devices: dev,
        hint: err
          ? '面板里填 AndVM → 调试 → 「本机地址」的端口（每次重启都会变），点「连接并保存」再试。'
          : (rootOk
            ? '可以直接用 vm_shell / vm_screenshot / vm_tap 了。'
            : 'adb 通了但 su 没拿到 root —— 去 Magisk 里给 shell 授权。'),
      }
      if (err) out.error = String(err)
      return out
    },
  }))

  reg(defineTool({
    name: 'vm_connect_adb',
    description: '填虚拟机的 adb 地址并连上（AI 用这个设置 adb 接口）。地址看 AndVM → 调试 → 「本机地址 127.0.0.1:NNNNN」，端口每次重启都变。可以只给端口；也可以给了 host/port 两个字段；不给地址则自动扫描。',
    parameters: {
      addr: { type: 'string', description: 'HOST:PORT 或只写 PORT，例如 127.0.0.1:56103 或 56103' },
      host: { type: 'string', description: '主机，默认 127.0.0.1' },
      port: { type: 'number', description: '端口（和 addr 二选一）' },
      scan: { type: 'boolean', description: '扫描 32768-60999 找出正在听 adb 的端口（约 60 秒）' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 180000,
    execute: async (a) => {
      // 1) 没给地址也没给端口 → 先看现有设备，再按需扫
      let raw = String(a.addr || '').trim()
      if (!raw && a.port) raw = `${a.host || '127.0.0.1'}:${a.port}`
      if (!raw && a.host && !a.port) raw = String(a.host).trim()

      if (!raw || a.scan) {
        const found = await scanAdb()
        if (!found.length) {
          return {
            ok: false, scanned: true,
            error: '扫 32768-60999 没找到在听的 adb 端口',
            hint: '确认 AndVM 里这台虚拟机在跑、配置 → 调试 → 「启用 ADB」开着；然后从 AndVM 调试页抄「本机地址」填进来。',
          }
        }
        raw = found[0]
      }

      if (/^\d+$/.test(raw)) raw = `127.0.0.1:${raw}`
      if (!/:\d+$/.test(raw)) return { ok: false, error: '看不懂这个地址: ' + raw }

      serial = raw
      saveState({ ...loadState(), serial: raw })
      adb(['disconnect', raw], 8)
      const c = adb(['connect', raw], 20)
      await new Promise((r) => setTimeout(r, 1200))
      let dev = devicesAny().find((d) => d.serial === raw)
      // 刚 connect 有时要再等一拍
      if (!dev || dev.state === 'offline') {
        await new Promise((r) => setTimeout(r, 1800))
        dev = devicesAny().find((d) => d.serial === raw)
      }
      const state = (dev && dev.state) || 'absent'
      return {
        ok: state === 'device',
        serial: raw,
        state,
        out: (c.out || c.err || '').trim(),
        hint: state === 'device' ? '连上了，vm_* 都能用。'
          : state === 'unauthorized' ? '在 AndVM 画面里点「允许 USB 调试」（勾一律允许），再调一次。'
            : state === 'offline' ? 'offline：AndVM 里把「启用 ADB」关掉再开，端口可能变，重新填一次。'
              : '连不上：确认 AndVM 里「启用 ADB」开着、端口没变。',
      }
    },
  }))

  reg(defineTool({
    name: 'vm_shell',
    description: '在虚拟机里跑 shell 命令（默认 su root）。装软件、改设置、查文件都用它。',
    parameters: {
      sh: { type: 'string', required: true, description: '要执行的命令' },
      su: { type: 'boolean', description: '用 su（默认 true）' },
      timeout: { type: 'number', description: '超时秒数，默认 60' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 600000,
    execute: async (a) => {
      await ensure()
      const r = a.su === false
        ? await shellOf(a.sh, a.timeout || 60)
        : await root(a.sh, a.timeout || 60)
      return { ok: r.code === 0, out: r.out, err: r.err, code: r.code, su: r.su }
    },
  }))

  reg(defineTool({
    name: 'vm_screenshot',
    description: '给虚拟机截屏，图存到本机（默认 /sdcard/Download/DSH-Go/vm-shot.png），返回宽高和字节数。',
    parameters: {
      save: { type: 'string', description: '本机保存路径' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      const s = await ensure()
      const remote = '/data/local/tmp/vm-shot.png'
      // screencap 在虚拟机里必崩（缺 gralloc mapper），走 Shot App 的无障碍 takeScreenshot
      const shot = await takeShot()
      if (!shot.ok) return { ok: false, error: shot.err, elapsed_ms: shot.ms }
      const mv = await root(`cp ${SHOT_PRIV} ${remote} && chmod 644 ${remote}`, 30)
      if (mv.code !== 0) return { ok: false, error: '把图搬到 /data/local/tmp 失败', out: mv.out, err: mv.err }
      const dest = a.save || '/sdcard/Download/DSH-Go/vm-shot.png'
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }) } catch {}
      const pull = await adbAsync(['-s', s, 'pull', remote, dest], 120)
      if (!pull.ok) return { ok: false, error: '拉回本机失败', out: pull.out, err: pull.err }
      let size = 0
      try { size = fs.statSync(dest).size } catch {}
      let w = 0, h = 0
      try {
        const b = Buffer.alloc(24)
        const fd = fs.openSync(dest, 'r'); fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd)
        if (b.slice(1, 4).toString() === 'PNG') { w = b.readUInt32BE(16); h = b.readUInt32BE(20) }
      } catch {}
      return { ok: true, local: dest, remote, bytes: size, w, h }
    },
  }))

  reg(defineTool({
    name: 'vm_screen',
    description: '看虚拟机当前屏幕：带编号的元素列表，[编号] 只在本屏有效，直接传给 vm_tap 的 id 参数。主要观察工具。',
    parameters: {},
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async () => {
      await ensure()
      const ui = dumpUi(150)
      const cur = currentFocus()
      return { ok: true, via: ui.via, count: lastNodes.length, screen: renderScreen(ui, cur) }
    },
  }))

  reg(defineTool({
    name: 'vm_ui',
    description: '同上但返回原始节点数组（要结构化数据时用）。',
    parameters: { limit: { type: 'number', description: '最多几个节点，默认 150' } },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const ui = dumpUi(a.limit || 150)
      return { ok: true, via: ui.via, w: ui.w, h: ui.h, count: ui.nodes.length, nodes: ui.nodes }
    },
  }))

  reg(defineTool({
    name: 'vm_tap',
    description: '点屏幕：传 id（vm_screen 里的编号）或 x/y 坐标。点完自动返回新屏幕。',
    parameters: {
      id: { type: 'number', description: 'vm_screen 里的元素编号' },
      x: { type: 'number', description: '横坐标' },
      y: { type: 'number', description: '纵坐标' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      let x = a.x, y = a.y, target = null
      if (a.id) {
        const n = lastNodes[a.id - 1]
        if (!n) return { ok: false, error: `没有编号 ${a.id}，先调 vm_screen` }
        const m = String(n.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
        if (!m) return { ok: false, error: `编号 ${a.id} 没有坐标` }
        x = Math.round((+m[1] + +m[3]) / 2)
        y = Math.round((+m[2] + +m[4]) / 2)
        target = (n.text || n.desc || n.id || n.cls || '').slice(0, 40)
      }
      if (x === undefined || y === undefined) return { ok: false, error: '给 id 或 x/y' }
      const r = await root(`input tap ${x} ${y}`, 30)
      return afterAction({ ok: r.code === 0, via: 'input tap', xy: `${x},${y}`, target, err: r.err || '' })
    },
  }))

  reg(defineTool({
    name: 'vm_click',
    description: '按文字点：找屏幕上含这段文字的元素，点它的中心。',
    parameters: {
      text: { type: 'string', required: true, description: '要点的文字' },
      exact: { type: 'boolean', description: '完全匹配（默认包含即可）' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const ui = dumpUi(150)
      const q = String(a.text || '')
      const hit = ui.nodes.find((n) => {
        const t = ((n.text || '') + ' ' + (n.desc || '')).trim()
        return a.exact ? t === q : t.includes(q)
      })
      if (!hit) return { ok: false, error: `屏幕上没有「${q}」`, screen: renderScreen(ui, currentFocus()) }
      const m = String(hit.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
      if (!m) return { ok: false, error: `「${q}」没有坐标` }
      const x = Math.round((+m[1] + +m[3]) / 2), y = Math.round((+m[2] + +m[4]) / 2)
      const r = await root(`input tap ${x} ${y}`, 30)
      return afterAction({ ok: r.code === 0, via: 'find+tap', xy: `${x},${y}`, target: q })
    },
  }))

  reg(defineTool({
    name: 'vm_swipe',
    description: '滑动：直线传 x1/y1/x2/y2；折线传 points（JSON 数组字符串）。滑完自动返回新屏幕。',
    parameters: {
      x1: { type: 'number', description: '起点 x' },
      y1: { type: 'number', description: '起点 y' },
      x2: { type: 'number', description: '终点 x' },
      y2: { type: 'number', description: '终点 y' },
      ms: { type: 'number', description: '时长毫秒，默认 300' },
      points: { type: 'string', description: '折线点位 JSON，如 [[540,1800],[540,900]]' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const ms = a.ms || 300
      if (a.points) {
        let pts
        try { pts = JSON.parse(a.points) } catch { return { ok: false, error: 'points 不是合法 JSON' } }
        if (!Array.isArray(pts) || pts.length < 2) return { ok: false, error: 'points 至少两个点' }
        let ok = true
        for (let i = 1; i < pts.length; i++) {
          const r = await root(`input swipe ${pts[i - 1][0]} ${pts[i - 1][1]} ${pts[i][0]} ${pts[i][1]} ${Math.max(80, Math.round(ms / (pts.length - 1)))}`, 30)
          if (r.code !== 0) ok = false
        }
        return afterAction({ ok, via: 'input swipe x' + (pts.length - 1), points: pts })
      }
      if ([a.x1, a.y1, a.x2, a.y2].some((v) => v === undefined)) return { ok: false, error: '给 x1/y1/x2/y2 或 points' }
      const r = await root(`input swipe ${a.x1} ${a.y1} ${a.x2} ${a.y2} ${ms}`, 30)
      return afterAction({ ok: r.code === 0, via: 'input swipe', from: `${a.x1},${a.y1}`, to: `${a.x2},${a.y2}` })
    },
  }))

  reg(defineTool({
    name: 'vm_key',
    description: '按系统键：back / home / recents / notifications / enter / power / volume_up / volume_down，或直接写 keyevent 数字。',
    parameters: { key: { type: 'string', required: true, description: '键名或数字' } },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const map = { back: 4, home: 3, recents: 187, notifications: 83, enter: 66, menu: 82, power: 26, volume_up: 24, volume_down: 25 }
      const k = map[String(a.key).toLowerCase()] !== undefined ? map[String(a.key).toLowerCase()] : a.key
      const r = await root(`input keyevent ${k}`, 30)
      return afterAction({ ok: r.code === 0, key: String(k) })
    },
  }))

  reg(defineTool({
    name: 'vm_text',
    description: '往当前聚焦的输入框输入文字（input text）。submit=true 输完按回车。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文字' },
      submit: { type: 'boolean', description: '输完按回车' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const esc = String(a.text).replace(/([\\"'`$&|;<>()*?~\[\]{}!#])/g, '\\$1').replace(/ /g, '%s')
      const r = await root(`input text ${quote(esc)}`, 30)
      if (a.submit) await root('input keyevent 66', 20)
      return afterAction({ ok: r.code === 0, sent: a.text })
    },
  }))

  reg(defineTool({
    name: 'vm_current',
    description: '看当前前台是哪个 App / Activity。',
    parameters: {},
    output: { schema: objSchema, render },
    timeoutMs: 60000,
    execute: async () => {
      await ensure()
      const c = currentFocus()
      return { ok: true, pkg: c.pkg, activity: c.activity, raw: c.raw }
    },
  }))

  reg(defineTool({
    name: 'vm_activity',
    description: '看 Activity 栈顶（TopResumedActivity）。',
    parameters: {},
    output: { schema: objSchema, render },
    timeoutMs: 60000,
    execute: async () => {
      await ensure()
      const r = adb(['-s', serial, 'shell',
        'dumpsys activity activities | grep -E "TopResumedActivity|mResumedActivity" | head -4'], 25)
      return { ok: r.ok, out: r.out.trim(), err: r.err }
    },
  }))

  reg(defineTool({
    name: 'vm_apps',
    description: '列出虚拟机里装的应用（可按关键字过滤）。',
    parameters: { filter: { type: 'string', description: '只看含这串的包名' } },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const r = adb(['-s', serial, 'shell', 'pm list packages'], 60)
      let list = String(r.out || '').split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean)
      if (a.filter) list = list.filter((p) => p.includes(a.filter))
      return { ok: true, count: list.length, apps: list.slice(0, 400) }
    },
  }))

  reg(defineTool({
    name: 'vm_start',
    description: '启动一个 App（包名，可选 activity）。',
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，如 com.android.settings' },
      activity: { type: 'string', description: '可选 Activity，如 .Settings' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const r = a.activity
        ? await root(`am start -n ${a.pkg}/${a.activity}`, 40)
        : await root(`monkey -p ${a.pkg} -c android.intent.category.LAUNCHER 1`, 40)
      return afterAction({ ok: r.code === 0, out: r.out, err: r.err })
    },
  }))

  reg(defineTool({
    name: 'vm_install_apk',
    description: '把本机 APK 装进虚拟机：adb push → pm install -r -g -d → 装前后包集合差集反查包名。',
    parameters: {
      local: { type: 'string', required: true, description: '本机 APK 路径' },
      grant: { type: 'boolean', description: '装时给全部权限（默认 true）' },
      launch: { type: 'boolean', description: '装完直接启动' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 600000,
    execute: async (a) => {
      const s = await ensure()
      if (!fs.existsSync(a.local)) return { ok: false, error: '本机没有这个文件: ' + a.local }
      const base = path.basename(a.local)
      const remote = `/data/local/tmp/${base}`
      try { await root(`rm -f ${remote}`, 20) } catch {}
      const push = await adbAsync(['-s', s, 'push', a.local, remote], 300)
      if (!push.ok) return { ok: false, error: 'adb push 失败', out: push.out, err: push.err }
      await root(`chmod 644 ${remote}`, 20)
      const parse = (t) => new Set(String(t || '').split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean))
      const before = parse(adb(['-s', s, 'shell', 'pm list packages'], 60).out)
      const grant = a.grant !== false ? '-g ' : ''
      const inst = await root(`pm install -r ${grant}-d ${remote}`, 300)
      const all = ((inst.out || '') + (inst.err || '')).trim()
      const ok = /Success/.test(all)
      const after = parse(adb(['-s', s, 'shell', 'pm list packages'], 60).out)
      const added = [...after].filter((p) => !before.has(p))
      const pkg = added.length === 1 ? added[0] : null
      let launched = null
      if (a.launch && pkg) {
        launched = (await root(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, 40)).out.trim()
      }
      let size = 0
      try { size = fs.statSync(a.local).size } catch {}
      return { ok, local: a.local, remote, size, pkg, pkg_all: added, out: all, ...(launched ? { launched } : {}) }
    },
  }))

  reg(defineTool({
    name: 'vm_uninstall_apk',
    description: '从虚拟机卸载 App。系统应用自动退到 pm uninstall --user 0。',
    parameters: {
      pkg: { type: 'string', required: true, description: '包名' },
      keep_data: { type: 'boolean', description: '保留数据（-k）' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 180000,
    execute: async (a) => {
      await ensure()
      const cmd = `pm uninstall ${a.keep_data ? '-k ' : ''}${a.pkg}`
      const r = await root(cmd, 120)
      let all = ((r.out || '') + (r.err || '')).trim()
      if (!/Success/.test(all)) {
        const r2 = await root(`pm uninstall --user 0 ${a.pkg}`, 120)
        all += '\n' + (((r2.out || '') + (r2.err || '')).trim())
      }
      return { ok: /Success/.test(all), pkg: a.pkg, cmd, out: all }
    },
  }))

  reg(defineTool({
    name: 'vm_apk_info',
    description: '看一个已装 App 的路径、大小、版本、安装时间。',
    parameters: { pkg: { type: 'string', required: true, description: '包名' } },
    output: { schema: objSchema, render },
    timeoutMs: 120000,
    execute: async (a) => {
      await ensure()
      const p = adb(['-s', serial, 'shell', `pm path ${a.pkg}`], 30)
      const apk = String(p.out || '').replace(/^package:/m, '').trim().split('\n')[0]
      const d = adb(['-s', serial, 'shell',
        `dumpsys package ${a.pkg} | grep -E "versionName|versionCode|firstInstallTime|lastUpdateTime"`], 30)
      const f = apk ? adb(['-s', serial, 'shell', `ls -l ${apk}`], 20) : { out: '' }
      return { ok: !!apk, pkg: a.pkg, apk, detail: String(d.out || '').trim(), file: String(f.out || '').trim() }
    },
  }))

  reg(defineTool({
    name: 'vm_file_pull',
    description: '把虚拟机里的文件拉到本机，默认存 /sdcard/Download/DSH-Go/。',
    parameters: {
      remote: { type: 'string', required: true, description: '虚拟机里的路径' },
      local: { type: 'string', description: '本机保存路径' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 300000,
    execute: async (a) => {
      const s = await ensure()
      const dest = a.local || `/sdcard/Download/DSH-Go/${path.basename(a.remote)}`
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }) } catch {}
      const r = await adbAsync(['-s', s, 'pull', a.remote, dest], 280)
      let size = 0
      try { size = fs.statSync(dest).size } catch {}
      return { ok: r.ok, remote: a.remote, local: dest, bytes: size, out: r.out.trim(), err: r.err }
    },
  }))

  reg(defineTool({
    name: 'vm_file_push',
    description: '把本机文件推到虚拟机里。',
    parameters: {
      local: { type: 'string', required: true, description: '本机路径' },
      remote: { type: 'string', required: true, description: '虚拟机目标路径' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 300000,
    execute: async (a) => {
      const s = await ensure()
      if (!fs.existsSync(a.local)) return { ok: false, error: '本机没有这个文件: ' + a.local }
      const r = await adbAsync(['-s', s, 'push', a.local, a.remote], 280)
      let size = 0
      try { size = fs.statSync(a.local).size } catch {}
      return { ok: r.ok, local: a.local, remote: a.remote, size, out: r.out.trim(), err: r.err }
    },
  }))

  reg(defineTool({
    name: 'vm_shot_setup',
    description: '装好/修好虚拟机里的截图 App（Shot）：装 APK、启用无障碍、自检一次出图。截图第一次用或报错时调它。',
    parameters: {
      reinstall: { type: 'boolean', description: '强制重装 APK' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 300000,
    execute: async (a) => {
      await ensure()
      let inst = { ok: true }
      if (a.reinstall) inst = await installShot()
      else {
        const p = await root(`pm list packages ${SHOT_PKG}`, 30)
        if (!String(p.out || '').includes(SHOT_PKG)) inst = await installShot()
        if (inst.ok) await new Promise((r) => setTimeout(r, 1000))
      }
      if (!inst.ok) return { ok: false, error: '装 Shot 失败', out: inst.out || inst.err || '' }
      shotReady = null
      const on = await ensureShot(true)
      const d = await root('dumpsys accessibility | grep -A1 "Bound services"', 30)
      const shot = on ? await takeShot() : { ok: false, err: '无障碍没连上' }
      return {
        ok: on && shot.ok,
        installed: true,
        a11y: on,
        shot: shot.ok ? `出图 ${shot.size} 字节 / ${shot.ms}ms` : '',
        out: String(d.out || '').trim(),
        error: on ? (shot.ok ? '' : shot.err || '') : '无障碍没启上：去虚拟机 设置→无障碍 手动打开 Shot',
        hint: '以后 vm_screenshot / vm_shots 会用 Shot 出图。',
      }
    },
  }))

  reg(defineTool({
    name: 'vm_shots',
    description: '连续截几张图（看动画/加载），存到本机目录。',
    parameters: {
      count: { type: 'number', description: '张数，默认 3' },
      interval: { type: 'number', description: '间隔毫秒，默认 800' },
      dir: { type: 'string', description: '本机目录，默认 /sdcard/Download/DSH-Go/shots' },
    },
    output: { schema: objSchema, render },
    timeoutMs: 300000,
    execute: async (a) => {
      await ensure()
      const n = Math.min(Math.max(a.count || 3, 1), 10)
      const gap = Math.max(a.interval || 800, 200)
      const dir = a.dir || '/sdcard/Download/DSH-Go/shots'
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      const files = []
      for (let i = 0; i < n; i++) {
        const remote = `/data/local/tmp/vm-shot-${i}.png`
        const shot = await takeShot()
        if (!shot.ok) { if (i === 0) return { ok: false, error: shot.err, count: 0, dir }; }
        await root(`cp ${SHOT_PRIV} ${remote} && chmod 644 ${remote}`, 30)
        const dest = path.join(dir, `shot-${String(i + 1).padStart(2, '0')}.png`)
        const p = await adbAsync(['-s', serial, 'pull', remote, dest], 60)
        if (p.ok) files.push(dest)
        if (i < n - 1) await new Promise((r) => setTimeout(r, gap))
      }
      return { ok: files.length > 0, count: files.length, dir, out: files.join('\n') }
    },
  }))
}

// ---------------------------------------------------------------- 插件入口

export function apply(ctx) {
  dbg('apply() 开始')
  let dts = null
  try {
    const req = createRequire('/opt/dsh/node_modules/@deepseek-ai/dsh-tools/package.json')
    dts = req('/opt/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
  } catch (e) {
    dbg(`同步 require dsh-tools 失败: ${(e && e.message) || e}`)
  }
  if (dts && typeof dts.defineTool === 'function') {
    try {
      makeTools(ctx, dts.defineTool)
      dbg('vm_* 工具全部注册成功（同步）')
    } catch (e) {
      dbg(`工具注册失败: ${(e && e.message) || e}`)
    }
  } else {
    dbg('dsh-tools 不可用，工具没注册')
  }

  // 从 form 提交的 event.value 里把端口掏出来，容忍各种形态
  function pickPort(event) {
    const v = event && event.value
    if (v == null) return ''
    if (typeof v === 'string' || typeof v === 'number') return v
    if (typeof v !== 'object') return ''
    const cands = [
      v.data && v.data.port, v.port, v['data.port'],
      v.data && v.data['data.port'], v.value, v.text,
    ]
    for (const c of cands) if (c !== undefined && c !== null && c !== '') return c
    // 实在找不到就把第一个像端口的字段抓出来
    const flat = []
    const walk = (o, d) => {
      if (d > 3 || o == null) return
      if (typeof o !== 'object') { flat.push(o); return }
      for (const k of Object.keys(o)) walk(o[k], d + 1)
    }
    walk(v, 0)
    return flat.find((x) => /^\s*[\d\uff10-\uff19]{1,5}\s*$/.test(String(x))) || flat[0] || ''
  }

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('vmbridge', {
      view: (scope, caps) => {
        const en = String(caps && caps.locale || '').startsWith('en')
        return {
          v: 2,
          type: 'stack',
          title: en ? 'VM (adb)' : '虚拟机（adb）',
          children: [
            { type: 'keyValue', items: [
              [en ? 'Device' : '设备', { $: 'data.serial' }],
              [en ? 'State' : '状态', { $: 'data.state' }],
              [en ? 'OS' : '系统', { $: 'data.os' }],
              ['root', { $: 'data.root' }],
            ] },
            { type: 'form', submitLabel: en ? 'Connect & save' : '连接并保存', submit: 'setport', children: [
              { type: 'textField', label: en ? 'ADB port' : 'ADB 端口', bind: 'data.port',
                placeholder: '56103', required: true, value: { $: 'data.port' } },
            ] },
            { type: 'actions', items: [
              { label: en ? 'Refresh' : '刷新', action: 'refresh' },
              { label: en ? 'Devices' : '设备列表', action: 'devices' },
            ] },
            { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const en = String(caps && caps.locale || '').startsWith('en')
        let stop = false
        // emit 是整份覆盖：输入框 bind 到 data.port，如果每次 tick 都重发同一份数据，
        // 用户正在敲的字会被冲回旧值。所以只在状态真的变了才 emit。
        let lastSig = null
        // 端口框里显示的初值只在第一次给；之后交给用户，不覆盖
        let portSeed = (serial || '').split(':')[1] || ''
        const tick = () => {
          if (stop) return
          const dev = devicesAny()
          const me = dev.find((d) => d.serial === serial)
          let os = '—', rootTxt = '—'
          if (me && me.state === 'device') {
            const v = adb(['-s', serial, 'shell', 'getprop ro.build.version.release'], 10).out.trim()
            if (v) os = 'Android ' + v
            rootTxt = /uid=0/.test(adb(['-s', serial, 'shell', 'su -c id'], 10).out || '')
              ? (en ? 'yes' : '有') : (en ? 'no' : '无')
          }
          const model = {
            serial: serial || (en ? '(not set)' : '（未填）'),
            state: me ? me.state : (serial ? 'absent' : '—'),
            os, root: rootTxt,
            port: portSeed,
            hint: me && me.state === 'device'
              ? (en ? 'Ready — vm_* tools work.' : '已连上，vm_* 工具都能用。')
              : (en ? 'AndVM → Debug → "本机地址 127.0.0.1:PORT". Fill PORT below.'
                    : '去 AndVM → 调试 → 看「本机地址 127.0.0.1:NNNNN」，把 NNNNN 填到下面。'),
          }
          const sig = JSON.stringify(model)
          if (sig === lastSig) return
          lastSig = sig
          emit(model)
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { stop = true; clearInterval(timer) }
      },
      actions: {
        setport: async (scope, event) => {
          // App 提交 form 时 event.value 的形态不一定就是 {data:{port}}：
          // 见过 {data:{port}}, {port}, {"data.port"}, 直接字符串。
          // 全角数字（中文输入法）也要认。所以这里宽松地翻一遍再判断。
          const raw = pickPort(event)
          dbg(`setport 收到 event.value=${JSON.stringify(event && event.value)} → 取到 ${JSON.stringify(raw)}`)
          let s = String(raw == null ? '' : raw)
            .normalize('NFKC')                  // ５６３９７ → 56397
            .replace(/[\s\u3000]+/g, '')       // 全角空格
            .trim()
          // 容忍 :56397 / 127.0.0.1:56397 / tcp:56397
          const m = s.match(/(?::|^)(\d{1,5})$/)
          if (m) s = `127.0.0.1:${m[1]}`
          if (!/^[\w.\-]+:\d{1,5}$/.test(s)) {
            return { toast: `端口不对：收到 ${JSON.stringify(String(raw == null ? '' : raw))}`, refresh: true }
          }
          serial = s
          saveState({ ...loadState(), serial: s })
          adb(['disconnect', s], 8)
          adb(['connect', s], 12)
          await new Promise((r) => setTimeout(r, 1200))
          const dev = devicesAny().find((d) => d.serial === s)
          return {
            refresh: true,
            toast: dev && dev.state === 'device' ? `已连上 ${s}` : `${s} → ${(dev && dev.state) || '连不上'}`,
          }
        },
        refresh: () => ({ refresh: true, toast: '已刷新' }),
        devices: () => {
          const dev = devicesAny()
          const txt = dev.length ? dev.map((d) => `${d.serial} (${d.state})`).join('\n') : '没有 adb 设备'
          return { toast: txt.slice(0, 60), copy: txt }
        },
      },
    })
  })
}
