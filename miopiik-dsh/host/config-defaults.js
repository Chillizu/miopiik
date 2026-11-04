/**
 * 可调项的唯一出口 —— SPEC §6（设置页）。
 *
 * 这些值都能在 `cordis.patch.yml` 的 `config` 段里改；
 * 设置页把它们原样列出来，`test/settings.test.js` 会检查两边没漂移。
 * 新增可调项时：先加到这里，再改用到它的地方，最后在 client 的 KNOBS 里补一行。
 */

export const DEFAULTS = Object.freeze({
  stateRoot: '.dsh/miopiik',
  activeLoopCap: 12,
  dormantAfterDays: 2,
  foldedAfterDays: 7,
  draftExpireDays: 7,
  briefingMaxChars: 1800,
  inboxMaxPreviews: 3,
  operatorTimeoutMs: 20 * 60 * 1000,
  operatorStallMs: 6 * 60 * 1000,
  inkModel: null,
})

/** 给设置页用的说明（同上，改这里等于改文档）。 */
export const KNOB_DOCS = Object.freeze([
  ['stateRoot', '账本目录（相对工作区）', '.dsh/miopiik'],
  ['activeLoopCap', '活跃开环上限，超了按固定顺序折进休眠', 12],
  ['dormantAfterDays', '几天没被碰到就休眠', 2],
  ['foldedAfterDays', '几天后折成一行', 7],
  ['draftExpireDays', '草稿几天没人碰自动丢弃', 7],
  ['briefingMaxChars', '交接简报的字数上限（一屏）', 1800],
  ['inboxMaxPreviews', '每轮最多看到几条完整预览', 3],
  ['operatorTimeoutMs', 'Operator 超时多少毫秒算超时', 20 * 60 * 1000],
  ['operatorStallMs', '多久没有新观测算「卡住」', 6 * 60 * 1000],
  ['inkModel', 'Ink 编译用的模型（空=跟随会话默认）', null],
])
