import MarkdownIt from 'markdown-it';

export interface FrontmatterEntry {
  key: string;
  value: string;
}

export function parseYamlFrontmatter(rawYaml: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  const lines = rawYaml.split(/\r?\n/);
  let currentKey = '';
  let currentValue = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Match "key: value" or "key:"
    const match = line.match(/^([a-zA-Z0-9_\s-]+?)\s*:\s*(.*)$/);
    if (match) {
      if (currentKey) {
        entries.push({ key: currentKey, value: currentValue.trim() });
      }
      currentKey = match[1].trim();
      currentValue = match[2] || '';
    } else if (currentKey) {
      // Continuation of multiline value or list item
      if (trimmed.startsWith('- ')) {
        currentValue += (currentValue ? '\n' : '') + trimmed;
      } else {
        currentValue += ' ' + trimmed;
      }
    }
  }

  if (currentKey) {
    entries.push({ key: currentKey, value: currentValue.trim() });
  }

  return entries;
}

export function frontmatterPlugin(md: MarkdownIt): void {
  // Block rule to intercept YAML frontmatter at the very beginning of the document
  md.block.ruler.before('table', 'frontmatter', (state, startLine, endLine, silent) => {
    // Frontmatter can only exist starting at line 0
    if (startLine !== 0) return false;

    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const maxPos = state.eMarks[startLine];
    const firstLine = state.src.slice(startPos, maxPos).trim();

    if (firstLine !== '---') return false;

    let nextLine = startLine + 1;
    let foundClose = false;

    while (nextLine < endLine) {
      const pos = state.bMarks[nextLine] + state.tShift[nextLine];
      const max = state.eMarks[nextLine];
      const lineText = state.src.slice(pos, max).trim();
      if (lineText === '---' || lineText === '...') {
        foundClose = true;
        break;
      }
      nextLine++;
    }

    if (!foundClose) return false;
    if (silent) return true;

    const yamlLines: string[] = [];
    for (let l = startLine + 1; l < nextLine; l++) {
      const pos = state.bMarks[l] + state.tShift[l];
      const max = state.eMarks[l];
      yamlLines.push(state.src.slice(pos, max));
    }
    const rawYaml = yamlLines.join('\n');

    state.line = nextLine + 1;

    const token = state.push('frontmatter', '', 0);
    token.content = rawYaml;
    token.map = [startLine, nextLine + 1];

    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  md.renderer.rules.frontmatter = (tokens, idx) => {
    const token = tokens[idx];
    const rawYaml = token.content;
    const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';
    const entries = parseYamlFrontmatter(rawYaml);

    if (entries.length === 0) return '';

    const rowsHtml = entries
      .map(e => {
        const escapedKey = md.utils.escapeHtml(e.key);
        const escapedVal = md.utils.escapeHtml(e.value);
        return `<tr><td class="fm-key">${escapedKey}</td><td class="fm-val">${escapedVal}</td></tr>`;
      })
      .join('');

    const countLabel = entries.length === 1 ? '1 property' : `${entries.length} properties`;

    return `<details class="frontmatter-card"${lineAttr} open>
  <summary class="frontmatter-header">
    <div class="frontmatter-header-left">
      <svg class="frontmatter-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
        <path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H1.75zM4 4.75a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 4.75zm0 3.5a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 8.25zm0 3.5a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75z"/>
      </svg>
      <span class="frontmatter-badge">Frontmatter</span>
    </div>
    <span class="frontmatter-count">${countLabel}</span>
  </summary>
  <div class="frontmatter-content">
    <table class="frontmatter-table">
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</details>\n`;
  };
}
