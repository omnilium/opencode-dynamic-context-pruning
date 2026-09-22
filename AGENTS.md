# opencode-dynamic-context-pruning

DCP is an OpenCode plugin that lowers token usage by replacing stale conversation content with summaries and
placeholders before each model request. One package, `@omnilium/opencode-dcp`, carries both hosts: the **V1** plugin
entrypoints and the **V2** `@opencode/plugin` setup/TUI modules. ESM TypeScript on pnpm (`packageManager`),
AGPL-3.0-or-later.

## Layout

| Path                  | Role                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`            | default export `{ id, setup, server }` — `server` is the V1 plugin, `setup` is the V2 plugin from `lib/v2/index.ts`            |
| `tui.tsx`             | default export `{ id, setup, tui }` — `tui` is the V1 TUI module, `setup` is the V2 TUI plugin from `lib/v2/tui.tsx`           |
| `server.js`           | V1 server entrypoint; re-exports `dist/index.js`                                                                               |
| `lib/v2/`             | V2 adapters — server `index`, `messages` projection, `rpc`, `language-strip`, `notify`, TUI                                    |
| `lib/compress/`       | `compress` tool pipelines (range and message modes)                                                                            |
| `lib/messages/`       | context transforms — inject, prune, query, sync, reasoning-strip                                                               |
| `lib/state/`          | session state and persistence                                                                                                  |
| `lib/strategies/`     | automatic pruning — deduplication, purge-errors                                                                                |
| `lib/commands/`       | `/dcp*` command handlers                                                                                                       |
| `lib/prompts/`        | system/nudge prompts and the custom-prompt store                                                                               |
| `lib/tui/`, `lib/ui/` | panel dialogs, notifications, formatting                                                                                       |
| `tests/`              | `node:test` suites; `tests/lab/` is the Docker integration harness; `tests/logger/` is the `opencode-request-logger` workspace |

`pnpm run build` cleans `dist`, bundles **only `index.ts`** with tsup (ESM, sourcemaps, `jsonc-parser` inlined), then
emits declarations. `tui.tsx` and `lib/` ship as TypeScript source — the host transpiles them.

## Checks

Run before every commit, and read the output:

```sh
pnpm run format:check    # prettier
pnpm run typecheck       # tsc --noEmit, then the request-logger workspace
pnpm test                # node:test DCP suites, then request-logger tests
pnpm run build           # tsup + declaration emit
pnpm run check:package   # build + verify the publishable package
```

`check:package` is required before publishing (`prepublishOnly`). CI mirrors format/typecheck/build/test and adds `pnpm
audit --audit-level high`. There is no linter; `tsc` is the only static gate.

## V1 vs V2

Both hosts ship from this one package. Exercise both when changing shared behaviour. Differences that bite:

- **ID format.** V2 uses compact refs — `@1@` messages, `@b2@` blocks, `@blocked@`, optional `[low|medium|high]`
  priority. V1 uses XML — `m0001`, `<dcp-message-id>` tags, `bN`. `IdFormat` is `"xml" | "compact"`; `state.idFormat`
  selects it and V2 paths pass `"compact"`. Never mix formats within one host's context.
- **Wiring.** V1 installs `experimental.chat.*` hooks, a `tool` map, and command handlers from `lib/hooks.ts`. V2
  registers through `ctx.*.transform`/`hook` in `lib/v2/index.ts` and ships its TUI in `lib/v2/tui.tsx`.
- **Notifications.** V1 uses model-invisible "ignored" chat messages. V2 has no equivalent, so it emits the `notify` RPC
  event and the TUI shows a toast; `lib/v2/index.ts` forces `pruneNotificationType` to `"toast"`.
- **Output text.** V2 exposes no output-text hook, so `lib/v2/language-strip.ts` wraps the resolved AI SDK language
  model to strip echoed ID tags from `doStream` deltas and `doGenerate` content.

## Testing

- DCP suites are `tests/*.test.ts` run by Node's built-in runner via `node --import tsx --test` — not Vitest. Put a
  `tests/<area>.test.ts` next to the behaviour it covers.
- `tests/logger/` is the `opencode-request-logger` workspace: request capture and relay for dev and the sandbox. It has
  its own build and tests, reached through the root scripts.
- `scripts/lab.mjs` packs DCP and the logger with `pnpm pack`, then runs the Docker image `dcp-lab:2.0.4` (built from
  `tests/lab/Dockerfile`) against a mock provider over HTTP and WebSockets, V1 and V2. `--built` reuses the last DCP
  build; `--live` uses saved V2 auth and the real `openai/gpt-5.6-sol` model.
- `pnpm run sandbox` opens an interactive Docker sandbox (`--v1`/`--v2`, `--model`, `--transport`). Copied credentials
  are never written back to the host.

## Conventions

Apply the house rules through their skills — `writing-ts`, `writing-markdown`, `writing-workflows`, `writing-docker`,
`writing-commits` — rather than restating them here. Repo-specific:

- **Prettier owns formatting**: 4-space indent, no semicolons, double quotes, `trailingComma: all`, `printWidth: 100`
  (`.prettierrc`). No ESLint.
- **`README.md` is the human-facing doc; `CONTRIBUTING.md` the dev guide.** This repo has no `docs/` tree; reconcile
  both in the same change as the behaviour.
- **`dcp.schema.json` and the README default-config block mirror `lib/config.ts`.** A new config key means updating all
  three.
- Config resolves global `~/.config/opencode/dcp.jsonc` → `$OPENCODE_CONFIG_DIR/dcp.jsonc` → project
  `.opencode/dcp.jsonc`, each overriding the previous.
- Session state persists to `~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json`.
- Custom prompts (off unless `experimental.customPrompts`) live under `~/.config/opencode/dcp-prompts/` or
  `$OPENCODE_CONFIG_DIR`; `defaults/` is reference-only and only `overrides/` is read.

## Gotchas

- **Never use `synthetic()` for display.** Its text enters the model's context; V2 display goes through the `notify` RPC
  event to a toast.
- **Keep the ID-strip patterns suffix-anchored** in `lib/v2/language-strip.ts`: a hallucinated tag is newline-prefixed
  and lands at the end, so mid-text IDs and email addresses must survive.
- **`jsonc-parser` is inlined** by tsup (`noExternal`) because its ESM imports are broken — don't drop that.
- V2 `compress` permission `"ask"` is unsupported by the public plugin API and surfaces as an error rather than a
  prompt.
