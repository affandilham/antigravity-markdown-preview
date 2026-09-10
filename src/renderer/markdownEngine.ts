import MarkdownIt from 'markdown-it';
import { alertPlugin } from './alertPlugin';
import { codeBlockPlugin } from './codeBlockPlugin';
import { collapsiblePlugin } from './collapsiblePlugin';
import { mermaidPlugin } from './mermaidPlugin';
import { plantumlPlugin } from './plantumlPlugin';
import { embedPlugin } from './embedPlugin';
import { tocPlugin, extractHeadings, TocItem } from './tocPlugin';
import { tablePlugin } from './tablePlugin';
import { sourceMapPlugin } from './sourceMapPlugin';
import { frontmatterPlugin } from './frontmatterPlugin';
import { taskListPlugin } from './taskListPlugin';
import { mathPlugin } from './mathPlugin';

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
    // 1. Source map line tagging for exact 1:1 scroll synchronization
    this.md.use(sourceMapPlugin);

    // 2. Specialized feature plugins
    this.md.use(frontmatterPlugin);
    this.md.use(taskListPlugin);
    this.md.use(alertPlugin);
    this.md.use(codeBlockPlugin, {
      lineNumbers: this.config.codeLineNumbers ?? true
    });
    this.md.use(collapsiblePlugin);
    this.md.use(mermaidPlugin);
    this.md.use(plantumlPlugin, {
      serverUrl: this.config.plantumlServer || 'https://www.plantuml.com/plantuml'
    });
    this.md.use(embedPlugin);
    this.md.use(tocPlugin);
    this.md.use(tablePlugin);
    this.md.use(mathPlugin);
  }

  private setupHorizontalRule(): void {
    const originalHr = this.md.renderer.rules.hr || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    this.md.renderer.rules.hr = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';
      return `<hr class="antigravity-hr"${lineAttr} />\n`;
    };
  }

  public render(markdown: string): { html: string; headings: TocItem[] } {
    const headings = extractHeadings(markdown);
    const html = this.md.render(markdown);
    return { html, headings };
  }
}
