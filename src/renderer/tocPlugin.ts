import MarkdownIt from 'markdown-it';

export interface TocItem {
  id: string;
  level: number;
  text: string;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '') // remove html tags
    .replace(/[^\w\s-]/g, '') // remove special chars
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function extractHeadings(markdown: string): TocItem[] {
  const headings: TocItem[] = [];
  const lines = markdown.split(/\r?\n/);
  const slugCounts = new Map<string, number>();

  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim().replace(/#+\s*$/, '');
      let baseSlug = slugify(text) || `heading-${headings.length + 1}`;
      
      let count = slugCounts.get(baseSlug) || 0;
      slugCounts.set(baseSlug, count + 1);
      const finalId = count === 0 ? baseSlug : `${baseSlug}-${count}`;

      headings.push({
        id: finalId,
        level,
        text
      });
    }
  }

  return headings;
}

export function generateTocHtml(headings: TocItem[]): string {
  if (headings.length === 0) {
    return '<p class="toc-empty">No headings found.</p>';
  }

  let html = '<nav class="antigravity-toc-inline"><div class="toc-inline-title">Table of Contents</div><ul class="toc-list">';
  for (const h of headings) {
    const indentClass = `toc-level-${h.level}`;
    html += `<li class="${indentClass}"><a href="#${h.id}" class="toc-link">${escapeHtml(h.text)}</a></li>`;
  }
  html += '</ul></nav>';
  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function tocPlugin(md: MarkdownIt): void {
  const defaultHeadingOpen =
    md.renderer.rules.heading_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  const slugCounts = new Map<string, number>();

  md.core.ruler.before('block', 'reset_slugs', () => {
    slugCounts.clear();
  });

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const nextToken = tokens[idx + 1];

    if (nextToken && nextToken.type === 'inline') {
      const text = nextToken.content;
      let baseSlug = slugify(text) || `heading-${idx}`;
      let count = slugCounts.get(baseSlug) || 0;
      slugCounts.set(baseSlug, count + 1);
      const finalId = count === 0 ? baseSlug : `${baseSlug}-${count}`;

      token.attrSet('id', finalId);
      token.attrJoin('class', 'antigravity-heading');
    }

    return defaultHeadingOpen(tokens, idx, options, env, self);
  };

  // Inline [TOC] or [[toc]] replacement
  md.core.ruler.after('block', 'inline_toc', (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'paragraph_open') continue;
      const inline = tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;

      const trimmed = inline.content.trim();
      if (trimmed === '[TOC]' || trimmed === '[[toc]]' || trimmed === '[toc]') {
        // Collect all headings in tokens
        const headings: TocItem[] = [];
        const localCounts = new Map<string, number>();

        for (let j = 0; j < tokens.length; j++) {
          if (tokens[j].type === 'heading_open') {
            const hLevel = parseInt(tokens[j].tag.replace('h', ''), 10) || 1;
            const hInline = tokens[j + 1];
            if (hInline && hInline.type === 'inline') {
              const hText = hInline.content;
              let base = slugify(hText) || `heading-${j}`;
              let c = localCounts.get(base) || 0;
              localCounts.set(base, c + 1);
              const id = c === 0 ? base : `${base}-${c}`;
              headings.push({ id, level: hLevel, text: hText });
            }
          }
        }

        const tocHtml = generateTocHtml(headings);
        tokens.splice(i, 3, {
          type: 'html_block',
          content: tocHtml,
          tag: 'nav',
          attrs: null,
          map: null,
          nesting: 0,
          level: 0,
          children: null,
          markup: '',
          info: '',
          meta: null,
          block: true,
          hidden: false
        } as any);
      }
    }
  });
}
