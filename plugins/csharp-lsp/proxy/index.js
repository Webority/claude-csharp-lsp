#!/usr/bin/env node
'use strict';

// claude-csharp-lsp: a thin LSP proxy that makes Microsoft's Roslyn language
// server solution-aware inside Claude Code.
//
// Why this exists: Claude Code's LSP client never sends Roslyn the
// `solution/open` / `project/open` notifications it needs to load a workspace
// as a Solution graph, so cross-file operations (findReferences, goToDefinition,
// goToImplementation, call hierarchy) return empty or file-scoped results. This
// proxy passes the LSP handshake through untouched, then once the client has
// sent `initialized` it discovers the right thing to open and injects the
// missing notification. Multi-repo workspaces are handled as a first-class
// case (see discovery.js).
//
// Protocol reference: dotnet/roslyn OpenSolutionHandler / OpenProjectsHandler
// and dotnet/vscode-csharp roslynProtocol.ts (public Microsoft protocol).
//
// Usage:
//   node index.js --server <roslyn-language-server> [--solution <path>]
//                 [--log <path>] [-- <args forwarded to the server>]

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FrameReader, encodeMessage } = require('./framing');
const { resolveOpenTarget, pathToFileUri, fileUriToPath } = require('./discovery');

const DEFAULT_SERVER_ARGS = ['--stdio', '--logLevel', 'Information'];

function parseArgs(argv) {
  let server = null;
  let solution = null;
  let logPath = null;
  const serverArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') server = argv[++i];
    else if (a === '--solution') solution = argv[++i];
    else if (a === '--log') logPath = argv[++i];
    else if (a === '--') { serverArgs.push(...argv.slice(i + 1)); break; }
    else serverArgs.push(a);
  }
  return { server, solution, logPath, serverArgs };
}

function openLog(logPath) {
  const target = logPath || path.join(os.tmpdir(), 'claude-csharp-lsp-logs', 'proxy.log');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const stream = fs.createWriteStream(target, { flags: 'a' });
    return (msg) => { try { stream.write(`[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ } };
  } catch {
    // Logging must never take the proxy down; if the file can't be opened,
    // fall back to a no-op (NEVER stdout, that is the LSP channel).
    return () => {};
  }
}

// Resolve a bare server name to an executable path. `dotnet tool install`
// creates a `.cmd` shim on Windows; spawn won't find a bare name without help,
// so probe the value, then `.cmd`/`.exe`/`.bat`, then each PATH entry.
function resolveServer(name) {
  if (fs.existsSync(name)) return name;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const ext of exts) {
    if (ext && fs.existsSync(name + ext)) return name + ext;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return name; // last resort: let spawn surface the error
}

function spawnServer(serverPath, serverArgs, log) {
  // Windows batch shims (.cmd/.bat) can't be launched via CreateProcess with
  // redirected binary stdio without cmd.exe mangling CRLF on the pipe. Wrap
  // them explicitly with `cmd.exe /d /c` (/d disables AutoRun so a user CMD
  // profile can't inject bytes into our stdout). LSP framing needs a raw byte
  // stream, so this matters.
  const isBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(serverPath);
  const file = isBatch ? process.env.ComSpec || 'cmd.exe' : serverPath;
  const args = isBatch ? ['/d', '/c', serverPath, ...serverArgs] : serverArgs;
  log(`start server=${serverPath} args=[${serverArgs.join(' ')}]${isBatch ? ' (via cmd.exe)' : ''}`);
  return spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function extractWorkspaceDirs(initializeParams) {
  const dirs = [];
  const p = initializeParams || {};
  if (Array.isArray(p.workspaceFolders)) {
    for (const f of p.workspaceFolders) {
      const d = f && f.uri ? fileUriToPath(f.uri) : null;
      if (d) dirs.push(d);
    }
  }
  if (dirs.length === 0 && p.rootUri) {
    const d = fileUriToPath(p.rootUri);
    if (d) dirs.push(d);
  }
  if (dirs.length === 0 && p.rootPath) {
    dirs.push(p.rootPath);
  }
  return dirs;
}

function buildOpenNotification(target, log) {
  if (target.kind === 'solution') {
    const uri = pathToFileUri(target.path);
    log(`open: solution/open ${uri} (${target.reason})`);
    return encodeMessage({ jsonrpc: '2.0', method: 'solution/open', params: { solution: uri } });
  }
  if (target.kind === 'projects') {
    const uris = target.paths.map(pathToFileUri);
    log(`open: project/open ${uris.length} projects (${target.reason})`);
    return encodeMessage({ jsonrpc: '2.0', method: 'project/open', params: { projects: uris } });
  }
  log(`open: none (${target.reason}); transparent passthrough`);
  return null;
}

function main() {
  const { server, solution, logPath, serverArgs } = parseArgs(process.argv.slice(2));
  const log = openLog(logPath);

  if (!server) {
    process.stderr.write('claude-csharp-lsp: --server <path> is required\n');
    process.exit(2);
  }

  const serverPath = resolveServer(server);
  const finalServerArgs = serverArgs.length > 0 ? serverArgs : DEFAULT_SERVER_ARGS.slice();
  const child = spawnServer(serverPath, finalServerArgs, log);

  let openSent = false;
  let workspaceDirs = [];
  const reader = new FrameReader();

  // server -> client: pure byte passthrough (we never alter server output).
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  // server diagnostics -> our stderr (NOT the LSP channel; Claude treats it as logs).
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  // client -> server: frame, forward verbatim, and inject after `initialized`.
  const writeToServer = (buf) => {
    if (!child.stdin.write(buf)) {
      process.stdin.pause();
      child.stdin.once('drain', () => process.stdin.resume());
    }
  };

  process.stdin.on('data', (chunk) => {
    let frames;
    try {
      frames = reader.push(chunk);
    } catch (err) {
      log(`framing error: ${err.message}`);
      return;
    }
    for (const frame of frames) {
      let method = null;
      let params = null;
      try {
        const msg = JSON.parse(frame.body.toString('utf8'));
        method = msg.method;
        params = msg.params;
      } catch {
        // Non-JSON or oversized; forward verbatim, don't inspect.
      }

      if (method === 'initialize') {
        workspaceDirs = extractWorkspaceDirs(params);
        log(`initialize: workspace dirs = [${workspaceDirs.join(', ')}]`);
      }

      writeToServer(frame.raw); // always forward the client's exact bytes

      if (method === 'initialized' && !openSent) {
        openSent = true;
        const target = resolveOpenTarget(workspaceDirs, solution);
        const notification = buildOpenNotification(target, log);
        if (notification) writeToServer(notification);
      }
    }
  });

  const shutdown = (code) => {
    try { if (!child.killed) child.kill(); } catch { /* best effort */ }
    process.exit(code);
  };

  process.stdin.on('end', () => shutdown(0));
  child.on('exit', (code) => { log(`server exited code=${code}`); shutdown(code == null ? 0 : code); });
  child.on('error', (err) => { log(`server spawn error: ${err.message}`); process.stderr.write(`claude-csharp-lsp: ${err.message}\n`); shutdown(1); });
}

main();
