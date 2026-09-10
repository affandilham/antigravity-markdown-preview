import MarkdownIt from 'markdown-it';
import katex from 'katex';

/**
 * Checks if a character at pos in src is preceded by an odd number of backslashes.
 */
function isEscaped(src: string, pos: number): boolean {
  let backslashCount = 0;
  while (pos > 0 && src.charCodeAt(pos - 1) === 0x5c /* \ */) {
    backslashCount++;
    pos--;
  }
  return backslashCount % 2 === 1;
}

/**
 * Markdown-it plugin for KaTeX math formatting.
 * Supports:
 * - Inline formulas: $formula$ (with currency & escaped dollar protection)
 * - Double dollar inline: $$formula$$
 * - Block formulas: $$...$$ (single-line or multiline)
 * - Fenced code blocks: ```math, ```latex, ```katex
 */
export function mathPlugin(md: MarkdownIt): void {
  // 1. Inline Rule: $formula$ and $$inline_display_formula$$
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const start = state.pos;
    const max = state.posMax;

    if (state.src.charCodeAt(start) !== 0x24 /* $ */) {
      return false;
    }

    if (isEscaped(state.src, start)) {
      return false;
    }

    let isDouble = false;
    let pos = start + 1;

    if (pos < max && state.src.charCodeAt(pos) === 0x24 /* $ */) {
      isDouble = true;
      pos++;
    }

    // Opening delimiter cannot be at the end of string
    if (pos >= max) return false;
    const firstChar = state.src.charCodeAt(pos);
    // Opening delimiter cannot be followed by whitespace
    if (firstChar === 0x20 || firstChar === 0x09 || firstChar === 0x0a || firstChar === 0x0d) {
      return false;
    }

    // Search for closing delimiter
    let match = -1;
    while (pos < max) {
      const code = state.src.charCodeAt(pos);
      if (code === 0x24 /* $ */ && !isEscaped(state.src, pos)) {
        if (isDouble) {
          if (pos + 1 < max && state.src.charCodeAt(pos + 1) === 0x24) {
            match = pos;
            break;
          }
        } else {
          // Currency protection:
          // 1. Closing $ cannot be followed immediately by a digit (e.g. $10-$20 or $10.50)
          const nextChar = pos + 1 < max ? state.src.charCodeAt(pos + 1) : -1;
          if (nextChar >= 0x30 && nextChar <= 0x39 /* 0-9 */) {
            return false;
          }
          // 2. Closing $ cannot be preceded by whitespace (e.g. $10 and $20)
          const prevChar = state.src.charCodeAt(pos - 1);
          if (prevChar === 0x20 || prevChar === 0x09 || prevChar === 0x0a || prevChar === 0x0d) {
            return false;
          }
          match = pos;
          break;
        }
      }
      pos++;
    }

    if (match === -1) {
      return false;
    }

    const content = state.src.slice(start + (isDouble ? 2 : 1), match);

    // Single dollar inline math cannot span across newlines
    if (!isDouble && content.includes('\n')) {
      return false;
    }

    if (!silent) {
      const token = state.push(isDouble ? 'math_inline_double' : 'math_inline', '', 0);
      token.content = content.trim();
      token.markup = isDouble ? '$$' : '$';
    }

    state.pos = match + (isDouble ? 2 : 1);
    return true;
  });

  // 2. Block Rule: $$ ... $$ (both single-line and multiline blocks)
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine];
    let max = state.eMarks[startLine];

    // Avoid indented code blocks (>= 4 spaces)
    if (state.sCount[startLine] - state.blkIndent >= 4) {
      return false;
    }

    if (pos + 2 > max) return false;
    if (state.src.charCodeAt(pos) !== 0x24 || state.src.charCodeAt(pos + 1) !== 0x24) {
      return false;
    }

    pos += 2;
    let firstLine = state.src.slice(pos, max).trim();

    // Case A: Single line $$formula$$
    if (firstLine.endsWith('$$') && firstLine.length >= 2) {
      firstLine = firstLine.slice(0, -2).trim();
      if (silent) return true;

      state.line = startLine + 1;
      const token = state.push('math_block', '', 0);
      token.content = firstLine;
      token.markup = '$$';
      token.map = [startLine, state.line];
      return true;
    }

    // Case B: Multiline $$ ... $$
    let nextLine = startLine;
    let haveEndMarker = false;

    while (nextLine < endLine) {
      nextLine++;
      if (nextLine >= endLine) break;

      pos = state.bMarks[nextLine] + state.tShift[nextLine];
      max = state.eMarks[nextLine];

      if (pos < max && state.sCount[nextLine] < state.blkIndent) {
        break;
      }

      const lineText = state.src.slice(pos, max).trim();
      if (lineText === '$$' || lineText.endsWith('$$')) {
        haveEndMarker = true;
        break;
      }
    }

    if (!haveEndMarker) return false;
    if (silent) return true;

    state.line = nextLine + 1;

    const lines: string[] = [];
    const afterStart = state.src.slice(state.bMarks[startLine] + state.tShift[startLine] + 2, state.eMarks[startLine]).trim();
    if (afterStart) {
      lines.push(afterStart);
    }

    for (let i = startLine + 1; i < nextLine; i++) {
      lines.push(state.src.slice(state.bMarks[i] + state.tShift[i], state.eMarks[i]));
    }

    const lastLineText = state.src.slice(state.bMarks[nextLine] + state.tShift[nextLine], state.eMarks[nextLine]).trim();
    if (lastLineText !== '$$') {
      const beforeEnd = lastLineText.replace(/\$\$$/, '').trim();
      if (beforeEnd) lines.push(beforeEnd);
    }

    const token = state.push('math_block', '', 0);
    token.content = lines.join('\n').trim();
    token.markup = '$$';
    token.map = [startLine, state.line];
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  // 3. Renderer: math_inline
  md.renderer.rules.math_inline = (tokens, idx) => {
    const formula = tokens[idx].content;
    try {
      return katex.renderToString(formula, { displayMode: false, throwOnError: false, output: 'htmlAndMathml' });
    } catch (e: any) {
      return `<span class="katex-error" title="${md.utils.escapeHtml(e?.message || 'Error')}">${md.utils.escapeHtml(formula)}</span>`;
    }
  };

  // 4. Renderer: math_inline_double
  md.renderer.rules.math_inline_double = (tokens, idx) => {
    const formula = tokens[idx].content;
    try {
      return katex.renderToString(formula, { displayMode: true, throwOnError: false, output: 'htmlAndMathml' });
    } catch (e: any) {
      return `<span class="katex-error" title="${md.utils.escapeHtml(e?.message || 'Error')}">${md.utils.escapeHtml(formula)}</span>`;
    }
  };

  // 5. Renderer: math_block
  md.renderer.rules.math_block = (tokens, idx) => {
    const token = tokens[idx];
    const formula = token.content;
    const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';
    try {
      const rendered = katex.renderToString(formula, { displayMode: true, throwOnError: false, output: 'htmlAndMathml' });
      return `<div class="katex-block"${lineAttr}>\n${rendered}\n</div>\n`;
    } catch (e: any) {
      return `<div class="katex-block katex-error"${lineAttr} title="${md.utils.escapeHtml(e?.message || 'Error')}">\n${md.utils.escapeHtml(formula)}\n</div>\n`;
    }
  };

  // 6. Fenced code block support for ```math, ```latex, ```katex
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const info = token.info ? token.info.trim() : '';
    const lang = info.split(/\s+/)[0].toLowerCase();

    if (lang === 'math' || lang === 'latex' || lang === 'katex') {
      const formula = token.content.trim();
      const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';
      try {
        const rendered = katex.renderToString(formula, { displayMode: true, throwOnError: false, output: 'htmlAndMathml' });
        return `<div class="katex-block"${lineAttr}>\n${rendered}\n</div>\n`;
      } catch (e: any) {
        return `<div class="katex-block katex-error"${lineAttr} title="${md.utils.escapeHtml(e?.message || 'Error')}">\n${md.utils.escapeHtml(formula)}\n</div>\n`;
      }
    }

    return defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}
