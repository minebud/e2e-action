# Minebud E2E Action

Run Minecraft Bedrock end-to-end suites on Minebud from a GitHub workflow. The SDK records customer tests locally on the runner, uploads the validated bundle, and waits for the hosted run. The action writes a job summary and source annotations, then fails the job on test failure or a configured performance breach. A downstream `needs: e2e` job is blocked by that failure.

The action has no dependencies or build step. GitHub runs the committed JavaScript with Node 24; the code and tests also support Node 20 and 22.

## Quick start

1. Commit a Minebud suite and `minebud-e2e.json` to your repository.
2. Create an E2E-scoped CI API key and save it in `secrets.MINEBUD_API_KEY`.
3. Add the PR workflow below. Pin the action to a reviewed tag or full commit SHA.

Use `minebud/e2e-action@v1` (moves with compatible releases) or pin a release tag/commit SHA. The default SDK pin is JS 0.9.0, which adds CI metadata, slot waiting and source-mapped insight locations.

Set `server.speed` and `server.maxTicks` in `minebud-e2e.json` to bound spending. There are deliberately no speed or max-ticks action inputs: the SDK rejects those CLI flags.

## Example workflows

### Pull-request check

```yaml
# .github/workflows/minebud-pr.yml: PR check
on: pull_request
permissions: {contents: read}
concurrency: {group: minebud-e2e-${{ github.ref }}, cancel-in-progress: true}
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: minebud/e2e-action@v1
        with:
          api-key: ${{ secrets.MINEBUD_API_KEY }}
          baseline: default-branch
          max-regression-pct: 20
          fail-on-insight-severity: high
```

### Push-to-main deploy gate

```yaml
# .github/workflows/release.yml: gate a deploy on main
on: {push: {branches: [main]}}
permissions: {contents: read}
concurrency: {group: minebud-e2e, cancel-in-progress: false}
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: minebud/e2e-action@v1
        with: {api-key: "${{ secrets.MINEBUD_API_KEY }}", max-mspt-p95: 40, max-script-errors: 0}
  deploy:
    needs: e2e            # never runs if the E2E job failed
    runs-on: ubuntu-latest
    steps: [{run: ./deploy.sh}]
```

### Nightly regression

```yaml
# .github/workflows/minebud-nightly.yml: regression on the customer's minutes
on: {schedule: [{cron: "17 3 * * *"}], workflow_dispatch: {}}
permissions: {contents: read}
concurrency: {group: minebud-e2e, cancel-in-progress: false}
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: minebud/e2e-action@v1
        with: {api-key: "${{ secrets.MINEBUD_API_KEY }}", config: e2e/nightly.json, baseline: default-branch}
```

The nightly schedule uses the customer's own GitHub Actions minutes and Minebud tick credits. This action repository's CI runs on pushes to main and pull requests only, with no scheduled jobs.

## Inputs

Names and defaults match `action.yml`. Inputs are trimmed using GitHub's `INPUT_<NAME>` convention (uppercase, dashes retained). Every input is validated before SDK installation or submission, even if the key is missing. Invalid values fail the action without submitting a run.

| Input | Default | Meaning |
| --- | --- | --- |
| `api-key` | empty; required in metadata | E2E-scoped CI key. An empty value follows `on-missing-key`. |
| `sdk-version` | empty | Empty uses the integrity-verified pin; otherwise numeric `major.minor.patch`, 1–4 digits per component. |
| `working-directory` | `.` | Suite directory inside `GITHUB_WORKSPACE`. |
| `config` | `minebud-e2e.json` | Config path relative to the working directory. |
| `paths` | empty | Whitespace/newline-separated test paths relative to the working directory. Paths containing whitespace cannot be represented here; configure them in the suite instead. |
| `junit` | empty | Optional JUnit output path relative to the working directory. |
| `queue-timeout-minutes` | `15` | Slot waiting budget, 1–360 minutes, when the SDK supports it. |
| `wait-timeout-minutes` | `30` | Run waiting budget, 1–360 minutes. Legacy SDKs clamp this to 900 seconds. |
| `on-missing-key` | `skip` | `skip` or `fail`. |
| `fail-on-infra` | `true` | Whether SDK exits 3/4/5 fail the job. |
| `annotations` | `true` | Emit contained-source annotations, capped at 10 per severity. |
| `summary` | `true` | Write the job summary. Outputs are still written when disabled. |
| `max-mspt-p95` | empty | Maximum MSPT p95 in milliseconds; empty disables. |
| `max-script-hotspot-ms` | empty | Maximum customer-script hotspot self time in milliseconds; empty disables. |
| `max-script-errors` | empty | Maximum script error count; empty disables. |
| `fail-on-insight-severity` | `none` | `high`, `medium`, `low`, or `none`. |
| `baseline` | `none` | `default-branch`, a literal branch name, or `none`. |
| `max-regression-pct` | `20` | Maximum relative regression percentage, together with the absolute noise floor. |
| `min-regression-ms` | `2` | Absolute regression noise floor; both limits must be exceeded. |

