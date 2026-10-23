# topcited

The TopCited CLI: check and improve how AI assistants cite your brand, from a
terminal or from an agent (Claude Code, Codex, Cursor, CI).

## Quickstart

```sh
curl -fsSL https://topcited.ai/install.sh | sh
topcited auth login
topcited brand list
```

## Install

| Path | Command |
|---|---|
| Script | `curl -fsSL https://topcited.ai/install.sh \| sh` (Linux, macOS; installs to `~/.local/bin`) |
| npm | `npm i -g @topcited/cli` or `npx @topcited/cli …` |
| Binary | Download from [Releases](https://github.com/TopCited/topcited-cli/releases) and check it against `SHA256SUMS` |

`install.sh` honours `TOPCITED_VERSION` (e.g. `v0.1.0`) and `TOPCITED_INSTALL_DIR`.

> While this repo is private, release downloads need GitHub access, and npm
> publishing is off (`.github/workflows/npm-publish.yml` is manual). Both open
> up at the Phase 2 launch.

## Sign in

`topcited auth login` prints a URL and a code, opens your browser when it can,
and waits while you approve. Approval issues an ordinary API key named
`topcited-cli on <hostname>`; logging in again on the same machine replaces it.

- No live terminal (some agents): `topcited auth login --no-wait` prints the
  code and exits; run `topcited auth login --continue` after approving.
- CI: `echo "$KEY" | topcited auth login --with-token`, or just set `TOPCITED_API_KEY`.
- `topcited auth status`, `topcited auth token [--show]`, `topcited auth logout`.

Keys are stored in `~/.config/topcited/credentials.json` (mode 0600), one per
API host. `TOPCITED_API_KEY` overrides the stored key and `TOPCITED_BASE_URL`
(or `--base-url`) overrides the API host. Keys expire after 90 days; the CLI
warns when fewer than 14 remain.

## For agents

- stdout is JSON when it isn't a terminal, or with `--json`.
- Errors are one JSON object on stderr: `{"code", "message", "hint", "status"}`.
  Warnings in JSON mode are JSON lines too: `{"warning", "message"}`.
- Nothing prompts without a TTY.
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

Not chosen yet: MIT or Apache-2.0 is pending a founder decision. Until a
`LICENSE` file lands, all rights are reserved.
