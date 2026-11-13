# MiOpIIk Agent

<img src="icon.svg" width="96" alt="MiOpIIk icon">

**Version 0.1.1** (stable) | English | [简体中文](README.zh-CN.md)

`MiOpIIk` = `Mi`(nd) + `Op`(erator) + `IIk`(ink). Ink sits in the middle of the word because it sits in the middle of the system.

`miopiik-dsh` is a host-side plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns a DSH Web conversation into a governed agent session: one voice in the foreground, one ledger in the middle, one execution layer in the background. It does not render chat messages and it does not replace the assistant; it changes what the assistant is allowed to remember, dispatch, and commit.

**Current release:** 0.1.1 (stable). Not published to the npm registry; install from the GitHub Release tarball or a local `npm pack`.

## What MiOpIIk is

A normal "chat assistant plus tool calls" setup handles long or asynchronous work badly. It either blocks the conversation while the user waits, or throws the work into the background and loses track of it. Add a middle manager that talks to the user and it will talk over the main conversation and invent conclusions.

MiOpIIk splits the job into three layers and gives exactly one of them the right to speak:

- **Mind** is the conversation trunk and the only user-facing role. It discusses, weighs options, decides, and advances the narrative. It alone closes open threads, and it alone asks the user to accept an outward change.
- **Ink** is the backstage memory and compiler. After each turn it records what was said, distills candidate conclusions and open loops, maintains the tiered inbox, watches background jobs for timeouts and stalls, and prepares folds and handoff material across topics and days. It never speaks to the user and never makes a decision for the conversation.
- **Operator** is the execution layer. It receives no chat transcript, only a complete contract plus a fishbone slice (fork premise, verbatim quotes, dependent facts). It reports results or failures back through `ink_report` and never appears in the conversation.

The result is two timelines flowing at once: the foreground is a sequence of conversation turns, the background is a sequence of asynchronous jobs, and Ink keeps the two sets of books aligned. **The conversation is never interrupted by background work, and background work never has to justify itself through the conversation.**

That is why this is not a chat-assistant wrapper. The plugin contributes a prompt charter, a narrow tool surface, append-only ledgers, background dispatch, and projections for the UI. The conversation still belongs to Mind.

![Architecture: one conversation, two timelines, three layers](docs/images/report-2026-11-10/architecture.png)

The diagram above is the repository's real architecture figure. Its lower band ("Extra display layer") is historical: that layer has been retired and archived in [miopiik-extra](https://github.com/Chillizu/miopiik-extra); current display work lives in the separate MiOpIIk IUI plugin. The upper band is this Agent.

## MiOpIIk Agent and MiOpIIk IUI

The two plugins are independent packages. Each can be installed alone; neither requires the other.

| | MiOpIIk Agent (`miopiik-dsh`) | MiOpIIk IUI (`miopiik-iui`) |
|---|---|---|
| Role | Host-side agent: Mind / Ink / Operator | Pure presentation layer |
| Current version | 0.1.1 (stable) | 0.1.0-rc.4 (prerelease) |
| Repository | https://github.com/Chillizu/miopiik | https://github.com/Chillizu/miopiik-iui |
| Depends on the other plugin | No | No |
| Can be installed alone | Yes | Yes |
| What it renders | No chat rendering; it adds tools, prompt context, a conversation view and a right sidebar panel | Declarative `iui` blocks and inline tokens in Markdown; browser-side rendering |
| Where it writes | Append-only JSONL ledgers under the workspace | No logs; one browser-local preference in `localStorage` |
| Host requirement | DSH Web profile | DSH Web profile; inline rendering additionally needs an experimental chat-package patch |

In short: **IUI is optional presentation, Agent is the working core.** Install only the Agent and you get the full Mind / Ink / Operator machinery with the Agent's own backstage panel. Add IUI when prose is not enough for comparisons, trends, or local controls. IUI never becomes the source of truth, and the Agent never renders its own UI protocol.

