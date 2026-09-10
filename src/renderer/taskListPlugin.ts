import MarkdownIt from 'markdown-it';

export function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'task-lists', (state) => {
    const tokens = state.tokens;

    for (let i = 2; i < tokens.length; i++) {
      if (tokens[i].type !== 'inline') continue;
      if (tokens[i - 1].type !== 'paragraph_open') continue;
      if (tokens[i - 2].type !== 'list_item_open') continue;

      const inlineToken = tokens[i];
      const listItemToken = tokens[i - 2];
      const children = inlineToken.children;
      if (!children || children.length === 0) continue;

      const firstChild = children[0];
      if (firstChild.type !== 'text') continue;

      const match = firstChild.content.match(/^\[([ xX])\][ \t]+/);
      if (!match) continue;

      const isChecked = match[1].toLowerCase() === 'x';
      const line = listItemToken.map
        ? listItemToken.map[0]
        : inlineToken.map
        ? inlineToken.map[0]
        : 0;

      // Add task list classes to list item
      listItemToken.attrJoin('class', 'task-list-item' + (isChecked ? ' checked' : ''));
      listItemToken.attrSet('data-line', String(line));

      // Mark parent bullet_list_open
      for (let j = i - 2; j >= 0; j--) {
        if (tokens[j].type === 'bullet_list_open') {
          const cls = tokens[j].attrGet('class') || '';
          if (!cls.includes('contains-task-list')) {
            tokens[j].attrJoin('class', 'contains-task-list');
          }
          break;
        }
      }

      // Remove the [ ] or [x] prefix from first text child
      firstChild.content = firstChild.content.slice(match[0].length);

      // Create interactive checkbox input token
      const checkboxToken = new state.Token('html_inline', '', 0);
      checkboxToken.content = `<input type="checkbox" class="task-list-item-checkbox" data-line="${line}" ${
        isChecked ? 'checked' : ''
      } />`;

      // Wrap item text in a span for styling and line-through transition
      const textOpenToken = new state.Token('html_inline', '', 0);
      textOpenToken.content = '<span class="task-text">';
      const textCloseToken = new state.Token('html_inline', '', 0);
      textCloseToken.content = '</span>';

      inlineToken.children = [
        checkboxToken,
        textOpenToken,
        ...children,
        textCloseToken
      ];
    }
  });
}
