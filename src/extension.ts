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

  // Event: Document changed -> live update
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

  // Event: Editor scroll -> throttled sync with webview (35ms ~ 30fps)
  let scrollThrottleTimer: NodeJS.Timeout | undefined;
  const scrollSub = vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
    if (MarkdownPreviewPanel.currentPanel && event.textEditor.document.languageId === 'markdown') {
      const config = vscode.workspace.getConfiguration('antigravity.markdownPreview');
      const isSyncEnabled = config.get<boolean>('scrollSync', true);
      if (!isSyncEnabled) return;

      if (scrollThrottleTimer) {
        clearTimeout(scrollThrottleTimer);
      }
      scrollThrottleTimer = setTimeout(() => {
        const ranges = event.visibleRanges;
        if (ranges.length > 0) {
          const topVisibleLine = ranges[0].start.line;
          const totalLines = event.textEditor.document.lineCount;
          const percentage = totalLines > 1 ? topVisibleLine / (totalLines - 1) : 0;
          MarkdownPreviewPanel.currentPanel?.syncScroll(percentage);
        }
      }, 35);
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
