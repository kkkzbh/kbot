# Testing Policy

CI tests are a release gate. Keep each test tied to a stable product or deployment contract.

## Keep tests for core contracts

Add or keep tests when they protect one of these contracts:

- User-visible behavior, protocol shape, data persistence, migration, permissions, privacy, or security boundaries.
- Deployment phase boundaries that prevent long or unsafe production failures.
- Runtime artifact contracts required to start the bot.
- Parser, normalization, scheduler, queue, memory, and provider routing behavior where regressions are hard to detect manually.

## Avoid low-value assertions

Do not add tests that only pin incidental implementation details. Examples:

- Exact shell command formatting, quoting style, action pin strings, or YAML line layout when the behavior is already covered by a stronger contract test or by syntax validation.
- Large cross-domain “config dump” assertions in an unrelated test file.
- Duplicate assertions that fail for the same underlying change as an existing targeted test.
- Negative assertions for old code paths after the path has been removed, unless the old path is likely to be reintroduced and would create a production risk.

## Prefer stable contract tests

For deployment and scripts, prefer a small number of boundary checks:

- Which phase owns the work: build, prepare, activate, or verify.
- Whether server activation can run only after a prepared release marker exists.
- Whether ordinary deploy uses `koishi` scope and full PMHQ/LLBot checks are explicit.
- Whether server prepare consumes CI-built artifacts and does not generate build artifacts.

Use script syntax checks such as `bash -n`, workflow validation such as `actionlint`, and full unit tests as verification commands. Do not replace these tools with brittle string snapshots.

## Placement

Put tests in the narrowest relevant file. Do not place deploy, systemd, or runtime-script assertions in voice, memory, reply, or UI tests. Cross-file contract tests belong in a dedicated `*-contract.test.ts` file.
