'use strict';

const fs = require('fs');
const path = require('path');

// Directories that never contain meaningful project/solution files and would
// otherwise make discovery slow and noisy. Every dot-folder (.git, .vs, .venv,
// .gradle, .cxx, .next and the like) is skipped as well.
const SKIP_DIRS = new Set([
  'node_modules', 'bin', 'obj', 'packages', 'target', 'build', 'dist', 'TestResults',
  'Pods', 'vendor', 'venv', 'DerivedData',
]);

const isSkippedName = (name) => name.startsWith('.') || SKIP_DIRS.has(name);

// Optional per-workspace config from `.roslynlsp.json` at the workspace root.
// All fields optional:
//   solution        pin one solution (path relative to the workspace, or absolute)
//   solutions       load the union of these solutions' projects (multi-solution)
//   exclude         extra directory names or path prefixes to skip in discovery
//   readyTimeoutMs  override the index-readiness hold cap
function loadConfig(dir) {
  if (!dir) return {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.roslynlsp.json'), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

// Build a directory-prune predicate from the built-in skip list plus any
// `exclude` entries (matched as a directory name or a path prefix). `relPath`
// is relative to the workspace folder, with `/` separators.
function makeSkip(exclude) {
  const extra = (Array.isArray(exclude) ? exclude : []).map((e) => String(e).replace(/\\/g, '/').replace(/\/+$/, ''));
  if (extra.length === 0) return isSkippedName;
  return (name, relPath) => isSkippedName(name) || extra.some((e) => name === e || relPath === e || relPath.startsWith(e + '/'));
}

// Walk `root` depth-first once, collecting solution and project files and
// pruning skipped directories. Errors on individual dirs are skipped so a
// single unreadable folder never aborts discovery.
function scan(root, skip) {
  const solutions = [];
  const projects = [];
  const stack = [[root, '']];
  while (stack.length > 0) {
    const [dir, rel] = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory()) {
        const childRel = rel ? `${rel}/${name}` : name;
        if (!skip(name, childRel)) stack.push([path.join(dir, name), childRel]);
      } else if (isSolution(name)) {
        solutions.push(path.join(dir, name));
      } else if (isProject(name)) {
        projects.push(path.join(dir, name));
      }
    }
  }
  return { solutions, projects };
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
  return entries.filter((e) => e.isFile() && isSolution(e.name)).map((e) => path.join(dir, e.name));
}

// Project paths referenced by a .sln or .slnx file, resolved to absolute paths
// that exist. Covers .slnx `Path="..."` attributes and .sln quoted project
// paths alike.
function projectsFromSolution(solutionPath) {
  let text;
  try { text = fs.readFileSync(solutionPath, 'utf8'); } catch { return []; }
  const base = path.dirname(solutionPath);
  const rels = new Set();
  const re = /["']([^"']+\.csproj)["']/gi;
  let m;
  while ((m = re.exec(text)) !== null) rels.add(m[1]);
  const out = [];
  for (const rel of rels) {
    const abs = path.resolve(base, rel.replace(/\\/g, path.sep));
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

// Decide what to tell Roslyn to load for a single workspace folder.
//   1. exactly one solution at the folder root  -> open it
//   2. exactly one solution anywhere in the tree -> open it
//   3. otherwise (zero, or several solutions) -> open EVERY project
function resolveForFolder(dir, skip) {
  const rootSolutions = solutionsAt(dir);
  if (rootSolutions.length === 1) {
    return { kind: 'solution', path: rootSolutions[0], reason: 'single root solution' };
  }
  const { solutions, projects } = scan(dir, skip);
  if (rootSolutions.length === 0 && solutions.length === 1) {
    return { kind: 'solution', path: solutions[0], reason: 'single nested solution' };
  }
  if (projects.length > 0) {
    const why = solutions.length > 1 ? 'multiple solutions' : 'no solution';
    return { kind: 'projects', paths: projects, reason: `${why} -> all projects` };
  }
  return { kind: 'none', reason: 'no solutions or projects found' };
}

// Resolve what to open. Precedence: explicit --solution, then .roslynlsp.json
// (`solution`, then `solutions`), then automatic discovery. A pinned solution
// that does not exist is skipped and named in the reason: Roslyn would never
// signal readiness for it, so every held request would wait the full cap.
function resolveOpenTarget(workspaceDirs, explicitSolution, config) {
  const cfg = config || {};
  const firstDir = (workspaceDirs || []).find(Boolean);
  const pins = [];
  if (explicitSolution) pins.push({ path: path.resolve(explicitSolution), reason: 'explicit --solution' });
  if (cfg.solution && firstDir) pins.push({ path: path.resolve(firstDir, cfg.solution), reason: 'config solution' });
  const missing = [];
  const withMissing = (reason) => [...missing, reason].join('; ');
  for (const pin of pins) {
    if (fs.existsSync(pin.path)) return { kind: 'solution', path: pin.path, reason: withMissing(pin.reason) };
    missing.push(`${pin.reason} not found: ${pin.path}`);
  }
  if (Array.isArray(cfg.solutions) && cfg.solutions.length && firstDir) {
    const seen = new Set();
    const paths = [];
    for (const s of cfg.solutions) {
      for (const p of projectsFromSolution(path.resolve(firstDir, s))) {
        if (!seen.has(p)) { seen.add(p); paths.push(p); }
      }
    }
    if (paths.length) return { kind: 'projects', paths, reason: withMissing(`config solutions union (${cfg.solutions.length})`) };
  }
  const skip = makeSkip(cfg.exclude);
  for (const dir of workspaceDirs || []) {
    if (!dir) continue;
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
    if (!isDir) continue;
    const result = resolveForFolder(dir, skip);
    if (result.kind !== 'none') return { ...result, reason: withMissing(result.reason) };
  }
  return { kind: 'none', reason: withMissing('no workspace folder yielded a solution or project') };
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

module.exports = { resolveOpenTarget, loadConfig, pathToFileUri, fileUriToPath };
