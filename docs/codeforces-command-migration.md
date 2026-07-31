# Codeforces command migration

## Objective

Move every Codeforces query out of the ChatLuna Agent tool loop and into a deterministic Koishi command service. The provider and image renderers remain shared implementation details. The deployed release must expose one execution path only: commands.

## User contract

| Command | Result |
| --- | --- |
| `cf <handle>` | Profile summary and profile card |
| `cf.rating <handle>` | Rating history and rating chart |
| `cf.submissions <handle> [limit]` | Recent submissions, with a bounded limit |
| `cf.contests [mode] [limit]` | Contest list; `mode` accepts the modes already supported by `CodeforcesProvider` |

Invalid arguments are rejected before an upstream request. Provider failures retain the failed operation, upstream HTTP status, and Codeforces error text where available. Commands send the rendered image before their concise text summary without passing through `StructuredReply` or the general reply action reorderer.

## Ownership and data flow

```text
QQ message
  -> Koishi command parser
  -> Codeforces command handler
  -> CodeforcesProvider
  -> renderCodeforcesProfileCard / renderCodeforcesRatingChart (when applicable)
  -> QQ message sender
```

`src/plugins/oj-tools/provider.ts` owns Codeforces API access, validation, rate limiting, and cache behavior. `src/plugins/oj-tools/render.ts` owns image artifacts. The plugin entry owns command registration and user-visible formatting. ChatLuna, ToolPolicy, context presets, and the Agent reply pipeline have no Codeforces responsibility after the cutover.

## Implementation sequence

1. Replace the four `chatluna.platform.registerTool` registrations in `src/plugins/oj-tools/index.ts` with the four command contracts above. Keep provider and renderer inputs typed and shared; remove the tool schemas and session-dependent tool wrappers.
2. Send command results directly from each handler. Profile and rating commands send the stored image asset first, followed by the concise structured summary. Submissions and contests send deterministic text.
3. Remove the four Codeforces entries from `src/plugins/tool-policy/catalog.ts` and remove the Codeforces Plugin card from the Agent catalog in the same change set.
4. Remove the Codeforces tool instruction from `src/plugins/shared/llm/reply-output-contract.ts`.
5. Remove Codeforces-specific image reordering from `src/plugins/reply/pipeline/resolver.ts`; direct command handlers already own send order.
6. Replace Agent scenario tests with command contract tests. Retain provider and renderer tests unchanged where their public behavior remains valid.

## Required tests

- Command registration exposes exactly the four public commands and no ChatLuna tools.
- Each command validates missing/invalid arguments without calling `CodeforcesProvider`.
- Profile and rating commands emit image then text.
- Submissions and contests enforce bounded limits and preserve provider errors.
- ToolPolicy and Agent state contain no `cf_*` entries after the migration.
- The reply semantic contract and reply pipeline contain no Codeforces-specific rules.

## Verification

```bash
pnpm vitest run tests/oj-tools-plugin.test.ts tests/oj-tools-provider.test.ts tests/oj-tools-render.test.ts
pnpm vitest run tests/tool-policy.test.ts tests/chatluna-model-guard.test.ts tests/reply-pipeline-v3.test.ts
pnpm build
```

The migration ships atomically. There is no period where Agent tools and commands are both enabled, and no alias or compatibility handler remains after deployment.
