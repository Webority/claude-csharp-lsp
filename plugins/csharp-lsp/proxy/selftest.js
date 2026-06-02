'use strict';

// Zero-dependency self-test for the proxy's pure logic (framing, discovery,
// URI conversion). Does not require Roslyn or Claude Code. Run: `npm test`.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FrameReader, encodeMessage } = require('./framing');
const { resolveOpenTarget, loadConfig, pathToFileUri, fileUriToPath } = require('./discovery');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('framing:');

test('parses a single frame', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} });
  const wire = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const frames = new FrameReader().push(wire);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(JSON.parse(frames[0].body.toString()).method, 'initialized');
});

test('reassembles a body split across chunks', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { a: 1 } });
  const wire = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const reader = new FrameReader();
  assert.strictEqual(reader.push(wire.subarray(0, 10)).length, 0); // header incomplete
  assert.strictEqual(reader.push(wire.subarray(10, 30)).length, 0); // body incomplete
  const frames = reader.push(wire.subarray(30));
  assert.strictEqual(frames.length, 1);
});

test('drains multiple frames from one chunk', () => {
  const mk = (m) => {
    const b = JSON.stringify({ jsonrpc: '2.0', method: m });
    return `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`;
  };
  const frames = new FrameReader().push(Buffer.from(mk('a') + mk('b') + mk('c')));
  assert.deepStrictEqual(frames.map((f) => JSON.parse(f.body).method), ['a', 'b', 'c']);
});

test('encodeMessage round-trips through FrameReader', () => {
  const wire = encodeMessage({ jsonrpc: '2.0', method: 'solution/open', params: { solution: 'file:///x' } });
  const frames = new FrameReader().push(wire);
  assert.strictEqual(JSON.parse(frames[0].body).params.solution, 'file:///x');
});

console.log('uri:');

test('pathToFileUri / fileUriToPath round-trip', () => {
  const p = process.platform === 'win32' ? 'C:\\Code\\Proj\\A.sln' : '/code/proj/A.sln';
  const round = fileUriToPath(pathToFileUri(p));
  assert.strictEqual(path.normalize(round), path.normalize(path.resolve(p)));
});

console.log('discovery:');

function tmpWorkspace(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csls-test-'));
  for (const rel of layout) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return root;
}

test('single root solution -> solution/open', () => {
  const root = tmpWorkspace(['App.sln', 'src/App/App.csproj']);
  const r = resolveOpenTarget([root]);
  assert.strictEqual(r.kind, 'solution');
  assert.strictEqual(path.basename(r.path), 'App.sln');
});

test('single nested solution -> solution/open', () => {
  const root = tmpWorkspace(['repo/App.slnx', 'repo/src/App.csproj']);
  const r = resolveOpenTarget([root]);
  assert.strictEqual(r.kind, 'solution');
  assert.strictEqual(path.basename(r.path), 'App.slnx');
});

test('multiple solutions (multi-repo) -> all projects', () => {
  const root = tmpWorkspace([
    'repoA/A.slnx', 'repoA/src/A.csproj',
    'repoB/B.slnx', 'repoB/src/B.csproj',
  ]);
  const r = resolveOpenTarget([root]);
  assert.strictEqual(r.kind, 'projects');
  assert.strictEqual(r.paths.length, 2);
});

test('no solution but projects -> all projects', () => {
  const root = tmpWorkspace(['src/A/A.csproj', 'src/B/B.csproj']);
  const r = resolveOpenTarget([root]);
  assert.strictEqual(r.kind, 'projects');
  assert.strictEqual(r.paths.length, 2);
});

test('explicit solution overrides discovery', () => {
  const root = tmpWorkspace(['A.sln', 'B.sln']);
  const r = resolveOpenTarget([root], path.join(root, 'B.sln'));
  assert.strictEqual(r.kind, 'solution');
  assert.strictEqual(path.basename(r.path), 'B.sln');
});

test('prunes bin/obj/node_modules', () => {
  const root = tmpWorkspace(['bin/Ghost.csproj', 'obj/Ghost2.csproj', 'src/Real.csproj']);
  const r = resolveOpenTarget([root]);
  assert.strictEqual(r.kind, 'projects');
  assert.strictEqual(r.paths.length, 1);
  assert.strictEqual(path.basename(r.paths[0]), 'Real.csproj');
});

console.log('config (.roslynlsp.json):');

test('loadConfig reads .roslynlsp.json', () => {
  const root = tmpWorkspace(['App.sln']);
  fs.writeFileSync(path.join(root, '.roslynlsp.json'), JSON.stringify({ readyTimeoutMs: 90000, exclude: ['legacy'] }));
  const cfg = loadConfig(root);
  assert.strictEqual(cfg.readyTimeoutMs, 90000);
  assert.deepStrictEqual(cfg.exclude, ['legacy']);
});

test('config solution pin overrides discovery', () => {
  const root = tmpWorkspace(['A.sln', 'B.sln', 'src/A.csproj']);
  const r = resolveOpenTarget([root], null, { solution: 'B.sln' });
  assert.strictEqual(r.kind, 'solution');
  assert.strictEqual(path.basename(r.path), 'B.sln');
});

test('config solutions union loads referenced projects', () => {
  const root = tmpWorkspace(['repoA/src/A.csproj', 'repoB/src/B.csproj']);
  fs.writeFileSync(path.join(root, 'repoA/A.slnx'), '<Solution><Project Path="src/A.csproj" /></Solution>');
  fs.writeFileSync(path.join(root, 'repoB/B.slnx'), '<Solution><Project Path="src/B.csproj" /></Solution>');
  const r = resolveOpenTarget([root], null, { solutions: ['repoA/A.slnx', 'repoB/B.slnx'] });
  assert.strictEqual(r.kind, 'projects');
  assert.strictEqual(r.paths.length, 2);
});

test('config exclude prunes a directory from discovery', () => {
  const root = tmpWorkspace(['src/Real.csproj', 'legacy/Old.csproj']);
  const r = resolveOpenTarget([root], null, { exclude: ['legacy'] });
  assert.strictEqual(r.kind, 'projects');
  assert.strictEqual(r.paths.length, 1);
  assert.strictEqual(path.basename(r.paths[0]), 'Real.csproj');
});

console.log(`\n${passed} tests passed.`);