Booleans must be exactly `true` or `false`. Numeric inputs must be finite and nonnegative; minutes must be 1–360. Metric/count/noise limits are capped at 1,000,000,000 and the regression percentage at 1,000,000. All file and directory inputs must remain within the workspace after normalization and symlink checks. Ref names must be 1–255 UTF-8 bytes, contain no controls or `..`, and not start with `-`.

## Outputs

| Output | Meaning |
| --- | --- |
| `run-id` | Minebud run identifier; empty without a result. |
| `status` | `result.status`, `skipped` for a missing key, or `error` without a result. |
| `result-path` | Absolute path to the result JSON; empty without a result. |
| `dashboard-url` | Validated dashboard run URL; details expire after 24 hours. |
| `mspt-p95` | MSPT p95 in milliseconds; empty if unavailable. |
| `script-hotspot-ms` | Maximum customer-script hotspot self time; empty if unavailable. |
| `regressions` | Single-line JSON array of all breached threshold/regression checks, or `[]`. |

Outputs are written to `GITHUB_OUTPUT` using collision-checked random multiline delimiters. The result is saved at `$RUNNER_TEMP/minebud/result.json`; upload it or the requested JUnit file in your own workflow if you need longer retention.

## Thresholds and baselines

| Input/check | Source | Breach |
| --- | --- | --- |
| `max-mspt-p95` | `metrics["mspt.p95"]` | Current value exceeds the limit. |
| `max-script-hotspot-ms` | Maximum `diagnostics.performance.nativeProfile.top[].selfMs` with nonempty `packUuid` | Customer script self time exceeds the limit. Requires `server.scriptProfiler`; engine-only rows do not count. |
| `max-script-errors` | `metrics["scriptErrors.count"]` | Count exceeds the limit. |
| `fail-on-insight-severity` | `insights[]` (SDK 0.9+), else `diagnostics.performance.insights[]` | `high`: any high. `medium`: any medium or high. `low`: any insight. `none`: disabled. A missing insights array counts as zero insights. |
| Baseline MSPT/hotspot regression | Current MSPT p95 / hotspot vs baseline `msptP95` / `scriptHotMs` | Both `current > baseline × (1 + max-regression-pct / 100)` **and** `current − baseline > min-regression-ms`. Equality is not a breach. |

Flat dotted metrics take precedence over a nested-path fallback. Missing metrics, missing/null baselines, failed baseline requests, and mismatched baseline speed or server type are **not compared**, never a pass or failure. Standard and Fast server timings are not comparable. The baseline API is queried with the current suite name, server type, and speed; any dimensions present in the returned baseline are also checked.

`baseline: default-branch` reads a valid `repository.default_branch` from the bounded GitHub event payload. When it is missing or invalid, scheduled runs fall back to a valid `GITHUB_REF_NAME`, since GitHub schedules run on the default branch. No other event borrows that ref: an unavailable default branch emits a warning and leaves regression checks **not compared**, without preventing the SDK run. A literal branch uses that ref directly. The action requests `GET /api/v1/e2e/ci/baseline?repository=&ref=&suite=&serverType=&speed=` with Bearer authentication, a 15-second timeout, no redirects, and a 64 KiB body limit. Response readers ignore unknown additive fields but validate known fields; missing metrics are null. Baseline failures produce a warning, not a synthetic passing comparison. The current pinned SDK does not send CI metadata, so baseline availability depends on a CI-capable SDK and server history.

## Exit behavior

