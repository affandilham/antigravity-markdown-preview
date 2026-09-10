import MarkdownIt from 'markdown-it';

export interface CodeTabItem {
  title: string;
  lines: string[];
  startLine: number;
}

function parseTabTitle(line: string): string | null {
  const match = line.match(/^===\s*(?:"([^"]+)"|'([^']+)'|([^\n\r]+))$/);
  if (!match) return null;
  return (match[1] || match[2] || match[3] || '').trim();
}

/**
 * Markdown-it plugin for Tabbed Code Blocks (Multi-Language Tabs).
 * Syntax:
 * === Tab Title 1
 * ```language
 * code...
 * ```
 * === Tab Title 2
 * ```language
 * code...
 * ```
 */
export function codeTabPlugin(md: MarkdownIt): void {
  md.block.ruler.before('fence', 'code_tabs', (state, startLine, endLine, silent) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine];
    let max = state.eMarks[startLine];

    // Avoid indented code blocks (>= 4 spaces)
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;

    const firstLineText = state.src.slice(pos, max).trim();
    const firstTitle = parseTabTitle(firstLineText);
    if (!firstTitle) return false;

    if (silent) return true;

    // Scan forward to collect all tabs in this tab group
    const tabs: CodeTabItem[] = [];
    let currentTab: CodeTabItem = { title: firstTitle, lines: [], startLine: startLine };
    tabs.push(currentTab);

    let nextLine = startLine + 1;
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let emptyLineCount = 0;

    while (nextLine < endLine) {
      // PRESERVE INDENTATION: slice from bMarks (start of line) NOT bMarks + tShift
      const lineStart = state.bMarks[nextLine];
      const lineEnd = state.eMarks[nextLine];
      const fullLine = state.src.slice(lineStart, lineEnd);
      const trimmed = fullLine.trim();

      // Check for code fence open/close
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!inFence) {
          inFence = true;
          fenceChar = marker[0];
          fenceLen = marker.length;
        } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
          inFence = false;
        }
      }

      if (!inFence) {
        // Check if this line is another tab header === Title
        const nextTitle = parseTabTitle(trimmed);
        if (nextTitle) {
          currentTab = { title: nextTitle, lines: [], startLine: nextLine };
          tabs.push(currentTab);
          emptyLineCount = 0;
          nextLine++;
          continue;
        }

        // Check if empty line ends current tab
        if (trimmed === '') {
          emptyLineCount++;
          // Peek ahead to see if subsequent lines have another === Title
          let peekLine = nextLine + 1;
          let foundNextTab = false;
          while (peekLine < endLine) {
            const peekFull = state.src.slice(state.bMarks[peekLine], state.eMarks[peekLine]);
            const peekTrimmed = peekFull.trim();
            if (peekTrimmed === '') {
              peekLine++;
              continue;
            }
            if (parseTabTitle(peekTrimmed)) {
              foundNextTab = true;
            }
            break;
          }

          // If there's another tab coming up in the same group, keep line and continue
          if (foundNextTab) {
            currentTab.lines.push(fullLine);
            nextLine++;
            continue;
          }

          // If no tab is coming up and we already have empty line, terminate tab group
          if (emptyLineCount >= 1 && currentTab.lines.length > 0) {
            break;
          }
        } else {
          emptyLineCount = 0;
          // If we hit a heading or hr, end the tab group
          if (trimmed.startsWith('#') || trimmed.match(/^(-{3,}|\*{3,}|_{3,})$/)) {
            break;
          }
        }
      }

      currentTab.lines.push(fullLine);
      nextLine++;
    }

    state.line = nextLine;

    const token = state.push('code_tabs', '', 0);
    token.meta = { tabs };
    token.map = [startLine, nextLine];
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  md.renderer.rules.code_tabs = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const tabs: CodeTabItem[] = token.meta.tabs;
    const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';

    if (!tabs || tabs.length === 0) return '';

    const tabId = `tabs-${idx}-${Math.random().toString(36).substring(2, 7)}`;

    const headerButtons = tabs.map((t, i) => {
      const activeCls = i === 0 ? ' active' : '';
      const escapedTitle = md.utils.escapeHtml(t.title);
      return `<button class="code-tab-btn${activeCls}" data-tab="${i}" type="button">${escapedTitle}</button>`;
    }).join('\n    ');

    const tabPanels = tabs.map((t, i) => {
      const activeCls = i === 0 ? ' active' : '';
      const rawContent = t.lines.join('\n');
      const renderedContent = md.render(rawContent, env).trim();
      return `<div class="code-tab-panel${activeCls}" data-tab="${i}">\n${renderedContent}\n</div>`;
    }).join('\n    ');

    return `<div class="code-tab-container"${lineAttr} id="${tabId}">
  <div class="code-tab-headers">
    ${headerButtons}
  </div>
  <div class="code-tab-panels">
    ${tabPanels}
  </div>
</div>\n`;
  };
}
