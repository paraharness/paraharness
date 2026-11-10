import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import jsdocPlugin from 'eslint-plugin-jsdoc';

/**
 * Process-wide cache of normalized absolute file paths imported or re-exported across `packages/**`.
 */
const WORKSPACE_IMPORT_CACHE = {
  initialized: false,
  referencedFiles: new Set(),
};

/**
 * Recursively collects all `.ts` file paths under `dirPath` into `outFiles`.
 *
 * Normalizes path separators to forward slashes so lookups are platform-independent.
 *
 * @param {string}   dirPath  - Directory path to traverse recursively.
 * @param {string[]} outFiles - Accumulator array receiving normalized absolute `.ts` file paths.
 *
 * @returns {void}
 */
function collectPackageTypeScriptFiles(dirPath, outFiles) {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) collectPackageTypeScriptFiles(fullPath, outFiles);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      outFiles.push(fullPath.replace(/\\/g, '/'));
    }
  }
}

/**
 * Returns the cached set of normalized absolute `.ts` file paths referenced by any import or re-export across `packages/**` and `tests/**`.
 *
 * Scans all workspace TypeScript files once per lint process and resolves relative `.js`/`.ts` specifiers.
 *
 * @returns {Set<string>} Set of normalized absolute `.ts` file paths imported or re-exported in the workspace.
 */
function getWorkspaceReferencedFiles() {
  if (WORKSPACE_IMPORT_CACHE.initialized) return WORKSPACE_IMPORT_CACHE.referencedFiles;
  WORKSPACE_IMPORT_CACHE.initialized = true;
  const allFiles = [];
  collectPackageTypeScriptFiles(path.join(import.meta.dirname, 'packages'), allFiles);
  collectPackageTypeScriptFiles(path.join(import.meta.dirname, 'tests'), allFiles);
  const specifierPattern = /(?:from|import)\s*['"](\.[^'"]+)['"]/g;
  for (const filePath of allFiles) {
    const sourceText = readFileSync(filePath, 'utf8');
    for (const match of sourceText.matchAll(specifierPattern)) {
      const rawSpecifier = match[1];
      if (!rawSpecifier) continue;
      const resolvedPath = path
        .resolve(path.dirname(filePath), rawSpecifier.replace(/\.js$/, '.ts'))
        .replace(/\\/g, '/');
      WORKSPACE_IMPORT_CACHE.referencedFiles.add(resolvedPath);
    }
  }
  return WORKSPACE_IMPORT_CACHE.referencedFiles;
}

/**
 * Classifies a top-level AST declaration into one of the five canonical file entity kinds.
 *
 * Unwraps export declarations and maps interfaces, types, classes, functions, and constants to their category.
 *
 * @param {object} rawNode - Top-level statement from `Program.body`.
 *
 * @returns {{ kind: string, name: string, node: object } | null} Entity descriptor or `null` for imports/re-exports.
 */