The action exits only 0 or 1, not the SDK's raw exit code. Reporting and outputs are written before the exit decision, including for SDK errors without a result.

| SDK exit | Meaning | Job result |
| --- | --- | --- |
| `0` | Tests passed | Success unless a threshold breaches. |
| `1` | Tests failed | Failure. |
| `2` | Invalid tests/bundle | Failure. |
| `3` | API/auth/network | Failure by default; warning and success if `fail-on-infra: false`, unless a threshold breaches. |
| `4` | Plan/quota limit | Same infrastructure policy as exit 3. |
| `5` | Run error/timeout/cancelled | Same infrastructure policy as exit 3. |
| `130` | Interrupted | Failure. |
| Other nonzero | Unknown SDK failure | Failure. |

An empty key defaults to a notice, a skipped summary, `status: skipped`, and success. `on-missing-key: fail` makes it fail. Invalid inputs, installation failures, and invalid/missing result output on SDK exit 0 always fail.

## Summaries and annotations

The summary includes status (including `rejected`), run ID and dashboard link, metric tiles, failing tests and steps with expected/actual values, the top 10 insights and fixes, up to 5 customer script hotspots sorted by self time, object-location digest findings, threshold comparisons, weighted tick-credit billing when available, and annotation overflow. It is capped at 1,000,000 UTF-8 bytes with an explicit truncation note; lower-priority sections may be omitted. All customer text is HTML-escaped first, then Markdown-neutralized, including table separators.

The upcoming SDK contract supplies optional `location: {pack, packPath, repoPath, line, sourcePath?, sourceLine?}` and `githubUrl` on `diagnostics.performance.insights[]`, `diagnostics.performance.nativeProfile.top[]`, and CLI envelope `digest.items[]`. Steps may also supply `tests[].steps[].location`. Location precedence selects **whole pairs**, never mixing a path with another pair's line:

1. `location.sourcePath` with a valid positive integer `location.sourceLine`.
2. `location.repoPath` with a valid positive integer `location.line`.
3. Legacy insight `localFile`/`line`, step `source.file`/`source.line`, or hotspot `localFile`/`line`, when available.

New `sourcePath` and `repoPath` are **repository-relative**, resolved against `GITHUB_WORKSPACE`, even with a subdirectory `working-directory`. `pack`/`packPath` are metadata, not local resolution roots. Legacy paths remain working-directory-relative or absolute. Paths must stay within the workspace after normalization and realpath checks of existing symlink ancestors, and must not contain control characters. An uncontained selected location remains summary-only; it does not downgrade to a different path. Source lines refer to original code when a complete source pair is supplied, otherwise the shipped script or legacy call site.

Summary links prefer the supplied `githubUrl` only after strict validation: a string of at most 2048 characters, `GITHUB_SERVER_URL` unset or exactly `https://github.com`, HTTPS host exactly `github.com`, no credentials, explicit port or query, and `/<owner>/<repo>/blob/<ref>/<path...>` matching `GITHUB_REPOSITORY` case-insensitively. Decoded path segments must not be `.` or `..`; the fragment must be empty, `#L<n>`, or `#L<n>-L<m>` for positive line numbers. Raw whitespace, controls, and any of `< > " ' ( )`, backticks, square/curly brackets, pipes or backslashes are forbidden. The summary emits the validated URL's `href`. Missing/invalid URLs fall back to a source link built from the selected contained location and the PR head SHA (otherwise `GITHUB_SHA`), then escaped `path:line` text, then nothing. GitHub Enterprise Server links are not supported, including built-link fallbacks.

Annotations prioritize failing steps, high insights (errors), error digest findings, the top customer hotspot at its severity, medium insights (warnings), warning digest findings, then low insights (notices). The top customer hotspot (nonempty `packUuid`, finite nonnegative `selfMs`) gets a `Script hotspot` warning with `<function> self time <ms> ms` when locatable and its self time is at least 50 ms, escalated to an error only when `max-script-hotspot-ms` or `hotspot-regression` breaches. Digest items annotate only `error`/`warning` severities with an object `location`: title is `kind`, message is `message` plus ` (×<count>)` for count > 1. Legacy SDK 0.8.0 string/null digest locations are ignored. Duplicate level/file/line/title/message candidates are removed before each severity's cap of 10 **per step**; capped items and invalid insight/step/digest sources appear in annotation overflow. Workflow-command titles/messages are bounded to 200/4000 characters and escaped separately from summary text.

