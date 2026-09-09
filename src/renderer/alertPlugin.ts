import MarkdownIt from 'markdown-it';

export type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

const ALERT_CONFIG: Record<AlertType, { label: string; icon: string }> = {
  note: {
    label: 'Note',
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75zM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>`
  },
  tip: {
    label: 'Tip',
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.91.24.417.379.888.379 1.533h3.5c0-.645.14-1.116.379-1.533.203-.354.45-.646.673-.91l.214-.253c.56-.679.984-1.32.984-2.304 0-2.06-1.637-3.75-4-3.75zM5.5 12h5v1h-5v-1zm1 2h3v1h-3v-1z"/></svg>`
  },
  important: {
    label: 'Important',
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.25-3.25a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5zm.75 6.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>`
  },
  warning: {
    label: 'Warning',
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>`
  },
  caution: {
    label: 'Caution',
    icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4.47.04c.383-.04.764.092 1.05.378L15.58 10.48c.586.586.586 1.536 0 2.122l-3.06 3.06a1.5 1.5 0 0 1-2.12 0L.418 5.68A1.5 1.5 0 0 1 .378 3.56L3.44.5a1.5 1.5 0 0 1 1.03-.46zM8 4.75a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 1.5 0v-3.5zm0 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>`
  }
};

const ALERT_REGEX = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;

export function alertPlugin(md: MarkdownIt): void {
  const defaultBlockquoteOpen =
    md.renderer.rules.blockquote_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultBlockquoteClose =
    md.renderer.rules.blockquote_close ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.core.ruler.after('block', 'github_alerts', (state) => {
    const tokens = state.tokens;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'blockquote_open') {
        continue;
      }

      // Look at children inside the blockquote
      let paragraphTokenIndex = -1;
      let inlineTokenIndex = -1;

      for (let j = i + 1; j < tokens.length && tokens[j].type !== 'blockquote_close'; j++) {
        if (tokens[j].type === 'paragraph_open') {
          paragraphTokenIndex = j;
          if (tokens[j + 1] && tokens[j + 1].type === 'inline') {
            inlineTokenIndex = j + 1;
          }
          break;
        }
      }

      if (paragraphTokenIndex === -1 || inlineTokenIndex === -1) {
        continue;
      }

      const inlineToken = tokens[inlineTokenIndex];
      if (!inlineToken.children || inlineToken.children.length === 0) {
        continue;
      }

      const firstChild = inlineToken.children[0];
      if (firstChild.type !== 'text') {
        continue;
      }

      const match = firstChild.content.match(ALERT_REGEX);
      if (!match) {
        continue;
      }

      const alertType = match[1].toLowerCase() as AlertType;
      const restOfFirstLine = match[2].trim();

      // Modify the first text token content
      if (restOfFirstLine.length > 0) {
        firstChild.content = restOfFirstLine;
      } else {
        inlineToken.children.shift();
      }

      // Mark this blockquote token as an alert
      tokens[i].meta = { isAlert: true, alertType };

      // Find matching blockquote_close
      let depth = 1;
      for (let k = i + 1; k < tokens.length; k++) {
        if (tokens[k].type === 'blockquote_open') depth++;
        if (tokens[k].type === 'blockquote_close') {
          depth--;
          if (depth === 0) {
            tokens[k].meta = { isAlert: true, alertType };
            break;
          }
        }
      }
    }
  });

  md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.meta && token.meta.isAlert) {
      const type = token.meta.alertType as AlertType;
      const config = ALERT_CONFIG[type] || ALERT_CONFIG.note;
      const lineAttr = token.map ? ` data-line="${token.map[0]}"` : '';
      return `<div class="antigravity-alert alert-${type}"${lineAttr}>
  <div class="alert-header">
    <span class="alert-icon-wrapper">${config.icon}</span>
    <span class="alert-title">${config.label}</span>
  </div>
  <div class="alert-content">`;
    }
    return defaultBlockquoteOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.blockquote_close = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.meta && token.meta.isAlert) {
      return `</div>\n</div>\n`;
    }
    return defaultBlockquoteClose(tokens, idx, options, env, self);
  };
}
