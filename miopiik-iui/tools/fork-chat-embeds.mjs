#!/usr/bin/env node
/**
 * 生成"Markdown 受信嵌入"实验分支：把已安装的 ui-chat 客户端包复制到本仓库，
 * 只在 AssistantMarkdown 的 text 分支插入一个受控挂钩，其余保持与上游逐字节一致。
 *
 *   node tools/fork-chat-embeds.mjs          # 生成/更新分支
 *   node tools/fork-chat-embeds.mjs --check  # 只校验分支是否与当前上游一致（CI 用）
 *
 * 注意：不修改系统安装目录，不参与运行中服务；启用需在 profile 配置里把 ui-chat
 * 指向本目录并重启 DSH（见 docs/UPSTREAM-MARKDOWN-EMBED.md）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 输出位置可用环境变量覆盖：回归测试写到临时目录，避免重建正在被服务加载的 fork。
const forkDir = process.env.MIOPIIK_FORK_DIR ?? join(root, 'upstream', 'dsh-client-ui-chat-embeds')
const patchPath = process.env.MIOPIIK_FORK_PATCH ?? join(root, 'patches', 'chat-markdown-embeds.patch')

// 必须从 DSH 安装目录解析上游，而不是 profile：profile 里可能已经有本 fork 的覆盖链接，
// 否则会把 fork 当成上游（自我复制）并把依赖根算到仓库里。
const DSH_DIR = process.env.MIOPIIK_DSH_DIR ?? '/home/chillizu/.npm-global/lib/node_modules/@deepseek-ai/dsh'
const upstreamDir = dirname(createRequire(join(DSH_DIR, 'package.json')).resolve('@deepseek-ai/dsh-client-ui-chat/package.json'))
if (resolve(upstreamDir).startsWith(root + '/')) {
  throw new Error(`上游解析到了本仓库（${upstreamDir}），请检查 MIOPIIK_DSH_DIR 或 profile 覆盖链接`)
}

const MARK_BEGIN = '\t\t// >>> miopiik:markdown-embeds (fork patch; see docs/UPSTREAM-MARKDOWN-EMBED.md)'
const MARK_END = '\t\t// <<< miopiik:markdown-embeds'

const HELPER = `${MARK_BEGIN}
		// 受信嵌入挂钩：没有注册表或开关未打开时返回 null，行为与上游完全一致。
		function miopiikSegments(text, streaming) {
			try {
				if (typeof localStorage !== "undefined" && localStorage.getItem("miopiik.markdownEmbeds") !== "1") return null;
				const registry = globalThis.__miopiikMarkdownEmbeds;
				if (registry === undefined || typeof registry.segments !== "function") return null;
				const parts = registry.segments(text, { streaming });
				return Array.isArray(parts) ? parts : null;
			} catch {
				return null;
			}
		}
		function MiopiikEmbedSegment({ part, streaming, labels, mentions, pathImages, t }) {
			const registry = globalThis.__miopiikMarkdownEmbeds;
			try {
				if (part.kind === "block") {
					const node = registry.renderBlock(part.raw, { t });
					return node ?? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, { text: part.raw, streaming, labels, fileMentions: mentions, pathImages });
				}
				if (part.kind === "inline") return registry.renderInline(part.node, { t });
			} catch (error) {
				// 局部降级：嵌入渲染失败只影响这一段，交回纯文本
				return (0, react_jsx_runtime.jsx)("span", { "data-miopiik-embed-fallback": String(error && error.message || error) }, part.raw ?? "");
			}
			return null;
		}
${MARK_END}`

const PATCHED_TEXT_CASE = `\t\t\t\t\tcase "text": {
						const segments = miopiikSegments(block.text, streaming);
						if (segments === null) {
							rendered.push((0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
								text: block.text,
								streaming,
								labels,
								fileMentions: mentions,
								pathImages
							}, i));
							break;
						}
						const segmentNodes = [];
						segments.forEach((part, partIndex) => {
							if (part.kind === "text") {
								segmentNodes.push((0, react_jsx_runtime.jsx)("div", {
									style: { display: "inline" },
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
										text: part.text,
										streaming,
										labels,
										fileMentions: mentions,
										pathImages
									})
								}, i + ":" + partIndex));
								return;
							}
							const embedded = (0, react_jsx_runtime.jsx)(MiopiikEmbedSegment, {
								part,
								streaming,
								labels,
								mentions,
								pathImages,
								t
							}, i + ":" + partIndex);
						// 行内/块级同条消息：块组件必须独占整行，不能被外层 flex 压成窄卡片。
						segmentNodes.push(part.kind === "block" ? (0, react_jsx_runtime.jsx)("div", {
							"data-miopiik-block-wrap": "1",
							style: { width: "100%", flexBasis: "100%", minWidth: 0 },
							children: embedded
						}, i + ":" + partIndex + ":block") : embedded);
						});
						// 行内段与块级段分开放：有行内标记时用 flex 容器把文字和 badge 排在同一行
						const hasInline = segments.some((part) => part.kind === "inline");
						rendered.push((0, react_jsx_runtime.jsx)("div", {
							"data-miopiik-segments": hasInline ? "inline" : "block",
							style: hasInline ? { display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 2, rowGap: 4 } : undefined,
							children: segmentNodes
						}, i));
						break;
					}`

/** 用锚点定位 AssistantMarkdown 里的 text 分支，避免依赖具体缩进/换行。 */
function locateTextCase(source) {
  const fnIndex = source.indexOf('const AssistantMarkdown = (0, react.memo)(function AssistantMarkdown(')
  if (fnIndex < 0) throw new Error('找不到 AssistantMarkdown 定义位置')
  const caseIndex = source.indexOf('case "text":', fnIndex)
  if (caseIndex < 0) throw new Error('找不到 AssistantMarkdown 的 text 分支')
  const breakIndex = source.indexOf('break;', caseIndex)
  if (breakIndex < 0) throw new Error('找不到 text 分支的 break')
  return { fnIndex, start: caseIndex, end: breakIndex + 'break;'.length }
}

