import MarkdownIt from 'markdown-it';
import { alertPlugin } from './alertPlugin';
import { codeBlockPlugin } from './codeBlockPlugin';
import { collapsiblePlugin } from './collapsiblePlugin';
import { mermaidPlugin } from './mermaidPlugin';
import { plantumlPlugin } from './plantumlPlugin';
import { embedPlugin } from './embedPlugin';
import { tocPlugin, extractHeadings, TocItem } from './tocPlugin';
import { tablePlugin } from './tablePlugin';

export interface MarkdownEngineConfig {
  plantumlServer?: string;
  codeLineNumbers?: boolean;
}

export class MarkdownEngine {
  private md: MarkdownIt;

  constructor(private config: MarkdownEngineConfig = {}) {
    this.md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
      breaks: false
    });

    this.setupPlugins();
    this.setupHorizontalRule();
  }

  private setupPlugins(): void {
    // 1. Alert support (> [!NOTE], etc.)
    this.md.use(alertPlugin);

    // 2. Code blocks with syntax highlighting & copy
    this.md.use(codeBlockPlugin, {
      lineNumbers: this.config.codeLineNumbers ?? true
    });

    // 3. Collapsible sections (::: details ... ::: and <details>)
    this.md.use(collapsiblePlugin);

    // 4. Mermaid diagrams
    this.md.use(mermaidPlugin);

    // 5. PlantUML diagrams
    this.md.use(plantumlPlugin, {
      serverUrl: this.config.plantumlServer || 'https://kroki.io'
    });

    // 6. Embed views (YouTube, Video, Audio, Iframe)
    this.md.use(embedPlugin);

    // 7. Table of contents [TOC] and heading anchors
    this.md.use(tocPlugin);

    // 8. Tables with scroll wrappers and copy
    this.md.use(tablePlugin);
  }

  private setupHorizontalRule(): void {
    this.md.renderer.rules.hr = () => {
      return `<div class="antigravity-hr-wrapper">
  <hr class="antigravity-hr" />
  <span class="hr-badge">❖</span>
</div>\n`;
    };
  }

  public render(markdown: string): { html: string; headings: TocItem[] } {
    const headings = extractHeadings(markdown);
    const html = this.md.render(markdown);
    return { html, headings };
  }
}
