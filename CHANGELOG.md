# Changelog

All notable changes to this project are documented here. The format is based on
Keep a Changelog, and this project adheres to semantic versioning.

## [Unreleased]

### Added

- Index-readiness gating. Reverse-lookup requests (`textDocument/references`,
  `textDocument/implementation`, call hierarchy) are held until Roslyn finishes
  building its cross-solution index, then released, so the first such query
  returns a complete result instead of an empty or partial one. Falls back to a
  configurable cap (`--ready-timeout`, default 60s) if the readiness signal does
  not arrive. Position-local operations (definition, hover, documentSymbol) are
  never held.
- `/csharp-lsp:doctor` command. Checks the prerequisites (.NET SDK,
  roslyn-language-server and its PATH entry, `ENABLE_LSP_TOOL`, and that exactly
  one C# language server is active) and, with `--fix`, installs the tool and
  sets `ENABLE_LSP_TOOL`. Zero dependencies; runnable standalone.

## [0.1.0]

Initial release.

### Added

- Zero-dependency Node LSP proxy that makes Microsoft's Roslyn language server
  solution-aware inside Claude Code.
- Injects `solution/open` or `project/open` after the client sends
  `initialized`, so cross-file navigation resolves across the whole solution.
- Multi-repo discovery: a single solution opens directly; multiple solutions
  load every project, so navigation works across all repos with no
  hand-authored master solution.
- Windows `.cmd` shim handling and file-based logging that never touches stdout.
- Self-test covering framing, discovery, and URI handling (`npm test`).
