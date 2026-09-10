import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { MarkdownEngine } from './renderer/markdownEngine';
import { TocItem } from './renderer/tocPlugin';

export class MarkdownPreviewPanel {
  public static currentPanel: MarkdownPreviewPanel | undefined;
  public static readonly viewType = 'antigravity.markdownPreview';
  public static isSyncingFromWebview = false;
  private static _context: vscode.ExtensionContext | undefined;

  public static setContext(context: vscode.ExtensionContext): void {
    MarkdownPreviewPanel._context = context;
  }

  public static saveZoomLevel(zoom: number): void {
    MarkdownPreviewPanel._context?.globalState.update('antigravity.markdownPreview.zoomLevel', zoom);
  }

  public static getZoomLevel(): number {
    return MarkdownPreviewPanel._context?.globalState.get<number>('antigravity.markdownPreview.zoomLevel') ?? 1.0;
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _document: vscode.TextDocument;
  private _disposables: vscode.Disposable[] = [];
  private _markdownEngine: MarkdownEngine;
  private _updateTimeout: NodeJS.Timeout | undefined;
  private _syncLockTimeout: NodeJS.Timeout | undefined;

  public get documentUri(): vscode.Uri {
    return this._document.uri;
  }

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
      `Preview ${getFileName(document.fileName)}`,
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

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'preview-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'preview-dark.svg')
    };

    const config = vscode.workspace.getConfiguration('antigravity.markdownPreview');
    this._markdownEngine = new MarkdownEngine({
      plantumlServer: config.get<string>('plantumlServer', 'https://kroki.io'),
      codeLineNumbers: config.get<boolean>('codeLineNumbers', true)
    });

    this.refresh();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'ready':
            const editor = vscode.window.visibleTextEditors.find(e => e.document === this._document);
            if (editor && editor.visibleRanges.length > 0) {
              const line = editor.visibleRanges[0].start.line;
              const total = editor.document.lineCount;
              const pct = total > 1 ? line / (total - 1) : 0;
              this.syncScroll(line, pct);
            }
            break;
          case 'scrollEditorToLine':
            if (typeof message.line === 'number') {
              this.scrollEditorToLine(message.line, !!message.setSelection);
            }
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
          case 'copyImageToClipboard':
            if (message.dataUrl) {
              await this.copyImageToClipboard(message.dataUrl);
            } else if (message.imageUrl) {
              await this.copyImageUrlToClipboard(message.imageUrl);
            }
            break;
          case 'saveImage':
            if (message.data) {
              await this.saveImageFile(message.data, message.defaultName);
            } else if (message.imageUrl) {
              await this.saveImageUrlFile(message.imageUrl, message.defaultName);
            }
            break;
          case 'saveSvg':
            if (message.svg) {
              await this.saveSvgFile(message.svg, message.defaultName);
            }
            break;
          case 'toggleTask':
            if (typeof message.line === 'number') {
              await this.toggleTaskAtLine(message.line, !!message.checked);
            }
            break;
          case 'openExternal':
            if (message.url) {
              await vscode.env.openExternal(vscode.Uri.parse(message.url));
            }
            break;
          case 'saveZoomLevel':
            if (typeof message.zoom === 'number') {
              MarkdownPreviewPanel.saveZoomLevel(message.zoom);
            }
            break;
          case 'requestSyncFromEditor':
            const activeEditor = vscode.window.activeTextEditor?.document === this._document 
              ? vscode.window.activeTextEditor 
              : vscode.window.visibleTextEditors.find(e => e.document === this._document);
            if (activeEditor && activeEditor.visibleRanges.length > 0) {
              const line = activeEditor.visibleRanges[0].start.line;
              const total = activeEditor.document.lineCount;
              const pct = total > 1 ? line / (total - 1) : 0;
              this.syncScroll(line, pct);
            }
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public setDocument(doc: vscode.TextDocument): void {
    if (this._document.uri.toString() === doc.uri.toString()) {
      return;
    }
    this._document = doc;
    this._panel.title = `Preview ${getFileName(doc.fileName)}`;
    this.refresh();
  }

