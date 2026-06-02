---
description: Check (and optionally repair) the prerequisites for the C# language server — .NET SDK, roslyn-language-server, ENABLE_LSP_TOOL, PATH, and a single active C# plugin.
---

Run the doctor and report the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/proxy/doctor.js"
```

Show the user the PASS / WARN / FAIL report. If anything failed or warned,
summarize what is wrong and the exact fix for each item.

If there are failures, offer to apply the safe automatic fixes (install the
roslyn-language-server tool and set `ENABLE_LSP_TOOL=1`). Only run the fix after
the user confirms:

```bash
node "${CLAUDE_PLUGIN_ROOT}/proxy/doctor.js" --fix
```

After any fix that installs a tool or edits `settings.json`, tell the user to
restart Claude Code. The "single C# language server" warning cannot be fixed by
the script — guide the user to disable the extra plugin(s) with `/plugin`.
