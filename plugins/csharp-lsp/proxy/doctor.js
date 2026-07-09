#!/usr/bin/env node
'use strict';

// Diagnose (and with --fix, repair) the prerequisites claude-csharp-lsp needs:
// Node, the .NET SDK, the roslyn-language-server tool and its PATH entry,
// ENABLE_LSP_TOOL, and that exactly one C# language server is active. Zero
// dependencies; safe to run standalone (`node doctor.js`) or via the
// /csharp-lsp:doctor command.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = process.argv.includes('--fix');
const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const toolsDir = path.join(home, '.dotnet', 'tools');
const isWin = process.platform === 'win32';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const results = [];
const add = (name, status, detail, hint) => results.push({ name, status, detail, hint });

// 1. Node
{
  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20 ? 'PASS' : 'WARN', process.version, major >= 20 ? null : 'Node 20 or newer is recommended.');
}

// 2. .NET SDK (Roslyn tracks the latest SDK)
{
  const v = run('dotnet', ['--version']);
  if (!v) {
    add('.NET SDK', 'FAIL', 'not found on PATH', 'Install .NET SDK 10 or newer: https://dotnet.microsoft.com/download');
  } else {
    const major = Number(v.split('.')[0]);
    add('.NET SDK', major >= 10 ? 'PASS' : 'WARN', v, major >= 10 ? null : 'Roslyn requires a current SDK; install .NET 10 or newer.');
  }
}

// 3. roslyn-language-server tool installed
let toolInstalled = false;
{
  const list = run('dotnet', ['tool', 'list', '--global']);
  toolInstalled = !!(list && /roslyn-language-server/i.test(list));
  if (toolInstalled) add('roslyn-language-server', 'PASS', 'installed (global tool)');
  else add('roslyn-language-server', 'FAIL', 'not installed', 'dotnet tool install --global roslyn-language-server --prerelease');
}

// 4. global tools dir on PATH
{
  const names = isWin ? ['roslyn-language-server.cmd', 'roslyn-language-server.exe'] : ['roslyn-language-server'];
  const onDisk = names.some((n) => fs.existsSync(path.join(toolsDir, n)));
  const onPath = (process.env.PATH || '').split(path.delimiter).some((d) => d && d.replace(/[/\\]+$/, '') === toolsDir);
  if (onDisk && onPath) add('tools dir on PATH', 'PASS', toolsDir);
  else if (onDisk && !onPath) add('tools dir on PATH', 'WARN', `${toolsDir} is not on PATH`, isWin ? `Add ${toolsDir} to your user PATH.` : `echo 'export PATH="$PATH:${toolsDir}"' >> ~/.profile && exec $SHELL -l`);
  else add('tools dir on PATH', toolInstalled ? 'WARN' : 'PASS', onDisk ? 'present' : 'nothing to check yet');
}

// 5. ENABLE_LSP_TOOL
{
  const s = readJson(settingsPath) || {};
  const ok = s.env && String(s.env.ENABLE_LSP_TOOL) === '1';
  if (ok) add('ENABLE_LSP_TOOL', 'PASS', 'set in settings.json');
  else add('ENABLE_LSP_TOOL', 'FAIL', 'not set', `Set {"env":{"ENABLE_LSP_TOOL":"1"}} in ${settingsPath}`);
}

// 6. exactly one active C# language server (avoid competing Roslyn servers)
{
  const settings = readJson(settingsPath) || {};
  const enabled = settings.enabledPlugins || {};
  const installed = (readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const csharp = [];
  for (const [key, instances] of Object.entries(installed)) {
    if (enabled[key] !== true) continue; // only plugins explicitly enabled are active
    const inst = Array.isArray(instances) ? instances[0] : instances;
    const lsp = inst && inst.installPath ? readJson(path.join(inst.installPath, '.lsp.json')) : null;
    if (!lsp) continue;
    const mapsCs = Object.values(lsp).some((c) => c && c.extensionToLanguage && c.extensionToLanguage['.cs']);
    if (mapsCs) csharp.push(key);
  }
  if (csharp.length <= 1) add('single C# language server', 'PASS', csharp[0] || 'this plugin');
  else add('single C# language server', 'WARN', `${csharp.length} active: ${csharp.join(', ')}`, 'Keep one enabled; disable the others with /plugin (competing servers slow and scramble indexing).');
}

// ---- report ----
console.log('claude-csharp-lsp doctor\n');
for (const r of results) {
  console.log(`[${r.status}] ${r.name}: ${r.detail}`);
  if (r.hint && r.status !== 'PASS') console.log(`        fix: ${r.hint}`);
}
const fails = results.filter((r) => r.status === 'FAIL').length;
const warns = results.filter((r) => r.status === 'WARN').length;
console.log(`\n${results.length} checks, ${fails} failed, ${warns} warning(s).`);

// ---- optional auto-fix ----
if (FIX) {
  console.log('\nApplying safe fixes...');
  if (!toolInstalled) {
    const out = run('dotnet', ['tool', 'install', '--global', 'roslyn-language-server', '--prerelease']);
    console.log(out !== null ? '  installed roslyn-language-server' : '  could not install roslyn-language-server; run it manually');
  }
  const s = readJson(settingsPath) || {};
  if (!(s.env && String(s.env.ENABLE_LSP_TOOL) === '1')) {
    s.env = s.env || {};
    s.env.ENABLE_LSP_TOOL = '1';
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
      console.log('  set ENABLE_LSP_TOOL=1 in settings.json');
    } catch (e) {
      console.log(`  could not update settings.json: ${e.message}`);
    }
  }
  console.log('  restart Claude Code, then re-run the doctor to confirm.');
} else if (fails) {
  console.log('Run with --fix to install the tool and set ENABLE_LSP_TOOL automatically.');
}

process.exit(fails && !FIX ? 1 : 0);
