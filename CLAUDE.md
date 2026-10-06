# claude-csharp-lsp
Public OSS (MIT): a solution-aware C# (Roslyn) LSP proxy plugin for Claude Code, zero-dependency Node.js. Retired from the internal Webority config on 01-Oct-2026; kept as low-touch public software. Cloud project 157 (Webority Libraries), component Claude C# LSP.

@~/.claude/conventions/pm.md
@~/.claude/conventions/mcp-usage.md
@~/.claude/conventions/shared-packages.md

## Stack & layout
- Node.js 20+, no npm dependencies, no build step. Plugin manifest in `.claude-plugin/`; the proxy in `plugins/csharp-lsp/proxy/` (start at `index.js`).

## Build, run, verify
- `npm test` runs `plugins/csharp-lsp/proxy/selftest.js`, then the regression tests in `test/` (`node test/run.js`, Node's built-in test runner). Run it before every push.
- CI is `.github/workflows/publish.yml` (tests on push to `main` and on every PR to `main`, plus a weekly CodeQL scan) and `version-check.yml`.

## Tests
`selftest.js` (proxy logic and the exit-code contract) and `test/*.test.js` (one file per fix) stay. `test/` sits outside `plugins/`, so it does not ship with the plugin.

## Rules
- Work on `development` and release through a `development` to `main` PR like every library repo; external contributors' PRs target `development`.
- `publish.yml` stays on `ubuntu-latest`: the repo is public, so a fork's PR must never run on the self-hosted pool.
- A release is the version bump in `package.json` plus a `CHANGELOG.md` entry; the Claude Code plugin marketplace reads it from `main`.
- Zero npm dependencies is a product promise; add none.

## Where facts live
- User install and configuration: `README.md`. History: `CHANGELOG.md`.