function classifyTopLevelEntity(rawNode) {
  if (rawNode.type === 'ImportDeclaration' || rawNode.type === 'ExportAllDeclaration') return null;
  if (rawNode.type === 'ExportNamedDeclaration' && rawNode.declaration === null) return null;
  const node = (rawNode.type === 'ExportNamedDeclaration' || rawNode.type === 'ExportDefaultDeclaration') && rawNode.declaration ? rawNode.declaration : rawNode;
  if (node.type === 'TSInterfaceDeclaration') return { kind: 'interface', name: node.id?.name ?? '<anonymous>', node };
  if (node.type === 'TSTypeAliasDeclaration') return { kind: 'type', name: node.id?.name ?? '<anonymous>', node };
  if (node.type === 'ClassDeclaration') return { kind: 'class', name: node.id?.name ?? '<anonymous>', node };
  if (node.type === 'FunctionDeclaration') return { kind: 'function', name: node.id?.name ?? '<anonymous>', node };
  if (node.type === 'VariableDeclaration') {
    const firstId = node.declarations?.[0]?.id;
    const isFn = (node.declarations ?? []).some((d) => d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression'));
    return { kind: isFn ? 'function' : 'const', name: firstId?.type === 'Identifier' ? firstId.name : '<variable>', node };
  }
  return null;
}

/**
 * Validates that interfaces in a file are reachable from a single root (or `*Params`/`*Options` roots in function/class files).
 *
 * Builds the `TSPropertySignature`, `TSIndexSignature`, `TSMethodSignature`, and `extends` reference graph and reports unreachable interfaces.
 *
 * @param {object[]} interfaces     - Array of classified interface descriptors in the file.
 * @param {string}   filename       - Normalized file path of the current module.
 * @param {object}   context        - ESLint rule execution context.
 * @param {boolean}  paramRootsOnly - Whether only `*Params` / `*Options` interfaces may serve as roots.
 *
 * @returns {void}
 */
function verifySingleRootInterface(interfaces, filename, context, paramRootsOnly = false) {
  for (const item of interfaces) {
    for (const member of item.node.body?.body ?? []) {
      if (member.type === 'TSPropertySignature' && member.key?.type === 'Identifier' && member.key.name.endsWith('Template')) {
        context.report({ node: member, message: `Fake '*Template' property '${member.key.name}' on '${item.name}' is forbidden (Rule 1.2 & Rule 3.4).` });
      }
    }
  }
  if (!paramRootsOnly && interfaces.length <= 1) return;
  const collectRefs = (astNode, out) => {
    if (!astNode || typeof astNode !== 'object') return;
    if (astNode.type === 'Identifier') out.add(astNode.name);
    for (const [k, v] of Object.entries(astNode)) {
      if (k === 'parent' || k === 'range' || k === 'loc') continue;
      if (Array.isArray(v)) for (const item of v) collectRefs(item, out);
      else if (v && typeof v === 'object') collectRefs(v, out);
    }
  };
  const byName = new Map(interfaces.map((item) => [item.name, item]));
  const edges = new Map();
  const inDegree = new Map(interfaces.map((item) => [item.name, 0]));
  for (const item of interfaces) {
    const refs = new Set();
    for (const heritage of item.node.extends ?? []) collectRefs(heritage, refs);
    for (const member of item.node.body?.body ?? []) {
      if (member.type === 'TSPropertySignature' && member.key?.type === 'Identifier' && member.key.name.endsWith('Template')) continue;
      if (member.type === 'TSPropertySignature' || member.type === 'TSIndexSignature' || member.type === 'TSMethodSignature') collectRefs(member.typeAnnotation ?? member, refs);
    }
    const targets = [...refs].filter((ref) => ref !== item.name && byName.has(ref));
    edges.set(item.name, targets);
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }
  const baseStem = (filename.split('/').pop() ?? '').replace(/\.[^.]+$/, '').replace(/-/g, '').toLowerCase();
  const root = interfaces.find((i) => i.name.toLowerCase() === baseStem && (inDegree.get(i.name) ?? 0) === 0) ?? interfaces.find((i) => i.name.toLowerCase() === baseStem) ?? interfaces.filter((i) => (inDegree.get(i.name) ?? 0) === 0).pop() ?? interfaces[interfaces.length - 1];
  const roots = paramRootsOnly ? interfaces.filter((i) => /(?:Params|Options)$/.test(i.name)).map((i) => i.name) : [root.name];
  const reachable = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    for (const next of edges.get(queue.shift()) ?? []) {
      if (!reachable.has(next)) queue.push(next);
      reachable.add(next);
    }
  }
  for (const item of interfaces) {
    if (!reachable.has(item.name)) {
      context.report({
        node: item.node,
        message: paramRootsOnly
          ? `Interface '${item.name}' in a function/class file must be a '*Params' / '*Options' interface or reachable from one (Rule 1.1 & Rule 1.2).`
          : `Interface '${item.name}' is not reachable from root interface '${root.name}'. Unrelated interfaces must live in separate files (Rule 1.2).`,
      });
    }
  }
}

/**
 * Validates that an AST node has an adjacent JSDoc block with a non-empty summary and required tags.
 *
 * Enforces summary prose, `@template` and `@param` tags, and `@returns` on non-void callables.
 *
 * @param {object} params - Validation target node, callable node, kind label, name, and ESLint context.
 *
 * @returns {void}
 */
