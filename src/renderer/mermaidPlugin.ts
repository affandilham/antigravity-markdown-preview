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

      // Detect diagram subtype from code
      const firstLine = code.replace(/^%%[^\n]*\n?/gm, '').trim().split('\n')[0].trim().toLowerCase();
      let diagramSubtype = 'diagram';
      let typeLabel = 'Mermaid Diagram';

      if (firstLine.startsWith('graph') || firstLine.startsWith('flowchart')) {
        diagramSubtype = 'flowchart';
        typeLabel = 'Mermaid Flowchart';
      } else if (firstLine.startsWith('sequencediagram') || firstLine.startsWith('sequence')) {
        diagramSubtype = 'sequence';
        typeLabel = 'Mermaid Sequence Diagram';
      } else if (firstLine.startsWith('classdiagram')) {
        diagramSubtype = 'class';
        typeLabel = 'Mermaid Class Diagram';
      } else if (firstLine.startsWith('statediagram')) {
        diagramSubtype = 'state';
        typeLabel = 'Mermaid State Diagram';
      } else if (firstLine.startsWith('erdiagram')) {
        diagramSubtype = 'er';
        typeLabel = 'Mermaid ER Diagram';
      } else if (firstLine.startsWith('gantt')) {
        diagramSubtype = 'gantt';
        typeLabel = 'Mermaid Gantt Chart';
      } else if (firstLine.startsWith('pie')) {
        diagramSubtype = 'pie';
        typeLabel = 'Mermaid Pie Chart';
      } else if (firstLine.startsWith('gitgraph')) {
        diagramSubtype = 'gitgraph';
        typeLabel = 'Mermaid Git Graph';
      } else if (firstLine.startsWith('mindmap')) {
        diagramSubtype = 'mindmap';
        typeLabel = 'Mermaid Mindmap';
      }

      return `<div class="antigravity-diagram-card mermaid-card mermaid-type-${diagramSubtype}"${lineAttr} id="card-${diagramId}">
  <div class="diagram-header">
    <div class="diagram-type">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6 2a2 2 0 0 0-2 2v1H3a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2H6zm0 1.5h4a.5.5 0 0 1 .5.5v1H5.5V4a.5.5 0 0 1 .5-.5z"/>
      </svg>
      <span>${typeLabel}</span>
    </div>
    <div class="diagram-actions">
      <button class="diagram-btn modal-expand-btn icon-only" data-target="${diagramId}" title="Fullscreen Pan & Zoom" type="button">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 0 1 0V2h3.5a.5.5 0 0 0 0-1h-4zm10 0a.5.5 0 0 0 0 1H14v3.5a.5.5 0 0 0 1 0v-4a.5.5 0 0 0-.5-.5h-4zM1 10.5a.5.5 0 0 0 1 0V14h3.5a.5.5 0 0 0 0 1h-4a.5.5 0 0 0-.5-.5v-4zm14 0a.5.5 0 0 0-1 0V14h-3.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 .5-.5v-4z"/>
        </svg>
      </button>
      <button class="diagram-btn copy-diagram-code-btn" data-code="${encoded}" title="Copy Mermaid Definition" type="button">
        Copy
      </button>
      <button class="diagram-btn copy-png-btn" data-target="${diagramId}" title="Copy Diagram as PNG to Clipboard" type="button">
        Copy PNG
      </button>
      <button class="diagram-btn export-png-btn" data-target="${diagramId}" title="Save as High-Res PNG Image" type="button">
        Save PNG
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
