'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test, after } = require('node:test');

const PROXY = path.join(__dirname, '..', 'plugins', 'csharp-lsp', 'proxy', 'index.js');
const POSIX_ONLY = process.platform === 'win32' && 'Windows ends the tree with taskkill /t, not a process group';

// Each run's folder holds helper.pid once its helper starts; any helper still
// running at the end, from a failed run included, is killed before the folder goes.
const dirs = [];
after(() => {
  for (const dir of dirs) {
    try { process.kill(Number(fs.readFileSync(path.join(dir, 'helper.pid'), 'utf8')), 'SIGKILL'); } catch { /* none started, or already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitFor(check, ms, what) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(25);
  }
}

// Runs the proxy against a fake server that starts a long-lived helper process,
// the way Roslyn starts its build host. Resolves with the proxy's exit code and
// the helper's pid once the proxy has exited.
async function runWithHelper(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csls-pg-'));
  dirs.push(dir);
  const pidFile = path.join(dir, 'helper.pid');
  const fake = path.join(dir, 'fake.js');
  fs.writeFileSync(fake, [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));`,
    'process.stdin.resume();',
    mode === 'crash' ? 'setTimeout(() => process.exit(7), 200);' : '',
  ].join('\n'));

  const proxy = spawn(process.execPath, [PROXY, '--server', process.execPath, '--log', path.join(dir, 'proxy.log'), '--', fake], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proxy.kill('SIGKILL'); reject(new Error('proxy did not exit in time')); }, 20000);
    proxy.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    proxy.on('error', reject);
  });
  exited.catch(() => { /* awaited below; this only stops an early throw leaving it unhandled */ });

  try {
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 15000, 'the helper to start');
  } catch (err) {
    proxy.kill('SIGKILL');
    throw err;
  }
  const helper = Number(fs.readFileSync(pidFile, 'utf8'));
  if (mode === 'sigterm') proxy.kill('SIGTERM');
  // stdin stays open: ending it would take the proxy's clean-shutdown path instead.

  const code = await exited;
  proxy.stdin.destroy();
  return { code, helper };
}

test('SIGTERM to the proxy also ends the server\'s helper processes', { skip: POSIX_ONLY, timeout: 45000 }, async () => {
  const { code, helper } = await runWithHelper('sigterm');

  assert.strictEqual(code, 0);
  await waitFor(() => !isAlive(helper), 3000, `helper ${helper} to end`);
});

test('a server crash also ends the server\'s helper processes', { skip: POSIX_ONLY, timeout: 45000 }, async () => {
  const { code, helper } = await runWithHelper('crash');

  assert.strictEqual(code, 7);
  await waitFor(() => !isAlive(helper), 3000, `helper ${helper} to end`);
});