/**
 * fork 目录是"另一个包"，Node 会从它自己向上找 node_modules；
 * 因此必须链到 DSH 安装的依赖树，否则 lib/index.js 会 ERR_MODULE_NOT_FOUND（如 @deepseek-ai/schemastery）。
 * 这个链接是生成物的一部分：重建 fork 时必须恢复，--check 只校验、不删除。
 */
function dependencyRoot() {
  return resolve(upstreamDir, '..', '..')
}

function ensureDependencyLink(dir, { create = true } = {}) {
  const link = join(dir, 'node_modules')
  const target = dependencyRoot()
  if (create) {
    rmSync(link, { recursive: true, force: true })
    symlinkSync(target, link, 'dir')
  }
  const requireFromFork = createRequire(join(dir, 'lib', 'index.js'))
  const checks = ['@deepseek-ai/schemastery']
  const resolved = {}
  for (const name of checks) {
    try {
      resolved[name] = requireFromFork.resolve(name)
    } catch (error) {
      resolved[name] = `MISSING (${error.code})`
    }
  }
  return { link, target, present: existsSync(link), resolved }
}

function readUpstream() {
  return readFileSync(join(upstreamDir, 'lib', 'client.js'), 'utf8')
}

function patchSource(source) {
  if (source.includes(MARK_BEGIN)) return { source, alreadyPatched: true }
  const { fnIndex, start, end } = locateTextCase(source)
  let next = source.slice(0, start) + PATCHED_TEXT_CASE.trim() + source.slice(end)
  const anchorAt = next.indexOf('const AssistantMarkdown = (0, react.memo)(function AssistantMarkdown(')
  if (anchorAt < 0) throw new Error('找不到 AssistantMarkdown 定义位置')
  next = next.slice(0, anchorAt) + HELPER + '\n' + next.slice(anchorAt)
  void fnIndex
  return { source: next, alreadyPatched: false }
}

function build() {
  const upstream = readUpstream()
  const { source: patched, alreadyPatched } = patchSource(upstream)
  rmSync(forkDir, { recursive: true, force: true })
  mkdirSync(forkDir, { recursive: true })
  cpSync(upstreamDir, forkDir, { recursive: true })
  writeFileSync(join(forkDir, 'lib', 'client.js'), patched, 'utf8')
  // 语法自检（浏览器侧是普通 CommonJS 包装，node --check 可验语法）
  execFileSync(process.execPath, ['--check', join(forkDir, 'lib', 'client.js')], { stdio: 'pipe' })
  const deps = ensureDependencyLink(forkDir)
  if (Object.values(deps.resolved).some((value) => value.startsWith('MISSING'))) {
    throw new Error(`fork 依赖解析失败：${JSON.stringify(deps.resolved)}（检查 ${deps.target} 是否存在）`)
  }

  // diff 在有差异时退出码为 1，属正常，不能被当成失败
  let diff = ''
  try {
    diff = execFileSync('diff', ['-u', join(upstreamDir, 'lib', 'client.js'), join(forkDir, 'lib', 'client.js')], { encoding: 'utf8' })
  } catch (error) {
    diff = String(error.stdout ?? '')
  }
  mkdirSync(dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, diff, 'utf8')
  return { alreadyPatched, patchBytes: diff.length, patchPath, dependencies: deps }
}

if (process.argv.includes('--check')) {
  const upstream = readUpstream()
  const { source } = patchSource(upstream)
  const current = existsSync(join(forkDir, 'lib', 'client.js')) ? readFileSync(join(forkDir, 'lib', 'client.js'), 'utf8') : ''
  // 只读校验：绝不创建/删除任何东西（尤其是正在被服务加载的 fork 与其依赖链接）
  const deps = existsSync(join(forkDir, 'lib', 'client.js')) ? ensureDependencyLink(forkDir, { create: false }) : null
  const problems = []
  if (current !== source) problems.push('分支与上游/补丁不一致，请运行 node tools/fork-chat-embeds.mjs')
  if (deps !== null && deps.present !== true) problems.push('fork 缺少 node_modules 依赖链接，请重新生成')
  if (deps !== null && Object.values(deps.resolved).some((value) => value.startsWith('MISSING'))) problems.push('fork 依赖解析失败')
  if (problems.length > 0) {
    console.error(problems.join('；'))
    process.exitCode = 1
  } else {
    console.log('分支一致')
  }
} else {
  const result = build()
  console.log(JSON.stringify({ ...result, forkDir, upstreamDir }, null, 2))
}
