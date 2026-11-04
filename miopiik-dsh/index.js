/**
 * miopiik-dsh — MiOpIIk（Mind · Ink · Operator）的 DSH host 半边。
 *
 * Batch 1 只搭骨架：Host 侧暂时不注册任何能力（没有工具、没有注入、没有事件）。
 * Batch 2 起，Ink 在这里接入 storageDomain（决定账/事实/开环/草稿/简报）、
 * sessionProjections（观测日志的投影）、ctx.llm（编译与校验）、subagents（Operator）、
 * systemPrompt.section（Mind 的章程）与 tools（Mind 的窄工具面）。
 *
 * 不变式（见 SPEC.md）：
 *  - Ink 不叙事、不直接回复用户；本文件永远不会有写对话的路径。
 *  - 观测由 Mind/Operator 写，决定由 Ink 写；两份日志不互写。
 */

/** Host 半边为空实现；能力在后续批次按 SPEC 分批注册。 */
export function apply() {}
