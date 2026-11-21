/**
 * 可调项的唯一出口 —— SPEC §6（设置页）。
 *
 * 三件事：
 *  1. DEFAULTS —— 全部内置默认值（host 侧 `?? DEFAULTS.key` 回退）；
 *  2. Config —— 手写的零依赖 schema，同时满足两套协议：
 *     - Cordis Standard Schema：`~standard.validate(config)` 把 4 个 volatile
 *       字段解析成 cosmokit volatile 引用（`get()` + `Symbol.for('cosmokit.volatile.write')`），
 *       DSH 改 cordis.patch.yml 后由 loader 原位写入引用，插件免重启热生效；
 *     - DSH Settings：`uid/type/meta/dict/toJSON()` 结构与 schemastery 的
 *       wire 格式逐位兼容，`new Schemastery(Config.toJSON())` 可无损还原；
 *  3. readConfig(config, key) —— host 侧统一读法：volatile 引用解包成当前值。
 *
 * 不引入任何 npm 依赖；上述协议行为按 DSH 自带 cosmokit/schemastery 的
 * 实测语义手写（volatile 包装的形状见 cosmokit createVolatile）。
 */

/** volatile 引用的写入端（cosmokit 用同一个符号识别跨 ESM 副本的引用）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

export const DEFAULTS = Object.freeze({
  stateRoot: '.dsh/miopiik',
  activeLoopCap: 12,
  dormantAfterDays: 2,
  foldedAfterDays: 7,
  draftExpireDays: 7,
  briefingMaxChars: 1800,
  inboxPreviewChars: 220,
  detailInlineMaxChars: 1200,
  inkTailLimit: 24,
  inkHeadMaxChars: 2000,
  operatorTimeoutMs: 20 * 60 * 1000,
  operatorStallMs: 6 * 60 * 1000,
  inkModel: null,
  operatorModel: null,
  conversationCompile: true,
})

/** 设置页暴露的 4 个实时生效字段（DSH settings 服务按 volatile 自动识别）。 */
export const VOLATILE_KEYS = Object.freeze([
  'conversationCompile',
  'operatorModel',
  'activeLoopCap',
  'operatorTimeoutMs',
])

/** volatile 字段的一句话说明（host 的 Config 与 client 的控件共用，防漂移由测试保证）。 */
export const VOLATILE_DOCS = Object.freeze([
  ['conversationCompile', '回合结束静默提炼结论与未结事项', 'boolean', true],
  ['operatorModel', 'Operator 派发模型（provider/model；留空跟随会话）', 'string', null],
  ['activeLoopCap', '活跃未结事项上限', 'number', DEFAULTS.activeLoopCap],
  ['operatorTimeoutMs', 'Operator 任务超时阈值（毫秒）', 'number', DEFAULTS.operatorTimeoutMs],
])

/** cosmokit isVolatile 的同款判定：对象 + 挂着写入符号即引用。 */
function isVolatile(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/**
 * 读一个配置项的当前值：volatile 引用解包，普通值原样返回。
 * host 侧所有「要热生效」的读法都必须走这里，禁止启动时一次性快照。
 */
export function readConfig(config, key) {
  const value = config?.[key]
  return isVolatile(value) ? value.get() : value
}

/** cosmokit createVolatile 的零依赖同形实现：冻结的 { get, [write] } 引用。 */
function createVolatile(value) {
  let current = snapshotVolatile(value)
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (next) => {
      current = next
    },
  })
}

/** 标量即可满足本插件需要；数组/普通对象按 cosmokit snapshot 冻结深拷贝。 */
function snapshotVolatile(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotVolatile))
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotVolatile(item)])))
  }
  return value
}

let uidNext = 1

/**
 * 手写一个 schema 节点：可调用（调用即校验解析）、带 uid/type/meta，
 * `~standard` 挂在 getter 上（与 schemastery 一样按节点暴露）。
 */
