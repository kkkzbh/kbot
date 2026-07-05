# Testing Policy

CI tests are a quality gate. Keep each test tied to stable product behavior or a runtime contract.

## Keep tests for core contracts

Add or keep tests when they protect one of these contracts:

- User-visible behavior, protocol shape, data persistence, migration, permissions, privacy, or security boundaries.
- Runtime artifact contracts required to start the bot.
- Parser, normalization, scheduler, queue, memory, and provider routing behavior where regressions are hard to detect manually.

## Avoid low-value assertions

Do not add tests that only pin incidental implementation details. Examples:

- Exact shell command formatting, quoting style, action pin strings, or YAML line layout when the behavior is already covered by a stronger contract test or by syntax validation.
- Large cross-domain “config dump” assertions in an unrelated test file.
- Duplicate assertions that fail for the same underlying change as an existing targeted test.
- Negative assertions for old code paths after the path has been removed, unless the old path is likely to be reintroduced and would create a production risk.

## Prefer stable contract tests

For runtime scripts, prefer boundary checks over incidental string snapshots. Verify the user-visible contract, required artifact shape, or startup preflight behavior. Use script syntax checks and full unit tests as verification commands when they add coverage.

## Placement

Put tests in the narrowest relevant file. Do not place runtime-script assertions in voice, memory, reply, or UI tests unless the script is the direct owner of that feature.
