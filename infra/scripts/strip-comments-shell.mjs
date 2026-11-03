import { spawnSync } from 'node:child_process';

const METACHARACTERS = /[\s;&|()<>]/;
const SPECIAL_PARAMETERS = new Set([
  '#',
  '?',
  '$',
  '!',
  '@',
  '*',
  '-',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

export function shellComments(text) {
  const comments = [];
  const protect = [];
  const pending = [];
  const length = text.length;
  let i = 0;
  let continuedAt = -1;
  let escapedUpTo = -1;

  const fail = (what) => {
    throw new Error(`${what} (offset ${i}), so the file is not scanned`);
  };

  const wordStart = (at) => at === 0 || (at !== escapedUpTo && METACHARACTERS.test(text[at - 1]));

  const skipSingleQuoted = () => {
    const end = text.indexOf("'", i + 1);
    if (end < 0) fail('unterminated single quote');
    i = end + 1;
  };

  const skipUntil = (quote, from) => {
    i = from;
    while (i < length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
    if (i >= length) fail(`unterminated ${quote}`);
    i += 1;
  };

  const doubleQuoted = () => {
    i += 1;
    while (i < length) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '"') {
        i += 1;
        return;
      } else if (c === '$') dollar(true);
      else if (c === '`') skipUntil('`', i + 1);
      else i += 1;
    }
    fail('unterminated double quote');
  };

  const arithmetic = () => {
    let depth = 2;
    while (i < length) {
      const c = text[i];
      if (c === '(') {
        depth += 1;
        i += 1;
      } else if (c === ')') {
        depth -= 1;
        i += 1;
        if (depth === 0) return;
      } else if (c === '\\') i += 2;
      else if (c === "'") skipSingleQuoted();
      else if (c === '"') doubleQuoted();
      else if (c === '$') dollar();
      else i += 1;
    }
    fail('unterminated arithmetic expansion');
  };

  const parameterExpansion = () => {
    i += 2;
    while (i < length) {
      const c = text[i];
      if (c === '}') {
        i += 1;
        return;
      }
      if (c === '\\') i += 2;
      else if (c === "'") skipSingleQuoted();
      else if (c === '"') doubleQuoted();
      else if (c === '`') skipUntil('`', i + 1);
      else if (c === '$') dollar();
      else i += 1;
    }
    fail('unterminated parameter expansion');
  };

  const dollar = (quoted = false) => {
    const next = text[i + 1];
    if (next === '(' && text[i + 2] === '(') {
      i += 3;
      arithmetic();
    } else if (next === '(') {
      i += 2;
      code(true);
    } else if (next === '{') parameterExpansion();
    else if (next === "'" && !quoted) skipUntil("'", i + 2);
    else if (next === '"' && !quoted) {
      i += 1;
      doubleQuoted();
    } else if (SPECIAL_PARAMETERS.has(next)) i += 2;
    else i += 1;
  };

  const heredocOperator = () => {
    if (text[i + 2] === '<') {
      i += 3;
      return;
    }
    let j = i + 2;
    const stripTabs = text[j] === '-';
    if (stripTabs) j += 1;
    while (text[j] === ' ' || text[j] === '\t') j += 1;
    let delimiter = '';
    while (j < length && !METACHARACTERS.test(text[j])) {
      const c = text[j];
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, j + 1);
        if (end < 0) fail('unterminated heredoc delimiter');
        delimiter += text.slice(j + 1, end);
        j = end + 1;
      } else if (c === '\\') {
        delimiter += text[j + 1] ?? '';
        j += 2;
      } else {
        delimiter += c;
        j += 1;
      }
    }
    if (delimiter === '') fail('heredoc without a delimiter');
    pending.push({ delimiter, stripTabs });
    i = j;
  };

  const heredocBodies = () => {
    for (const { delimiter, stripTabs } of pending.splice(0)) {
      const start = i;
      let closed = false;
      while (i < length && !closed) {
        const newline = text.indexOf('\n', i);
        const end = newline < 0 ? length : newline;
        const line = text.slice(i, end).replace(/\r$/, '');
        closed = (stripTabs ? line.replace(/^\t+/, '') : line) === delimiter;
        i = newline < 0 ? length : newline + 1;
      }
      if (!closed) fail(`heredoc ${delimiter} never ends`);
      protect.push({ start, end: i });
    }
  };

  const lineComment = () => {
    if (continuedAt >= 0 && continuedAt <= i && /^[ \t]*$/.test(text.slice(continuedAt, i))) {
      fail(
        'a comment follows a line continuation, so removing it would join the next line onto the command',
      );
    }
    let end = text.indexOf('\n', i);
    if (end < 0) end = length;
    if (text[end - 1] === '\r') end -= 1;
    comments.push({ start: i, end });
    i = end;
  };

  const arithmeticCommand = () => {
    const mark = { i, comments: comments.length, protect: protect.length, pending: pending.length };
    i += 2;
    try {
      arithmetic();
      return true;
    } catch {
      i = mark.i;
      comments.length = mark.comments;
      protect.length = mark.protect;
      pending.length = mark.pending;
      return false;
    }
  };

  function code(nested) {
    let depth = 0;
    while (i < length) {
      const c = text[i];
      if (c === '\n') {
        i += 1;
        if (pending.length > 0) heredocBodies();
      } else if (c === '\\') {
        if (text[i + 1] === '\n') continuedAt = i + 2;
        i += 2;
        escapedUpTo = i;
      } else if (c === "'") skipSingleQuoted();
      else if (c === '"') doubleQuoted();
      else if (c === '`') skipUntil('`', i + 1);
      else if (c === '$') dollar();
      else if (c === '#' && wordStart(i)) lineComment();
      else if (c === '<' && text[i + 1] === '<') heredocOperator();
      else if (c === '(' && text[i + 1] === '(' && arithmeticCommand()) continue;
      else if (c === '(') {
        depth += 1;
        i += 1;
      } else if (c === ')') {
        i += 1;
        if (nested && depth === 0) return;
        depth = Math.max(0, depth - 1);
      } else i += 1;
    }
    if (nested) fail('unterminated command substitution');
  }

  code(false);
  return { comments, protect };
}

const PROBE = '__strip_comments_probe';
const BASH_ENVIRONMENT = { PATH: process.env.PATH };

const bash = (args, input) => {
  const result = spawnSync('bash', args, { input, encoding: 'utf8', env: BASH_ENVIRONMENT });
  if (result.error) throw result.error;
  return result;
};

const bashAccepts = (text) => bash(['-n'], text).status === 0;

const asFunction = (text) => `${PROBE}() {\n${text}\n}\n`;

const commandsOf = (text) => {
  const wrapped = asFunction(text);
  if (!bashAccepts(wrapped)) return null;
  const result = bash(['-s'], `${wrapped}declare -f ${PROBE}\n`);
  return result.status === 0 ? result.stdout : null;
};

export function shellProblems(before, after) {
  if (!bashAccepts(before)) return ['bash -n rejects the script, so the removal cannot be checked'];
  if (!bashAccepts(after)) return ['bash -n rejects the script after the removal'];
  const commands = commandsOf(before);
  if (commands === null) return ['bash cannot print the script as a function, so the removal cannot be checked'];
  return commands === commandsOf(after)
    ? []
    : ['the commands differ after the removal (declare -f of the script wrapped in a function)'];
}
