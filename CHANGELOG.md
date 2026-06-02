# Changelog

All notable changes to this project are documented here. The format is based on
Keep a Changelog, and this project adheres to semantic versioning.

## [0.3.1]

### Fixed

- `/csharp-lsp:doctor` command frontmatter: a colon in the `description` produced
  invalid YAML, which silently dropped the command's metadata. Rephrased so it
  parses. Caught by `claude plugin validate`.

## [0.3.0]

### Added

- Razor / Blazor support. `.razor` and `.cshtml` files are routed to the Roslyn
  server, which serves the C# inside `@code` blocks via cohosting, so navigation
  (references, definition, implementation, call hierarchy) works inside
  components. No separate Razor server required.
- Workspace config (`.roslynlsp.json`). Optional file at the workspace root to
  pin a solution, load the union of several solutions, exclude directories, or
  set the readiness-hold cap, without editing the plugin.
- Multi-solution union via the `solutions` config key: loads every project from
  the listed solutions so navigation spans them.
- Confirmed support for projects using `Directory.Build.props`,
  `Directory.Build.targets`, and Central Package Management, which load
  correctly through Roslyn's real MSBuild evaluation.

## [0.2.0]

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
- Clean teardown. On exit the proxy kills its entire Roslyn child tree, so
  restarts never leave orphaned language servers. If Roslyn exits, the proxy
  exits too so the host can restart the whole stack fresh.

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
