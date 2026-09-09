import * as vscode from 'vscode';
import { MarkdownPreviewPanel } from './previewPanel';

export function activate(context: vscode.ExtensionContext) {
  // Command: Open Preview to the Side
  const openToSideCommand = vscode.commands.registerCommand(
    'antigravity.markdownPreview.openToSide',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('Please open a Markdown file to preview.');
        return;
      }
      MarkdownPreviewPanel.createOrShow(context.extensionUri, editor.document, vscode.ViewColumn.Beside);
    }
  );

  // Command: Open Preview in Current Column
  const openCommand = vscode.commands.registerCommand(
    'antigravity.markdownPreview.open',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('Please open a Markdown file to preview.');
        return;
      }
      MarkdownPreviewPanel.createOrShow(context.extensionUri, editor.document, vscode.ViewColumn.Active);
    }
  );

  // Command: Export HTML
  const exportCommand = vscode.commands.registerCommand(
    'antigravity.markdownPreview.exportHtml',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('Please open a Markdown file to export.');
        return;
      }
      const panel = MarkdownPreviewPanel.createOrShow(context.extensionUri, editor.document);
      await panel.exportStandaloneHtml();
    }
  );

  // Event: Document edited -> fast streaming update (40ms)
  const changeDocSub = vscode.workspace.onDidChangeTextDocument((event) => {
    if (MarkdownPreviewPanel.currentPanel && event.document.languageId === 'markdown') {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document === event.document) {
        MarkdownPreviewPanel.currentPanel.updateContent();
      }
    }
  });

  // Event: Active editor changed -> switch preview to current active markdown doc
  const changeEditorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (MarkdownPreviewPanel.currentPanel && editor && editor.document.languageId === 'markdown') {
      MarkdownPreviewPanel.currentPanel.setDocument(editor.document);
    }
  });

  // Event: Real-time 60fps streaming scroll synchronization
  let lastScrollTimestamp = 0;
  let scrollTrailingTimer: NodeJS.Timeout | null = null;
  let latestScrollPercentage = 0;

  const scrollSub = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    if (MarkdownPreviewPanel.currentPanel && event.textEditor.document.languageId === 'markdown') {
      const config = vscode.workspace.getConfiguration('antigravity.markdownPreview');
      const isSyncEnabled = config.get<boolean>('scrollSync', true);
      if (!isSyncEnabled) return;

      const ranges = event.visibleRanges;
      if (ranges.length === 0) return;

      const topVisibleLine = ranges[0].start.line;
      const totalLines = event.textEditor.document.lineCount;
      const percentage = totalLines > 1 ? topVisibleLine / (totalLines - 1) : 0;
      latestScrollPercentage = percentage;

      const now = Date.now();
      const elapsed = now - lastScrollTimestamp;

      // Stream immediately if more than 16ms (~60fps) has elapsed
      if (elapsed >= 16) {
        lastScrollTimestamp = now;
        MarkdownPreviewPanel.currentPanel.syncScroll(percentage);
      } else {
        // Otherwise schedule trailing frame so no position is ever lost
        if (!scrollTrailingTimer) {
          scrollTrailingTimer = setTimeout(() => {
            scrollTrailingTimer = null;
            lastScrollTimestamp = Date.now();
            MarkdownPreviewPanel.currentPanel?.syncScroll(latestScrollPercentage);
          }, 16 - elapsed);
        }
      }
    }
  });

  context.subscriptions.push(
    openToSideCommand,
    openCommand,
    exportCommand,
    changeDocSub,
    changeEditorSub,
    scrollSub
  );
}

export function deactivate() {
  if (MarkdownPreviewPanel.currentPanel) {
    MarkdownPreviewPanel.currentPanel.dispose();
  }
}
