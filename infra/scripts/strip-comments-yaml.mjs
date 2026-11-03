import { isDeepStrictEqual } from 'node:util';

import { Lexer, parseAllDocuments } from 'yaml';

const DOCUMENT_MODE = '\u0002';
const FLOW_END = '\u0018';
const SCALAR_MARKER = '\u001f';
const ZERO_WIDTH = new Set([DOCUMENT_MODE, FLOW_END]);

export function yamlComments(text) {
  const comments = [];
  const protect = [];
  let offset = 0;
  let scalarNext = false;
  for (const token of new Lexer().lex(text)) {
    if (ZERO_WIDTH.has(token)) continue;
    if (token === SCALAR_MARKER) {
      scalarNext = true;
      continue;
    }
    const range = { start: offset, end: offset + token.length };
    if (token.startsWith('#') && !scalarNext) comments.push(range);
    else if (token.includes('\n') && token.trim() !== '') protect.push(range);
    scalarNext = false;
    offset += token.length;
  }
  if (offset !== text.length)
    throw new Error('the YAML lexer lost its place, so the file is not scanned');
  return { comments, protect };
}

const valueOf = (document) => {
  try {
    return document.toJS();
  } catch (error) {
    return `${error}`;
  }
};

const signature = (text) =>
  parseAllDocuments(text)
    .filter((document) => document.contents !== null || document.errors.length > 0)
    .map((document) => ({
      errors: document.errors.map((error) => error.code),
      value: valueOf(document),
    }));

export function yamlProblems(before, after) {
  return isDeepStrictEqual(signature(before), signature(after))
    ? []
    : ['the YAML values differ after the removal'];
}
