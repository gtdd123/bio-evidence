# T00 preparation evidence

Date: 2026-10-09 (Asia/Shanghai)

Scope: the approved T00 preparation substep only. This report does not mark all of T00 complete. The neutral launcher, bootstrap configuration, and sentinel validation are recorded separately by the task owner.

## Source copy and byte verification

- Original source: `D:/agent-helson/craft-agents付费版内参/craft-new/work/craft-agents-oss-main`.
- Original archive: `D:/agent-helson/craft-agents付费版内参/craft-new/craft-agents-oss-main.zip`.
- New repository: `D:/agent-helson/craft-agents付费版内参/craft-new/work/bio-evidence`.
- The destination was checked with `Test-Path` and did not exist. Resolved source/destination paths were checked against the authorized workspace before copying. No existing destination was overwritten, moved, or deleted.
- Native PowerShell `Copy-Item -LiteralPath $bioSourcePath -Destination $bioTargetPath -Recurse` completed with exit 0. Both source and initial copy contained 1,877 files.
- A read-only bundled Python 3.12.14 process, invoked with `-B -c` from the workspace root, compared SHA256 for every archive entry against both the original directory and the copy before Git or preparation files were added. It also compared the full relative filename sets.

Verification result (exit 0):

```json
{
  "archive_sha256": "ba48c941238e5fcf6ef6412c7fd53b30c863220ea81395e368013c38eb054871",
  "archive_files": 1877,
  "source_files": 1877,
  "target_files": 1877,
  "manifest_sha256": "a0c9cbaa8dadad40fa6e14a56b81e4b49a7e310170de03f8e2570b2f7bcd5480",
  "changed_source": [],
  "changed_target": [],
  "missing": [],
  "source_extra": [],
  "target_extra": []
}
```

The manifest digest is SHA256 of UTF-8 bytes formed by sorting archive-relative paths and concatenating `path + NUL + lowercase_file_sha256 + LF` for each file. The archive entry prefix was `craft-agents-oss-main/`.

The root package version is 0.11.4. The archive comment declares `50ffa143ab76e44c0e96ea785d03aa67cf942c50`; earlier remote verification failed. This is an archive declaration, not a verified upstream commit or reconstructed upstream Git history.

## Initial Git snapshot

The following commands were executed only in the new repository; each completed successfully:

```powershell
git init --initial-branch=main
git config --local user.name 'gtdd123'
git config --local user.email '230968026+gtdd123@users.noreply.github.com'
git config --local core.autocrlf false
git config --local core.hooksPath '.git/hooks'
git add --force --all
git -c commit.gpgsign=false commit --quiet -m 'chore: import provided Craft Agents 0.11.4 source snapshot'
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git rev-list --parents -n 1 HEAD
git status --porcelain
```

- Initial commit: `a89f39f6b1368c808d84918e64e70d78d48a2aeb`.
- Initial tree: `37eab72696ca9a23f62222b11b42a27988ab40b4`.
- Branch: `main`.
- Tracked baseline files: 1,877.
- Commit parents: none; this is an honest local source import.
- Status immediately after the initial snapshot: empty.
- Author: `gtdd123 <230968026+gtdd123@users.noreply.github.com>`.
- Only repository-local identity, byte-preserving configuration, and hook isolation were set. No global Git configuration or personal resume email was used.

The initial commit precedes all BioEvidence ignore-rule, tool, evidence, and launcher changes. Those changes belong to T00 implementation after the initial source snapshot.

## Project-local fixed Bun

Executed from the workspace root, which was checked to have no `bunfig.toml`:

```powershell
Invoke-WebRequest -Uri 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-windows-x64.zip' -OutFile $bioZipPath -TimeoutSec 180
Invoke-WebRequest -Uri 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/SHASUMS256.txt' -OutFile $bioChecksumPath -TimeoutSec 90
Get-FileHash -LiteralPath $bioZipPath -Algorithm SHA256
Expand-Archive -LiteralPath $bioZipPath -DestinationPath $bioExtractPath
& $bioBunExe --version
Get-FileHash -LiteralPath $bioBunExe -Algorithm SHA256
```

Before extraction, every ZIP entry's resolved destination was checked to remain inside the project tool extraction directory. The exact `bun-windows-x64.zip` checksum entry was required to be unique and to match before extraction. The runtime leaf directory was required not to exist; no existing tool was overwritten.

Download, checksum validation, extraction, and the version check completed with exit 0:

| Item | Result |
| --- | --- |
| Archive URL | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/bun-windows-x64.zip` |
| Official checksum URL | `https://github.com/oven-sh/bun/releases/download/bun-v1.3.10/SHASUMS256.txt` |
| Archive bytes | 41,064,682 |
| Archive SHA256 | `7a77b3e245e2e26965c93089a4a1332e8a326d3364c89fae1d1fd99cdd3cd73d` |
| Official checksum | matched archive SHA256 |
| Executable | `.tools/bun/1.3.10/unpacked/bun-windows-x64/bun.exe` |
| Executable SHA256 | `f3b8ec8560eafce3bb0a458ab402c663bd5256ecc5419804df7d5c36b4de98f5` |
| Version output | `1.3.10` |
| Version-check cwd | `D:/agent-helson/craft-agents付费版内参/craft-new` |

The ignored `.tools/bun-manifest.json` contains the version, repository-relative executable path, archive SHA256, and official archive URL for launcher discovery. Bun was not installed globally, added to global PATH, or executed from the project directory during this preparation substep.

## Ignore-rule verification

The copied `.gitignore` was extended after the source snapshot to cover project tools, `.runtime`, `.bio-evidence`, runtime/private-data/export roots, local environment variants, SQLite databases/journals, and runtime logs. Runtime JSONL histories remain under the ignored runtime roots; reviewed synthetic source fixtures are not globally excluded.

The final direct-argument command `git check-ignore --verbose -- @bioIgnoreCandidates` completed with exit 0 and matched all 12 candidates:

```text
.tools/bun-manifest.json
.tools/bun/1.3.10/bun-windows-x64.zip
.runtime/server/state.sqlite
.runtime/client/history.jsonl
.env
.env.production
temporary.sqlite
temporary.sqlite-wal
temporary.sqlite-shm
temporary.sqlite-journal
temporary.db-journal
temporary.log
```

`git ls-files --error-unmatch '.env.example'` completed with exit 0: the upstream public example remains in the baseline snapshot. No actual environment or credential contents were read for these checks.

An earlier `git check-ignore --stdin --verbose` harness returned fewer matches and the enclosing validation exited 1 because PowerShell's native stdin pipeline added CR characters to candidate filenames. Its diagnostic output showed paths ending in `\r`. The harness was corrected to direct arguments; the ignore rules then passed all candidates. This was a verification transport issue, not a TDD Red or an ignored behavior failure.

## Boundaries and remaining T00 work

- No GitHub repository was created and nothing was pushed.
- No dependencies were installed; no tests, build, SDK, platform application, or new launcher were executed by this preparation substep.
- No original Craft user data, real experiment directory, real `.env`, or credential store was read or changed.
- The original source and ZIP were not modified. Only the new project directory received preparation writes.
- The task owner must finish and validate the neutral launcher/bootstrap and sentinel checks, then present the complete T00 result to the independent judge. The source snapshot and tool preparation alone do not constitute T00 completion.
