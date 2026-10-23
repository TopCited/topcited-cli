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