Run details (report, profiles, artifacts) expire **24 h** after the run, and the dashboard link stops working then. The job summary and artifacts you upload follow your GitHub retention settings.

## Installation, concurrency, and SDK compatibility

`sdk-pins.json` pins JS 0.9.0 (SHA-256 `962332d0e1bb7931644cff874249f8387b40eed13cc5e8ce5fb95faaa6b80e8a`). An explicit version equal to the pin still verifies its checksum. A different `sdk-version` emits a warning that integrity is not verified. Update pins only after reviewing the SDK release and artifact digest.

JavaScript downloads are limited to 32 MiB, use no redirects, time out after about 60 seconds, and retry network/5xx failures up to three attempts. SHA-256 is checked in constant time before offline npm installation with lifecycle scripts disabled. Windows npm invocation quotes action-controlled paths and rejects paths containing command-expansion characters.

Minebud permits one active run per account. Use workflow concurrency as shown for release/nightly jobs. A newer SDK exposing `--wait-for-slot` in its `help` receives `queue-timeout-minutes × 60` and `wait-timeout-minutes × 60`. The pinned SDK lacks the flag: the action emits one notice, omits it, and clamps `--wait-timeout` to at most 900 seconds. Its shorter API retry budget may still return an account-busy error.

SDK 0.9 result contract (pinned by `test/sdk-contract.test.mjs`, generated from the SDK's own `localizeResult` and `digest`):

- New SDKs attach CI metadata when `GITHUB_ACTIONS=true`; the action neither constructs nor uploads a second metadata format.
- Insights and hotspots are read from the SDK's localized top-level `insights[]` and `scriptHotspots[]`, falling back to `diagnostics.performance.insights[]` and `nativeProfile.summary.top[]` for older SDKs. Insight severities are the host's `high`, `medium` and `low`.
- `location` objects carry `repoPath`/`line` and, when a source map resolves, `sourcePath`/`sourceLine`, both workspace-relative, plus an optional `githubUrl`. Complete source pairs take precedence. Digest items carry the object in `codeLocation`; their string `location` is display text and is never parsed as a path.
- Legacy step sources `{file, line, column?}` and insight/hotspot `localFile` are working-directory-relative or absolute. Missing sources remain summary-only.

## Security

- **Never use `pull_request_target` for these workflows.** It can execute untrusted fork code with repository secrets. Fork PRs receive no secrets, so this action skips them by default; the notice identifies a fork when the event payload says so.
- Use an E2E-scoped CI key in `secrets.MINEBUD_API_KEY`, minimal `permissions: {contents: read}`, and a reviewed action tag or SHA. No GitHub token is required by the action.
- The API key is masked once and passed to the SDK only as `MINEBUD_API_KEY` in the child environment, never as argv. Installation/probe children receive no key; all `INPUT_*` variables are stripped from child environments. The authenticated baseline request uses the key only in the Bearer header.
- npm/pip/SDK log output is enclosed in random `stop-commands` regions; JSON stdout is captured rather than echoed. Workflow-command properties and messages are escaped. SIGINT/SIGTERM are forwarded while the SDK is running so it can cancel the hosted run.
- Baseline origin defaults to `https://minebud.dev`. `MINEBUD_API_URL` may override it with an HTTPS origin, or HTTP only on localhost. Credentials, paths, queries, fragments, and redirects are rejected before sending the key.

## Development

```sh
node --test
# Optional: verify the pinned SDK with its bundled local mock API, without network:
MINEBUD_E2E_TEST_TGZ=/path/to/minebud-e2e-0.9.0.tgz MINEBUD_E2E_TEST_SDK_SRC=/path/to/e2e-sdk-js node --test test/integration.test.mjs
```

Fixtures reduce the real SDK 0.8.0 warps result (plus the SDK 0.9.0 localized contract fixture) and identify spec-contract additions explicitly. Ordinary tests need no network. The integration test is skipped unless `MINEBUD_E2E_TEST_TGZ` and `MINEBUD_E2E_TEST_SDK_SRC` are set; it verifies and installs that tarball offline, spawns the checkout's mock runner, executes its golden suite through the action, and closes the mock process afterward.
