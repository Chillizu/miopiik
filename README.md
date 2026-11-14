# MiOpIIk Agent

<img src="icon.svg" width="96" alt="MiOpIIk icon">

**Version 0.1.1** (stable) | English | [简体中文](README.zh-CN.md)

`MiOpIIk` = `Mi`(nd) + `Op`(erator) + `IIk`(ink).

`miopiik-dsh` is a host-side plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It structures a DSH Web conversation around three layers: one foreground role (`Mind`), one middle ledger (`Ink`), and one background execution layer (`Operator`). It adds a prompt charter, a scoped tool surface, append-only JSONL ledgers, background dispatch, and session projections.

**Current release:** 0.1.1 (stable). Install from the GitHub Release tarball, a local `npm pack`, or a checkout path; the package is not published to the npm registry.

## What MiOpIIk is

In a single-loop tool-calling chat session, long or multi-turn tasks either block the foreground turn or run detached in the background without shared state. Giving a middle coordinator direct access to the chat stream introduces competing voices and unverified claims.

MiOpIIk separates conversation, bookkeeping, and execution into three layers and restricts user-facing speech to one role:

- **Mind** is the conversation trunk and the sole user-facing role. It discusses options, makes decisions, closes open loops, and proposes outward changes through the commit gate.
- **Ink** is the backstage memory and compiler. After each turn it records user input and final assistant output, compiles candidate conclusions and open loops, maintains the tiered inbox, monitors background jobs for timeouts and stalls, and prepares context folds and cross-day handoff material. It does not speak to the user or make decisions for the conversation.
- **Operator** is the execution layer. It receives a validated six-part contract and a fishbone branch slice (fork premise, verbatim quotes, dependent facts) without the chat transcript. It reports results or failures back through `ink_report` and stays out of the conversation stream.

Two timelines run in parallel: a foreground sequence of conversation turns and a background sequence of asynchronous jobs. Ink keeps both aligned in the workspace ledger.

![Architecture: one conversation, two timelines, three layers](docs/images/report-2026-11-10/architecture.png)

