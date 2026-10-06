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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csls-walk-'));
  roots.push(root);
  for (const rel of layout) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '');
  }
  return root;
}

test('dot-folders, Pods, vendor, venv and DerivedData are pruned from discovery', () => {
  const root = workspace([
    'src/Real.csproj',
    '.venv/A.csproj', '.cache/B.csproj', '.gradle/C.csproj',
    'Pods/D.csproj', 'ios/Pods/E.csproj', 'vendor/F.csproj', 'venv/G.csproj', 'DerivedData/H.csproj',
  ]);
  const r = resolveOpenTarget([root]);

  assert.strictEqual(r.kind, 'projects');
  assert.deepStrictEqual(r.paths.map((p) => path.basename(p)), ['Real.csproj']);
});

test('several nested solutions are reported as multiple solutions', () => {
  const root = workspace([
    'repoA/A.slnx', 'repoA/src/A.csproj',
    'repoB/B.slnx', 'repoB/src/B.csproj',
  ]);
  const r = resolveOpenTarget([root]);

  assert.strictEqual(r.kind, 'projects');
  assert.strictEqual(r.paths.length, 2);
  assert.strictEqual(r.reason, 'multiple solutions -> all projects');
});
