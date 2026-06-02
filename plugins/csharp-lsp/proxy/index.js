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

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FrameReader, encodeMessage } = require('./framing');
const { resolveOpenTarget, loadConfig, pathToFileUri, fileUriToPath } = require('./discovery');

const DEFAULT_SERVER_ARGS = ['--stdio', '--logLevel', 'Information'];

// Reverse-lookup operations need Roslyn's cross-solution index, which is built
// asynchronously after the solution opens. Asked before it is ready they return
// empty or partial results. We hold these requests until Roslyn signals
// readiness or a timeout fires, so the client gets a complete answer instead of
// a misleading empty one. Position-local ops (definition, hover, documentSymbol,
// prepareCallHierarchy) never need the index and are never held.
const INDEX_DEPENDENT_METHODS = new Set([
  'textDocument/references',
  'textDocument/implementation',
  'callHierarchy/incomingCalls',
  'callHierarchy/outgoingCalls',
  'workspace/symbol',
]);

// Roslyn sends this once every project in the opened solution has loaded.
const READY_NOTIFICATION = 'workspace/projectInitializationComplete';

function parseArgs(argv) {
  let server = null;
  let solution = null;
  let logPath = null;
  let readyTimeoutMs = 60000;
  const serverArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') server = argv[++i];
    else if (a === '--solution') solution = argv[++i];
    else if (a === '--log') logPath = argv[++i];
    else if (a === '--ready-timeout') readyTimeoutMs = Number(argv[++i]) || readyTimeoutMs;
    else if (a === '--') { serverArgs.push(...argv.slice(i + 1)); break; }
    else serverArgs.push(a);
  }
  return { server, solution, logPath, serverArgs, readyTimeoutMs };
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
  const { server, solution, logPath, serverArgs, readyTimeoutMs } = parseArgs(process.argv.slice(2));
  const log = openLog(logPath);

  if (!server) {
    process.stderr.write('claude-csharp-lsp: --server <path> is required\n');
    process.exit(2);
  }

  const serverPath = resolveServer(server);
  const finalServerArgs = serverArgs.length > 0 ? serverArgs : DEFAULT_SERVER_ARGS.slice();
  const child = spawnServer(serverPath, finalServerArgs, log);

  let openSent = false;
  let indexReady = false;
  let workspaceDirs = [];
  let config = {};
  let readyTimeoutEffective = readyTimeoutMs;
  const reader = new FrameReader();
  const serverReader = new FrameReader(); // inspects server output for the readiness signal
  const held = [];                        // index-dependent requests parked until ready
  let readyTimer = null;
  let clientRequestedShutdown = false;    // set when the client asks for an LSP shutdown/exit

  const writeToServer = (buf) => {
    if (!child.stdin.write(buf)) {
      process.stdin.pause();
      child.stdin.once('drain', () => process.stdin.resume());
    }
  };

  const markReady = (reason) => {
    if (indexReady) return;
    indexReady = true;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    log(`index ready (${reason})${held.length ? `; releasing ${held.length} held request(s)` : ''}`);
    while (held.length) writeToServer(held.shift());
  };

  // server -> client: pass every byte through untouched, and watch a copy of the
  // stream for the readiness notification.
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    if (indexReady) return;
    try {
      for (const f of serverReader.push(chunk)) {
        try {
          if (JSON.parse(f.body.toString('utf8')).method === READY_NOTIFICATION) markReady('projectInitializationComplete');
        } catch { /* ignore non-JSON frames */ }
      }
    } catch { /* never let inspection break the pipe */ }
  });
  // server diagnostics -> our stderr (NOT the LSP channel; Claude treats it as logs).
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  // client -> server: forward verbatim, inject the open notification after
  // `initialized`, and hold index-dependent requests until the index is ready.
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
        config = loadConfig(workspaceDirs[0]);
        if (config.readyTimeoutMs) readyTimeoutEffective = Number(config.readyTimeoutMs) || readyTimeoutEffective;
        log(`initialize: workspace dirs = [${workspaceDirs.join(', ')}]${Object.keys(config).length ? ' (.roslynlsp.json loaded)' : ''}`);
      }

      // A client-driven shutdown means a later Roslyn exit is expected, not a
      // crash. Record it so the exit handler can tell the two apart.
      if (method === 'shutdown' || method === 'exit') clientRequestedShutdown = true;

      if (!indexReady && INDEX_DEPENDENT_METHODS.has(method)) {
        held.push(frame.raw);
        log(`holding ${method} until index ready (${held.length} queued)`);
        continue; // park it; released by markReady()
      }

      writeToServer(frame.raw); // forward the client's exact bytes

      if (method === 'initialized' && !openSent) {
        openSent = true;
        const target = resolveOpenTarget(workspaceDirs, solution, config);
        const notification = buildOpenNotification(target, log);
        if (notification) {
          writeToServer(notification);
          // Safety net: if Roslyn never signals readiness, stop holding after the cap.
          readyTimer = setTimeout(() => markReady(`timeout ${readyTimeoutEffective}ms`), readyTimeoutEffective);
          if (readyTimer.unref) readyTimer.unref();
        } else {
          markReady('no solution opened'); // nothing to index; never hold
        }
      }
    }
  });

  let shuttingDown = false;

  // Kill the whole child process tree. On Windows, Roslyn runs under a cmd.exe
  // shim, so killing only `child` would orphan the dotnet grandchild; that is
  // how stray Roslyn servers accumulate across restarts. `taskkill /t` walks the
  // tree, SIGKILL covers POSIX. Best-effort: the target may already be gone.
  const killTree = (pid) => {
    if (!pid) return;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch { /* already dead, or nothing to kill */ }
  };

  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (readyTimer) { try { clearTimeout(readyTimer); } catch { /* ignore */ } }
    killTree(child && child.pid);
    process.exit(code);
  };

  // Exit cleanly on host/OS termination so a Roslyn process is never stranded.
  // On Windows the host typically closes our stdin, which fires 'end' below.
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.stdin.on('end', () => shutdown(0));

  // If Roslyn exits, exit too. The exit code we report decides whether the host
  // restarts us: Claude Code re-spawns an LSP server (up to maxRestarts) on a
  // non-zero exit, but treats exit 0 as an intentional stop and leaves it dead.
  // So exit 0 only when the client actually asked to shut down; on any
  // unexpected death (crash, OOM, or signal kill where code is null) exit
  // non-zero so the restart policy fires and re-runs the handshake fresh.
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (clientRequestedShutdown) {
      log(`server exited (code=${code}); client-initiated shutdown, exiting clean`);
      shutdown(0);
    } else {
      const exitCode = code && code !== 0 ? code : 1;
      log(`server exited unexpectedly (code=${code}, signal=${signal || 'none'}); exiting ${exitCode} so the host restarts the stack`);
      shutdown(exitCode);
    }
  });
  child.on('error', (err) => {
    log(`server spawn error: ${err.message}`);
    process.stderr.write(`claude-csharp-lsp: ${err.message}\n`);
    shutdown(1);
  });
}

main();