In the repository's architecture figure above, the upper band represents this Agent. The lower band ("Extra display layer") is retired; its design history is recorded in the IUI repository's [docs/EXTRA-UI.md](https://github.com/Chillizu/miopiik-iui/blob/main/docs/EXTRA-UI.md), and current display work lives in the separate MiOpIIk IUI plugin.

## MiOpIIk Agent and MiOpIIk IUI

The two plugins are independent packages. Each can be installed alone; neither requires the other.

| | MiOpIIk Agent (`miopiik-dsh`) | MiOpIIk IUI (`miopiik-iui`) |
|---|---|---|
| Role | Host-side agent: Mind / Ink / Operator | Pure presentation layer |
| Current version | 0.1.1 (stable) | 0.1.0-rc.4 (prerelease) |
| Repository | https://github.com/Chillizu/miopiik | https://github.com/Chillizu/miopiik-iui |
| Depends on the other plugin | No | No |
| Can be installed alone | Yes | Yes |
| What it renders | Tools, prompt context, a conversation view, and a right sidebar panel; no chat message rendering | Declarative `iui` blocks and inline tokens in Markdown; browser-side rendering |
| Where it writes | Append-only JSONL ledgers under the workspace | One browser-local preference in `localStorage`; no logs |
| Host requirement | DSH Web profile | DSH Web profile; inline rendering requires an experimental chat-package patch |

**Agent provides the Mind / Ink / Operator runtime and backstage panels; IUI provides optional declarative presentation.** Installing only the Agent gives the full governance and ledger machinery. Installing IUI adds inline badges and block components for comparisons, trends, and local state controls.

The earlier Extra display layer is retired (see [docs/EXTRA-UI.md](https://github.com/Chillizu/miopiik-iui/blob/main/docs/EXTRA-UI.md)). Existing `ink-view` widget snapshots remain readable in the ledger and can be replayed read-only by IUI's legacy adapter. The current Agent writes no new widget records.

## Architecture and data flow

The host runtime lives in `host/`, the browser side in `client.js`, and the plugin entry point in `index.js`.

A turn moves through seven stages:

1. **Observe.** When a turn ends, Ink appends the user's real prompt and the assistant's final message to `observations.jsonl`. Reasoning traces are excluded.
2. **Compile.** When `conversationCompile` is enabled, Ink reads its middle-layer context and recent utterances to produce candidate notes: a one-line claim, a user-answerable question, confidence, evidence, and a contradiction flag.
3. **Deliver.** Notes enter the inbox as tiered previews (T0 blocking, T1 linked to an active loop or branch, T2 new conclusion, T3 other). Mind decides whether and when to surface an inbox preview in conversation.
4. **Act.** Mind updates the ledger through the `ink_*` tools: register or close loops, write fact cards with provenance, open a fishbone branch, store a draft, or propose an outward change through the commit gate.
5. **Dispatch.** `ink_dispatch` validates the six-part contract, opens a `pending-dispatch` loop and a background job, attaches the branch slice, and starts an Operator child agent with the contract and slice.
6. **Report.** The Operator returns a conclusion with evidence through `ink_report` (stored as a fact card) or through its final output. Ink compiles the report into an inbox preview and marks any contradiction with an exact `U-n` utterance reference. Watchdogs report stalls and timeouts as T0 blocking previews.
7. **Fold and hand off.** Topic switches advance the epoch; long contexts fold in two phases; end-of-day handoffs produce a five-part briefing written by Mind. When an overnight hard break is detected, the next session surfaces the break point in L3 before continuing.

Each turn's prompt context (L3) is assembled from active loops and inbox previews and injected into the system prompt; Ink's index stays out of the user/assistant message stream.

### Ledger layout

All state is stored as append-only JSONL under the workspace. File names are defined in `host/store.js` (`LOG_NAMES`).

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

Ledgers are plain-text JSONL files. On session open, each file is replayed in order; malformed lines are skipped, and read-time migrations keep the on-disk files unchanged.

### The tool surface

Twelve tools are registered for Mind and two for Operator.

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

Tool boundaries are enforced in `index.js`: Operator child agents are denied the twelve Mind tools and receive no chat transcript, while Mind is denied `ink_ask` and `ink_report`. Users can also close a loop or invalidate a fact directly from the UI via the `/miopiik loop close L-1`, `/miopiik loop drop L-1`, and `/miopiik fact invalidate F-1` session commands and their buttons.

## What it can do

- **Open loops.** A loop records an unresolved point between Mind and the user: an unanswered question, an awaiting-user item, a pending option, a promise, a pending dispatch, or a forming intent. Loops carry no due dates or assignees. They age on the day axis: dormant after `dormantAfterDays`, folded to one line after `foldedAfterDays`, and revived when touched. Mind alone closes or drops loops; Ink only marks candidates that appear answered. `activeLoopCap` bounds the active set in L3.
- **Fact cards with provenance.** Settled conclusions are stored with provenance, confidence, validity, and scope (`session` by default, `workspace` when shared across sessions). User-stated facts take precedence over Operator reports. When answering from memory, Mind cites a fact card or precedent; when no citation exists, the question escalates.
- **Fishbone branches.** A branch (`B-n`) anchors a line of work to the turn where it forked, storing the fork premise, verbatim quotes from the trunk, and dependent fact ids. Operator receives only that slice. When the work finishes, the branch merges back into the trunk with a one-line claim and evidence.
- **Drafts and the commit gate.** Exploratory or low-confidence work is stored as a draft and expires after `draftExpireDays`. Outward changes go through `ink_commit` with a one-line title, a one-sentence summary, and a binary user choice ("行" / "不行"). Low-confidence commits and commits on turns without real user input are rejected at the gate. A user rejection marks the draft as rejected.
- **Compilation and contradiction tracking.** After qualifying turns, Ink compiles candidates from its middle-layer context. If a background result contradicts an earlier statement to the user, the compile pass flags the contradiction with the exact `U-n` utterance id for Mind to address.
- **Background dispatch and watchdogs.** `ink_dispatch` checks six contract fields: `goal`, `deliverables`, `acceptance`, `acceptanceSample`, `boundary`, and `budget`. Missing fields cause dispatch to reject and return the missing list. Exploratory dispatches (`draft: true`) require only `goal` and write their output to drafts. During execution, watchdogs monitor for stalls (`operatorStallMs` without new observations) and timeouts (`operatorTimeoutMs`) and deliver a T0 blocking preview when triggered.
- **Two-phase folding.** Folding is triggered by topic/session events. First, Ink proposes a shadow fold containing an archive and loop-settlement suggestions without modifying the active context. Second, Mind reviews the proposal against active open loops. Once approved, the fold is scheduled for the next turn boundary via the host compaction service; if compaction is unavailable, the fold is recorded in `folds.jsonl` and the active context remains unchanged.
- **Cross-day briefing.** At the end of a day, Mind writes a five-part briefing (`progress`, `loops`, `running`, `drafts`, `next`) using materials gathered by `ink_brief materials`. On the next day, L3 surfaces the latest briefing and any detected overnight hard break.
- **Backstage views.** The "MiOpIIk" conversation view displays the fishbone graph, branch stream, open loops, fact cards, running jobs, drafts, and daily briefing, plus a "Seen" tab with Ink's folded head, live tail, and compiled candidates. The right sidebar "Ink" panel shows loop counts, inbox previews, and recent decisions.
- **Plugin and settings pages.** `Plugins -> Installed -> MiOpIIk` presents an overview of the architecture, roles, version, and ledger path. **Settings -> Built-in plugins -> MiOpIIk Agent** lists the built-in defaults from `host/config-defaults.js` and a copyable `cordis.patch.yml` snippet. Both views are read-only; runtime values come from the active profile configuration.
- **Append-only ledger and replay.** Session state is persisted in workspace JSONL ledgers and replayed when DSH restarts.
- **Historical compatibility.** Existing session ledgers remain in place without migration. Legacy `widgets.jsonl` snapshots remain readable and can be replayed read-only by `miopiik-iui`.

## Illustrative usage

The examples below use the exact tool and parameter names from `host/tools.js` with illustrative dialogue.

### 1. A fact that should change future answers

**User:** "We use pnpm in this repository. Don't run npm install here."

**Mind:** records a fact card with `ink_facts`.

```json
{"action": "add", "claim": "This repository uses pnpm; do not run npm install here.", "provenance": ["user: turn 12"], "conf": "high", "source": "user", "scope": "session"}
```

**System:** appends the card to `facts.jsonl` and includes it in L3 on subsequent turns. If the convention changes later, Mind revises or invalidates the card.

### 2. A question that stays open

**User:** "Should the settings page keep the raw YAML example, or is the copy button enough?"

**Mind:** registers an open loop and continues the discussion.

```json
{"action": "add", "text": "Decide whether the settings page keeps the raw YAML example or only the copy button", "type": "pending-option", "pointer": "turn 18", "closureCondition": "The user picks one and the page copy reflects it"}
```

**System:** writes a `create` record to `loops.jsonl`. When the user answers in a later turn, Mind closes the loop by id:

```json
{"action": "close", "id": "L-7", "reason": "user chose the copy button only"}
```

Ink may mark the loop as a closure candidate, while Mind executes the close action.

### 3. A background job with a real contract

**User:** "Translate the report to English and run the test suite before you're done."

**Mind:** opens a fishbone branch anchored to this turn, then dispatches with a six-part contract.

```json
{"action": "open", "label": "report-translation", "summary": "Deliver an English report and a green test run", "forkedAtTurn": 34, "premise": "The user wants the existing report translated and verified in one background pass", "quotes": ["Translate the report to English and run the test suite before you're done."], "facts": ["F-4"]}
```

```json
{"goal": "Translate the report to English and run the test suite", "deliverables": "An English report file plus the test run output", "acceptance": "The English report exists and the test suite exits 0", "acceptanceSample": "A short English report; a test summary with no failures", "boundary": "Do not change the report's conclusions or the source code", "branch": "report-translation", "budget": "One background pass, no network access"}
```

**System:** creates a `pending-dispatch` loop, a job record, a task-board card, and an Operator child agent seeded with the contract and branch slice. On completion, Operator reports its conclusion:

```json
{"claim": "The English report is complete and the test suite passes", "conf": "high", "evidence": "docs/report.en.md; test run exited 0"}
```

Ink compiles the report into an inbox preview. Mind reads it with `ink_inbox {"action": "open", "id": "I-6"}`, merges the branch with `ink_branch {"action": "merge", "id": "B-3", "claim": "English report delivered; tests green", "detail": "docs/report.en.md"}`, and reports the outcome to the user.

### 4. The commit gate and the end of a day

**User:** "Ship the shorter settings copy, but ask me before it goes out."

**Mind:** saves a draft, then opens the commit gate.

```json
{"action": "add", "title": "Shorter settings page copy", "summary": "Replace the configuration page text with the shorter version", "artifact": "docs/draft/settings-copy.md", "conf": "mid"}
```

```json
{"title": "Settings page copy", "summary": "Shorter configuration text; no behavior change.", "confidence": "high", "draftId": "P-3"}
```

**System:** prompts the user with the options 行 / 不行. "行" marks the draft committed; "不行" marks it rejected. Low-confidence commits are rejected before prompting the user.

At the end of the day Mind saves a handoff briefing:

```json
{"action": "save", "progress": "Settings copy shortened and shipped", "loops": "L-7 closed; L-9 still waiting on the release decision", "running": "No background jobs running", "drafts": "None", "next": "Start from the release decision, not from a summary of the day"}
```

**System:** appends the briefing to `briefings.jsonl` and loads it into the next session's L3 context and backstage view.

## Requirements and support

| Item | Requirement |
|---|---|
| Host | DSH Web (`web` profile); host-side plugin |
| DSH baseline | 0.2.1-rc.5 (verified test and release baseline) |
| Node | >= 23.6 (`package.json` `engines`) |
| Runtime dependencies | None (zero third-party runtime dependencies) |
| Browser side | `client.js` (`platform: "web"`): conversation view, right sidebar, plugin page (`plugins.bundle.config`), and settings page (`settings.plugins.tab`) |
| Other platforms | Untested; requires DSH Web services (`tools`, `systemPrompt`, `sessionProjections`, `subagents`, `userQuestions`, `compaction`) |

See [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md) for the full compatibility matrix.

## Install, upgrade, uninstall, rollback

**This package is not published to the npm registry.** `dsh plugin add miopiik-dsh` with a bare package name cannot resolve it. Pass a GitHub Release tarball, a local `npm pack` tarball, or a local checkout path.

### From a GitHub Release (recommended)

1. Download `miopiik-dsh-0.1.1.tgz` and `SHA256SUMS.txt` from
   https://github.com/Chillizu/miopiik/releases/tag/miopiik-agent-v0.1.1
2. Verify the checksum: `sha256sum -c SHA256SUMS.txt`.
3. Install into the target profile: `dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz`.
4. Restart the DSH process serving that profile so the host plugin loads.

### From a local checkout

The repository root is the package root (`package.json` and `index.js` are at the root) with zero runtime dependencies.

```sh
git clone https://github.com/Chillizu/miopiik.git
cd miopiik
npm pack
dsh plugin --profile <profile> add ./miopiik-dsh-0.1.1.tgz
```

`npm pack` produces a local tarball only.

To install a working tree directly in link mode:

```sh
dsh plugin --profile <profile> add /path/to/miopiik
```

`tools/install-plugin.mjs` wraps both modes. It defaults to dry-run and requires `--allow-running-profile` before writing to the `web` profile:

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

Session ledgers live under the workspace `.dsh/miopiik/` directory and remain intact across uninstall, upgrade, and rollback.

### Uninstall

```sh
dsh plugin --profile <profile> remove miopiik-dsh
```

Restart the profile. Workspace ledgers remain on disk and are replayed if the plugin is reinstalled.

## Configuration

Configure the plugin under `config` in the profile's `cordis.patch.yml`. Omitted fields fall back to the defaults in `host/config-defaults.js` (`DEFAULTS`):

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: miopiik-dsh
  config:
    stateRoot: .dsh/miopiik
    activeLoopCap: 12
    conversationCompile: true
```

| Key | Default | Meaning |
|---|---|---|
| `stateRoot` | `.dsh/miopiik` | Ledger directory, relative to the workspace |
| `activeLoopCap` | `12` | Maximum active open loops before the oldest are folded into dormant in a fixed order |
| `dormantAfterDays` | `2` | Days without a touch before a loop goes dormant |
| `foldedAfterDays` | `7` | Days before a loop is folded into one line |
| `draftExpireDays` | `7` | Days before an untouched draft is discarded |
| `briefingMaxChars` | `1800` | Character cap for a handoff briefing (one screen) |
| `inboxPreviewChars` | `220` | Character budget for the previews injected each turn |
| `detailInlineMaxChars` | `1200` | Details longer than this become pointers to the detail store |
| `inkTailLimit` | `24` | Middle-layer context tail entries kept before folding into the head |
| `inkHeadMaxChars` | `2000` | Character cap for the middle-layer head summary |
| `operatorTimeoutMs` | `1200000` | Operator timeout in milliseconds (20 minutes) |
| `operatorStallMs` | `360000` | Time without a new observation before a running job is marked stalled (6 minutes) |
| `inkModel` | `null` | Model used for Ink compilation (`null` follows the session default; otherwise an object with `provider` and `model`) |
| `conversationCompile` | `true` | Let Ink read its own context and produce candidates after a turn (`false` records observations only) |

`Plugins -> Installed -> MiOpIIk` shows the plugin overview. **Settings -> Built-in plugins -> MiOpIIk Agent** displays the built-in defaults above and a copyable YAML snippet; it is read-only and reflects defaults, while effective runtime values come from the active profile.

## Security and permissions

- **Single write root.** The plugin writes only under `<workspace>/.dsh/miopiik` (or the workspace-relative `stateRoot`). It does not modify the DSH installation or profile directories.
- **Plain-text JSONL ledgers.** Ledgers are unencrypted and unredacted. User prompts and assistant replies are written to `observations.jsonl` on disk; avoid pasting secrets into the session.
- **No credential collection or telemetry.** The plugin reads no environment secrets, writes no credential files, and makes no direct network requests. LLM calls use the host's configured `ctx.llm` and `ctx.subagents` services.
- **Per-agent tool isolation.** `index.js` denies the twelve Mind tools to Operator child agents and denies `ink_ask` and `ink_report` to Mind. Operator child agents receive only the contract and branch slice.
- **User-gated commits.** Outward changes require `ink_commit` approval ("行" / "不行") on a turn with real user input and non-low confidence. UI controls do not grant execution approval.
- **Data-only compilation.** Compilation outputs are parsed as JSON data. Failed or malformed compiles fall back to a preview with the raw report attached in `detail`.
- **Single user-facing role.** Ink writes only to ledgers and the inbox; Mind controls all user-facing responses.

## Tests and development

```sh
npm test            # node --test
npm run check       # tools/check-release.mjs
npm run build:check # tools/build-client-rules.mjs --check
npm run icon:check  # tools/icon-check.mjs
```

| Command | What it checks |
|---|---|
| `npm test` | Unit and integration suite using Node's built-in test runner (`node:test`), with zero third-party test dependencies. |
| `npm run check` | Release readiness: required metadata, `npm pack`, unpacked file list against the runtime import graph, `node --check` on every shipped script, icon rules, and package size limits. Outputs a JSON report and exits non-zero on failure. |
| `npm run build:check` | Verifies that the Agent client does not embed the retired IUI / Widget renderer. |
| `npm run icon:check` | Validates `icon.svg` (SVG format, <= 256 KiB, no scripts or external references, `36x36` viewBox) and `exports["./icon"]` / `files` metadata. Accepts `--original <path>` for byte-for-byte comparison. |

All four commands run offline in a clean checkout without DSH installed, `~/.dsh`, Chromium, or network access.

CI: `.github/workflows/ci.yml` runs the commands above on pushes and pull requests.

Repository layout:

| Path | Content |
|---|---|
| `index.js` | Host plugin entry: session init, projection, tool registration, prompt charter |
| `host/` | Engine, ledgers, compile, fold, dispatch, operator, tools |
| `client.js` | Browser side: conversation view, right sidebar panel, plugin pages |
| `SPEC.md` | Architecture specification and invariants (single source of truth) |
| `test/` | `node:test` suite |
| `tools/` | Release checks, icon check, client renderer guard, install helper, dev scripts |
| `docs/` | Design notes, audits, historical reports, architecture figures |
| `locale/` | Plugin locale dictionaries |

Key documents:

- [SPEC.md](SPEC.md): architecture specification and invariants.
- [docs/ALIGNMENT-AUDIT.md](docs/ALIGNMENT-AUDIT.md): alignment audit against the original design conversation.
- [docs/SUPPORT-MATRIX.md](docs/SUPPORT-MATRIX.md): supported DSH/Node baseline and known constraints.
- [LICENSE](LICENSE): MIT license text.

## FAQ

**Is this the same package as MiOpIIk IUI?**
No. Agent (`miopiik-dsh`) provides the Mind / Ink / Operator runtime, ledgers, dispatch, and commit gate. IUI (`miopiik-iui`) is an independent presentation plugin that renders declarative `iui` blocks. Either or both can be installed.

**Do I need to restart DSH after installing?**
Yes. Host plugins load when the DSH process starts; restart the process for the target profile after installing or upgrading.

**Where is session data stored?**
Under `<workspace>/.dsh/miopiik/` (or the configured `stateRoot`) as plain-text JSONL files. It persists across upgrades, rollbacks, and uninstallation.

**Can I use the Agent without IUI?**
Yes. The Agent's tools, ledgers, backstage views, and settings pages operate without IUI.

**What happens to pre-split sessions?**
Session ledgers stay in place without migration. Legacy widget snapshots in `widgets.jsonl` remain readable and can be replayed read-only by IUI's legacy adapter; the current Agent creates no new widget records.

## Limitations

- **No npm registry publication.** Install from the GitHub Release tarball, a local `npm pack`, or a local checkout.
- **DSH Web only.** Tested against the `web` profile on DSH `0.2.1-rc.5` and Node `>= 23.6`. Other profiles and DSH versions are unverified.
- **Unofficial plugin.** Maintained independently of the DeepSeek Harness upstream project and subject to host service changes.
- **Extra model calls and background agents.** Enabling `conversationCompile` adds an LLM call after qualifying turns, and each `ink_dispatch` starts a background subagent. No load or cost benchmarks are bundled.
- **Unredacted plain-text ledgers.** Dialogue text is stored as written without secret detection or redaction.
- **Read-only legacy widgets.** Existing `widgets.jsonl` records are preserved for read-only replay; creating or editing widget records is retired.
- **Host service requirements.** `ink_commit` requires the host `userQuestions` service; context replacement on fold approval requires the host compaction service (when absent, approved folds are recorded in `folds.jsonl` only).
- **Single foreground voice.** Ink never replies to the user directly, and outward commits require explicit user confirmation in an interactive turn.

## Repository split

This repository continues the original MiOpIIk monorepo at https://github.com/Chillizu/miopiik. The Agent package moved from `miopiik-dsh/` to the repository root while preserving the git history, tags, and releases.

The presentation plugin was extracted to https://github.com/Chillizu/miopiik-iui (currently `0.1.0-rc.4` prerelease). The retired Extra display layer's history is archived in the IUI repository. Workspace session ledgers require no migration. See [docs/MIGRATION.md](docs/MIGRATION.md) for the full layout mapping.

## Contributing

Issues and pull requests are welcome at https://github.com/Chillizu/miopiik.

- Keep the package boundary clean: the Agent client must not re-embed the IUI renderer (`npm run build:check` enforces this).
- Follow the codebase conventions: Node ESM, relative imports, zero third-party runtime dependencies, and no host build step.
- Place tests in `test/*.test.js` using `node:test`.
- Run `npm test`, `npm run check`, `npm run build:check`, and `npm run icon:check` before submitting a pull request.
- Update `SPEC.md` alongside any architecture or data-model change.
- Keep generated tarballs and `.dsh/` out of version control.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Chillizu.
