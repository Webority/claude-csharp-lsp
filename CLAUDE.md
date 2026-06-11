# claude-csharp-lsp

**Public OSS tool** — solution-aware C# (Roslyn) LSP proxy for Claude Code. Zero-dependency Node.js. MIT licence.

**Tech:** Node.js ≥ 20, no npm dependencies | **Plugin entry:** `.claude-plugin/` | **Proxy:** `plugins/csharp-lsp/proxy/`

**Build:** no build step — pure JS

**Test:**
```bash
npm test   # runs plugins/csharp-lsp/proxy/selftest.js
```

**CI:** GitHub Actions (`ci.yml`) — runs `npm test` on every push to `main` and every PR.

**Release process:** bump `version` in `package.json` → update `CHANGELOG.md` → commit → push tag `vX.Y.Z` to `main`; Claude Code marketplace picks up from the GitHub release.

**Branch:** `main` (no `development` branch — OSS repo, PRs target `main` directly)

**Install (users):**
```bash
/plugin marketplace add Webority/claude-csharp-lsp
/plugin install csharp-lsp@claude-csharp-lsp
```

**No Webority client conventions apply** — this is a public tool repo, not a client project.
