'use strict';

const fs = require('fs');
const path = require('path');

// Directories that never contain meaningful project/solution files and would
// otherwise make discovery slow and noisy.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'bin', 'obj', 'packages', '.vs', '.vscode',
  'target', 'build', 'dist', '.idea', 'TestResults', '.understand-anything',
]);

// Walk `root` depth-first, yielding files whose name matches `predicate`,
// pruning the directories above. Errors on individual dirs are skipped so a
// single unreadable folder never aborts discovery.
function enumerateFiles(root, predicate) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(full);
        }
      } else if (predicate(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

const isSolution = (name) => name.endsWith('.slnx') || name.endsWith('.sln');
const isProject = (name) => name.endsWith('.csproj');

function solutionsAt(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && isSolution(e.name))
    .map((e) => path.join(dir, e.name));
}

// Decide what to tell Roslyn to load for a single workspace folder.
//
// The ordering encodes the multi-repo policy that sets this proxy apart:
//   1. exactly one solution at the folder root  -> open it (a normal checkout,
//      or a hand-authored master that aggregates several repos)
//   2. exactly one solution anywhere in the tree -> open it
//   3. otherwise (zero, or several side-by-side solutions) -> open EVERY
//      project, so solution-wide navigation works across all repos without a
//      hand-authored master solution.
function resolveForFolder(dir) {
  const rootSolutions = solutionsAt(dir);
  if (rootSolutions.length === 1) {
    return { kind: 'solution', path: rootSolutions[0], reason: 'single root solution' };
  }

  if (rootSolutions.length === 0) {
    const allSolutions = enumerateFiles(dir, isSolution);
    if (allSolutions.length === 1) {
      return { kind: 'solution', path: allSolutions[0], reason: 'single nested solution' };
    }
  }

  const projects = enumerateFiles(dir, isProject);
  if (projects.length > 0) {
    const why = rootSolutions.length > 1 ? 'multiple solutions' : 'no solution';
    return { kind: 'projects', paths: projects, reason: `${why} → all projects` };
  }

  return { kind: 'none', reason: 'no solutions or projects found' };
}

// Resolve across all workspace folders. An explicit override always wins.
function resolveOpenTarget(workspaceDirs, explicitSolution) {
  if (explicitSolution) {
    return { kind: 'solution', path: path.resolve(explicitSolution), reason: 'explicit --solution' };
  }
  for (const dir of workspaceDirs) {
    if (!dir) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const result = resolveForFolder(dir);
    if (result.kind !== 'none') {
      return result;
    }
  }
  return { kind: 'none', reason: 'no workspace folder yielded a solution or project' };
}

function pathToFileUri(p) {
  let full = path.resolve(p).replace(/\\/g, '/');
  // Windows drive paths -> file:///C:/... ; POSIX absolute -> file:///...
  if (!full.startsWith('/')) {
    full = '/' + full;
  }
  return 'file://' + encodeURI(full).replace(/#/g, '%23');
}

function fileUriToPath(uri) {
  if (!uri || !uri.startsWith('file://')) return null;
  let p = decodeURIComponent(uri.slice('file://'.length));
  // file:///C:/x -> /C:/x on Windows; strip the leading slash before a drive.
  if (/^\/[a-zA-Z]:/.test(p)) {
    p = p.slice(1);
  }
  return path.normalize(p);
}

module.exports = { resolveOpenTarget, pathToFileUri, fileUriToPath };
