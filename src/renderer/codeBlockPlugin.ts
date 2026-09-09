import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

export function codeBlockPlugin(md: MarkdownIt, options?: { lineNumbers?: boolean }): void {
  const showLineNumbers = options?.lineNumbers ?? true;

  md.renderer.rules.fence = (tokens, idx, _options, _env, _self) => {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : '';
    const lang = info.split(/\s+/)[0] || '';
    const code = token.content;

    // Special diagram types handled elsewhere
    if (lang === 'mermaid' || lang === 'plantuml' || lang === 'puml') {
      return token.content;
    }

    let highlighted = '';
    let validLang = lang;

    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch (err) {
        highlighted = md.utils.escapeHtml(code);
      }
    } else {
      try {
        const auto = hljs.highlightAuto(code);
        highlighted = auto.value;
        validLang = auto.language || 'text';
      } catch (err) {
        highlighted = md.utils.escapeHtml(code);
        validLang = 'text';
      }
    }

    let lineNumbersHtml = '';
    if (showLineNumbers) {
      const lines = code.split('\n');
      const count = code.endsWith('\n') ? lines.length - 1 : lines.length;
      const totalLines = Math.max(1, count);
      const digits = String(totalLines).length;
      const spans: string[] = [];
      for (let i = 1; i <= totalLines; i++) {
        spans.push(`<span>${i}</span>`);
      }
      const minWidthCh = Math.max(2, digits);
      lineNumbersHtml = `<div class="code-line-numbers" style="min-width: ${minWidthCh}ch;" aria-hidden="true">${spans.join('')}</div>`;
    }

    const displayLang = (lang || validLang || 'code').toLowerCase();
    const encodedRaw = encodeURIComponent(code);
    const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';

    return `<div class="antigravity-code-block"${lineAttr} data-lang="${displayLang}">
  <div class="code-block-header">
    <span class="code-lang-label">${displayLang}</span>
    <button class="copy-code-btn" data-code="${encodedRaw}" title="Copy code" type="button">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
        <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z"/>
        <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"/>
      </svg>
      <span class="copy-text">Copy</span>
    </button>
  </div>
  <div class="code-block-body">
    ${lineNumbersHtml}
    <pre><code class="hljs language-${lang || 'plaintext'}">${highlighted}</code></pre>
  </div>
</div>\n`;
  };
}
