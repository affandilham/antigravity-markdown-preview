import MarkdownIt from 'markdown-it';
import { getPlantUmlSvgUrl } from '../utils/plantumlEncoder';

export function plantumlPlugin(md: MarkdownIt, options?: { serverUrl?: string }): void {
  const serverUrl = options?.serverUrl || 'https://www.plantuml.com/plantuml';
  const defaultFence = md.renderer.rules.fence;

  md.renderer.rules.fence = (tokens, idx, opt, env, self) => {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : '';
    const lang = info.split(/\s+/)[0];

    if (lang === 'plantuml' || lang === 'puml') {
      const pumlCode = token.content.trim();
      const svgUrl = getPlantUmlSvgUrl(pumlCode, serverUrl);
      const encodedCode = encodeURIComponent(pumlCode);
      const diagramId = `puml-${idx}-${Math.random().toString(36).substring(2, 8)}`;
      const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';

      return `<div class="antigravity-diagram-card plantuml-card"${lineAttr} id="card-${diagramId}">
  <div class="diagram-header">
    <div class="diagram-type">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5v-3zM2.5 2a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm6.5.5A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5v-3zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM1 10.5A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-3zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm7.5.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5zm0 3a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 0 1h-4a.5.5 0 0 1-.5-.5z"/>
      </svg>
      <span>PlantUML Diagram</span>
    </div>
    <div class="diagram-actions">
      <button class="diagram-btn modal-expand-btn modal-puml-expand-btn icon-only" data-target="${diagramId}" title="Fullscreen Pan & Zoom" type="button">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 0 1 0V2h3.5a.5.5 0 0 0 0-1h-4zm10 0a.5.5 0 0 0 0 1H14v3.5a.5.5 0 0 0 1 0v-4a.5.5 0 0 0-.5-.5h-4zM1 10.5a.5.5 0 0 0 1 0V14h3.5a.5.5 0 0 0 0 1h-4a.5.5 0 0 0-.5-.5v-4zm14 0a.5.5 0 0 0-1 0V14h-3.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 .5-.5v-4z"/>
        </svg>
      </button>
      <button class="diagram-btn copy-diagram-code-btn" data-code="${encodedCode}" title="Copy PlantUML Source" type="button">
        Copy
      </button>
      <button class="diagram-btn copy-puml-png-btn" data-target="${diagramId}" title="Copy Diagram as PNG to Clipboard" type="button">
        Copy PNG
      </button>
      <button class="diagram-btn export-puml-png-btn" data-target="${diagramId}" title="Save as PNG Image" type="button">
        Save PNG
      </button>
      <a class="diagram-btn open-url-btn" href="${svgUrl}" target="_blank" title="Open Full SVG" rel="noopener noreferrer">
        Open SVG
      </a>
    </div>
  </div>
  <div class="diagram-body plantuml-body">
    <img class="plantuml-svg-img" id="${diagramId}" src="${svgUrl}" alt="PlantUML Diagram" loading="lazy" onerror="this.alt='Failed to render PlantUML'; this.style.display='none';" />
  </div>
</div>\n`;
    }

    if (defaultFence) {
      return defaultFence(tokens, idx, opt, env, self);
    }
    return self.renderToken(tokens, idx, opt);
  };
}
