#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shellComments, shellProblems } from './strip-comments-shell.mjs';
import { yamlComments, yamlProblems } from './strip-comments-yaml.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(ROOT, 'package.json'));
const ts = require('@typescript/typescript6');

const DEFAULT_PATHS = ['apps', 'packages', 'infra', '.github', 'e2e', '.mergify.yml', 'tsconfig.base.json'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
const SKIPPED_PREFIXES = ['.claude/archive'];
const SKIPPED_FILES = new Set(['pnpm-lock.yaml']);
const IGNORE_FILE = '.strip-comments-ignore';
const PREVIEW_LENGTH = 60;
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', ...JAVASCRIPT_EXTENSIONS]);
const JSDOC_TYPE_TAG =
  /@(?:type|param|arg|argument|returns?|yields?|this|extends|augments|implements|enum|satisfies|throws|property|prop|typedef|callback|overload)\s*\{|@(?:template|import)\s/;
const EXIT = { clean: 0, found: 1, refused: 2 };

const KEEP = [
  [/^\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b/, 'triple-slash directive (TypeScript)'],
  [/^\/\/\/?\s*@ts-(?:expect-error|ignore|(?:nocheck|check)\b)/, 'TypeScript checker directive'],
  [/^\/\*(?:[\s\S]*\n)?[^\S\n]*[/*]*[^\S\n]*@ts-(?:expect-error|ignore)[^\n]*$/, 'TypeScript checker directive'],
  [/^\/[/*]\s*(?:eslint|oxlint)(?:-(?:disable|enable|env)(?:-next-line|-line)?\b|\s+[\w@/-]+\s*:)/, 'ESLint or Oxlint directive'],
  [/^\/[/*]\s*(?:global|globals|jshint|jscs)\s/, 'linter globals directive'],
  [/^\/[/*]\s*prettier-ignore\b/, 'Prettier directive'],
  [/^\/[/*]\s*(?:istanbul|c8|v8)\s+ignore\b/, 'coverage directive'],
  [/^\/\*\s*(?:@vite-ignore|webpack[A-Z]\w*\s*:)/, 'bundler directive'],
  [/^\/\*\s*[#@]__(?:PURE|NO_SIDE_EFFECTS)__\s*\*\/$/, 'tree-shaking annotation'],
  [/^\/(?:\/|\*\*?)\s*@(?:vitest|jest)-environment\b/, 'test environment pragma'],
  [/^\/(?:\/|\*\*?)\s*@jsx(?:ImportSource|Runtime|Frag)?\b/, 'JSX pragma'],
  [/^\/\*!|^\/(?:\/|\*+)[\s*]*@(?:license|preserve)\b/, 'licence header'],
];

export function keepReason(comment) {
  for (const [pattern, reason] of KEEP) if (pattern.test(comment)) return reason;
  return null;
}

export function isDirective(comment) {
  return keepReason(comment) !== null;
}

const HASH_KINDS = new Set(['yaml', 'shell']);

const HASH_KEEP = {
  yaml: [/^#\s*yaml-language-server:/, /^#\s*prettier-ignore\b/],
  shell: [/^#\s*shellcheck\b/i],
};

const ACTION_SHA_PIN = /^\s*(?:-\s+)?uses:\s+(["']?)[\w.-]+\/[\w./-]+@[0-9a-f]{40}\1\s+$/;
const VERSION_NOTE = /^#\s*v?\d+(?:\.\d+)*\s*$/;

const HASH_KEEP_AFTER = {
  yaml: [[ACTION_SHA_PIN, VERSION_NOTE]],
  shell: [],
};

const isHashDirective = (kind, text, { start, end }) => {
  const comment = text.slice(start, end);
  const before = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  return (
    (start === 0 && comment.startsWith('#!')) ||
    HASH_KEEP[kind].some((pattern) => pattern.test(comment)) ||
    HASH_KEEP_AFTER[kind].some(([line, note]) => line.test(before) && note.test(comment))
  );
};

export const GENERATED = /\bGENERATED\b[\s\S]*\bdo not edit\b/;

export function kindOf(path) {
  const extension = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) return 'script';
  if (extension === '.yml' || extension === '.yaml') return 'yaml';
  if (extension === '.sh') return 'shell';
  if (extension === '.jsonc') return 'jsonc';
  const isConfig = /^tsconfig.*\.json$/.test(basename(path)) || basename(dirname(path)) === '.vscode';
  return extension === '.json' && isConfig ? 'jsonc' : null;
}

function scriptKind(path) {
  switch (extname(path).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.json':
    case '.jsonc':
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.TS;
  }
}

function leaves(sf) {
  const out = [];
  const visit = (node) => {
    const children = node.getChildren(sf);
    if (children.length === 0 && node.kind !== ts.SyntaxKind.SyntaxList) {
      out.push(node);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  return out;
}

function isJsxText(node) {
  return node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
}

function commentRanges(sf, text) {
  const seen = new Map();
  const all = leaves(sf);
  const jsxText = all.filter(isJsxText).map((leaf) => [leaf.pos, leaf.end]);
  const inJsxText = (at) => jsxText.some(([from, to]) => at >= from && at < to);
  const add = (range) => {
    if (inJsxText(range.pos)) return;
    if (!seen.has(range.pos)) seen.set(range.pos, { start: range.pos, end: range.end });
  };
  for (const leaf of all) {
    if (isJsxText(leaf)) continue;
    for (const range of ts.getLeadingCommentRanges(text, leaf.pos) ?? []) add(range);
    for (const range of ts.getTrailingCommentRanges(text, leaf.end) ?? []) add(range);
  }
  for (const range of ts.getLeadingCommentRanges(text, sf.endOfFileToken.pos) ?? []) add(range);
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

function emptyJsxExpressions(sf, text, comments) {
  const out = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxExpression && node.expression === undefined) {
      const open = node.getStart(sf);
      const close = node.end - 1;
      const inner = comments.filter((c) => c.start > open && c.end <= close);
      const rest = text
        .slice(open + 1, close)
        .split('')
        .map((ch, i) => (inner.some((c) => open + 1 + i >= c.start && open + 1 + i < c.end) ? '' : ch))
        .join('');
      if (inner.length > 0 && rest.trim() === '' && inner.every((c) => !isDirective(text.slice(c.start, c.end)))) {
        out.push({ start: open, end: node.end });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function position(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo] + 1 };
}

const isBlank = (s) => s.trim() === '';
const HSPACE = /[ \t]/;

const commentRuns = (text, ranges) => {
  const runs = [];
  let previousEnd = -1;
  for (const { start, end } of ranges) {
    const joined = previousEnd >= 0 && /^[ \t]*\r?\n?[ \t]*$/.test(text.slice(previousEnd, start));
    if (joined) runs[runs.length - 1] += `\n${text.slice(start, end)}`;
    else runs.push(text.slice(start, end));
    previousEnd = end;
  }
  return runs;
};

const headerLines = (run) =>
  run.split('\n').map((line) =>
    line
      .replace(/^\s*(?:\/\*+|\/\/+|#+|\*+(?!\/))?\s?/, '')
      .replace(/\*\/\s*$/, '')
      .trim(),
  );

const isGeneratedHeader = (run) =>
  headerLines(run).some((line) => /^GENERATED by\b/.test(line)) && GENERATED.test(run);

const isJsdocTypes = (path, comment) =>
  JAVASCRIPT_EXTENSIONS.has(extname(path).toLowerCase()) && comment.startsWith('/**') && JSDOC_TYPE_TAG.test(comment);

function findScriptComments(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const all = commentRanges(sf, text);
  const generated = commentRuns(text, all).some(isGeneratedHeader);
  const dropped = all.filter((c) => {
    const comment = text.slice(c.start, c.end);
    return !isDirective(comment) && !isJsdocTypes(path, comment);
  });
  return { generated, dropped, jsx: emptyJsxExpressions(sf, text, all), protect: [] };
}

function findHashComments(kind, text) {
  const { comments, protect } = kind === 'yaml' ? yamlComments(text) : shellComments(text);
  const generated = commentRuns(text, comments).some(isGeneratedHeader);
  const dropped = comments.filter((c) => !isHashDirective(kind, text, c));
  return { generated, dropped, jsx: [], protect };
}

export function planFile(path, text) {
  const kind = kindOf(path);
  const found = HASH_KINDS.has(kind) ? findHashComments(kind, text) : findScriptComments(path, text);
  if (found.generated) return { generated: true, edits: [], comments: [] };
  return planRemoval(text, found);
}

function planRemoval(text, { dropped, jsx, protect }) {
  const mask = new Uint8Array(text.length);
  const replacements = new Map();
  for (const c of dropped) mask.fill(1, c.start, c.end);
  for (const e of jsx) mask.fill(1, e.start, e.end);

  const starts = lineStarts(text);
  const lineEnd = (i) => (i + 1 < starts.length ? starts[i + 1] : text.length);
  const lineCount = starts.length;
  const removedLine = new Uint8Array(lineCount);

  for (let i = 0; i < lineCount; i += 1) {
    const from = starts[i];
    const to = lineEnd(i);
    let touched = false;
    let rest = '';
    for (let k = from; k < to; k += 1) {
      if (mask[k]) touched = true;
      else if (text[k] !== '\n') rest += text[k];
    }
    if (!touched) continue;
    const wasContent = !isBlank(text.slice(from, to));
    let wholeLineMasked = true;
    for (let k = from; k < to; k += 1) if (!mask[k] && text[k] !== '\n') wholeLineMasked = false;
    const insideComment = wholeLineMasked && mask[from] === 1 && from > 0 && mask[from - 1] === 1;
    if ((wasContent || insideComment) && isBlank(rest)) {
      removedLine[i] = 1;
      mask.fill(1, from, to);
    }
  }

  for (let i = 0; i < lineCount; i += 1) {
    if (removedLine[i]) continue;
    const from = starts[i];
    const to = lineEnd(i);
    let k = from;
    while (k < to) {
      if (!mask[k]) {
        k += 1;
        continue;
      }
      let runEnd = k;
      while (runEnd < text.length && mask[runEnd]) runEnd += 1;
      let indentOnly = true;
      for (let q = from; q < k; q += 1) if (mask[q] || !HSPACE.test(text[q])) indentOnly = false;
      let runStart = k;
      if (indentOnly) {
        let j = runEnd;
        while (j < text.length && HSPACE.test(text[j])) j += 1;
        mask.fill(1, runEnd, j);
        runEnd = j;
      } else {
        let j = k;
        while (j > from && HSPACE.test(text[j - 1]) && !mask[j - 1]) j -= 1;
        mask.fill(1, j, k);
        runStart = j;
      }
      const before = text[runStart - 1] ?? '';
      const after = text[runEnd] ?? '';
      const spansNewline = text.slice(runStart, runEnd).includes('\n');
      const endLine = position(starts, Math.min(runEnd, text.length - 1)).line - 1;
      const trailingCode = spansNewline && !isBlank(text.slice(runEnd, lineEnd(endLine)));
      if (trailingCode) replacements.set(runStart, '\n');
      else if (/[\w$]/.test(before) && /[\w$]/.test(after)) replacements.set(runStart, ' ');
      k = runEnd;
    }
  }

  const survivors = [];
  for (let i = 0; i < lineCount; i += 1) {
    const from = starts[i];
    const to = lineEnd(i);
    if (from === text.length) continue;
    let allMasked = to > from;
    for (let k = from; k < to; k += 1) if (!mask[k]) allMasked = false;
    if (!allMasked) survivors.push(i);
  }
  const lineText = (i) => text.slice(starts[i], lineEnd(i));
  const nearRemoval = (a, b) => {
    for (let i = a + 1; i < b; i += 1) if (removedLine[i]) return true;
    return false;
  };
  for (let s = 0; s < survivors.length; s += 1) {
    const i = survivors[s];
    if (!isBlank(lineText(i)) || protect.some((r) => starts[i] >= r.start && starts[i] < r.end)) continue;
    const prev = s > 0 ? survivors[s - 1] : -1;
    const next = s + 1 < survivors.length ? survivors[s + 1] : lineCount;
    const touchesRemoval = nearRemoval(prev, i) || nearRemoval(i, next) || (prev === -1 && nearRemoval(-1, i));
    if (!touchesRemoval) continue;
    const prevText = prev >= 0 ? lineText(prev).trimEnd() : '';
    const nextText = next < lineCount ? lineText(next).trim() : '';
    const redundant =
      prev === -1 ||
      isBlank(prevText) ||
      /[{([]$/.test(prevText) ||
      /^[})\]]/.test(nextText) ||
      next >= lineCount;
    if (redundant) {
      mask.fill(1, starts[i], lineEnd(i));
      survivors.splice(s, 1);
      s -= 1;
    }
  }

  const edits = [];
  let k = 0;
  while (k < text.length) {
    if (!mask[k]) {
      k += 1;
      continue;
    }
    let end = k;
    while (end < text.length && mask[end]) end += 1;
    let replacement = '';
    for (const [at, value] of replacements) if (at >= k && at < end) replacement = value;
    const a = position(starts, k);
    const b = position(starts, end);
    const kinds = new Set();
    for (const c of dropped) {
      if (c.start < k || c.start >= end) continue;
      const body = text.slice(c.start, c.end);
      const inJsx = jsx.some((e) => c.start > e.start && c.end < e.end);
      kinds.add(inJsx ? 'jsx' : body.startsWith('/**') ? 'jsdoc' : body.startsWith('/*') ? 'block' : 'line');
    }
    edits.push({
      kinds: [...kinds].sort(),
      start: k,
      end,
      startLine: a.line,
      startCol: a.col,
      endLine: b.line,
      endCol: b.col,
      text: text.slice(k, end),
      ...(replacement ? { replacement } : {}),
    });
    k = end;
  }

  const commentRecords = dropped.map((c) => {
    const body = text.slice(c.start, c.end);
    const inJsx = jsx.some((e) => c.start > e.start && c.end < e.end);
    const at = position(starts, c.start);
    return {
      start: c.start,
      end: c.end,
      line: at.line,
      col: at.col,
      kind: inJsx ? 'jsx' : body.startsWith('/**') ? 'jsdoc' : body.startsWith('/*') ? 'block' : 'line',
      text: body,
    };
  });
  return { generated: false, comments: commentRecords, edits };
}

export function applyEdits(text, edits) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + (e.replacement ?? '') + out.slice(e.end);
  }
  return out;
}

function significantTokens(path, text, skip = []) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const out = [];
  for (const leaf of leaves(sf)) {
    const start = leaf.getStart(sf);
    if (skip.some((r) => start >= r.start && start < r.end)) continue;
    if (leaf.kind === ts.SyntaxKind.EndOfFileToken) continue;
    let value = leaf.getText(sf);
    if (isJsxText(leaf)) {
      value = value.replace(/\s+/g, ' ').trim();
      if (value === '') continue;
    }
    out.push(`${leaf.kind}:${value}`);
  }
  return { tokens: out, diagnostics: sf.parseDiagnostics.length };
}

function tokenProblems(path, before, after, edits) {
  const problems = [];
  const a = significantTokens(path, before, edits);
  const b = significantTokens(path, after);
  if (a.diagnostics !== b.diagnostics) problems.push(`parse errors ${a.diagnostics} -> ${b.diagnostics}`);
  if (a.tokens.length !== b.tokens.length) {
    problems.push(`token count ${a.tokens.length} -> ${b.tokens.length}`);
  } else {
    const at = a.tokens.findIndex((t, i) => t !== b.tokens[i]);
    if (at >= 0) problems.push(`token ${at} differs: ${a.tokens[at]} -> ${b.tokens[at]}`);
  }
  return problems;
}

const CONTENT_PROBLEMS = { yaml: yamlProblems, shell: shellProblems };

export function verifyFile(path, before, after, edits) {
  const kind = kindOf(path);
  const hash = HASH_KINDS.has(kind);
  const problems = hash ? CONTENT_PROBLEMS[kind](before, after) : tokenProblems(path, before, after, edits);
  const commentSyntax = hash ? /#[^\n]*/g : /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  const ignorable = hash ? /\s/g : /[{}\s]/g;
  for (const e of edits) {
    const stripped = e.text.replace(commentSyntax, '').replace(ignorable, '');
    if (stripped !== '') problems.push(`edit at ${e.startLine}:${e.startCol} removes non-comment text ${JSON.stringify(stripped.slice(0, 60))}`);
  }
  return problems;
}

class UsageError extends Error {}

const HELP = `Usage: node infra/scripts/strip-comments.mjs [--check | --write | --report] [--type ts,sh,...] [paths...]

Removes the comments from the code we write: TypeScript and JavaScript (ts, tsx, mts, cts, js, jsx, mjs, cjs),
YAML (yml, yaml), shell (sh) and the JSON that allows comments (jsonc, tsconfig*.json, .vscode/*.json).
Directives that tools read stay: a shebang, /// <reference>, @ts-*, eslint-* and oxlint-* comments, shellcheck
and yaml-language-server comments, istanbul/c8/v8 ignores, prettier-ignore, a leading @license or @preserve,
the version note after a SHA-pinned GitHub Actions uses: line, and the like.

  --check    the default: list every comment that would go (file:line and its first ${PREVIEW_LENGTH} characters), write nothing; exit 1 if there is any
  --write    remove them in place; nothing is written if any file cannot be handled safely
  --report   print the counts per file type and per top-level folder (alone, it only counts)
  --type     only these extensions, for example --type ts,tsx
  paths      files or folders; default: ${DEFAULT_PATHS.join(', ')} (those that exist), from the current directory

Skipped: node_modules, dist, .git, ${SKIPPED_PREFIXES.join(', ')}, pnpm-lock.yaml, files whose header says GENERATED ... do not edit,
files ignored by git, and every path listed in ${IGNORE_FILE} (one per line).
Exit codes: 0 clean or written, 1 comments found by --check, 2 usage error or a file that cannot be handled safely.`;

function parseArgs(argv) {
  const args = { check: false, write: false, report: false, help: false, types: null, paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--report') args.report = true;
    else if (arg === '--help') args.help = true;
    else if (arg === '--type' || arg.startsWith('--type=')) {
      const value = arg === '--type' ? argv[(i += 1)] : arg.slice('--type='.length);
      if (!value || value.startsWith('--')) throw new UsageError('--type needs a comma-separated list of extensions');
      args.types = new Set(value.split(',').map((type) => type.trim().replace(/^\./, '').toLowerCase()));
    } else if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    else args.paths.push(arg);
  }
  if (args.check && args.write) throw new UsageError('--check and --write exclude each other');
  if (!args.write && !args.report) args.check = true;
  return args;
}

function isWorkTreeRoot(root) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return realpathSync(top) === realpathSync(root);
  } catch {
    return false;
  }
}

const childPath = (parent, name) => (parent === '' ? name : `${parent}/${name}`);

function walk(root, rel) {
  const stat = lstatSync(join(root, rel));
  if (stat.isFile()) return [rel];
  if (!stat.isDirectory()) return [];
  return readdirSync(join(root, rel))
    .sort()
    .flatMap((name) => (SKIPPED_DIRECTORIES.has(name) ? [] : walk(root, childPath(rel, name))));
}

function listedByGit(root, rel) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', rel === '' ? '.' : rel], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return out.split('\0').filter((file) => file !== '' && existsSync(join(root, file)));
}

function ignoredPaths(root) {
  const path = join(root, IGNORE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

const isSkipped = (file) =>
  file.split('/').slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment)) ||
  SKIPPED_PREFIXES.some((prefix) => file.startsWith(`${prefix}/`)) ||
  SKIPPED_FILES.has(basename(file));

function selectFiles(root, { paths, types }) {
  const requested = paths.length > 0 ? paths : DEFAULT_PATHS.filter((path) => existsSync(join(root, path)));
  const list = isWorkTreeRoot(root) ? listedByGit : walk;
  const ignored = ignoredPaths(root);
  const files = new Set();
  for (const path of requested) {
    const rel = relative(root, resolve(root, path));
    if (rel.startsWith('..')) throw new UsageError(`${path} is outside the working directory`);
    if (!existsSync(join(root, rel))) throw new UsageError(`no such path: ${path}`);
    for (const file of list(root, rel)) files.add(file);
  }
  return [...files]
    .sort()
    .filter((file) => kindOf(file) !== null && (types === null || types.has(extname(file).slice(1).toLowerCase())))
    .filter((file) => !isSkipped(file) && !ignored.some((entry) => file === entry || file.startsWith(`${entry}/`)));
}

function scan(root, files) {
  const scanned = [];
  const errors = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    try {
      scanned.push({ file, text, plan: planFile(file, text) });
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  return { scanned, errors };
}

const preview = (comment) => comment.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);

function reportLines(scanned) {
  const byType = new Map();
  const byFolder = new Map();
  const byFolderAndType = new Map();
  let filesWithComments = 0;
  const tally = (counts, key, n) => counts.set(key, (counts.get(key) ?? 0) + n);
  for (const { file, plan } of scanned) {
    const n = plan.comments.length;
    if (n === 0) continue;
    filesWithComments += 1;
    const type = extname(file).slice(1).toLowerCase();
    const folder = file.includes('/') ? file.slice(0, file.indexOf('/')) : '.';
    tally(byType, type, n);
    tally(byFolder, folder, n);
    tally(byFolderAndType, `${folder}/${type}`, n);
  }
  const table = (title, counts) => {
    const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const width = Math.max(0, ...rows.map(([name]) => name.length));
    return [title, ...rows.map(([name, n]) => `  ${name.padEnd(width)}  ${n}`)];
  };
  return [
    ...table('by file type', byType),
    ...table('by folder', byFolder),
    ...table('by folder and file type', byFolderAndType),
    `files with comments: ${filesWithComments} of ${scanned.length} scanned`,
  ];
}

function write(root, scanned) {
  const writes = [];
  const problems = [];
  for (const { file, text, plan } of scanned) {
    if (plan.edits.length === 0) continue;
    const after = applyEdits(text, plan.edits);
    let issues;
    try {
      issues = verifyFile(file, text, after, plan.edits);
    } catch (error) {
      issues = [error.message];
    }
    if (issues.length > 0) problems.push(...issues.map((issue) => `${file}: ${issue}`));
    else writes.push({ file, after, removed: plan.comments.length });
  }
  if (problems.length > 0) return problems;
  for (const { file, after } of writes) writeFileSync(join(root, file), after);
  const removed = writes.reduce((sum, entry) => sum + entry.removed, 0);
  console.log(`strip-comments: removed ${removed} comments from ${writes.length} files`);
  return [];
}

function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return EXIT.clean;
  }
  const root = process.cwd();
  const { scanned, errors } = scan(root, selectFiles(root, args));
  const refusals = [...errors];
  if (args.write && errors.length === 0) refusals.push(...write(root, scanned));
  for (const refusal of refusals) console.error(`strip-comments: ${refusal}`);
  if (refusals.length > 0) return EXIT.refused;
  const comments = scanned.flatMap(({ file, plan }) => plan.comments.map((comment) => `${file}:${comment.line} ${preview(comment.text)}`));
  if (args.check) for (const line of comments) console.log(line);
  if (args.report) for (const line of reportLines(scanned)) console.log(line);
  if (!args.check || comments.length === 0) return EXIT.clean;
  console.error(`strip-comments --check: ${comments.length} comments found, and code carries no comments (CLAUDE.md)`);
  return EXIT.found;
}

function main(argv) {
  try {
    process.exitCode = run(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`strip-comments: ${error.message}\n\n${HELP}`);
    process.exitCode = EXIT.refused;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

