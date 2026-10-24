# topcited

The TopCited CLI: check and improve how AI assistants cite your brand, from a
terminal or from an agent (Claude Code, Codex, Cursor, CI).

## Quickstart

```sh
curl -fsSL https://github.com/TopCited/topcited-cli/releases/latest/download/install.sh | sh
topcited auth login
topcited brand list
```

## Install

| Path | Command |
|---|---|
| macOS, Linux | `curl -fsSL https://github.com/TopCited/topcited-cli/releases/latest/download/install.sh \| sh` (installs to `~/.local/bin`) |
| Windows (PowerShell) | `irm https://github.com/TopCited/topcited-cli/releases/latest/download/install.ps1 \| iex` |
| Binary | Download from [Releases](https://github.com/TopCited/topcited-cli/releases) and check it against `SHA256SUMS` |

The install scripts honour `TOPCITED_VERSION` (e.g. `v0.1.0`) and `TOPCITED_INSTALL_DIR`.
npm (`@topcited/cli`) isn't published yet.

## Sign in

`topcited auth login` prints a URL and a code, opens your browser when it can,
and waits while you approve. Approval issues an ordinary API key named
`topcited-cli on <hostname>`; logging in again on the same machine replaces it.

- Interrupted (an agent's shell timed out)? Run `topcited auth login` again: it
  resumes the code you already approved. `--restart` starts over.
- No live terminal (some agents): `topcited auth login --no-wait` prints the
  code and exits; run `topcited auth login --continue` after approving.
- CI: `echo "$KEY" | topcited auth login --with-token`, or just set `TOPCITED_API_KEY`.
- `topcited auth status`, `topcited auth token [--show]`, `topcited auth logout`.

Keys are stored in `~/.config/topcited/credentials.json` (mode 0600), one per
API host. `TOPCITED_API_KEY` overrides the stored key and `TOPCITED_BASE_URL`
(or `--base-url`) overrides the API host. Keys expire after 90 days; the CLI
warns when fewer than 14 remain.

## Commands

```
topcited auth login | logout | status | token [--show]
topcited brand list | use <id|name> | show [brand]
topcited monitor sets list | create | show
topcited monitor queries add | rm
topcited monitor run <set> [--wait] [--dry-run] [--yes]
topcited monitor results [--set] [--since] [--until]  # summary, gaps, share of voice
topcited audit run <url> [--wait] | show <id> | list
topcited recommend [keywords|prompts|content] [--wait] [--list]
topcited report generate [--wait] | list | show <id> | download <id>
topcited competitors list | add
topcited tasks list | show <id> [--wait]
topcited wait <job>                             # resume any --wait
topcited usage                                  # plan, T-coins, quotas, monitoring forecast
topcited api <path> [-X M] [-d json|@file] [-f k=v] [-F k=v] [--paginate]
topcited doctor                                 # config, auth, connectivity, version skew
topcited upgrade [--check]
```

`topcited <command> --help` shows a runnable example for each. `--brand`
(or `TOPCITED_BRAND`) picks a brand for one command; `brand use` stores one per
API host.

## For agents

- stdout is JSON when it isn't a terminal, or with `--json`.
- stderr in JSON mode is JSON Lines. A failure always ends with the error
  envelope `{"code", "message", "hint", "status"}` as the last line; earlier
  lines are warnings (`{"warning", "message"}`) or, for `auth login`, the
  `{"device_authorization": …}` prompt. Parse the last line.
- Nothing prompts without a TTY. Commands that spend T-coins ask for
  confirmation only on a TTY (`--yes` skips it); `--dry-run` prints the
  estimate and exits 0 without spending.
- `--wait` polls with backoff until the job ends (`--timeout`, default 1200 s).
  Async commands print a `job` reference such as `monitor:<set>:<batch>:<runs>`;
  `topcited wait <job>` resumes waiting.
- Exit codes: `0` ok, `1` error, `2` usage, `3` auth, `4` payment/quota,
  `5` not found, `6` conflict, `7` `--wait` timed out.

## Development

```sh
bun install
bun run dev -- --help        # run from source
bun test
bun run typecheck
bun run build                # all five targets into dist/ (+ SHA256SUMS)
bun run build --target linux-x64
```

The API client in `src/generated/` is generated from the public OpenAPI
contract in `openapi.public.json`. Don't edit it by hand:

```sh
bun run gen:client           # regenerate from the committed snapshot
bun run gen:client --fetch   # refresh the snapshot from prod first
```

### Releasing

1. Bump `version` in `package.json` and merge.
2. Push the tag `v<version>`. `release.yml` builds linux-x64, linux-arm64,
   darwin-x64, darwin-arm64 and windows-x64, and publishes a GitHub Release
   with `SHA256SUMS` and `install.sh`.
3. npm (when enabled): run the **Publish to npm** workflow with the tag. It
   publishes `@topcited/cli-<os>-<cpu>` platform packages and the
   `@topcited/cli` launcher, which picks the right one through
   `optionalDependencies`.

## License

[MIT](LICENSE).