function makeSchema({ type, meta = {}, dict = null, validate }) {
  const schema = (data) => {
    const result = schema['~standard'].validate(data)
    if (result.issues !== undefined) {
      const first = result.issues[0]
      throw new TypeError(`invalid config: ${first.message} (at ${(first.path ?? []).join('.')})`)
    }
    return result.value
  }
  Object.defineProperty(schema, 'uid', { value: uidNext++ })
  Object.defineProperty(schema, '~standard', {
    get: () => ({ version: 1, vendor: 'schemastery', validate: (data) => validate(data, schema) }),
  })
  schema.type = type
  schema.meta = meta
  if (dict !== null) schema.dict = dict
  schema.toString = () => `Schema<${type}>`
  schema.toJSON = function toJSON() {
    // 与 schemastery 的 wire 信封同形：{ uid, refs }，refs 表内 dict 以子 uid 引用。
    const refs = {}
    const entry = { type: this.type, meta: JSON.parse(JSON.stringify(this.meta)) }
    if (this.dict !== undefined) {
      entry.dict = {}
      for (const [key, child] of Object.entries(this.dict)) {
        refs[String(child.uid)] = { type: child.type, meta: JSON.parse(JSON.stringify(child.meta)) }
        entry.dict[key] = child.uid
      }
    }
    refs[String(this.uid)] = entry
    return { uid: this.uid, refs }
  }
  return schema
}

/** 叶子字段校验：nullish 回退默认值，类型不符回报 standard-schema issue。 */
function validateLeaf(data, schema, path) {
  const meta = schema.meta
  if (data === null || data === undefined) {
    if (meta.required === true) return { issues: [{ message: 'missing required value', path }] }
    if (meta.default === null || meta.default === undefined) return { value: data }
    data = typeof meta.default === 'object' ? structuredClone(meta.default) : meta.default
  }
  const expected = schema.type
  if (expected === 'boolean' && typeof data !== 'boolean') return { issues: [{ message: `expected boolean but got ${data}`, path }] }
  if (expected === 'number' && (typeof data !== 'number' || !Number.isFinite(data))) {
    return { issues: [{ message: `expected number but got ${data}`, path }] }
  }
  if (expected === 'string' && typeof data !== 'string') return { issues: [{ message: `expected string but got ${data}`, path }] }
  return { value: data }
}

/** 对象字段校验：按 schemastery object resolver 的语义——声明键逐个解析，未声明键原样透传。 */
function validateObject(data, schema) {
  if (data === null || data === undefined) {
    if (schema.meta.default !== undefined && schema.meta.default !== null) data = structuredClone(schema.meta.default)
    else return { issues: [{ message: 'missing required value', path: [] }] }
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return { issues: [{ message: `expected object but got ${data}`, path: [] }] }
  }
  const result = {}
  const issues = []
  for (const [key, child] of Object.entries(schema.dict)) {
    const field = validateLeaf(data[key], child, [key])
    if (field.issues !== undefined) {
      issues.push(...field.issues)
      continue
    }
    // volatile 字段包成引用：loader 之后只原位写入引用，插件免重启读到新值。
    result[key] = metaOf(child).volatile === true ? createVolatile(field.value) : field.value
  }
  if (issues.length > 0) return { issues }
  for (const key of Reflect.ownKeys(data)) {
    if (key in result) continue
    result[key] = data[key]
  }
  return { value: result }
}

function metaOf(schema) {
  return schema.meta ?? {}
}

/** 4 个实时生效字段的叶子 schema（volatile: true 与默认值都在 meta 里，随 toJSON 序列化）。 */
function volatileLeaf([key, , type, fallback]) {
  return makeSchema({
    type,
    meta: { default: fallback, volatile: true },
    validate: (data, schema) => validateLeaf(data, schema, [key]),
  })
}

/** 插件 Config：`export { Config }` 即被 cordis/DSH settings 识别。 */
export const Config = makeSchema({
  type: 'object',
  meta: { default: {} },
  dict: Object.fromEntries(VOLATILE_DOCS.map((entry) => [entry[0], volatileLeaf(entry)])),
  validate: validateObject,
})

/** 未声明字段的元信息（供诊断与测试对照，不参与 wire 协议）。 */
export const ORDINARY_DOCS = Object.freeze([
  ['stateRoot', '账本存储目录（相对工作区）', '.dsh/miopiik'],
  ['dormantAfterDays', '未结事项转入休眠的静默天数', 2],
  ['foldedAfterDays', '未结事项归档折叠的静默天数', 7],
  ['draftExpireDays', '草稿自动过期的静默天数', 7],
  ['briefingMaxChars', '交接记录单屏字符上限', 1800],
  ['inboxPreviewChars', '每轮注入收件箱摘要的字符预算', 220],
  ['detailInlineMaxChars', '内联详情字符上限（超出转存详情仓）', 1200],
  ['inkTailLimit', 'Ink 连续上下文尾部保留条数', 24],
  ['inkHeadMaxChars', 'Ink 折叠头部摘要字符上限', 2000],
  ['operatorStallMs', 'Operator 无进展停滞阈值（毫秒）', 6 * 60 * 1000],
  ['inkModel', 'Ink 后台编译模型（空为跟随会话）', null],
])
