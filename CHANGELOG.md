# Changelog

All notable changes to this project are documented here. The format is based on
Keep a Changelog, and this project adheres to semantic versioning.

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
