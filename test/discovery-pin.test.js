'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const { resolveOpenTarget } = require('../plugins/csharp-lsp/proxy/discovery');

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csls-pin-'));
  roots.push(root);
  for (const rel of layout) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return root;
}

test('a missing config solution falls through to discovery and is named in the reason', () => {
  const root = workspace(['App.sln', 'src/App.csproj']);
  const r = resolveOpenTarget([root], null, { solution: 'Gone.sln' });

  assert.strictEqual(r.kind, 'solution');
  assert.strictEqual(path.basename(r.path), 'App.sln');
  assert.strictEqual(r.reason, `config solution not found: ${path.join(root, 'Gone.sln')}; single root solution`);
});

test('a missing --solution falls through to the config solution and is named in the reason', () => {
  const root = workspace(['A.sln', 'B.sln']);
  const missing = path.join(root, 'Missing.sln');
  const r = resolveOpenTarget([root], missing, { solution: 'B.sln' });

  assert.strictEqual(r.kind, 'solution');
  assert.strictEqual(path.basename(r.path), 'B.sln');
  assert.strictEqual(r.reason, `explicit --solution not found: ${missing}; config solution`);
});

test('a pinned solution that exists keeps its plain reason', () => {
  const root = workspace(['A.sln', 'B.sln']);
  const r = resolveOpenTarget([root], path.join(root, 'A.sln'), { solution: 'B.sln' });

  assert.strictEqual(path.basename(r.path), 'A.sln');
  assert.strictEqual(r.reason, 'explicit --solution');
});
