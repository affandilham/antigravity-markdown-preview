import MarkdownIt from 'markdown-it';

export function mermaidPlugin(md: MarkdownIt): void {
  const defaultFence = md.renderer.rules.fence;

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : '';
    const lang = info.split(/\s+/)[0];

    if (lang === 'mermaid') {
      const code = token.content.trim();
      const encoded = encodeURIComponent(code);
      const diagramId = `mermaid-${idx}-${Math.random().toString(36).substring(2, 8)}`;
      const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';

      return `<div class="antigravity-diagram-card mermaid-card"${lineAttr} id="card-${diagramId}">
  <div class="diagram-header">
    <div class="diagram-type">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6 2a2 2 0 0 0-2 2v1H3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2H6zm0 1.5h4a.5.5 0 0 1 .5.5v1H5.5V4a.5.5 0 0 1 .5-.5z"/>
      </svg>
      <span>Mermaid Diagram</span>
    </div>
    <div class="diagram-actions">
      <button class="diagram-btn copy-diagram-code-btn" data-code="${encoded}" title="Copy Mermaid Definition" type="button">
        Copy
      </button>
      <button class="diagram-btn export-svg-btn" data-target="${diagramId}" title="Download Diagram SVG" type="button">
        Save SVG
      </button>
    </div>
  </div>
  <div class="diagram-body">
    <div class="mermaid" id="${diagramId}">${md.utils.escapeHtml(code)}</div>
  </div>
</div>\n`;
    }

    if (defaultFence) {
      return defaultFence(tokens, idx, options, env, self);
    }
    return self.renderToken(tokens, idx, options);
  };
}
