import * as vscode from 'vscode';
import { MarkdownEngine } from './renderer/markdownEngine';
import { TocItem } from './renderer/tocPlugin';

export class MarkdownPreviewPanel {
  public static currentPanel: MarkdownPreviewPanel | undefined;
  public static readonly viewType = 'antigravity.markdownPreview';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _document: vscode.TextDocument;
  private _disposables: vscode.Disposable[] = [];
  private _markdownEngine: MarkdownEngine;
  private _updateTimeout: NodeJS.Timeout | undefined;

  public static createOrShow(extensionUri: vscode.Uri, document: vscode.TextDocument, viewColumn?: vscode.ViewColumn): MarkdownPreviewPanel {
    const column = viewColumn || vscode.ViewColumn.Beside;

    if (MarkdownPreviewPanel.currentPanel) {
      MarkdownPreviewPanel.currentPanel._document = document;
      MarkdownPreviewPanel.currentPanel._panel.reveal(column);
      MarkdownPreviewPanel.currentPanel.updateContent();
      return MarkdownPreviewPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      MarkdownPreviewPanel.viewType,
      `Preview: ${getFileName(document.fileName)}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'dist')
        ]
      }
    );

    MarkdownPreviewPanel.currentPanel = new MarkdownPreviewPanel(panel, extensionUri, document);
    return MarkdownPreviewPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, document: vscode.TextDocument) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._document = document;

    const config = vscode.workspace.getConfiguration('antigravity.markdownPreview');
    this._markdownEngine = new MarkdownEngine({
      plantumlServer: config.get<string>('plantumlServer', 'https://kroki.io'),
      codeLineNumbers: config.get<boolean>('codeLineNumbers', true)
    });

    this._panel.webview.html = this._getHtmlForWebview();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'copyText':
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
              vscode.window.setStatusBarMessage('$(check) Copied to clipboard!', 2500);
            }
            break;
          case 'exportHtml':
            await this.exportStandaloneHtml();
            break;
          case 'openExternal':
            if (message.url) {
              await vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            break;
          case 'log':
            console.log('[Markdown Preview]:', message.data);
            break;
        }
      },
      null,
      this._disposables
    );

    // Initial render
    this.updateContent();
  }

  public setDocument(doc: vscode.TextDocument): void {
    this._document = doc;
    this._panel.title = `Preview: ${getFileName(doc.fileName)}`;
    this.updateContent();
  }

  public updateContent(): void {
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
    }
    this._updateTimeout = setTimeout(() => {
      const text = this._document.getText();
      const { html, headings } = this._markdownEngine.render(text);
      const stats = computeStats(text);

      this._panel.webview.postMessage({
        command: 'update',
        html,
        headings,
        stats,
        title: getFileName(this._document.fileName)
      });
    }, 150);
  }

  public syncScroll(topPercentage: number): void {
    this._panel.webview.postMessage({
      command: 'syncScroll',
      percentage: topPercentage
    });
  }

  public async exportStandaloneHtml(): Promise<void> {
    const text = this._document.getText();
    const { html } = this._markdownEngine.render(text);
    const title = getFileName(this._document.fileName).replace(/\.md$/i, '');

    const defaultUri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file('/tmp'),
      `${title}.html`
    );

    const targetUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'HTML Files': ['html'] },
      saveLabel: 'Export HTML'
    });

    if (!targetUri) return;

    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --fg: #e6edf3;
      --card-bg: #161b22;
      --border: #30363d;
      --accent: #38bdf8;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.6;
      color: var(--fg);
      background-color: var(--bg);
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    pre code { background: #161b22; padding: 12px; border-radius: 8px; display: block; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { border: 1px solid var(--border); padding: 8px 12px; }
    th { background: #21262d; }
    blockquote { border-left: 4px solid var(--accent); margin: 16px 0; padding: 8px 16px; background: rgba(56, 189, 248, 0.05); }
    img { max-width: 100%; border-radius: 8px; }
  </style>
</head>
<body>
  <article class="markdown-body">
    ${html}
  </article>
</body>
</html>`;

    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(fullHtml, 'utf8'));
    vscode.window.showInformationMessage(`Exported Markdown Preview to ${targetUri.fsPath}`);
  }

  private _getHtmlForWebview(): string {
    const webview = this._panel.webview;
    const mediaUri = vscode.Uri.joinPath(this._extensionUri, 'media');

    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'preview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'preview.js'));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'vendor', 'mermaid.min.js'));

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: http: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; frame-src https: http:; font-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Markdown Preview</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body class="antigravity-preview-body">
  <!-- Top Glass Toolbar -->
  <header class="preview-toolbar" id="previewToolbar">
    <div class="toolbar-left">
      <button class="toolbar-btn active-state" id="btnToggleToc" title="Toggle Table of Contents (TOC)" type="button">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 3.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z"/>
        </svg>
        <span>TOC</span>
      </button>
      <button class="toolbar-btn active-state" id="btnToggleSync" title="Toggle Scroll Sync with Editor" type="button">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-7.068 2H.534a.25.25 0 0 1-.192-.41l1.966-2.36a.25.25 0 0 1 .384 0l1.966 2.36a.25.25 0 0 1-.192.41z"/>
        </svg>
        <span>Sync</span>
      </button>
    </div>

    <div class="toolbar-center">
      <span class="preview-doc-title" id="docTitle">Loading...</span>
      <span class="doc-badge" id="docStats">0 words</span>
    </div>

    <div class="toolbar-right">
      <div class="zoom-controls">
        <button class="toolbar-btn icon-only" id="btnZoomOut" title="Zoom Out" type="button">−</button>
        <span class="zoom-level" id="zoomLevel">100%</span>
        <button class="toolbar-btn icon-only" id="btnZoomIn" title="Zoom In" type="button">+</button>
        <button class="toolbar-btn icon-only" id="btnZoomReset" title="Reset Zoom" type="button">↺</button>
      </div>
      <button class="toolbar-btn" id="btnExportHtml" title="Export to Standalone HTML" type="button">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
          <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
        </svg>
        <span>Export</span>
      </button>
      <button class="toolbar-btn icon-only" id="btnPrint" title="Print or Save as PDF" type="button">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2.5 8a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z"/>
          <path d="M5 1a2 2 0 0 0-2 2v2H2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2H5zm1 2h4v2H6V3zm6 9v2H4v-2h8z"/>
        </svg>
      </button>
    </div>
  </header>

  <!-- Main Workspace -->
  <div class="preview-layout" id="previewLayout">
    <!-- Sidebar / Drawer TOC -->
    <aside class="preview-toc-drawer open" id="tocDrawer">
      <div class="toc-drawer-header">
        <span class="toc-drawer-title">Table of Contents</span>
        <button class="toc-close-btn" id="btnCloseToc" type="button">✕</button>
      </div>
      <div class="toc-drawer-body" id="tocContainer">
        <p class="toc-empty">Scanning headings...</p>
      </div>
    </aside>

    <!-- Markdown Canvas -->
    <main class="preview-content-area" id="previewContentArea">
      <article class="antigravity-markdown-root" id="markdownRoot">
        <div class="initial-loading">
          <div class="loading-spinner"></div>
          <p>Parsing Markdown with Antigravity Rich Engine...</p>
        </div>
      </article>
    </main>
  </div>

  <script nonce="${nonce}" src="${mermaidUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    MarkdownPreviewPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[\\\/]/);
  return parts[parts.length - 1] || 'Document';
}

function computeStats(markdown: string): string {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(1, Math.ceil(words / 200));
  return `${words} words · ${readMinutes} min read`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
