import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import jsdocPlugin from 'eslint-plugin-jsdoc';

/**
 * Classifies a top-level AST declaration into one of the five canonical file entity kinds.
 *
 * Unwraps export declarations and maps interfaces, type aliases, classes, functions, and constants
 * to their mutually exclusive category for file-separation verification.
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
 * Validates that multiple interfaces in a single file are property-referenced sub-interfaces of one root.
 *
 * Builds the directed graph of `TSPropertySignature`, `TSIndexSignature`, and `extends` references
 * across interfaces in the file, rejects fake `*Template` properties, and reports any interface
 * not reachable from the root interface.
 * @param {object[]} interfaces - Array of classified interface descriptors in the file.
 * @param {string}   filename   - Normalized file path of the current module.
 * @param {object}   context    - ESLint rule execution context.
 * @returns {void}
 */
function verifySingleRootInterface(interfaces, filename, context) {
  for (const item of interfaces) {
    for (const member of item.node.body?.body ?? []) {
      if (member.type === 'TSPropertySignature' && member.key?.type === 'Identifier' && member.key.name.endsWith('Template')) {
        context.report({ node: member, message: `Fake '*Template' property '${member.key.name}' on '${item.name}' is forbidden (Rule 1.2 & Rule 3.4).` });
      }
    }
  }
  if (interfaces.length <= 1) return;
  const collectRefs = (astNode, out) => {
    if (!astNode || typeof astNode !== 'object' || astNode.type === 'TSMethodSignature') return;
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
      if (member.type === 'TSPropertySignature' || member.type === 'TSIndexSignature') collectRefs(member.typeAnnotation ?? member, refs);
    }
    const targets = [...refs].filter((ref) => ref !== item.name && byName.has(ref));
    edges.set(item.name, targets);
    for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  }
  const baseStem = (filename.split('/').pop() ?? '').replace(/\.[^.]+$/, '').replace(/-/g, '').toLowerCase();
  const root = interfaces.find((i) => i.name.toLowerCase() === baseStem && (inDegree.get(i.name) ?? 0) === 0) ?? interfaces.find((i) => i.name.toLowerCase() === baseStem) ?? interfaces.filter((i) => (inDegree.get(i.name) ?? 0) === 0).pop() ?? interfaces[interfaces.length - 1];
  const reachable = new Set([root.name]);
  const queue = [root.name];
  while (queue.length > 0) for (const next of edges.get(queue.shift()) ?? []) if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
  for (const item of interfaces) if (!reachable.has(item.name)) context.report({ node: item.node, message: `Interface '${item.name}' is not a property sub-interface of '${root.name}'. Top-level interfaces must live one per file (Rule 1.2).` });
}

/**
 * Validates that an AST node has an adjacent JSDoc block with required 2-part prose and aligned tags.
 *
 * Enforces summary + detailed description paragraphs, `@template`, `@param {Type} name - Desc`,
 * column alignment across multi-tag blocks, and `@returns {Type} Desc` for non-void callables.
 *
 * @param {object} params - Validation target node, callable node, kind label, name, and ESLint context.
 *
 * @returns {void}
 */
