#!/usr/bin/env node
/**
 * 认领旧布局账本。
 *
 * 背景：早期版本把账本写在 <工作区>/.dsh/miopiik/*.jsonl，所有会话混在一起。
 * 现在按会话隔离到 sessions/<sessionId>/。本脚本按「记录时间戳落在哪个会话的活动区间」
 * 把旧记录归还给对应会话，不猜、不硬塞。
 *
 * 用法：node tools/adopt-legacy.mjs <工作区路径>
 *   node tools/adopt-legacy.mjs /home/data/models
 * 会先备份到 .dsh/miopiik.bak-<时间戳>，再移动记录。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const workspace = process.argv[2]
if (!workspace) {
  console.error('用法：node tools/adopt-legacy.mjs <工作区路径>')
  process.exit(1)
}

const stateRoot = join(workspace, '.dsh', 'miopiik')
const sessionsRoot = join(stateRoot, 'sessions')
const LEGACY = ['observations', 'loops', 'notes', 'inbox', 'drafts', 'cases', 'branches', 'jobs', 'briefings', 'folds', 'details']
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${stateRoot}.bak-${stamp}`
cpSync(stateRoot, backup, { recursive: true })
console.log(`备份：${backup}`)

function sessionRanges() {
  const dirName = `--${workspace.replace(/^\//, '').replace(/\//g, '-')}--`
  const logRoot = join(process.env.HOME, '.dsh', 'sessions', dirName)
  const ranges = new Map()
  if (!existsSync(logRoot)) return ranges
  for (const entry of readdirSync(logRoot)) {
    const dir = join(logRoot, entry)
    const files = readdirSync(dir).filter((f) => f.endsWith('.zstd'))
    if (files.length === 0) continue
    let text = ''
    try {
      text = execFileSync('zstd', ['-dc', join(dir, files[files.length - 1])], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
    } catch {
      continue
    }
    const times = [...text.matchAll(/"time":(\d{13})/g)].map((m) => Number(m[1]))
    if (times.length > 0) ranges.set(entry, [Math.min(...times), Math.max(...times)])
  }
  return ranges
}

function ownerOf(ts, ranges) {
  for (const [sid, [lo, hi]] of ranges) if (ts >= lo - 5000 && ts <= hi + 5000) return sid
  let best = null
  let bestGap = Infinity
  for (const [sid, [lo, hi]] of ranges) {
    const gap = Math.min(Math.abs(ts - lo), Math.abs(ts - hi))
    if (gap < bestGap) {
      best = sid
      bestGap = gap
    }
  }
  return best
}

function timestampOf(record) {
  const nested = [['branch', 'createdAt'], ['loop', 'createdAt'], ['draft', 'createdAt'], ['job', 'startedAt'], ['note', 'at'], ['fact', 'createdAt'], ['proposal', 'createdAt']]
  for (const [key, field] of nested) {
    const value = record[key]
    if (value && typeof value === 'object' && value[field]) return value[field]
  }
  return record.at ?? record.createdAt ?? 0
}

const ranges = sessionRanges()
if (ranges.size === 0) {
  console.error('没有找到任何会话日志，放弃')
  process.exit(1)
}

let moved = 0
for (const name of LEGACY) {
  const path = join(stateRoot, `${name}.jsonl`)
  if (!existsSync(path)) continue
  const buckets = new Map()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const record = JSON.parse(line)
    const owner = ownerOf(timestampOf(record), ranges)
    if (owner === null) continue
    if (!buckets.has(owner)) buckets.set(owner, [])
    buckets.get(owner).push(line)
  }
  for (const [sid, lines] of buckets) {
    const dir = join(sessionsRoot, sid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.jsonl`), lines.join('\n') + '\n', { flag: 'a' })
    moved += lines.length
  }
  writeFileSync(path, '')
}
console.log(`认领完成：${moved} 条记录归还到 ${ranges.size} 个会话中`)