The older Extra display layer is kept only as a historical archive at [miopiik-extra](https://github.com/Chillizu/miopiik-extra). Its data is not deleted: legacy `ink-view` widget snapshots remain readable in the ledger, and IUI's read-only legacy adapter can replay them. The current Agent no longer creates new widget records.

## Architecture and data flow

The implementation lives in `host/`, the browser side in `client.js`, and the plugin entry point in `index.js`.

A turn moves through the system like this:

1. **Observe.** When a turn ends, Ink mechanically records the user's real prompt and the assistant's final message into `observations.jsonl`. Only human-visible input and final assistant text are recorded; reasoning traces are not.
2. **Compile.** If `conversationCompile` is on, Ink reads its own middle-layer context plus recent utterances and produces candidate notes: one-line claim, a question the user could answer, confidence, evidence, and a contradiction flag.
3. **Deliver.** Notes become inbox items with tiered previews (T0 blocking, T1 connected to an active loop or branch, T2 new conclusion, T3 the rest). The inbox is the funnel through which compiled work reaches Mind; whether and how to mention it is still Mind's call.
4. **Act.** Mind updates the ledger through the `ink_*` tools: register or close loops, write fact cards with provenance, open a fishbone branch, drop a draft, or promote a change through the commit gate.
5. **Dispatch.** `ink_dispatch` validates the six-part contract, opens a `pending-dispatch` loop and a background job, attaches the branch slice, and starts an Operator child agent. The child gets the contract and the slice, not the conversation.
6. **Report.** The Operator finishes through `ink_report` (one claim plus evidence becomes a fact card) or through its final report. Ink compiles that report into a preview, marks contradictions with an exact `U-n` utterance reference, and puts it in the inbox. Watchdogs turn stalls and timeouts into T0 blocking previews.
7. **Fold and hand off.** Topic switches advance the epoch; long contexts are folded in two phases; the end of a day can produce a five-part briefing written by Mind. A detected overnight gap is admitted at the start of the next day instead of being silently skipped.

Each turn's prompt context (L3) is assembled from the active loops and the inbox previews. This is prompt context, not chat history: Ink's index never enters the message stream as a user or assistant message.

### Ledger layout

All state is append-only JSONL under the workspace. The source of truth for file names is `host/store.js` (`LOG_NAMES`).

```
<workspace>/.dsh/miopiik/
  sessions/<sessionId>/
    observations.jsonl    facts.jsonl        loops.jsonl
    notes.jsonl           inbox.jsonl        jobs.jsonl
    drafts.jsonl          cases.jsonl        branches.jsonl
    folds.jsonl           briefings.jsonl    details.jsonl
    ink-context.jsonl     ink-debug.jsonl    widgets.jsonl
    details/<hash>.txt
  shared/
    facts.jsonl
```

| Ledger file | Contents | Written by | Read by |
|---|---|---|---|
| `observations.jsonl` | Turn-by-turn observation log: real user prompts, final assistant messages, turn boundaries, folds | Ink | Compile pass, fold, Seen panel |
| `notes.jsonl` | Decision ledger and compiled candidate notes | Ink | Inbox delivery, audit view |
| `loops.jsonl` | Open-loop operations: `create` / `touch` / `status` / `close` / `drop` | Mind via `ink_loops`; user intervention command | L3 context, inbox correlation |
| `facts.jsonl` | Fact-card operations: `add` / `revise` / `invalidate`, with provenance and scope | Mind via `ink_facts`; Operator via `ink_report` | L3 context, self-answer checks |
| `inbox.jsonl` | Delivered previews and their status: `read` / `star` / `unstar` / `defer` / `supersede` | Ink | L3 context, Seen panel |
| `jobs.jsonl` | Background dispatch contracts, child ids, job states, stop reasons | Ink / Operator layer | Watchdog, task board, Seen panel |
| `drafts.jsonl` | Drafts below the commit gate, with expiry | Mind via `ink_draft` | Commit gate, Seen panel |
| `cases.jsonl` | Precedents: question, answer, citations | Ink | `ink_ask` citation path |
| `branches.jsonl` | Fishbone branches: premise, verbatim quotes, dependent facts, merged conclusion | Mind via `ink_branch` | Dispatch slice, Seen panel |
| `folds.jsonl` | Two-phase fold proposals, review results, application records | Ink | Fold review, Seen panel |
| `briefings.jsonl` | Cross-day handoff briefings and hard-break records | Mind via `ink_brief` | L3 next morning, Seen panel |
| `details.jsonl` | Detail index: content hash, entities, pointers attached to loops/branches/jobs | Ink | `ink_recall` |
| `ink-context.jsonl` | Ink's own middle-layer context: tail entries and head folds | Ink | Compile pass |
| `ink-debug.jsonl` | Debug records kept for audit | Ink | Diagnostics |
| `widgets.jsonl` | Legacy display specs written by the retired Extra layer; read-only replay | (legacy data only) | IUI legacy adapter |
| `shared/facts.jsonl` | Workspace-scoped facts shared by all sessions in the same workspace | Mind via `ink_facts` with `scope: "workspace"` | All sessions |
| `details/<hash>.txt` | Full detail bodies addressed by content hash | Ink | `ink_recall` with a hash |

The ledgers are plain text and human-auditable. On open, every JSONL file is replayed; a corrupt line is skipped without aborting the replay, and read-time migrations never rewrite the file on disk.

### The tool surface

The model-facing surface is intentionally narrow. Twelve tools belong to Mind; two belong to Operator.

| Tool | Side | Purpose |
|---|---|---|
| `ink_status` | Mind | Read backstage state: loops, facts, inbox counts, epoch, day |
| `ink_loops` | Mind | `list` / `get` / `add` / `touch` / `close` / `drop` open loops |
| `ink_facts` | Mind | `list` / `add` / `revise` / `invalidate` fact cards |
| `ink_inbox` | Mind | `list` / `open` / `read` / `star` / `unstar` / `defer` inbox items |
| `ink_dispatch` | Mind | Hand a contracted job to a background Operator |
| `ink_commit` | Mind | Open the single outward commit gate |
| `ink_brief` | Mind | `materials` / `save` / `latest` cross-day briefing |
| `ink_epoch` | Mind | Advance the topic epoch |
| `ink_draft` | Mind | `list` / `add` / `drop` drafts |
| `ink_branch` | Mind | `list` / `open` / `get` / `summary` / `context` / `merge` / `abandon` fishbone branches |
| `ink_fold` | Mind | `propose` / `review` / `approve` / `reject` / `list` context folds |
| `ink_recall` | Mind | Search the detail index; read a detail back by hash |
| `ink_ask` | Operator | Ask Ink a question; Ink answers only by citation, otherwise escalates |
| `ink_report` | Operator | Hand back one conclusion with evidence, as a fact card |

The split is structural, not a prompt convention. In `index.js` the Operator child agent is denied the twelve Mind tools, while Mind is denied `ink_ask` and `ink_report`. Operator children also never receive the chat transcript. A user can additionally close a loop or invalidate a fact from the UI without involving the model; that path is the `/miopiik loop close L-1`, `/miopiik loop drop L-1`, and `/miopiik fact invalidate F-1` session command and the corresponding buttons.

## What it can do

- **Open loops without a todo list.** A loop is a sentence that is still hanging between Mind and the user: an unanswered question, an awaiting-user item, a pending option, a promise, a pending dispatch, or a forming intent. There are no dates and no owners. Loops age on the day axis: dormant after `dormantAfterDays`, folded to one line after `foldedAfterDays`, revived by a touch. Only Mind closes them; Ink can only hint that one looks answered. The active cap (`activeLoopCap`) keeps the prompt context small.
- **Fact cards with provenance.** A settled conclusion is stored with its sources, confidence, and validity, plus a scope: session by default, workspace when other conversations must honor it. User-stated facts outrank Operator inference. When Mind has to answer from memory it cites a card or precedent; if it cannot cite, it escalates instead of inventing.
- **Fishbone branches.** Work grows out of a specific sentence. A branch (`B-n`) records the fork premise, verbatim quotes from the trunk, and dependent fact ids. Operator receives only that slice, so a background agent cannot drift on the whole conversation. When the work concludes, the branch merges back with a one-line claim and the evidence.
- **Drafts and a single commit gate.** Half-formed work goes to the draft area, where it ages out after `draftExpireDays` and never reaches the user. Outward changes pass through `ink_commit`: one title, one sentence of impact, and a user answer of "行" (OK) or "不行" (No). Low-confidence changes are refused at the gate and stay in drafts; a turn with no real user input cannot commit. A rejected commit settles as rejected; the user is never asked to repair the work.
- **Compilation line and contradiction naming.** After qualifying turns, Ink compiles candidates from its own context. When a background result contradicts something Mind told the user, the compile pass flags it and names the exact `U-n` utterance. Mind decides whether and when to correct the record; Ink does not rewrite history.
- **Background dispatch and a night watch.** Dispatch is gated by the contract: goal, deliverables, acceptance criteria, acceptance sample, boundary, budget. If any element is missing, dispatch refuses and lists what is missing, so a half-formed picture stays in the conversation. A `draft: true` dispatch needs only a goal and keeps its output in the draft area. While a job runs, the stall watchdog looks for "running but no new observation" (`operatorStallMs`) and the timeout watchdog catches jobs that exceed `operatorTimeoutMs`; both deliver a blocking T0 preview instead of guessing or rolling back on their own.
- **Two-phase folding.** Folding is event-driven, not a character cutoff. Ink first builds a shadow fold: an archive plus loop settlement suggestions, replacing nothing. Mind reviews it while it still holds the old context; the only acceptance criterion is that every still-active open thread can be picked up again after the fold. On approval the narrative fold is applied, scheduled for the next turn boundary when the host compaction service is available; if it is not, the proposal is recorded and nothing is silently rewritten.
- **Cross-day briefing.** At the end of a day, Mind writes a five-part briefing itself: progress, open loops, running background work, drafts, and what it wants to discuss next. A machine-written briefing would make tomorrow's Mind unrecognizable, so Ink only supplies materials (`ink_brief materials`) and the L3 context shows the latest briefing and any detected hard break. If the previous day ended without a goodbye, the next day starts by admitting where the thread broke.
- **A visible backstage.** The conversation view "MiOpIIk" shows the fishbone graph, a branch stream, and a list pane with open loops, fact cards, running jobs, drafts, and today's handoff record; its "Seen" tab shows Ink's folded head, live tail, and the candidates just compiled. A right sidebar panel "Ink" shows loop counts, inbox previews, and recent decisions. Nothing behind the curtain is hidden from the user; Ink just does not speak.
- **Plugin pages and a read-only configuration view.** Under DSH `Plugins -> Installed -> MiOpIIk`, the plugin declares one configuration slot with two tabs: an introduction (layers, roles, version, ledger location) and a configuration page. The configuration page lists the built-in defaults for every host knob and a copyable profile YAML example. It is read-only and writes no files; the actual values come from the profile.
- **Append-only ledger and replay.** Restarting DSH replays the session ledgers. State does not live only in the model context. The agent's own context is a working index over the ledger, not the source of truth.
- **Historical compatibility.** Old session ledgers are not migrated, rewritten, or deleted. Legacy widget entries stay readable, and the separate IUI plugin can replay them read-only. The current Agent does not create new widget entries.

## Illustrative usage

The examples below are illustrative conversations. **Tool names and parameter names are the real ones from `host/tools.js`; the user wording is invented.** Each example shows: what the user says, what Mind does, and what the system produces.

### 1. A fact that should change future answers

**User:** "We use pnpm in this repository. Don't run npm install here."

**Mind:** records a fact card rather than relying on recall.

```json
{"action": "add", "claim": "This repository uses pnpm; do not run npm install here.", "provenance": ["user: turn 12"], "conf": "high", "source": "user", "scope": "session"}
```

**System:** the card is appended to `facts.jsonl`; the next turn's L3 context carries it; later answers cite the card. If the user later says pnpm was abandoned, Mind revises or invalidates the card instead of silently forgetting it.

### 2. A question that stays open

**User:** "Should the settings page keep the raw YAML example, or is the copy button enough?"

**Mind:** registers an open loop and keeps the conversation going without forcing an immediate decision.

```json
{"action": "add", "text": "Decide whether the settings page keeps the raw YAML example or only the copy button", "type": "pending-option", "pointer": "turn 18", "closureCondition": "The user picks one and the page copy reflects it"}
```

**System:** `loops.jsonl` gets a `create` record. If the user answers three turns later, Mind closes it with the exact loop id:

```json
{"action": "close", "id": "L-7", "reason": "user chose the copy button only"}
```

Ink may have hinted that the loop looked answered, but only Mind performs the close.

### 3. A background job with a real contract

**User:** "Translate the report to English and run the test suite before you're done."

**Mind:** opens a branch so the work is traceable to this sentence, then dispatches with a complete contract.

```json
{"action": "open", "label": "report-translation", "summary": "Deliver an English report and a green test run", "forkedAtTurn": 34, "premise": "The user wants the existing report translated and verified in one background pass", "quotes": ["Translate the report to English and run the test suite before you're done."], "facts": ["F-4"]}
```

```json
{"goal": "Translate the report to English and run the test suite", "deliverables": "An English report file plus the test run output", "acceptance": "The English report exists and the test suite exits 0", "acceptanceSample": "A short English report; a test summary with no failures", "boundary": "Do not change the report's conclusions or the source code", "branch": "report-translation", "budget": "One background pass, no network access"}
```

**System:** a `pending-dispatch` loop, a job record, a task-board card, and an Operator child agent. The child sees the contract and the branch slice, not the conversation. When it finishes, it hands back a conclusion:

```json
{"claim": "The English report is complete and the test suite passes", "conf": "high", "evidence": "docs/report.en.md; test run exited 0"}
```

Ink compiles the result into an inbox preview; Mind opens it with `ink_inbox {"action": "open", "id": "I-6"}`, merges the branch with `ink_branch {"action": "merge", "id": "B-3", "claim": "English report delivered; tests green", "detail": "docs/report.en.md"}` and decides how to tell the user. If the contract had been incomplete, `ink_dispatch` would have refused and named the missing fields.

### 4. The commit gate and the end of a day

**User:** "Ship the shorter settings copy, but ask me before it goes out."

**Mind:** parks the work in a draft, then opens the single commit gate.

```json
{"action": "add", "title": "Shorter settings page copy", "summary": "Replace the configuration page text with the shorter version", "artifact": "docs/draft/settings-copy.md", "conf": "mid"}
```

```json
{"title": "Settings page copy", "summary": "Shorter configuration text; no behavior change.", "confidence": "high", "draftId": "P-3"}
```

**System:** DSH asks the user one question with the options 行 / 不行. "行" settles the draft as committed; "不行" settles it as rejected, with no follow-up asking the user to repair it. A low-confidence commit is refused before the user is bothered.

At the end of the day Mind writes the handoff itself:

```json
{"action": "save", "progress": "Settings copy shortened and shipped", "loops": "L-7 closed; L-9 still waiting on the release decision", "running": "No background jobs running", "drafts": "None", "next": "Start from the release decision, not from a summary of the day"}
```

**System:** the briefing is stored in `briefings.jsonl` and appears in the next session's L3 context and in the backstage panel. If the day ended without a goodbye, the next start reports the hard break before continuing.

## Requirements and support

| Item | Requirement |
|---|---|
| Host | DSH Web (the `web` profile); host-side plugin, not a standalone app |
| DSH baseline | 0.2.1-rc.5 (the version the test suite and release checks target) |
| Node | >= 23.6 (`package.json` `engines`) |
| Runtime dependencies | None; the package has no third-party runtime dependencies |
| Browser side | `client.js` declares `platform: "web"` and plugs into DSH's conversation view, right sidebar, and `plugins.bundle.config` slot |
| Other platforms | Not tested; the plugin relies on DSH Web services such as tools, system prompt, session projections, subagents, user questions, and compaction |

DSH is a moving target. The baseline above is what this release was verified against; a DSH upgrade may rename or remove a host service the plugin depends on. Treat `docs/SUPPORT-MATRIX.md` as the maintained compatibility statement.

## Install, upgrade, uninstall, rollback

**This package is not published to the npm registry.** A bare `dsh plugin add miopiik-dsh` without a path or tarball will not resolve it; there is no registry install path. Install from the GitHub Release tarball, from a local `npm pack`, or from a checkout path.

### From a GitHub Release (recommended)

1. Download `miopiik-dsh-0.1.1.tgz` and `SHA256SUMS.txt` from
   https://github.com/Chillizu/miopiik/releases/tag/miopiik-agent-v0.1.1
2. Verify the download in the download directory with `sha256sum -c SHA256SUMS.txt`.
3. Install into the target profile with `dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz`.
4. Restart the DSH process that serves that profile. A browser refresh is not enough: host plugins load when the DSH process starts.

### From a local checkout

The repository root is the package root (`package.json` and `index.js` are siblings), and the package has no dependencies, so no `npm install` is needed.

```sh
git clone https://github.com/Chillizu/miopiik.git
cd miopiik
npm pack
dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz
```

`npm pack` only builds a local tarball. Do not publish it to any registry.

You can also install a working tree directly (link mode):

```sh
dsh plugin --profile <profile> add /path/to/miopiik
```

The helper `tools/install-plugin.mjs` wraps both modes. It is a dry run by default, prints the exact `dsh` command, and refuses to write the running `web` profile unless explicitly allowed:

```sh
node tools/install-plugin.mjs --profile <profile>            # dry run, link mode
node tools/install-plugin.mjs --profile <profile> --mode tarball --execute
node tools/install-plugin.mjs --profile web --execute --allow-running-profile
```

### Upgrade

1. `dsh plugin --profile <profile> remove miopiik-dsh`
2. `dsh plugin --profile <profile> add ./miopiik-dsh-<new-version>.tgz`
3. Restart the DSH process for that profile.

### Rollback

1. `dsh plugin --profile <profile> remove miopiik-dsh`
2. `dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz`
3. Restart the DSH process for that profile.

Session ledgers are not touched by uninstall, upgrade, or rollback: they live in the workspace, not in the plugin directory. Roll back to 0.1.1 whenever a newer version misbehaves; the 0.1.1 tarball is this release's stable artifact.

### Uninstall

```sh
dsh plugin --profile <profile> remove miopiik-dsh
```

Restart the profile. Your conversation history stays in the workspace ledgers and, if you reinstall later, the plugin replays it.

## Configuration

Configuration lives in the profile's `cordis.patch.yml`, in the `config` section for this plugin. A patch replaces the entry's `config` as a whole; fields you omit fall back to the built-in defaults below.

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: miopiik-dsh
  config:
    stateRoot: .dsh/miopiik
    activeLoopCap: 12
    conversationCompile: true
```

The defaults come from `host/config-defaults.js` (`DEFAULTS`):

| Key | Default | Meaning |
|---|---|---|
| `stateRoot` | `.dsh/miopiik` | Ledger directory, relative to the workspace |
| `activeLoopCap` | `12` | Maximum active open loops before the oldest are folded into dormant in a fixed order |
| `dormantAfterDays` | `2` | Days without a touch before a loop goes dormant |
| `foldedAfterDays` | `7` | Days before a loop is folded into one line |
| `draftExpireDays` | `7` | Days before an untouched draft is discarded |
| `briefingMaxChars` | `1800` | Character cap for a handoff briefing (one screen) |
| `inboxPreviewChars` | `220` | Character budget for the previews injected each turn (as many as fit, not a count limit) |
| `detailInlineMaxChars` | `1200` | Details longer than this become pointers to the detail store |
| `inkTailLimit` | `24` | Middle-layer context tail entries kept before folding into the head |
| `inkHeadMaxChars` | `2000` | Character cap for the middle-layer head summary |
| `operatorTimeoutMs` | `1200000` | Operator timeout in milliseconds (20 minutes) |
| `operatorStallMs` | `360000` | Time without a new observation before a running job is considered stalled (6 minutes) |
| `inkModel` | `null` | Model used for Ink compilation (`null` follows the session default; otherwise an object with `provider` and `model`) |
| `conversationCompile` | `true` | Let Ink read its own context and produce candidates after a turn (`false` means bookkeeping only) |

The plugin settings page under `Plugins -> Installed -> MiOpIIk` shows these built-in defaults and a copyable YAML example. It is read-only and displays defaults, not live values; the running values are whatever the profile (and higher patch layers) resolve to.

## Security and permissions

- **One write location.** The plugin writes only under the workspace's ledger root (`<workspace>/.dsh/miopiik` by default, or the configured `stateRoot`, still relative to the workspace). It does not write into the DSH installation, the profile directory, or any other user directory.
- **Append-only, human-auditable data.** The ledgers are plain-text JSONL. They are not encrypted and there is no automatic redaction: if something is said in the conversation, the observation log may keep it. Treat the conversation as written to disk and do not paste secrets into it.
- **No credential harvesting, no telemetry.** The plugin has no credential fields and never dumps environment variables or DSH credential files into the ledger. It reads no environment secrets and contains no network calls or analytics. Its own outbound traffic is zero; model calls go through the host's configured LLM service (`ctx.llm` for Ink compilation, the host's subagent service for Operator).
- **Structural separation of roles.** Operator child agents are denied the twelve Mind tools, receive no chat transcript, and get only the contract plus the branch slice. Mind is denied the Operator-only `ink_ask` and `ink_report`. This is enforced by per-agent tool restrictions in `index.js`, not by a polite instruction.
- **The commit gate belongs to the user.** Outward changes are proposed through `ink_commit` and answered with "行" or "不行". Low-confidence changes are refused, no-input turns cannot commit, and a rejection settles the draft without asking the user to repair it. UI buttons are proposals, not approvals: the plugin does not treat a rendered control as consent.
- **Backstage input is untrusted.** Compilation output is parsed as data, not executed. A failed or malformed compile degrades to a preview with the raw report attached; it never invents a conclusion.
- **User overflow is respected.** Ink does not speak to the user; it only delivers previews and hints. Mind decides what is shown, when, and in what words.

## Tests and development

```sh
npm test            # node --test
npm run check       # tools/check-release.mjs
npm run build:check # tools/build-client-rules.mjs --check
npm run icon:check  # tools/icon-check.mjs
```

| Command | What it checks |
|---|---|
| `npm test` | Unit and integration suite using Node's built-in test runner (`node:test`). No third-party test dependencies. |
| `npm run check` | Release readiness: required metadata, a real `npm pack`, unpacked file list against the runtime import graph, `node --check` on every shipped script, icon rules, and package size limits. Emits a JSON report and exits non-zero on any problem. |
| `npm run build:check` | Fails if the Agent client re-introduces the retired IUI / Widget renderer. The separate IUI package is the only display renderer. |
| `npm run icon:check` | Validates the shipped `icon.svg` against the icon rules (SVG, at most 256 KiB, no scripts or external references, 36x36 viewBox) and the `exports["./icon"]` / `files` metadata. Optionally compares byte-for-byte with the designer's original via `--original <path>`. |

The suite is designed to pass in a clean checkout without DSH installed, without `~/.dsh`, without Chromium, and without network access. Checks that need a real host are skipped or conditionally executed instead of being faked. The package has no third-party runtime dependencies, so there is nothing to install before running the tests.

CI: `.github/workflows/ci.yml` runs the commands above on pushes and pull requests.

Repository layout for contributors:

| Path | Content |
|---|---|
| `index.js` | Host plugin entry: session init, projection, tool registration, prompt charter |
| `host/` | Engine, ledgers, compile, fold, dispatch, operator, tools |
| `client.js` | Browser side: conversation view, right sidebar panel, plugin pages |
| `SPEC.md` | Architecture specification and invariants (the single source of truth) |
| `test/` | `node:test` suite |
| `tools/` | Release checks, icon check, client renderer guard, install helper, dev scripts |
| `docs/` | Design notes, audits, historical reports, architecture figures |
| `locale/` | Plugin locale dictionaries |

Key documents:

- [SPEC.md](SPEC.md): architecture specification and invariants, the single source of truth.
- [docs/ALIGNMENT-AUDIT.md](docs/ALIGNMENT-AUDIT.md): alignment audit against the original design conversation.
- [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md): supported DSH/Node baseline and known constraints.
- [LICENSE](LICENSE): MIT license text.

## FAQ

**Is this the same thing as MiOpIIk IUI?**
No. Agent (`miopiik-dsh`) is the working core: Mind / Ink / Operator, ledgers, dispatch, commit gate. IUI (`miopiik-iui`) is a separate presentation plugin that renders declarative `iui` blocks. Install either or both; neither depends on the other.

**Do I need to restart DSH after installing?**
Yes. Host plugins are loaded when the DSH process starts. Restart the process for the target profile; refreshing the browser is not enough.

**Where is my data?**
In the workspace, under `.dsh/miopiik/` (or the configured `stateRoot`): per-session ledgers, workspace-scoped facts, and the detail store. It is plain-text JSONL and stays there after upgrade, rollback, or uninstall.

**Can I use the Agent without IUI?**
Yes. The Agent does not render chat UI and does not require IUI. Its own backstage panels and plugin pages work without IUI.

**Are old sessions still there after the split?**
Yes. Session ledgers are not migrated or deleted. Old widget snapshots remain readable; if IUI is installed, its read-only legacy adapter can replay them. This repository does not promise that old widget entries can be edited again.

## Limitations

This list is intentionally not polished.

- **No npm release.** The package is distributed as a GitHub Release tarball, a local `npm pack`, or a checkout. There is no registry package to depend on.
- **DSH Web only.** The plugin is built and tested against the `web` profile and DSH 0.2.1-rc.5. Other hosts, profiles, and DSH versions are unverified, and host API drift can break it.
- **Unofficial plugin.** It is not maintained by the DeepSeek Harness project and depends on host services that are not a stability guarantee.
- **No performance or scale benchmarks.** No load testing, no large-ledger benchmarks, no cost measurements. Compilation adds an extra LLM call after qualifying turns when `conversationCompile` is enabled, and every dispatched job is an extra background agent; budget accordingly.
- **No secret scanning.** The ledger keeps dialogue text as written. The plugin does not detect or redact secrets.
- **Old display data is read-only.** Legacy widget snapshots are preserved and replayable, but the current Agent creates no new widget records and does not edit old ones.
- **Host-service dependencies.** The commit gate needs the host `userQuestions` service; fold application needs the host compaction service. Without them, the gate refuses to open and a fold is recorded but not applied to the context, respectively.
- **Not a second assistant.** Ink does not answer the user, and the plugin does not auto-commit, auto-send, or run unattended outward actions.

## Repository split

This repository is the continuation of the original MiOpIIk monorepo, which remains at https://github.com/Chillizu/miopiik. The Agent package moved from its subdirectory in the monorepo to the repository root; the git history and the existing tags and releases were preserved.

The presentation plugin was extracted into its own repository, https://github.com/Chillizu/miopiik-iui, with its own history and its own prerelease line (currently 0.1.0-rc.4). The historical Extra display layer stays archived at https://github.com/Chillizu/miopiik-extra. Session data is not migrated between repositories; it stays in the workspace ledgers described above. See [docs/MIGRATION.md](docs/MIGRATION.md) for the detailed mapping.

## Contributing

Issues and pull requests are welcome at https://github.com/Chillizu/miopiik.

- Keep the split honest: the Agent repo must not re-embed the IUI renderer (`npm run build:check` guards this).
- Match the existing style: Node ESM, relative imports, zero third-party runtime dependencies, no build step for the host code.
- Put tests in `test/*.test.js` and use `node:test`; tests must be green before a pull request is merged.
- Run `npm test`, `npm run check`, `npm run build:check`, and `npm run icon:check` locally.
- Architecture or data-model changes should update `SPEC.md`, the single source of truth, in the same change.
- Do not add generated tarballs or caches to the repository; `.dsh/` is ignored.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Chillizu.
