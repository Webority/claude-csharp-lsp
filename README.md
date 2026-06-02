# claude-csharp-lsp

Solution-aware C# (Roslyn) language intelligence for [Claude Code](https://claude.com/claude-code), with multi-repo and multi-solution workspaces handled as a first-class case.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#requirements)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#how-it-works)

`findReferences`, `goToDefinition`, `goToImplementation`, hover, and call hierarchy that resolve across your whole solution, including when your Claude Code workspace contains several repositories side by side.

## The problem

Claude Code can talk to language servers, but its LSP client does not send Microsoft's Roslyn server the `solution/open` notification it needs to load your code as a unified solution graph. Without it, Roslyn runs in per-file mode, so cross-file queries come back empty or partial: `findReferences` finds only the declaration, `goToImplementation` finds nothing. If you have tried the stock C# LSP plugins and watched them return nothing, this is why.

If you open multiple repos in one workspace (a common setup), the existing workarounds also fall over: they pick one solution arbitrarily and leave the rest blind.

## The fix

`claude-csharp-lsp` is a small, zero-dependency Node proxy that sits between Claude Code and Roslyn. It passes the LSP handshake through untouched, then, once the client is ready, discovers what to open and injects the missing notification:

```
Claude Code  <->  claude-csharp-lsp  <->  Microsoft Roslyn language server
                       |
                       after `initialized`: sends solution/open or project/open
```

The discovery logic is what makes it work everywhere:

| Your workspace | What it loads |
|---|---|
| One solution at the root | that solution (`solution/open`) |
| One solution anywhere in the tree | that solution (`solution/open`) |
| Several repos or solutions side by side | every project across all of them (`project/open`), with no hand-authored master solution required |
| No solution, just `.csproj` files | all of those projects |

That third row is the point: multi-repo works with no setup, and you get full cross-file navigation in every repo.

## Requirements