function checkStructuredJsdoc(params) {
  const { node, callableNode, kindLabel, name, isCallable, context } = params;
  const target = node.parent?.type === 'ExportNamedDeclaration' || node.parent?.type === 'ExportDefaultDeclaration' ? node.parent : node;
  const last = context.sourceCode.getCommentsBefore(target).pop();
  const comment = last && last.type === 'Block' && last.value.startsWith('*') && target.loc.start.line - last.loc.end.line <= 1 ? last : null;
  if (!comment) return context.report({ node, message: `Missing mandatory JSDoc on ${kindLabel} '${name}' (Rule 2.1).` });
  const lines = comment.value.replace(/^\*/, '').split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '').trimEnd());
  const firstTagIdx = lines.findIndex((l) => /^@[a-zA-Z]+/.test(l.trim()));
  const prose = (firstTagIdx === -1 ? lines : lines.slice(0, firstTagIdx)).join('\n').trim();
  if (!prose) context.report({ node, message: `JSDoc for ${kindLabel} '${name}' must contain a non-empty summary before any @tags (Rule 2.2).` });
  const tagLines = firstTagIdx === -1 ? [] : lines.slice(firstTagIdx);
  const templateLines = tagLines.filter((l) => l.trim().startsWith('@template'));
  for (const tp of callableNode?.typeParameters?.params ?? node.typeParameters?.params ?? []) {
    const tpName = typeof tp.name === 'string' ? tp.name : tp.name?.name;
    if (tpName && !templateLines.some((l) => new RegExp(`^@template\\s+(?:\\{[^}]+\\}\\s+)?${tpName}\\b\\s+\\S+`).test(l.trim()))) {
      context.report({ node, message: `JSDoc for ${kindLabel} '${name}' is missing '@template ${tpName} <Description>' (Rule 2.2).` });
    }
  }
  if (!isCallable) return;
  const paramLines = tagLines.filter((l) => l.trim().startsWith('@param'));
  const paramList = callableNode?.params ?? [];
  if (paramList.length > 0 && paramLines.length !== paramList.length) {
    context.report({ node, message: `JSDoc '@param' count (${paramLines.length}) on ${kindLabel} '${name}' must match parameter count (${paramList.length}) (Rule 2.2).` });
  }
  for (const param of paramList) {
    const unwrapped = param?.type === 'TSParameterProperty' ? param.parameter : param;
    const idNode = unwrapped?.type === 'AssignmentPattern' ? unwrapped.left : unwrapped?.type === 'RestElement' ? unwrapped.argument : unwrapped;
    const pName = idNode?.type === 'Identifier' ? idNode.name : null;
    if (pName && !paramLines.some((l) => new RegExp(`^@param\\s+\\{.+\\}\\s+(?:\\[)?${pName}(?:=[^\\]]+)?(?:\\])?\\s+-\\s+\\S+`).test(l.trim()))) {
      context.report({ node, message: `JSDoc for ${kindLabel} '${name}' is missing '@param {Type} ${pName} - Description' (Rule 2.2).` });
    }
  }
  const ret = callableNode?.returnType?.typeAnnotation;
  const isVoid = !ret || ret.type === 'TSVoidKeyword' || node.kind === 'constructor' || node.kind === 'set';
  if (!isVoid && !tagLines.some((l) => /^@returns?\s+\{.+\}\s+\S+/.test(l.trim()))) {
    context.report({ node, message: `JSDoc for ${kindLabel} '${name}' with non-void return type is missing '@returns {Type} Description' (Rule 2.2).` });
  }
}

