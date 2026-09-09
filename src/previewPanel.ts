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
  private _isWebviewReady = false;

  public static createOrShow(extensionUri: vscode.Uri, document: vscode.TextDocument, viewColumn?: vscode.ViewColumn): MarkdownPreviewPanel {
    const column = viewColumn || vscode.ViewColumn.Beside;

    if (MarkdownPreviewPanel.currentPanel) {
      MarkdownPreviewPanel.currentPanel._document = document;
      MarkdownPreviewPanel.currentPanel._panel.reveal(column);
      MarkdownPreviewPanel.currentPanel.refresh();
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

    // Instant initial render directly in HTML
    this.refresh();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'ready':
            this._isWebviewReady = true;
            break;
          case 'copyText':
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
              vscode.window.setStatusBarMessage('$(check) Copied to clipboard', 2000);
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
        }
      },
      null,
      this._disposables
    );
  }

  public setDocument(doc: vscode.TextDocument): void {
    this._document = doc;
    this._panel.title = `Preview: ${getFileName(doc.fileName)}`;
    this.refresh();
  }

  public refresh(): void {
    const text = this._document.getText();
    const { html, headings } = this._markdownEngine.render(text);
    const stats = computeStats(text);
    const title = getFileName(this._document.fileName);

    if (!this._isWebviewReady) {
      this._panel.webview.html = this._getHtmlForWebview(html, headings, stats, title);
    } else {
      this.updateContent();
    }
  }

  public updateContent(): void {
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
    }
    // 40ms fast streaming update when editing text
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
    }, 40);
  }

  public syncScroll(topPercentage: number): void {
    if (!this._isWebviewReady) return;
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
      --bg: #ffffff;
      --fg: #1f2328;
      --border: rgba(128, 128, 128, 0.2);
      --accent: #0969da;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1117;
        --fg: #e6edf3;
        --border: rgba(255, 255, 255, 0.12);
        --accent: #58a6ff;
      }
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.65;
      color: var(--fg);
      background-color: var(--bg);
      max-width: 860px;
      margin: 0 auto;
      padding: 48px 24px;
    }
    h1, h2, h3, h4 { color: var(--fg); }
    pre code { background: rgba(128, 128, 128, 0.08); padding: 14px; border-radius: 6px; display: block; overflow-x: auto; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13.5px; }
    th, td { border: 1px solid var(--border); padding: 8px 12px; color: var(--fg); }
    th { background: rgba(128, 128, 128, 0.05); }
    blockquote { border-left: 3px solid var(--accent); margin: 16px 0; padding: 4px 16px; }
    img { max-width: 100%; border-radius: 6px; }
  </style>
</head>
<body>
  <article class="markdown-body">
    ${html}
  </article>
</body>
</html>`;

    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(fullHtml, 'utf8'));
    vscode.window.showInformationMessage(`Exported Markdown to ${targetUri.fsPath}`);
  }

  private _getHtmlForWebview(initialHtml: string, headings: TocItem[], stats: string, title: string): string {
    const webview = this._panel.webview;
    const mediaUri = vscode.Uri.joinPath(this._extensionUri, 'media');

    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'preview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'preview.js'));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'vendor', 'mermaid.min.js'));

    const nonce = getNonce();

    // Build initial TOC HTML
    let initialTocHtml = '<p class="toc-empty">No headings found.</p>';
    if (headings && headings.length > 0) {
      initialTocHtml = '<ul>';
      for (const h of headings) {
        initialTocHtml += `<li class="toc-item-${Math.min(4, h.level)}"><a href="#${h.id}" data-target-id="${h.id}">${escapeHtml(h.text)}</a></li>`;
      }
      initialTocHtml += '</ul>';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: http: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; frame-src https: http:; font-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview: ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body class="antigravity-preview-body">
  <header class="preview-toolbar" id="previewToolbar">
    <div class="toolbar-left">
      <button class="toolbar-btn" id="btnToggleToc" title="Toggle Table of Contents" type="button">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 3.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z"/>
        </svg>
        <span>Outline</span>
      </button>
      <button class="toolbar-btn active-state" id="btnToggleSync" title="Sync Scroll with Editor" type="button">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-7.068 2H.534a.25.25 0 0 1-.192-.41l1.966-2.36a.25.25 0 0 1 .384 0l1.966 2.36a.25.25 0 0 1-.192.41z"/>
        </svg>
        <span>Sync</span>
      </button>
    </div>

    <div class="toolbar-center">
      <span class="preview-doc-title" id="docTitle">${escapeHtml(title)}</span>
      <span class="doc-badge" id="docStats">${escapeHtml(stats)}</span>
    </div>

    <div class="toolbar-right">
      <button class="toolbar-btn" id="btnExportHtml" title="Export HTML" type="button">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
          <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
        </svg>
        <span>Export</span>
      </button>
      <button class="toolbar-btn icon-only" id="btnPrint" title="Print" type="button">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2.5 8a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z"/>
          <path d="M5 1a2 2 0 0 0-2 2v2H2a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-1h1a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1V3a2 2 0 0 0-2-2H5zm1 2h4v2H6V3zm6 9v2H4v-2h8z"/>
        </svg>
      </button>
    </div>
  </header>

  <div class="preview-layout" id="previewLayout">
    <aside class="preview-toc-drawer closed" id="tocDrawer">
      <div class="toc-drawer-header">
        <span class="toc-drawer-title">Outline</span>
        <button class="toc-close-btn" id="btnCloseToc" type="button">✕</button>
      </div>
      <div class="toc-drawer-body" id="tocContainer">
        ${initialTocHtml}
      </div>
    </aside>

    <main class="preview-content-area" id="previewContentArea">
      <article class="antigravity-markdown-root" id="markdownRoot">
        ${initialHtml}
      </article>
    </main>
  </div>

  <script nonce="${nonce}" src="${mermaidUri}" defer></script>
  <script nonce="${nonce}" src="${jsUri}" defer></script>
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
