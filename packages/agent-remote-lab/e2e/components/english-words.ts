import type { Page } from '@playwright/test';

/**
 * Proper names that stay as they are in Chinese: the product, the agents, the parts of the system the design names in Latin
 * letters ("可用的 Agent", "每台 Host", "Controller 更新", "在 Bot 模式里"), languages offered by name and common acronyms.
 */
export const PROPER_NAMES: readonly string[] = [
  'Orchard', 'orchard', 'Claude', 'Code', 'Codex', 'Copilot', 'OpenCode', 'Agent', 'Host', 'Controller', 'VS', 'Bot', 'Trace', 'Inspector',
  'Replica', 'English', 'Mac', 'mini', 'macOS', 'Linux', 'Windows', 'iOS', 'iPhone', 'Android', 'Google', 'GitHub', 'Team', 'Ask', 'Shift',
  'Enter', 'Return', 'Esc', 'Tab', 'ID', 'URL', 'CPU', 'OS', 'MCP', 'API', 'PNG', 'JPEG', 'WebP', 'KB', 'MB', 'GB', 'ms', 'Provider',
];

/**
 * Latin words a person sees on the page that are not proper names, code or paths: every visible text node and every accessible
 * name, title, placeholder and alternative text, outside code (`code`, `pre`, `kbd`, `samp`), content marked as not to translate
 * (`translate="no"`, `data-user-content`) and the selectors given in `skip` (a fixture's own sample data). In Chinese this list
 * is empty; each entry says where it was found.
 */
export async function englishWords(page: Page, options: { skip?: readonly string[]; allow?: readonly string[] } = {}): Promise<string[]> {
  return page.evaluate(({ skip, allowed }) => {
    const excluded = ['code', 'pre', 'kbd', 'samp', '[translate="no"]', '[data-user-content]', 'script', 'style', 'template', ...skip].join(', ');
    const allow = new Set(allowed);
    const visible = (element: Element) => {
      if (element.closest('[hidden], [aria-hidden="true"]') || element.closest(excluded)) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 || element.classList.contains('agent-visually-hidden');
    };
    // Code-like tokens are not words: identifiers, file names, paths, versions, key combinations and anything with a digit.
    const codeLike = (token: string) => /[\d_/\\.@:#=+]/.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z]{2,}s?$/.test(token) && token.length <= 5;
    const found = new Set<string>();
    const scan = (text: string, where: string) => {
      for (const piece of text.split(/[\s,，。！？、；：（）()[\]{}"“”'‘’·…<>«»|「」『』]+/u)) {
        const token = piece.replace(/^[.!?:;]+|[.!?:;]+$/g, '');
        if (!/[A-Za-z]/.test(token) || codeLike(token)) continue;
        for (const word of token.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []) {
          const bare = word.replace(/['’-]+$/, '');
          if (bare.length < 2 || allow.has(bare)) continue;
          found.add(`${bare} (${where.slice(0, 60)})`);
        }
      }
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim() || !visible(parent)) continue;
      scan(node.textContent, node.textContent.trim());
    }
    for (const element of document.body.querySelectorAll('[aria-label], [title], [placeholder], [alt], [aria-description], [data-placeholder]')) {
      if (!visible(element)) continue;
      for (const name of ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'data-placeholder']) {
        const value = element.getAttribute(name);
        if (value) scan(value, `${name}="${value}"`);
      }
    }
    return [...found].sort();
  }, { skip: options.skip ?? [], allowed: [...PROPER_NAMES, ...options.allow ?? []] });
}