export default [
  {
    ignores: ['playground/**'],
  },
  {
    files: [
      'packages/*/{src,test}/**/*.ts',
      'tests/*/{src,test}/**/*.ts',
      '.agents/hooks/**/*.mjs',
      'scripts/**/*.mjs',
      'eslint.config.mjs',
    ],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: {
      '@typescript-eslint': tsPlugin,
      jsdoc: jsdocPlugin,
      harness: {
        rules: {
          'no-inline-comments': {
            create(context) {
              const blockRanges = [];
              return {
                BlockStatement: (node) => blockRanges.push(node.range),
                'Program:exit'() {
                  for (const c of context.sourceCode.getAllComments()) {
                    if (c.type === 'Line') context.report({ loc: c.loc, message: "Inline '//' comments are forbidden (Rule 2.4)." });
                    else if (!c.value.startsWith('*')) context.report({ loc: c.loc, message: "Non-JSDoc '/* ... */' comments are forbidden (Rule 2.4)." });
                    else if (blockRanges.some(([s, e]) => c.range[0] > s && c.range[1] < e)) context.report({ loc: c.loc, message: 'Comments inside function or method bodies are forbidden (Rule 2.4).' });
                  }
                },
              };
            },
          },
          'file-separation': {
            create(context) {
              const filename = context.filename.replace(/\\/g, '/');
              return {
                TSAsExpression(node) {
                  if (node.typeAnnotation?.type === 'TSUnknownKeyword' || node.typeAnnotation?.type === 'TSAnyKeyword') {
                    context.report({ node, message: "Unsound 'as unknown' or 'as any' type assertion is forbidden (Rule 5.1)." });
                  }
                  if (node.expression?.type === 'Identifier' && node.expression.name === 'undefined' && node.typeAnnotation?.type === 'TSNeverKeyword') {
                    context.report({ node, message: "Unsound 'undefined as never' type assertion is forbidden (Rule 5.1)." });
                  }
                },
                Program(program) {
                  if (filename.endsWith('.test.ts')) return;
                  if (filename.includes('/test/') && !filename.includes('/test/fixtures/')) {
                    context.report({ node: program, message: 'Non-test helper files under test/ must reside in test/fixtures/ (Rule 6.1).' });
                  }
                  if (filename.endsWith('/index.ts')) {
                    for (const stmt of program.body) {
                      if (!(stmt.type === 'ExportNamedDeclaration' && stmt.declaration === null && stmt.source !== null)) {
                        context.report({ node: stmt, message: 'Barrel file index.ts must contain only named re-exports (Rule 1.7).' });
                      }
                    }
                    return;
                  }
                  for (const stmt of program.body) {
                    if (stmt.type === 'ExportAllDeclaration' || (stmt.type === 'ExportNamedDeclaration' && (stmt.source !== null || (stmt.declaration === null && stmt.specifiers.length > 0)))) {
                      context.report({ node: stmt, message: "Re-export statements ('export { ... }' / 'export *') are only allowed in barrel index.ts files (Rule 1.7)." });
                    }
                  }
                  if (filename.includes('/.agents/hooks/') || filename.includes('/scripts/') || filename.endsWith('/eslint.config.mjs')) return;
                  const entities = program.body.map(classifyTopLevelEntity).filter(Boolean);
                  if (filename.endsWith('.schema.ts')) {
                    for (const e of entities.filter((x) => x.kind === 'interface' || x.kind === 'class' || x.kind === 'function')) {
                      context.report({ node: e.node, message: `Schema file may not declare ${e.kind} '${e.name}' (Rule 1.1).` });
                    }
                    return;
                  }
                  if (filename.endsWith('.types.ts')) {
                    for (const e of entities) {
                      if (e.kind !== 'type') context.report({ node: e.node, message: `'*.types.ts' file may not declare ${e.kind} '${e.name}' (Rule 1.4).` });
                      else if (e.node.typeAnnotation?.type === 'TSTypeLiteral') context.report({ node: e.node, message: `Object type literal 'type ${e.name} = { ... }' in *.types.ts is forbidden; use a dedicated interface file (Rule 1.4).` });
                    }
                  } else if (filename.endsWith('.constants.ts')) {
                    for (const e of entities) {
                      if (e.kind !== 'const') context.report({ node: e.node, message: `'*.constants.ts' file may not declare ${e.kind} '${e.name}' (Rule 1.5).` });
                    }
                  } else {
                    for (const e of entities) {
                      if (e.kind === 'type') context.report({ node: e.node, message: `Type alias '${e.name}' must reside in a '*.types.ts' or '*.schema.ts' file (Rule 1.4).` });
                      else if (e.kind === 'const' && !/\/[a-z0-9-]+-namespace\.ts$/.test(filename)) context.report({ node: e.node, message: `Constant '${e.name}' must reside in a '*.constants.ts', '*-namespace.ts', or '*.schema.ts' file (Rule 1.5).` });
                    }
                  }
                  const kinds = [...new Set(entities.map((e) => e.kind))];
                  const canCoLocateParams = kinds.length === 2 && kinds.includes('interface') && (kinds.includes('function') || kinds.includes('class'));
                  if (kinds.length > 1 && !canCoLocateParams) {
                    const firstMixed = entities.find((e) => e.kind !== entities[0].kind) ?? entities[1];
                    context.report({ node: firstMixed.node, message: `File mixes multiple entity kinds (${kinds.join(' + ')}): ${entities.map((e) => `${e.kind} '${e.name}'`).join(', ')}. Keep interfaces, types, classes, functions, and constants in separate files (Rule 1.1).` });
                  }
                  for (const cls of entities.filter((e) => e.kind === 'class').slice(1)) {
                    context.report({ node: cls.node, message: `Class '${cls.name}' exceeds 1 class per file (Rule 1.3).` });
                  }
                  if (kinds.length === 1 || canCoLocateParams) {
                    verifySingleRootInterface(entities.filter((e) => e.kind === 'interface'), filename, context, canCoLocateParams);
                  }
                },
              };
            },
          },
          'require-complete-jsdoc': {
            create(context) {
              const filename = context.filename.replace(/\\/g, '/');
              if (filename.endsWith('/index.ts')) return {};
              const check = (node, callableNode, kindLabel, name, isCallable) =>
                checkStructuredJsdoc({ node, callableNode, kindLabel, name, isCallable, context });
              return {
                TSInterfaceDeclaration: (n) => check(n, n, 'interface', n.id?.name ?? '<interface>', false),
                ClassDeclaration: (n) => check(n, n, 'class', n.id?.name ?? '<class>', false),
                TSTypeAliasDeclaration: (n) => check(n, n, 'type', n.id?.name ?? '<type>', false),
                FunctionDeclaration: (n) => check(n, n, 'function', n.id?.name ?? '<function>', true),
                MethodDefinition: (n) => check(n, n.value, 'method', n.key?.name ?? '<method>', true),
                TSMethodSignature: (n) => n.parent?.type === 'TSInterfaceBody' && check(n, n, 'interface method', n.key?.name ?? '<method>', true),
                TSPropertySignature: (n) => n.parent?.type === 'TSInterfaceBody' && check(n, n, 'interface property', n.key?.name ?? '<property>', false),
                PropertyDefinition: (n) => check(n, n, 'class property', n.key?.name ?? '<property>', false),
                VariableDeclaration(n) {
                  if (n.parent?.type !== 'Program' && n.parent?.type !== 'ExportNamedDeclaration') return;
                  const first = n.declarations?.[0];
                  const name = first?.id?.type === 'Identifier' ? first.id.name : '<const>';
                  const isFn = first?.init && (first.init.type === 'ArrowFunctionExpression' || first.init.type === 'FunctionExpression');
                  if (isFn) check(n, first.init, 'function', name, true);
                  else check(n, n, 'const', name, false);
                },
              };
            },
          },
          'no-dead-files': {
            create(context) {
              const filename = context.filename.replace(/\\/g, '/');
              if (!/\/(?:packages|tests)\/[^/]+\/src\/.+\.ts$/.test(filename)) return {};
              if (/\/(?:packages|tests)\/[^/]+\/src\/(?:runtime\/)?index\.ts$/.test(filename)) return {};
              return {
                Program(program) {
                  const referencedFiles = getWorkspaceReferencedFiles();
                  if (!referencedFiles.has(filename)) {
                    context.report({
                      node: program,
                      message: `Unreferenced source file '${filename.split(/\/(?:packages|tests)\//).pop() ?? filename}' is not imported or re-exported by any file in the workspace (Rule 1.7 & Rule 3.4).`,
                    });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      'harness/no-inline-comments': 'error',
      'harness/file-separation': 'error',
      'harness/no-dead-files': 'error',
      'max-statements-per-line': ['error', { max: 1 }],
      'one-var': ['error', 'never'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
    },
  },
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/test/**/*.ts',
      'tests/*/src/**/*.ts',
      'tests/*/test/**/*.ts',
      'scripts/**/*.mjs',
      'eslint.config.mjs',
    ],
    ignores: ['packages/*/test/**/*.test.ts', 'tests/*/test/**/*.test.ts'],
    rules: { 'harness/require-complete-jsdoc': 'error' },
  },
];
