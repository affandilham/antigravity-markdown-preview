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
    this.md.use(alertPlugin);
    this.md.use(codeBlockPlugin, {
      lineNumbers: this.config.codeLineNumbers ?? true
    });
    this.md.use(collapsiblePlugin);
    this.md.use(mermaidPlugin);
    this.md.use(plantumlPlugin, {
      serverUrl: this.config.plantumlServer || 'https://kroki.io'
    });
    this.md.use(embedPlugin);
    this.md.use(tocPlugin);
    this.md.use(tablePlugin);
  }

  private setupHorizontalRule(): void {
    this.md.renderer.rules.hr = () => {
      return `<hr class="antigravity-hr" />\n`;
    };
  }

  public render(markdown: string): { html: string; headings: TocItem[] } {
    const headings = extractHeadings(markdown);
    const html = this.md.render(markdown);
    return { html, headings };
  }
}
