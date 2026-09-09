import MarkdownIt from 'markdown-it';

export function tablePlugin(md: MarkdownIt): void {
  const defaultTableOpen =
    md.renderer.rules.table_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose =
    md.renderer.rules.table_close ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const tableId = `table-${idx}-${Math.random().toString(36).substring(2, 7)}`;
    const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';

    return `<div class="antigravity-table-wrapper"${lineAttr} id="${tableId}">
  <div class="table-toolbar">
    <span class="table-badge">Table</span>
    <button class="copy-table-btn" data-target="${tableId}" title="Copy Table Data" type="button">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z"/>
        <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"/>
      </svg>
      <span>Copy</span>
    </button>
  </div>
  <div class="table-scroll-container">
    ${defaultTableOpen(tokens, idx, options, env, self)}`;
  };

  md.renderer.rules.table_close = (tokens, idx, options, env, self) => {
    return `${defaultTableClose(tokens, idx, options, env, self)}
  </div>
</div>\n`;
  };
}
