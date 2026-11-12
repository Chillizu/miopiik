# MiOpIIk IUI for DeepSeek Harness

**Independent presentation plugin, MiOpIIk family.** A DSH chat message can contain ordinary Markdown, small inline tokens and locally interactive, declarative `iui` blocks. The plugin does not need the MiOpIIk Mind/Ink/Operator agent, its event log, or its tools.

> Version 0.1.0-rc.1 — local release candidate, not an upstream DSH feature or a published package yet.

## What it provides

- Inline: `{{badge:success:完成}}`, `{{icon:check}}`, `{{code:status}}`
- Fenced `iui` containing `miopiik-ml` or a validated `iui/1` JSON AST
- Metric, card, grid, table, bar/line chart, progress, callout, empty state and local segmented controls
- Strict schema, bounded state and table data, safe links, local error isolation
- Own short host output contract, instead of the legacy `ink_view` / `ink_chart` tool surface
- No arbitrary HTML, JavaScript, CSS, network calls or model round-trips from IUI controls

Example (actual Markdown with an `iui` code fence):

~~~md
测试完成 {{badge:success:通过}}。

```iui
<ui title="周活跃" fallback="周一 12，周二 19">
  <column>
    <metric label="累计" value="31" unit="次"/>
    <chart kind="line" series='[["周一",12],["周二",19]]' source="演示数据"/>
  </column>
</ui>
```
~~~

## Installation in a DSH Web profile

This DSH release does not yet provide an official Markdown AST embed API. The plugin therefore ships a **version-pinned, fail-closed patch generator** for `@deepseek-ai/dsh-client-ui-chat`. The patch preserves native `AssistantMarkdown` and `ReasoningRow`, but it is still an experimental fork.

1. Add `miopiik-iui` to the profile dependencies and DSH profile bundle list. In a local development profile you can use `link:/path/to/miopiik-iui` and ensure the profile's `node_modules` resolves the package.
2. Run `node miopiik-iui/tools/build.mjs --check`. On first install, create the patched fork using `node miopiik-iui/tools/fork-chat-embeds.mjs` in a controlled staging environment, then run `node miopiik-iui/tools/fork-chat-embeds.mjs --check`. The `--check` command is read-only and requires the fork to exist.
3. Point only that profile's `@deepseek-ai/dsh-client-ui-chat` dependency to `miopiik-iui/upstream/dsh-client-ui-chat-embeds`; do not overwrite DSH's global package. Ensure the fork's `node_modules` dependency link is intact.
4. Back up the original profile configuration and fork; confirm DSH has no active task; restart the DSH Web service.
5. In that browser, enable the experimental renderer with `localStorage.setItem('miopiik.markdownEmbeds','1')` and refresh.

**Rollback:** set the browser key to `'0'` and refresh, or restore the profile's previous ui-chat resolution and restart. Historical messages remain untouched.

The current client hook splits Markdown into pieces; cross-token formatting, selection/copy semantics, streaming incomplete fences and accessibility require more work. Do not claim that the upstream Markdown AST extension is complete.

## Development and verification

Run from the monorepo root:

```sh
node miopiik-iui/tools/build.mjs --check
node miopiik-iui/tools/fork-chat-embeds.mjs --check
npm test
```

The protocol source of truth lives in `miopiik-iui/shared/`, the React renderer in `miopiik-iui/renderer.js`. `client.js` is generated and must not be manually edited.

`miopiik-dsh` is a separate optional sibling application. Its older Widget tools are retired from active registration, but historical Ink data are not erased.

## Release gates

Before external release, verify packaging, DSH profile installation from **only this package**, theme and narrow-screen rendering, native reasoning fold, local interactions, error isolation, and compatibility with the exact DSH version claimed. Do not publish the generated fork as a replacement for the official package.
