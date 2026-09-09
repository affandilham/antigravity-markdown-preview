import MarkdownIt from 'markdown-it';

export function sourceMapPlugin(md: MarkdownIt): void {
  function injectLineNumber(tokens: any[], idx: number) {
    const token = tokens[idx];
    if (token.map && (token.level === 0 || token.type === 'list_item_open')) {
      token.attrSet('data-line', String(token.map[0]));
    }
  }

  const blockRules = [
    'paragraph_open',
    'heading_open',
    'blockquote_open',
    'table_open',
    'list_item_open',
    'hr'
  ];

  for (const rule of blockRules) {
    const original = md.renderer.rules[rule] || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      injectLineNumber(tokens, idx);
      return original(tokens, idx, options, env, self);
    };
  }
}
