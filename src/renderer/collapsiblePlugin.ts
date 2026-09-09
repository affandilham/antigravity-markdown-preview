import MarkdownIt from 'markdown-it';

export function collapsiblePlugin(md: MarkdownIt): void {
  // Support custom container ::: details [Title] ... :::
  md.core.ruler.after('block', 'custom_details', (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'paragraph_open') continue;

      const inlineToken = tokens[i + 1];
      if (!inlineToken || inlineToken.type !== 'inline') continue;

      const match = inlineToken.content.match(/^:::\s*details(?:\s+(.*))?$/i);
      if (!match) continue;

      const title = match[1]?.trim() || 'Details';

      // Find matching ::: end
      let closeIndex = -1;
      for (let j = i + 2; j < tokens.length; j++) {
        if (tokens[j].type === 'paragraph_open') {
          const nextInline = tokens[j + 1];
          if (nextInline && nextInline.type === 'inline' && nextInline.content.trim() === ':::') {
            closeIndex = j;
            break;
          }
        }
      }

      if (closeIndex !== -1) {
        // Replace opening paragraph with details_open
        tokens.splice(i, 3, {
          type: 'html_block',
          content: `<details class="antigravity-collapsible">
  <summary class="collapsible-summary">
    <span class="collapsible-chevron">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/></svg>
    </span>
    <span class="collapsible-title">${md.utils.escapeHtml(title)}</span>
  </summary>
  <div class="collapsible-content">\n`,
          tag: 'details',
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

        // Replace closing paragraph
        // Adjust closeIndex because we removed 3 tokens and inserted 1 (-2 diff)
        const adjustedClose = closeIndex - 2;
        tokens.splice(adjustedClose, 3, {
          type: 'html_block',
          content: `  </div>\n</details>\n`,
          tag: 'details',
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