- [Claude Code](https://claude.com/claude-code) 2.1.50 or newer
- .NET SDK 10.0 or newer (Roslyn's language server tracks the latest SDK)
- Node.js 20 or newer (Claude Code already ships a modern Node)
- The Roslyn language server tool:
  ```bash
  dotnet tool install --global roslyn-language-server
  ```
  Make sure your global tools directory (`~/.dotnet/tools`) is on `PATH`.

## Install

Enable Claude Code's LSP tool once, then add the plugin:

```jsonc
// ~/.claude/settings.json
{ "env": { "ENABLE_LSP_TOOL": "1" } }
```

```bash
/plugin marketplace add Webority/claude-csharp-lsp
/plugin install csharp-lsp@claude-csharp-lsp
```

Then fully restart Claude Code (the language server is launched fresh on start). Open any `.cs` file and ask Claude to find references, go to definition, or list implementations.

The proxy ships inside the plugin, so there is nothing else to install: no NuGet package and no binary download. `/plugin marketplace add` delivers everything.

Run `/csharp-lsp:doctor` at any time to verify your setup. It checks the .NET SDK, the Roslyn language server and its PATH entry, `ENABLE_LSP_TOOL`, and that only one C# language server is active, and it can fix the common issues for you.

## Supported operations

Claude Code's LSP tool surfaces read and navigation operations, all of which this proxy makes solution-aware:

`findReferences`, `goToDefinition`, `goToImplementation`, `hover`, `documentSymbol`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`.

These apply to C# (`.cs`) and to Razor/Blazor components (`.razor`, `.cshtml`). Roslyn serves the C# inside Razor `@code` blocks via cohosting, so navigation works inside components too.

LSP-based edits (rename, code actions, formatting) are not exposed by Claude Code's tool, so they are out of scope. Claude edits files directly and you verify with `dotnet build`.

## How it works

- Zero dependencies. Pure Node built-ins (`child_process`, `fs`, `path`, `Buffer`). Nothing to audit, nothing to break.
- Byte-exact passthrough. Server-to-client output is piped verbatim; client-to-server messages are forwarded as the exact bytes received. The proxy only reads `initialize` (to learn your workspace folders) and injects one notification after `initialized`.
- Logs to a file, never stdout. stdout is the LSP channel; diagnostics go to `<temp>/claude-csharp-lsp-logs/proxy.log`.
- Windows-safe. Roslyn's `.cmd` shim is launched via `cmd.exe /d /c` so binary LSP framing is not corrupted.
- Clean teardown and crash recovery. On exit the proxy kills its entire Roslyn child tree, so restarts never leave orphaned language servers. If Roslyn dies unexpectedly the proxy exits non-zero so Claude Code's restart policy (`maxRestarts`) brings the stack back and re-runs the handshake; on a client-initiated shutdown it exits cleanly so nothing is restarted.
- Index-aware. Reverse-lookups are held until Roslyn's cross-solution index is ready, so the first query returns a complete result instead of an empty one.
- Real MSBuild. Because it drives Roslyn, projects that use `Directory.Build.props`, `Directory.Build.targets`, or Central Package Management load and resolve correctly, which is a common failure point for non-Roslyn servers.

## Configuration

The defaults need no configuration. To pin a specific solution (for example a curated master in a multi-repo workspace), pass `--solution` in the plugin's `.lsp.json`:

```jsonc
"args": [
  "${CLAUDE_PLUGIN_ROOT}/proxy/index.js",
  "--server", "roslyn-language-server",
  "--solution", "C:/path/to/Master.sln",
  "--ready-timeout", "60000",
  "--", "--stdio", "--logLevel", "Information"
]
```

`--ready-timeout <ms>` caps how long the proxy holds reverse-lookup requests while waiting for Roslyn's index to finish (default 60000). After the cap it forwards them anyway.

### Workspace config (`.roslynlsp.json`)

Drop a `.roslynlsp.json` at your workspace root to steer discovery without editing the plugin:

```json
{
  "solution": "src/App.slnx",
  "solutions": ["api/Api.slnx", "web/Web.slnx"],
  "exclude": ["legacy", "samples"],
  "readyTimeoutMs": 90000
}
```

- `solution`: pin one solution (relative to the workspace, or absolute).
- `solutions`: load the union of these solutions' projects, for multi-solution workspaces.
- `exclude`: directory names or path prefixes to skip during discovery.
- `readyTimeoutMs`: override the index-readiness hold cap.

Precedence: `--solution` > `solution` > `solutions` > automatic discovery.

## Troubleshooting

- First reverse-lookup after a solution opens can take 20 to 35 seconds on large solutions. The proxy holds reverse-lookup requests (`findReferences`, `goToImplementation`, call hierarchy) until Roslyn finishes building its cross-solution index, then returns a complete result, so you get the right answer in one call instead of an empty one. Local operations (`documentSymbol`, `hover`, `goToDefinition`) are never held and respond immediately. The hold has a safety cap (default 60 seconds, set with `--ready-timeout`).
- Nothing resolves. Check `<temp>/claude-csharp-lsp-logs/proxy.log`. You should see `open: solution/open ...` or `open: project/open N projects`. If it says `none`, no `.sln`, `.slnx`, or `.csproj` was found under your workspace folder.
- `roslyn-language-server` not found. Confirm `~/.dotnet/tools` is on `PATH` and the tool is installed.
- Only one C# LSP plugin should be enabled. Two plugins claiming `.cs` spawn competing Roslyn servers, which slows and scrambles indexing.

## Known limitations

- `workspaceSymbol` does not work through Claude Code's LSP tool. The tool sends an empty query with no symbol position, so Roslyn has nothing to search for and returns an empty set. This is a limitation of the host tool, not the proxy. To find a symbol by name, use grep or Glob to locate it, then run a position-based operation such as `findReferences` or `goToDefinition`.
- Recovery from a signal kill or session resume is host-limited. The proxy signals a crash correctly (non-zero exit) so Claude Code restarts it, but the host does not currently restart a server it signal-kills itself or one that dies on session resume. If navigation goes dead after a resume, restart Claude Code.

## Contributing

Issues and pull requests are welcome. The proxy is three small files under [`plugins/csharp-lsp/proxy/`](plugins/csharp-lsp/proxy); `npm test` runs the self-test (framing, discovery, URI handling) with no external dependencies.

## License

[MIT](LICENSE), Webority Technologies.
