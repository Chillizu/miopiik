/**
 * 念旧内容：详情仓与索引 —— SPEC §2.2。
 *
 * 原则：**账本是数据，上下文只是索引**。
 *  - 详情按内容 hash 落成文件（同内容只存一份），note 里只留指针；
 *  - 索引按「时间 / 开环 / 分支 / 实体 / 任务」可查，用来**发现**有哪些详情；
 *    hash 只负责**取回**，不负责检索（这是 §2.2 早就写下的分工）；
 *  - 回收只删「没有任何 note 指着它、且超过保留期」的文件；
 *    只要还有记录引用，就不删——provenance 不能断链。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

/** 内容 hash：同内容永远同 hash，天然去重。 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 从一段文字里抽实体线索（确定性，不调模型）：
 * 反引号包裹的标识符、文件路径、大写缩写词。给索引当检索键用。
 */
export function extractEntities(text) {
  const raw = String(text ?? '')
  const found = new Set()
  for (const match of raw.matchAll(/`([^`\n]{2,40})`/gu)) found.add(match[1].trim())
  for (const match of raw.matchAll(/(?:^|\s)([\w./-]+\.[a-z]{2,4})(?=[\s,，。)]|$)/gu)) found.add(match[1])
  for (const match of raw.matchAll(/\b([A-Z][A-Z0-9_]{2,20})\b/gu)) found.add(match[1])
  return [...found].slice(0, 24)
}

export function detailsDir(stateDir) {
  return join(stateDir, 'details')
}

/** 写一份详情；返回指针记录（不含正文）。 */
export async function putDetail(stateDir, input) {
  const text = String(input.text ?? '')
  const hash = contentHash(text)
  const dir = detailsDir(stateDir)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${hash}.txt`), text, 'utf8')
  const at = input.at ?? Date.now()
  return {
    hash,
    bytes: Buffer.byteLength(text, 'utf8'),
    createdAt: at,
    day: Math.floor(at / DAY_MS),
    kind: input.kind ?? 'detail',
    refs: Array.isArray(input.refs) ? input.refs.map(String) : [],
    loops: Array.isArray(input.loops) ? input.loops.map(String) : [],
    branch: input.branch ?? null,
    jobId: input.jobId ?? null,
    turn: input.turn ?? null,
    entities: extractEntities(text),
    preview: text.replace(/\s+/gu, ' ').trim().slice(0, 120),
  }
}

export async function readDetail(stateDir, hash) {
  try {
    return await readFile(join(detailsDir(stateDir), `${hash}.txt`), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 检索索引：所有条件都是「与」，空条件不参与。
 * @returns 匹配的索引记录（新→旧）
 */
export function searchIndex(entries, { query = null, entity = null, loop = null, branch = null, sinceDay = null, limit = 10 } = {}) {
  const needle = query === null ? null : String(query).toLowerCase()
  return entries
    .filter((entry) => (sinceDay === null ? true : entry.day >= sinceDay))
    .filter((entry) => (loop === null ? true : entry.loops.includes(loop)))
    .filter((entry) => (branch === null ? true : entry.branch === branch))
    .filter((entry) => (entity === null ? true : entry.entities.includes(entity)))
    .filter((entry) => (needle === null ? true : `${entry.preview} ${entry.entities.join(' ')}`.toLowerCase().includes(needle)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

/**
 * 回收：只删「没有引用 且 超过保留期」的详情文件。
 * @returns 被删与被保留的统计（可审计）
 */
export async function gcDetails(stateDir, { entries, referencedHashes, now = Date.now(), retentionDays = 30 }) {
  const dir = detailsDir(stateDir)
  let files = []
  try {
    files = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { deleted: [], kept: 0, freed: 0 }
    throw error
  }
  const cutoff = now - retentionDays * DAY_MS
  const deleted = []
  let freed = 0
  let kept = 0
  for (const file of files) {
    if (!file.endsWith('.txt')) continue
    const hash = file.slice(0, -4)
    const entry = entries.find((candidate) => candidate.hash === hash)
    const referenced = referencedHashes.has(hash)
    const tooNew = entry !== undefined && entry.createdAt >= cutoff
    if (referenced || tooNew || entry === undefined) {
      kept += 1
      continue
    }
    await unlink(join(dir, file))
    deleted.push(hash)
    freed += entry.bytes ?? 0
  }
  return { deleted, kept, freed }
}
