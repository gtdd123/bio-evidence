# T00 neutral execution validation

Date: 2026-10-09 (Asia/Shanghai)

This complements `T00-preparation.md`. T00 prepares tools and checks; it does not claim platform implementation or an artificial feature TDD Red.

## Implemented setup

- `scripts/bio-launch.mjs` resolves the ignored project-local Bun manifest, enforces version 1.3.10, uses an explicit neutral config and a purpose-specific new runtime directory, and filters inherited environment variables.
- `scripts/bunfig.bio-bootstrap.toml` has no original interceptor preload and retains the required hoisted install layout.
- Normal commands reject automatic `.env` files by filename without reading their values. Bun 1.3.10 predates `--no-env-file`; examples remain allowed, real backend secrets are not loaded into the build environment.
- Callers cannot override cwd/config/preload/env-file/defines, use their short aliases, or select a global executable. No global HOME/CODEX_HOME or Git setting is changed.
- Fixture cleanup checks both resolved and real absolute paths inside the owned test parent before recursive removal.

## Observed setup issue and correction

The initial Node validation returned exit 1: three environment/argument/dotenv checks passed, but the neutral subprocess check had no expected stdout. Controlled probes ran only in a new project-owned fixture with a harmless preload sentinel.

Observed Bun 1.3.10 behavior:

- A separated `--config <path>` did not suppress the fixture's default preload.
- The inline `--config=<path>` was recognized.
- Declaring an empty `preload = []` caused `Expected preload to be an array` in this pinned version.

The launcher was corrected to inline config after the subcommand, the neutral file omits preload declarations, and integration executes the launcher's actual generated argument list. The fixture default preload is now demonstrably not executed. No original interceptor or real Craft user directory was used in the probes.

## Actual commands and results

Working directory: `work/bio-evidence`.

```text
node --test scripts/__tests__/bio-launch.test.mjs
node scripts/bio-launch.mjs bootstrap --version
git diff --check
```

The successful test run reported 4 tests, 4 pass, 0 fail, 0 skipped. The version query printed `1.3.10`; the whitespace check reported no errors. A later final verification includes the additional reserved short-alias cases.

The four checks cover filtered inherited credentials without parent mutation, forbidden override/global runtime (including `--import` and `--import=<path>` preload aliases), filename-only dotenv rejection, and the actual pinned Bun honoring neutral configuration while a default preload sentinel remains absent.

The independent judge found a missing `--import` alias using its own synthetic hook. T00 was held at REVISE; both alias forms are now rejected before subprocess creation and included in the actual argument regression. This is a corrected setup finding, not a claim that the original SDK profile is safe.

## Scope and limitations

The source snapshot, portable runtime and ignore evidence are recorded separately in `T00-preparation.md`. No dependencies, SDK/application, normal Bun preload, model request, actual experimental data or GitHub publication has been executed. Safety of the real interceptor and SDK paths remains T01/T02 work. T00 is submitted to the independent judge before advancing.

## Independent decision

2026-10-09: `/root/independent_judge` independently reran the Node suite (4 pass, 0 fail, exit 0), checked the corrected `--import` rejection and whitespace diff, then issued **PASS**, authorizing T01. No user credential or original profile was used in this approval.