function checkStructuredJsdoc({ node, callableNode, kindLabel, name, requireTwoParagraphs, isCallable, context }) {
  const target = node.parent?.type === 'ExportNamedDeclaration' || node.parent?.type === 'ExportDefaultDeclaration' ? node.parent : node;
  const last = context.sourceCode.getCommentsBefore(target).pop();
  const comment = last && last.type === 'Block' && last.value.startsWith('*') && target.loc.start.line - last.loc.end.line <= 1 ? last : null;
  if (!comment) return context.report({ node, message: `Missing mandatory JSDoc on ${kindLabel} '${name}' (Rule 2.1).` });
  const lines = comment.value.replace(/^\*/, '').split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '').trimEnd());
  const firstTagIdx = lines.findIndex((l) => /^@[a-zA-Z]+/.test(l.trim()));
  const prose = (firstTagIdx === -1 ? lines : lines.slice(0, firstTagIdx)).join('\n').trim();
  const paragraphs = prose ? prose.split(/\n\s*\n/).filter((p) => p.trim().length > 0) : [];
  if (requireTwoParagraphs && paragraphs.length < 2) {
    context.report({ node, message: `JSDoc for ${kindLabel} '${name}' must contain a 1-sentence Summary paragraph and a Detailed description paragraph separated by a blank '*' line before any @tags (Rule 2.2).` });
  } else if (!requireTwoParagraphs && paragraphs.length < 1) {
    context.report({ node, message: `JSDoc for ${kindLabel} '${name}' must contain a non-empty summary (Rule 2.1).` });
  }
  const tagLines = firstTagIdx === -1 ? [] : lines.slice(firstTagIdx);
  const templateLines = tagLines.filter((l) => l.trim().startsWith('@template'));
  for (const tp of callableNode?.typeParameters?.params ?? node.typeParameters?.params ?? []) {
    const tpName = typeof tp.name === 'string' ? tp.name : tp.name?.name;
    if (tpName && !templateLines.some((l) => new RegExp(`^@template\\s+(?:\\{[^}]+\\}\\s+)?${tpName}\\b\\s+\\S+`).test(l.trim()))) {
      context.report({ node, message: `JSDoc for ${kindLabel} '${name}' is missing '@template ${tpName} <Description>' (Rule 2.2).` });
    }
  }
  if (templateLines.length >= 2) {
    const tCols = templateLines.map((l) => /^(@template\s+(?:\{[^}]+\}\s+)?[a-zA-Z0-9_$]+\s+)\S/.exec(l.trimStart())?.[1].length ?? null);
    if (tCols.every(Boolean) && new Set(tCols).size > 1) context.report({ node, message: `JSDoc '@template' tags on ${kindLabel} '${name}' must vertically align descriptions (Rule 2.2).` });
  }
  if (!isCallable) return;
  const paramLines = tagLines.filter((l) => l.trim().startsWith('@param'));
  for (const param of callableNode?.params ?? []) {
    const unwrapped = param?.type === 'TSParameterProperty' ? param.parameter : param;
    const idNode = unwrapped?.type === 'AssignmentPattern' ? unwrapped.left : unwrapped?.type === 'RestElement' ? unwrapped.argument : unwrapped;
    const pName = idNode?.type === 'Identifier' ? idNode.name : null;
    if (pName && !paramLines.some((l) => new RegExp(`^@param\\s+\\{.+\\}\\s+(?:\\[)?${pName}(?:=[^\\]]+)?(?:\\])?\\s+-\\s+\\S+`).test(l.trim()))) {
      context.report({ node, message: `JSDoc for ${kindLabel} '${name}' is missing '@param {Type} ${pName} - Description' (Rule 2.2).` });
    }
  }
  if (paramLines.length >= 2) {
    const cols = paramLines.map((l) => {
      const m = /^(@param\s+\{.+?\}\s+)((?:\[)?[a-zA-Z0-9_$]+(?:=[^\]]+)?(?:\])?\s+)-\s+\S/.exec(l.trimStart());
      return m ? { nameCol: m[1].length, dashCol: m[1].length + m[2].length } : null;
    });
    if (cols.every(Boolean) && (new Set(cols.map((c) => c.nameCol)).size > 1 || new Set(cols.map((c) => c.dashCol)).size > 1)) {
      context.report({ node, message: `JSDoc '@param' tags on ${kindLabel} '${name}' must vertically align parameter names and '-' descriptions (Rule 2.2).` });
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
    files: ['packages/*/{src,test}/**/*.ts'],
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
                  if (node.typeAnnotation?.type === 'TSUnknownKeyword' || node.typeAnnotation?.type === 'TSAnyKeyword') context.report({ node, message: "Unsound 'as unknown' or 'as any' type assertion is forbidden (Rule 5.1)." });
                },
                Program(program) {
                  const totalLines = context.sourceCode.lines.length;
                  const maxLines = filename.endsWith('.test.ts') ? 400 : 250;
                  if (totalLines > maxLines) context.report({ node: program, message: `File has ${totalLines} lines (max ${maxLines}, Rule 1.1).` });
                  if (filename.endsWith('.test.ts')) return;
                  if (filename.endsWith('/index.ts')) {
                    for (const stmt of program.body) {
                      if (stmt.type !== 'ExportAllDeclaration' && !(stmt.type === 'ExportNamedDeclaration' && stmt.declaration === null && stmt.source !== null)) {
                        context.report({ node: stmt, message: 'Barrel file index.ts must contain only re-exports (Rule 1.7).' });
                      }
                    }
                    return;
                  }
                  for (const stmt of program.body) {
                    if (stmt.type === 'ExportAllDeclaration' || (stmt.type === 'ExportNamedDeclaration' && (stmt.source !== null || (stmt.declaration === null && stmt.specifiers.length > 0)))) {
                      context.report({ node: stmt, message: "Re-export statements ('export { ... }' / 'export *') are only allowed in barrel index.ts files (Rule 1.7)." });
                    }
                  }
                  const entities = program.body.map(classifyTopLevelEntity).filter(Boolean);
                  if (filename.endsWith('.schema.ts')) {
                    for (const e of entities.filter((x) => x.kind === 'interface' || x.kind === 'class')) context.report({ node: e.node, message: `Schema file may not declare ${e.kind} '${e.name}' (Rule 1.1).` });
                    return;
                  }
                  const kinds = [...new Set(entities.map((e) => e.kind))];
                  if (kinds.length > 1) {
                    const firstMixed = entities.find((e) => e.kind !== entities[0].kind) ?? entities[1];
                    context.report({ node: firstMixed.node, message: `File mixes multiple entity kinds (${kinds.join(' + ')}): ${entities.map((e) => `${e.kind} '${e.name}'`).join(', ')}. Keep interfaces, types, classes, functions, and constants in separate files (Rule 1.1).` });
                  }
                  for (const cls of entities.filter((e) => e.kind === 'class').slice(1)) context.report({ node: cls.node, message: `Class '${cls.name}' exceeds 1 class per file (Rule 1.3).` });
                  verifySingleRootInterface(entities.filter((e) => e.kind === 'interface'), filename, context);
                  const funcs = entities.filter((e) => e.kind === 'function');
                  for (const fn of funcs) {
                    const lines = fn.node.loc.end.line - fn.node.loc.start.line + 1;
                    if (lines > 80) context.report({ node: fn.node, message: `Function exceeds 80 lines (${lines} lines). Decompose into smaller internal/ helpers (Rule 3.1).` });
                  }
                  const singleFn = (!filename.includes('/internal/') && (filename.includes('/builders/') || /\/create-[^/]+\.ts$/.test(filename))) || funcs.some((f) => f.node.loc.end.line - f.node.loc.start.line + 1 > 40);
                  for (const fn of funcs.slice(singleFn ? 1 : 4)) context.report({ node: fn.node, message: `Function '${fn.name}' exceeds maximum of ${singleFn ? 1 : 4} function(s) in this file (Rule 1.6).` });
                },
              };
            },
          },
          'require-complete-jsdoc': {
            create(context) {
              if (context.filename.replace(/\\/g, '/').endsWith('/index.ts')) return {};
              const check = (node, callableNode, kindLabel, name, requireTwoParagraphs, isCallable) =>
                checkStructuredJsdoc({ node, callableNode, kindLabel, name, requireTwoParagraphs, isCallable, context });
              return {
                TSInterfaceDeclaration: (n) => check(n, n, 'interface', n.id?.name ?? '<interface>', true, false),
                ClassDeclaration: (n) => check(n, n, 'class', n.id?.name ?? '<class>', true, false),
                TSTypeAliasDeclaration: (n) => check(n, n, 'type', n.id?.name ?? '<type>', false, false),
                FunctionDeclaration: (n) => check(n, n, 'function', n.id?.name ?? '<function>', true, true),
                MethodDefinition: (n) => check(n, n.value, 'method', n.key?.name ?? '<method>', true, true),
                TSMethodSignature: (n) => n.parent?.type === 'TSInterfaceBody' && check(n, n, 'interface method', n.key?.name ?? '<method>', true, true),
                TSPropertySignature: (n) => n.parent?.type === 'TSInterfaceBody' && check(n, n, 'interface property', n.key?.name ?? '<property>', false, false),
                PropertyDefinition: (n) => check(n, n, 'class property', n.key?.name ?? '<property>', false, false),
                VariableDeclaration(n) {
                  if (n.parent?.type !== 'Program' && n.parent?.type !== 'ExportNamedDeclaration') return;
                  const first = n.declarations?.[0];
                  const name = first?.id?.type === 'Identifier' ? first.id.name : '<const>';
                  const isFn = first?.init && (first.init.type === 'ArrowFunctionExpression' || first.init.type === 'FunctionExpression');
                  if (isFn) check(n, first.init, 'function', name, true, true);
                  else check(n, n, 'const', name, false, false);
                },
              };
            },
          },
        },
      },
    },
    rules: { 'harness/no-inline-comments': 'error', 'harness/file-separation': 'error', 'max-statements-per-line': ['error', { max: 1 }], '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-non-null-assertion': 'error', '@typescript-eslint/ban-ts-comment': 'error' },
  },
  { files: ['packages/*/src/**/*.ts', 'packages/*/test/fixtures/**/*.ts'], rules: { 'harness/require-complete-jsdoc': 'error', 'max-lines': ['error', { max: 250, skipBlankLines: false, skipComments: false }] } },
  { files: ['packages/*/test/**/*.test.ts'], rules: { 'max-lines': ['error', { max: 400, skipBlankLines: false, skipComments: false }] } },
];