  public refresh(): void {
    const text = this._document.getText();
    const { html, headings } = this._markdownEngine.render(text);
    const title = getFileName(this._document.fileName);

    this._panel.webview.html = this._getHtmlForWebview(html, headings, title);
  }

  public updateContent(): void {
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
    }
    this._updateTimeout = setTimeout(() => {
      const text = this._document.getText();
      const { html, headings } = this._markdownEngine.render(text);

      this._panel.webview.postMessage({
        command: 'update',
        html,
        headings,
        title: getFileName(this._document.fileName)
      });
    }, 40);
  }

  public syncScroll(line: number, percentage: number): void {
    this._panel.webview.postMessage({
      command: 'syncScroll',
      line: line,
      percentage: percentage
    });
  }

  public scrollEditorToLine(line: number, setSelection: boolean = false): void {
    const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === this._document.uri.toString()) ||
      (vscode.window.activeTextEditor?.document.uri.toString() === this._document.uri.toString() ? vscode.window.activeTextEditor : undefined);
    if (!editor) return;

    const targetLine = Math.min(Math.max(0, line), editor.document.lineCount - 1);
    const range = new vscode.Range(targetLine, 0, targetLine, 0);

    MarkdownPreviewPanel.isSyncingFromWebview = true;
    if (setSelection) {
      editor.selection = new vscode.Selection(range.start, range.start);
    }
    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);

    if (this._syncLockTimeout) {
      clearTimeout(this._syncLockTimeout);
    }
    this._syncLockTimeout = setTimeout(() => {
      MarkdownPreviewPanel.isSyncingFromWebview = false;
    }, 120);
  }

  public async saveImageFile(dataUrl: string, defaultName: string = 'diagram.png'): Promise<void> {
    try {
      const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(this._document.uri);
      const defaultUri = vscode.Uri.joinPath(
        workspaceFolder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file('/tmp'),
        defaultName
      );

      const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'PNG Image': ['png'] }
      });

      if (targetUri) {
        await vscode.workspace.fs.writeFile(targetUri, buffer);
        vscode.window.showInformationMessage(`Saved diagram to ${getFileName(targetUri.fsPath)}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save diagram image: ${err?.message || err}`);
    }
  }

  public async saveSvgFile(svgString: string, defaultName: string = 'diagram.svg'): Promise<void> {
    try {
      const buffer = Buffer.from(svgString, 'utf8');
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(this._document.uri);
      const defaultUri = vscode.Uri.joinPath(
        workspaceFolder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file('/tmp'),
        defaultName
      );

      const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { 'SVG Vector Image': ['svg'] }
      });

      if (targetUri) {
        await vscode.workspace.fs.writeFile(targetUri, buffer);
        vscode.window.showInformationMessage(`Saved diagram to ${getFileName(targetUri.fsPath)}`);
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save SVG diagram: ${err?.message || err}`);
    }
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
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
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

  private _getHtmlForWebview(initialHtml: string, headings: TocItem[], title: string): string {
    const webview = this._panel.webview;
    const mediaUri = vscode.Uri.joinPath(this._extensionUri, 'media');

    const katexCssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'vendor', 'katex', 'katex.min.css'));
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'preview.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'preview.js'));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'vendor', 'mermaid.min.js'));

    const nonce = getNonce();
    const savedZoom = MarkdownPreviewPanel.getZoomLevel();
    const zoomPercent = Math.round(savedZoom * 100);

    let initialTocHtml = '<p class="toc-empty">No headings found.</p>';
    if (headings && headings.length > 0) {
      initialTocHtml = '<ul>';
      for (const h of headings) {
        const lineAttr = typeof h.line === 'number' ? ` data-toc-line="${h.line}"` : '';
        initialTocHtml += `<li class="toc-item-${Math.min(4, h.level)}"><a href="#${h.id}" data-target-id="${h.id}"${lineAttr}>${escapeHtml(h.text)}</a></li>`;
      }
      initialTocHtml += '</ul>';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: http: data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; frame-src https: http:; font-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Preview ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${katexCssUri}">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body class="antigravity-preview-body" data-initial-zoom="${savedZoom}">
  <header class="preview-toolbar" id="previewToolbar">
    <div class="toolbar-left">
      <button class="toolbar-btn" id="btnToggleToc" title="Toggle Outline" type="button">
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

      <!-- Zoom Controls di sebelah icon Print -->
      <div class="zoom-controls">
        <button class="toolbar-btn icon-only" id="btnZoomOut" title="Zoom Out (Cmd -)" type="button">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 7.75A.75.75 0 0 1 2.75 7h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.75z"/>
          </svg>
        </button>
        <button class="zoom-indicator-btn" id="btnZoomReset" title="Reset Zoom (Cmd 0)" type="button">
          <span id="zoomLevel">${zoomPercent}%</span>
        </button>
        <button class="toolbar-btn icon-only" id="btnZoomIn" title="Zoom In (Cmd +)" type="button">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2z"/>
          </svg>
        </button>
      </div>
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
      <!-- Minimalist Professional Skeleton Loader -->
      <div class="preview-loading-overlay" id="previewLoadingOverlay" aria-hidden="true">
        <div class="skeleton-container">
          <div class="skeleton-bar skeleton-title"></div>
          <div class="skeleton-bar skeleton-subtitle"></div>
          <div class="skeleton-divider"></div>
          <div class="skeleton-bar skeleton-text w90"></div>
          <div class="skeleton-bar skeleton-text w75"></div>
          <div class="skeleton-bar skeleton-text w85"></div>
          <div class="skeleton-bar skeleton-text w60"></div>
          <div class="skeleton-gap"></div>
          <div class="skeleton-block"></div>
          <div class="skeleton-gap"></div>
          <div class="skeleton-bar skeleton-text w80"></div>
          <div class="skeleton-bar skeleton-text w70"></div>
        </div>
      </div>

      <article class="antigravity-markdown-root" id="markdownRoot" style="zoom: ${savedZoom}; ${savedZoom <= 0.5 ? 'max-width: 100%;' : ''}">
        ${initialHtml}
      </article>
    </main>
  </div>

  <!-- Diagram Interactive Lightbox Modal -->
  <div class="diagram-modal-overlay" id="diagramModalOverlay" aria-hidden="true">
    <div class="diagram-modal-backdrop" id="diagramModalBackdrop"></div>
    <header class="diagram-modal-header">
      <div class="diagram-modal-title">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 1a.5.5 0 0 0-.5.5v4a.5.5 0 0 0 1 0V2h3.5a.5.5 0 0 0 0-1h-4zm10 0a.5.5 0 0 0 0 1H14v3.5a.5.5 0 0 0 1 0v-4a.5.5 0 0 0-.5-.5h-4zM1 10.5a.5.5 0 0 0 1 0V14h3.5a.5.5 0 0 0 0 1h-4a.5.5 0 0 0-.5-.5v-4zm14 0a.5.5 0 0 0-1 0V14h-3.5a.5.5 0 0 0 0 1h4a.5.5 0 0 0 .5-.5v-4z"/>
        </svg>
        <span id="diagramModalTitle">Diagram Interactive View</span>
      </div>
      <div class="diagram-modal-controls">
        <button class="modal-control-btn icon-only" id="btnModalZoomOut" title="Zoom Out (- / Scroll Down)" type="button">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M2 7.75A.75.75 0 0 1 2.75 7h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.75z"/>
          </svg>
        </button>
        <button class="modal-zoom-indicator-btn" id="btnModalZoomReset" title="Reset Zoom (0 / 100%)" type="button">
          <span id="modalZoomLevel">100%</span>
        </button>
        <button class="modal-control-btn icon-only" id="btnModalZoomIn" title="Zoom In (+ / Scroll Up)" type="button">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2z"/>
          </svg>
        </button>
        <button class="modal-control-btn" id="btnModalFit" title="Fit to Screen (F)" type="button">
          Fit
        </button>
        <button class="modal-control-btn modal-close-btn" id="btnModalClose" title="Close (Esc)" type="button">
          ✕
        </button>
      </div>
    </header>
    <div class="diagram-modal-viewport" id="diagramModalViewport">
      <div class="diagram-modal-canvas" id="diagramModalCanvas"></div>
    </div>
    <div class="diagram-modal-hint">
      <span>Pinch / Scroll to Zoom · Two-Finger / Drag to Pan · Esc to Close</span>
    </div>
  </div>

  <script nonce="${nonce}" src="${mermaidUri}" defer></script>
  <script nonce="${nonce}" src="${jsUri}" defer></script>
</body>
</html>`;
  }

  private async toggleTaskAtLine(line: number, checked: boolean): Promise<void> {
    const doc = this._document;
    if (!doc || line < 0 || line >= doc.lineCount) return;

    let targetLine = line;
    let lineText = doc.lineAt(targetLine).text;
    const taskBoxRegex = /^(\s*(?:[-*+]|\d+\.)\s*)\[([ xX])\]/;

    if (!taskBoxRegex.test(lineText)) {
      // Check adjacent lines +/- 2 in case of line shifts
      for (const offset of [-1, 1, -2, 2]) {
        const candidate = line + offset;
        if (candidate >= 0 && candidate < doc.lineCount) {
          const candText = doc.lineAt(candidate).text;
          if (taskBoxRegex.test(candText)) {
            targetLine = candidate;
            lineText = candText;
            break;
          }
        }
      }
    }

    const match = lineText.match(taskBoxRegex);
    if (!match) return;

    const currentBox = match[2];
    const isCurrentlyChecked = currentBox.toLowerCase() === 'x';
    if (isCurrentlyChecked === checked) return;

    const newBox = checked ? '[x]' : '[ ]';
    const matchPrefix = match[1];
    const startChar = matchPrefix.length;
    const endChar = startChar + 3; // length of "[ ]"

    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(targetLine, startChar, targetLine, endChar);
    edit.replace(doc.uri, range, newBox);
    await vscode.workspace.applyEdit(edit);
  }

  private async copyImageUrlToClipboard(imageUrl: string): Promise<void> {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await this.writeBufferToClipboard(buffer);
      vscode.window.setStatusBarMessage('$(check) Diagram PNG copied to clipboard!', 2500);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to copy image to clipboard: ${err}`);
    }
  }

  private async saveImageUrlFile(imageUrl: string, defaultName: string = 'diagram.png'): Promise<void> {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(this._document.uri);
      const defaultUri = vscode.Uri.joinPath(
        workspaceFolder?.uri || vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file('/tmp'),
        defaultName
      );

      const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: {
          Images: ['png']
        }
      });

      if (targetUri) {
        await vscode.workspace.fs.writeFile(targetUri, buffer);
        vscode.window.showInformationMessage(`Saved diagram to ${targetUri.fsPath}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save image: ${err}`);
    }
  }

  private async copyImageToClipboard(dataUrl: string): Promise<void> {
    try {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      await this.writeBufferToClipboard(buffer);
      vscode.window.setStatusBarMessage('$(check) Diagram PNG copied to clipboard!', 2500);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to copy image to clipboard: ${err}`);
    }
  }

  private async writeBufferToClipboard(buffer: Buffer): Promise<void> {
    if (process.platform === 'darwin') {
      const tempPath = path.join(os.tmpdir(), `antigravity-diagram-${Date.now()}.png`);
      await fs.promises.writeFile(tempPath, buffer);
      try {
        cp.execSync(`osascript -e 'set the clipboard to (read (POSIX file "${tempPath}") as «class PNGf»)'`);
      } finally {
        fs.promises.unlink(tempPath).catch(() => {});
      }
    } else if (process.platform === 'win32') {
      const tempPath = path.join(os.tmpdir(), `antigravity-diagram-${Date.now()}.png`);
      await fs.promises.writeFile(tempPath, buffer);
      try {
        cp.execSync(`powershell -Command "Set-Clipboard -Path '${tempPath}'"`);
      } finally {
        fs.promises.unlink(tempPath).catch(() => {});
      }
    } else {
      try {
        const child = cp.spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png']);
        child.stdin.write(buffer);
        child.stdin.end();
      } catch (_) {}
    }
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
