import type { Locator, Page } from '@playwright/test';

export type LocatorCall =
  | { kind: 'testId'; value: string }
  | { kind: 'css'; value: string }
  | { kind: 'text'; value: string; exact: boolean }
  | { kind: 'role'; value: string; name: string | null; exact: boolean }
  | { kind: 'label'; value: string; exact: boolean };

const QUOTED = `(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`;
const LOCATOR = new RegExp(
  `(getByTestId|locator|getByText|getByRole|getByLabel)\\(${QUOTED}(?:,\\s*\\{([^}]*)\\})?\\)`,
  'g',
);

function unquote(single: string | undefined, double: string | undefined): string {
  return (single ?? double ?? '').replace(/\\(.)/g, '$1');
}

export function locatorsIn(message: string): LocatorCall[] {
  const found: LocatorCall[] = [];
  for (const match of message.matchAll(LOCATOR)) {
    const [, method, single, double, options = ''] = match;
    const value = unquote(single, double);
    const exact = /exact:\s*true/.test(options);
    const nameMatch = /name:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\/([^/]*)\/)/.exec(
      options,
    );
    const name = nameMatch === null ? null : (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? null);
    if (method === 'getByTestId') found.push({ kind: 'testId', value });
    else if (method === 'locator') found.push({ kind: 'css', value });
    else if (method === 'getByText') found.push({ kind: 'text', value, exact });
    else if (method === 'getByLabel') found.push({ kind: 'label', value, exact });
    else found.push({ kind: 'role', value, name, exact });
  }
  const unique = new Map(found.map((call) => [JSON.stringify(call), call]));
  return [...unique.values()];
}

export function describeCall(call: LocatorCall): string {
  if (call.kind === 'role')
    return `getByRole('${call.value}'${call.name === null ? '' : `, { name: '${call.name}' }`})`;
  const method = { testId: 'getByTestId', css: 'locator', text: 'getByText', label: 'getByLabel' }[
    call.kind
  ];
  return `${method}('${call.value}')`;
}

function locate(page: Page, call: LocatorCall): Locator {
  switch (call.kind) {
    case 'testId':
      return page.getByTestId(call.value);
    case 'css':
      return page.locator(call.value);
    case 'text':
      return page.getByText(call.value, { exact: call.exact });
    case 'label':
      return page.getByLabel(call.value, { exact: call.exact });
    case 'role':
      return page.getByRole(call.value as Parameters<Page['getByRole']>[0], {
        ...(call.name === null ? {} : { name: call.name }),
        exact: call.exact,
      });
  }
}

interface Excerpt {
  tag: string;
  testId: string | null;
  text: string;
  box: string;
  style: string;
}

async function excerpt(locator: Locator): Promise<Excerpt | null> {
  try {
    return await locator.evaluate(
      (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        const round = (value: number) => Math.round(value);
        return {
          tag: el.tagName.toLowerCase(),
          testId: el.getAttribute('data-testid'),
          text: ((el as HTMLElement).innerText ?? el.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80),
          box: `${String(round(r.left))},${String(round(r.top))} ${String(round(r.width))}×${String(round(r.height))}`,
          style: [
            `display:${s.display}`,
            `visibility:${s.visibility}`,
            `opacity:${s.opacity}`,
            `pointer-events:${s.pointerEvents}`,
            `color:${s.color}`,
            `background:${s.backgroundColor}`,
            `font:${s.fontSize}/${s.lineHeight} ${s.fontWeight}`,
            ...(el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')
              ? ['disabled']
              : []),
          ].join(' '),
        };
      },
      undefined,
      { timeout: 1_000 },
    );
  } catch {
    return null;
  }
}

export async function domExcerpts(
  pages: readonly Page[],
  message: string,
  limit = 3,
): Promise<string[]> {
  const calls = locatorsIn(message).slice(0, limit);
  const lines: string[] = [];
  for (const call of calls) {
    let written = false;
    for (const page of pages) {
      if (page.isClosed()) continue;
      const locator = locate(page, call);
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      const first = await excerpt(locator.first());
      if (first === null) continue;
      lines.push(
        `${describeCall(call)} → ${String(count)} match${count === 1 ? '' : 'es'}; <${first.tag}${first.testId === null ? '' : ` data-testid="${first.testId}"`}> "${first.text}" at ${first.box}; ${first.style}`,
      );
      written = true;
      break;
    }
    if (!written) lines.push(`${describeCall(call)} → not in any open page`);
  }
  return lines;
}
