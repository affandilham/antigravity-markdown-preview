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
  private _extraResourceRoots = new Set<string>();

  private _updateLocalResourceRoots(): void {
    this._panel.webview.options = {
      enableScripts: true,
      localResourceRoots: MarkdownPreviewPanel.getLocalResourceRoots(this._extensionUri, this._document, this._extraResourceRoots)
    };
  }

  public get documentUri(): vscode.Uri {
    return this._document.uri;
  }

  public static getLocalResourceRoots(extensionUri: vscode.Uri, document?: vscode.TextDocument, extraDirs: Iterable<string> = []): vscode.Uri[] {
    const roots: vscode.Uri[] = [
      vscode.Uri.joinPath(extensionUri, 'media'),
      vscode.Uri.joinPath(extensionUri, 'dist')
    ];

    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        roots.push(folder.uri);
      }
    }

    if (document && document.uri.scheme === 'file') {
      const docFolder = path.dirname(document.fileName);
      roots.push(vscode.Uri.file(docFolder));
      const parentFolder = path.resolve(docFolder, '..');
      roots.push(vscode.Uri.file(parentFolder));
      const docWs = vscode.workspace.getWorkspaceFolder(document.uri);
      if (docWs) {
        roots.push(docWs.uri);
      }
    }

    for (const extraDir of extraDirs) {
      roots.push(vscode.Uri.file(extraDir));
    }

    const seen = new Set<string>();
    const uniqueRoots: vscode.Uri[] = [];
    for (const r of roots) {
      const key = r.toString();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRoots.push(r);
      }
    }

    return uniqueRoots;
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
        localResourceRoots: MarkdownPreviewPanel.getLocalResourceRoots(extensionUri, document)
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
          case 'print':
            await this.printDocument(message.html);
            break;
          case 'copyPng':
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
    this._updateLocalResourceRoots();
    this.refresh();
  }

  public refresh(): void {
    this._updateLocalResourceRoots();
    const text = this._document.getText();
    const { html, headings } = this._markdownEngine.render(text);
    const resolvedHtml = this._resolveImageUrls(html);
    const title = getFileName(this._document.fileName);

    this._panel.webview.html = this._getHtmlForWebview(resolvedHtml, headings, title);
  }

  public updateContent(): void {
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
    }
    this._updateTimeout = setTimeout(() => {
      const text = this._document.getText();
      const { html, headings } = this._markdownEngine.render(text);
      const resolvedHtml = this._resolveImageUrls(html);

      this._panel.webview.postMessage({
        command: 'update',
        html: resolvedHtml,
        headings,
        title: getFileName(this._document.fileName)
      });
    }, 40);
  }

  private _resolveImageUrls(html: string): string {
    if (!this._document || this._document.uri.scheme !== 'file') {
      return html;
    }

    const docDir = path.dirname(this._document.fileName);
    const wsFolder = vscode.workspace.getWorkspaceFolder(this._document.uri);
    const wsDir = wsFolder ? wsFolder.uri.fsPath : undefined;
    let addedExtraRoot = false;

    const resolveSrc = (rawSrc: string): string => {
      if (!rawSrc) return rawSrc;

      if (
        rawSrc.startsWith('http://') ||
        rawSrc.startsWith('https://') ||
        rawSrc.startsWith('data:') ||
        rawSrc.startsWith('blob:') ||
        rawSrc.startsWith('vscode-webview:') ||
        rawSrc.startsWith('vscode-resource:') ||
        rawSrc.startsWith('#') ||
        rawSrc.startsWith('mailto:')
      ) {
        return rawSrc;
      }

      try {
        let cleanSrc = rawSrc;
        let query = '';
        let fragment = '';

        const hashIndex = cleanSrc.indexOf('#');
        if (hashIndex !== -1) {
          fragment = cleanSrc.slice(hashIndex + 1);
          cleanSrc = cleanSrc.slice(0, hashIndex);
        }

        const queryIndex = cleanSrc.indexOf('?');
        if (queryIndex !== -1) {
          query = cleanSrc.slice(queryIndex + 1);
          cleanSrc = cleanSrc.slice(0, queryIndex);
        }

        try {
          cleanSrc = decodeURIComponent(cleanSrc);
        } catch {}

        let fileUri: vscode.Uri;
        let resolvedPath: string;

        if (cleanSrc.startsWith('file://')) {
          fileUri = vscode.Uri.parse(cleanSrc);
          resolvedPath = fileUri.fsPath;
        } else if (path.isAbsolute(cleanSrc)) {
          if (fs.existsSync(cleanSrc)) {
            resolvedPath = cleanSrc;
          } else if (wsDir) {
            const relFromWs = path.join(wsDir, cleanSrc.replace(/^[\/\\]+/, ''));
            if (fs.existsSync(relFromWs)) {
              resolvedPath = relFromWs;
            } else {
              resolvedPath = cleanSrc;
            }
          } else {
            resolvedPath = cleanSrc;
          }
          fileUri = vscode.Uri.file(resolvedPath);
        } else {
          // Relative path: check relative to document directory first
          const absFromDoc = path.resolve(docDir, cleanSrc);
          if (fs.existsSync(absFromDoc)) {
            resolvedPath = absFromDoc;
          } else if (wsDir) {
            // Fallback: check relative to workspace directory
            const absFromWs = path.resolve(wsDir, cleanSrc);
            if (fs.existsSync(absFromWs)) {
              resolvedPath = absFromWs;
            } else {
              resolvedPath = absFromDoc;
            }
          } else {
            resolvedPath = absFromDoc;
          }
          fileUri = vscode.Uri.file(resolvedPath);
        }

        const dir = path.dirname(resolvedPath);
        if (!this._extraResourceRoots.has(dir)) {
          this._extraResourceRoots.add(dir);
          addedExtraRoot = true;
        }

        if (query || fragment) {
          fileUri = fileUri.with({ query: query || undefined, fragment: fragment || undefined });
        }

        return this._panel.webview.asWebviewUri(fileUri).toString();
      } catch {
        return rawSrc;
      }
    };

    let resolved = html.replace(
      /(<(?:img|video|audio|source)[^>]*?src=)(?:(["'])([^"']+)|([^\s>]+))/gi,
      (match, prefix, quote, src1, src2) => {
        const src = src1 || src2;
        const q = quote || '"';
        return `${prefix}${q}${resolveSrc(src)}${q}`;
      }
    );

    resolved = resolved.replace(
      /(<(?:source|img)[^>]*?srcset=)(?:(["'])([^"']+))/gi,
      (match, prefix, quote, srcset) => {
        const newSrcset = srcset
          .split(',')
          .map((item: string) => {
            const trimmed = item.trim();
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx === -1) {
              return resolveSrc(trimmed);
            }
            const url = trimmed.slice(0, spaceIdx);
            const descriptor = trimmed.slice(spaceIdx);
            return `${resolveSrc(url)}${descriptor}`;
          })
          .join(', ');
        return `${prefix}${quote}${newSrcset}${quote}`;
      }
    );

    if (addedExtraRoot) {
      this._updateLocalResourceRoots();
    }

    return resolved;
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
    }
    .code-tab-container { margin: 20px 0; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; background: var(--bg); }
    .code-tab-headers { display: flex; background: rgba(128,128,128,0.06); border-bottom: 1px solid var(--border); padding: 0 6px; }
    .code-tab-btn { padding: 8px 14px; font-size: 12.5px; font-weight: 500; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--fg); cursor: pointer; opacity: 0.7; }
    .code-tab-btn.active { border-bottom-color: var(--accent); color: var(--accent); opacity: 1; font-weight: 600; }
    .code-tab-panel { display: none; }
    .code-tab-panel.active { display: block; }
    .code-tab-panel > .antigravity-code-block { margin: 0 !important; border: none !important; }
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
<script>
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.code-tab-btn');
    if (!btn) return;
    var container = btn.closest('.code-tab-container');
    if (!container) return;
    var idx = btn.getAttribute('data-tab');
    container.querySelectorAll('.code-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    container.querySelectorAll('.code-tab-panel').forEach(function(p) { p.classList.remove('active'); });
    btn.classList.add('active');
    var target = container.querySelector('.code-tab-panel[data-tab="' + idx + '"]');
    if (target) target.classList.add('active');
  });
</script>
</body>
</html>`;

    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(fullHtml, 'utf8'));
    vscode.window.showInformationMessage(`Exported Markdown to ${targetUri.fsPath}`);
  }

  private async printDocument(renderedHtml?: string): Promise<void> {
    const rawTitle = getFileName(this._document.fileName);
    const title = rawTitle.replace(/\.md$/i, "");
    const content = renderedHtml || this._markdownEngine.render(this._document.getText()).html;

    const printHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Print - ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
  <style>
    :root {
      --bg: #ffffff;
      --fg: #1f2328;
      --border: #d0d7de;
      --accent: #0969da;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.65;
      color: #1f2328;
      background-color: #ffffff;
      max-width: 860px;
      margin: 0 auto;
      padding: 32px 24px;
    }
    h1, h2, h3, h4, h5, h6 {
      color: #1f2328;
      page-break-after: avoid;
      break-after: avoid;
    }
    h1 { font-size: 2em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; margin-bottom: 16px; }
    h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; margin-top: 28px; margin-bottom: 14px; }
    h3 { font-size: 1.25em; margin-top: 22px; margin-bottom: 12px; }
    p, ul, ol { margin: 12px 0; }
    table { width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 13.5px; page-break-inside: avoid; break-inside: avoid; }
    th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
    th { background: #f6f8fa; font-weight: 600; }
    blockquote { border-left: 4px solid #0969da; margin: 16px 0; padding: 6px 16px; color: #57606a; background: #f6f8fa; border-radius: 0 4px 4px 0; }
    pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 14px; overflow-x: auto; font-size: 13px; page-break-inside: avoid; break-inside: avoid; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 85%; }
    pre code { font-size: 13px; background: transparent; padding: 0; }
    img, svg { max-width: 100%; height: auto; page-break-inside: avoid; break-inside: avoid; }
    .diagram-wrapper, .mermaid-container, .plantuml-container { page-break-inside: avoid; break-inside: avoid; margin: 20px 0; text-align: center; }
    .diagram-actions, .copy-code-btn, .table-toolbar, .code-tab-headers, .preview-toolbar, .search-overlay { display: none !important; }
    .code-tab-panel { display: block !important; margin-bottom: 12px; }
    kbd {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.85em;
      font-weight: 600;
      padding: 2px 6px;
      background: #f6f8fa;
      border: 1px solid #d0d7de;
      border-bottom: 2px solid #afb8c1;
      border-radius: 4px;
    }
    mark.ag-search-match { background: transparent !important; color: inherit !important; box-shadow: none !important; }
    @media print {
      @page { margin: 15mm 15mm; size: auto; }
      body { padding: 0; max-width: 100%; font-size: 11pt; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
  <article class="markdown-body">
    ${content}
  </article>
  <script>
    window.addEventListener("load", function() {
      setTimeout(function() {
        window.print();
      }, 350);
    });
  </script>
</body>
</html>`;

    const tmpFile = path.join(os.tmpdir(), `antigravity-print-${Date.now()}.html`);
    await fs.promises.writeFile(tmpFile, printHtml, "utf8");

    if (process.platform === "darwin") {
      cp.exec(`open "${tmpFile}"`);
    } else if (process.platform === "win32") {
      cp.exec(`start "" "${tmpFile}"`);
    } else {
      cp.exec(`xdg-open "${tmpFile}"`);
    }

    vscode.window.setStatusBarMessage("$(check) Opening Print dialog in browser...", 3500);

    setTimeout(() => {
      try {
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {}
    }, 120000);
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
      <button class="toolbar-btn icon-only" id="btnOpenSearch" title="Find in preview (Cmd + F)" type="button">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
        </svg>
      </button>
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

  <!-- In-Page Floating Search Bar (Cmd + F) -->
  <div class="search-overlay search-hidden" id="searchOverlay" style="display: none;" aria-hidden="true">
    <div class="search-input-wrapper">
      <svg class="search-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
      </svg>
      <input type="text" id="searchInput" placeholder="Find in preview..." autocomplete="off" spellcheck="false" />
      <span class="search-matches-count" id="searchMatchesCount">0/0</span>
    </div>
    <div class="search-actions">
      <button class="search-btn" id="btnSearchPrev" title="Previous match (Shift + Enter / ↑)" type="button">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M8 12a.5.5 0 0 0 .5-.5V5.707l2.146 2.147a.5.5 0 0 0 .708-.708l-3-3a.5.5 0 0 0-.708 0l-3 3a.5.5 0 1 0 .708.708L7.5 5.707V11.5a.5.5 0 0 0 .5.5z"/>
        </svg>
      </button>
      <button class="search-btn" id="btnSearchNext" title="Next match (Enter / ↓)" type="button">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M8 4a.5.5 0 0 1 .5.5v5.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V4.5A.5.5 0 0 1 8 4z"/>
        </svg>
      </button>
      <button class="search-btn search-close-btn" id="btnSearchClose" title="Close (Esc)" type="button">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
          <path d="M2.146 2.854a.5.5 0 1 1 .708-.708L8 7.293l5.146-5.147a.5.5 0 0 1 .708.708L8.707 8l5.147 5.146a.5.5 0 0 1-.708.708L8 8.707l-5.146 5.147a.5.5 0 0 1-.708-.708L7.293 8 2.146 2.854Z"/>
        </svg>
      </button>
    </div>
  </div>

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
        <div class="diagram-modal-info-wrapper">
          <button class="modal-control-btn icon-only" id="btnModalInfo" title="Gestures & Shortcuts" type="button">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </button>
          <div class="diagram-modal-info-tooltip" id="modalInfoTooltip">
            <div class="tooltip-title">Gestures & Shortcuts</div>
            <div class="tooltip-grid">
              <div class="tooltip-row"><span>Pan / Geser</span><kbd>V</kbd> or <kbd>Space</kbd> + Drag</div>
              <div class="tooltip-row"><span>Pen / Coret</span><kbd>P</kbd></div>
              <div class="tooltip-row"><span>Undo</span><kbd>Cmd+Z</kbd></div>
              <div class="tooltip-row"><span>Redo</span><kbd>Cmd+Shift+Z</kbd></div>
              <div class="tooltip-row"><span>Zoom</span><kbd>+</kbd> / <kbd>-</kbd> / Pinch</div>
              <div class="tooltip-row"><span>Fit View</span><kbd>F</kbd></div>
              <div class="tooltip-row"><span>Close</span><kbd>Esc</kbd></div>
            </div>
          </div>
        </div>
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
      <canvas class="diagram-draw-canvas" id="diagramDrawCanvas"></canvas>
    </div>
    <!-- Floating Annotation Dock (Desktop Pro Grade) -->
    <div class="diagram-modal-dock" id="diagramModalDock" role="toolbar" aria-label="Diagram Annotation Toolbar">
      <!-- 1. Drag Handle -->
      <div class="dock-drag-handle" id="dockDragHandle" title="Drag to Reposition Toolbar" role="button" tabindex="0" aria-label="Drag toolbar">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="5" cy="3" r="1.5"/>
          <circle cx="11" cy="3" r="1.5"/>
          <circle cx="5" cy="8" r="1.5"/>
          <circle cx="11" cy="8" r="1.5"/>
          <circle cx="5" cy="13" r="1.5"/>
          <circle cx="11" cy="13" r="1.5"/>
        </svg>
      </div>

      <!-- 2. Pan Tool -->
      <button class="dock-btn active" id="btnToolPan" title="Pan / Geser Canvas (V / Space)" type="button" aria-label="Pan tool">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/>
          <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/>
          <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/>
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
        </svg>
        <span>Pan</span>
      </button>

      <div class="dock-divider" id="dockDividerCore"></div>

      <!-- 3. Draw Tool with Popover -->
      <div class="dock-tool-wrapper" id="dockToolDrawWrapper">
        <button class="dock-btn" id="btnToolDraw" title="Draw Pen (P)" type="button" aria-label="Draw tool" aria-haspopup="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m18 2 4 4-14 14H4v-4L18 2z"/>
          </svg>
          <span>Draw</span>
          <svg class="dock-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
          </svg>
        </button>
      </div>

      <!-- 4. Erase Tool with Popover -->
      <div class="dock-tool-wrapper" id="dockToolEraseWrapper">
        <button class="dock-btn" id="btnToolErase" title="Eraser (E)" type="button" aria-label="Eraser tool" aria-haspopup="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>
            <path d="M22 21H7"/>
            <path d="m5 11 9 9"/>
          </svg>
          <span>Erase</span>
          <svg class="dock-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
          </svg>
        </button>
      </div>

      <div class="dock-divider" id="dockDividerShapes"></div>

      <!-- 6. Shape Tool with Popover -->
      <div class="dock-tool-wrapper" id="dockToolShapeWrapper">
        <button class="dock-btn" id="btnToolShape" title="Shapes (S)" type="button" aria-label="Shape tool" aria-haspopup="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2"/>
          </svg>
          <span>Shape</span>
          <svg class="dock-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
          </svg>
        </button>
      </div>

      <!-- 7. Arrow Tool -->
      <button class="dock-btn" id="btnToolArrow" title="Arrow (A)" type="button" aria-label="Arrow tool">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 17 17 7"/>
          <path d="M7 7h10v10"/>
        </svg>
        <span>Arrow</span>
      </button>

      <!-- 8. Text Tool -->
      <div class="dock-tool-wrapper" id="dockToolTextWrapper">
        <button class="dock-btn" id="btnToolText" title="Text (T)" type="button" aria-label="Text tool" aria-haspopup="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 7 4 4 20 4 20 7"/>
            <line x1="9" x2="15" y1="20" y2="20"/>
            <line x1="12" x2="12" y1="4" y2="20"/>
          </svg>
          <span>Text</span>
        </button>
      </div>

      <div class="dock-divider" id="dockDividerColors"></div>

      <!-- 9. Color Shortcut & Dropdown Palette -->
      <div class="dock-colors-group" id="dockColorsGroup">
        <div class="dock-colors" id="dockColors">
          <button class="color-dot" data-color="#ea1c24" style="background:#ea1c24;" title="Red" type="button" aria-label="Red color"></button>
          <button class="color-dot" data-color="#1576fe" style="background:#1576fe;" title="Blue" type="button" aria-label="Blue color"></button>
          <button class="color-dot" data-color="#229b47" style="background:#229b47;" title="Green" type="button" aria-label="Green color"></button>
          <button class="color-dot active" data-color="#fb980c" style="background:#fb980c;" title="Orange" type="button" aria-label="Orange color"></button>
          <button class="color-dot" data-color="#8437ef" style="background:#8437ef;" title="Purple" type="button" aria-label="Purple color"></button>
        </div>
        <button class="color-chevron-btn" id="btnColorChevron" title="Full Color Palette & Custom Picker" type="button" aria-label="More colors">
          <svg width="12" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1.5 1.5L6 6L10.5 1.5"/>
          </svg>
        </button>
      </div>

      <div class="dock-divider" id="dockDividerActions"></div>

      <!-- 10. History & Delete -->
      <div class="dock-actions" id="dockActionsGroup">
        <button class="dock-btn icon-only" id="btnDrawUndo" title="Undo (Cmd+Z / Ctrl+Z)" type="button" aria-label="Undo" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7v6h6"/>
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
          </svg>
        </button>
        <button class="dock-btn icon-only" id="btnDrawRedo" title="Redo (Cmd+Shift+Z / Ctrl+Y)" type="button" aria-label="Redo" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 7v6h-6"/>
            <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
          </svg>
        </button>
        <button class="dock-btn icon-only" id="btnDrawDelete" title="Delete Selected Object (Backspace / Del)" type="button" aria-label="Delete selected" disabled>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/>
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            <line x1="10" x2="10" y1="11" y2="17"/>
            <line x1="14" x2="14" y1="11" y2="17"/>
          </svg>
        </button>
      </div>

      <div class="dock-divider" id="dockDividerExport"></div>

      <!-- 11. Copy PNG -->
      <button class="dock-btn dock-btn-primary" id="btnDrawExportPng" title="Copy Diagram with Annotations as PNG" type="button" aria-label="Copy image as PNG">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
        </svg>
        <span id="btnCopyPngLabel">Copy PNG</span>
      </button>

      <!-- 12. Dynamic More Button & Divider -->
      <div class="dock-divider" id="dockDividerMore" style="display:none;"></div>
      <button class="dock-btn dock-btn-more icon-only" id="btnDockMore" title="More tools" type="button" aria-label="More tools" aria-haspopup="true" style="display:none;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="5" cy="12" r="2"/>
          <circle cx="12" cy="12" r="2"/>
          <circle cx="19" cy="12" r="2"/>
        </svg>
        <span class="dock-more-dot" id="dockMoreDot" style="display:none;"></span>
      </button>
    </div>

    <!-- Popover 1: Draw Settings -->
    <div class="dock-popover" id="popoverDraw" aria-label="Draw settings" style="display:none;">
      <div class="popover-arrow" id="popoverDrawArrow"></div>
      <div class="popover-section">
        <div class="popover-row-header">
          <span class="popover-label">Stroke size</span>
          <div class="popover-number-wrap">
            <input type="number" id="drawStrokeNumber" min="1" max="50" value="5" />
            <span class="unit">px</span>
          </div>
        </div>
        <div class="popover-slider-row">
          <span class="range-bound">1</span>
          <input type="range" id="drawStrokeSlider" min="1" max="50" value="5" />
          <span class="range-bound">50</span>
        </div>
      </div>

      <div class="popover-section">
        <div class="popover-row-header">
          <span class="popover-label">Opacity</span>
          <div class="popover-number-wrap">
            <input type="number" id="drawOpacityNumber" min="5" max="100" step="5" value="100" />
            <span class="unit">%</span>
          </div>
        </div>
        <div class="popover-slider-row">
          <span class="range-bound">5%</span>
          <input type="range" id="drawOpacitySlider" min="5" max="100" step="5" value="100" />
          <span class="range-bound">100%</span>
        </div>
      </div>

      <div class="popover-divider"></div>

      <div class="popover-section">
        <div class="popover-label">Recent colors</div>
        <div class="popover-colors-row" id="drawRecentColors"></div>
      </div>

      <div class="popover-section">
        <div class="popover-label">More colors</div>
        <div class="popover-palette-grid" id="drawMoreColors"></div>
      </div>
    </div>

    <!-- Popover 1b: Erase Settings -->
    <div class="dock-popover" id="popoverErase" aria-label="Erase settings" style="display:none;">
      <div class="popover-arrow" id="popoverEraseArrow"></div>
      <div class="popover-section">
        <div class="popover-row-header">
          <span class="popover-label">Eraser size</span>
          <div class="popover-number-wrap">
            <input type="number" id="eraseSizeNumber" min="4" max="100" value="20" />
            <span class="unit">px</span>
          </div>
        </div>
        <div class="popover-slider-row">
          <span class="range-bound">4</span>
          <input type="range" id="eraseSizeSlider" min="4" max="100" value="20" />
          <span class="range-bound">100</span>
        </div>
      </div>
    </div>

    <!-- Popover 2: Shapes -->
    <div class="dock-popover" id="popoverShapes" aria-label="Shapes" style="display:none;">
      <div class="popover-arrow" id="popoverShapesArrow"></div>
      <div class="popover-section">
        <div class="popover-title">Shapes</div>
        <div class="shapes-grid">
          <button class="shape-card active" data-shape="rect" type="button" aria-label="Rectangle shape">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/></svg>
            <span>Rectangle</span>
          </button>
          <button class="shape-card" data-shape="circle" type="button" aria-label="Circle shape">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>
            <span>Circle</span>
          </button>
          <button class="shape-card" data-shape="ellipse" type="button" aria-label="Ellipse shape">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="10" ry="6"/></svg>
            <span>Ellipse</span>
          </button>
          <button class="shape-card" data-shape="line" type="button" aria-label="Line shape">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="20" x2="20" y2="4"/></svg>
            <span>Line</span>
          </button>
          <button class="shape-card" data-shape="roundrect" type="button" aria-label="Rounded rectangle shape">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/></svg>
            <span>Rounded Rect</span>
          </button>
          <button class="shape-card" data-shape="freeform" type="button" aria-label="Freeform shape">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 15c4-6 6-6 9 0s5 6 9 0"/></svg>
            <span>Freeform</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Popover 3: Text Settings -->
    <div class="dock-popover" id="popoverText" aria-label="Text settings" style="display:none;">
      <div class="popover-arrow" id="popoverTextArrow"></div>
      <div class="popover-section">
        <div class="popover-row-header">
          <span class="popover-label">Font size</span>
          <div class="popover-number-wrap">
            <input type="number" id="textFontNumber" min="8" max="72" value="16" />
            <span class="unit">px</span>
          </div>
        </div>
        <div class="popover-slider-row">
          <span class="range-bound">8</span>
          <input type="range" id="textFontSlider" min="8" max="72" value="16" />
          <span class="range-bound">72</span>
        </div>
      </div>

      <div class="popover-divider"></div>

      <div class="popover-section">
        <div class="popover-label">Text color</div>
        <div class="popover-colors-row" id="textColorsRow"></div>
      </div>

      <div class="popover-divider"></div>

      <div class="popover-section">
        <div class="popover-label">Font style</div>
        <div class="font-style-row">
          <button class="style-toggle-btn" id="btnFontBold" type="button" title="Bold" aria-label="Bold text">
            <span class="style-icon-b">B</span>
            <small>Bold</small>
          </button>
          <button class="style-toggle-btn" id="btnFontItalic" type="button" title="Italic" aria-label="Italic text">
            <span class="style-icon-i">I</span>
            <small>Italic</small>
          </button>
          <button class="style-toggle-btn" id="btnFontUnderline" type="button" title="Underline" aria-label="Underline text">
            <span class="style-icon-u">U</span>
            <small>Underline</small>
          </button>
        </div>
      </div>
    </div>

    <!-- Popover 4: Custom Color Picker -->
    <div class="dock-popover" id="popoverCustomColor" aria-label="Custom color picker" style="display:none;">
      <div class="popover-arrow" id="popoverCustomColorArrow"></div>
      <div class="popover-section">
        <div class="popover-title">Custom Color</div>
        <div class="color-picker-sat-val" id="colorPickerSatVal">
          <div class="color-picker-sat-white"></div>
          <div class="color-picker-val-black"></div>
          <div class="color-picker-handle" id="colorPickerHandle"></div>
        </div>
        <div class="color-picker-hue-bar" id="colorPickerHueBar">
          <div class="color-picker-hue-thumb" id="colorPickerHueThumb"></div>
        </div>
        <div class="color-picker-hex-row">
          <div class="color-picker-preview-dot" id="colorPickerPreview"></div>
          <div class="color-picker-hex-input-wrap">
            <span class="hex-hash">#</span>
            <input type="text" id="colorPickerHexInput" maxlength="6" value="F59E0B" spellcheck="false" />
          </div>
        </div>
      </div>
    </div>

    <!-- Popover 5: More Tools & Actions (Dynamic Overflow) -->
    <div class="dock-popover popover-more" id="popoverMore" aria-label="More tools" style="display:none;">
      <div class="popover-arrow" id="popoverMoreArrow"></div>
      <div class="popover-more-content" id="popoverMoreContent">
        <!-- Group 1: Creation Tools -->
        <div class="more-group" id="moreGroupTools" style="display:none;">
          <button class="more-menu-item" id="moreItemShape" type="button" aria-label="Shape" style="display:none;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
            <span class="more-item-label">Shape</span>
            <span class="more-item-badge" id="moreBadgeShape" style="display:none;">●</span>
          </button>
          <button class="more-menu-item" id="moreItemArrow" type="button" aria-label="Arrow" style="display:none;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>
            <span class="more-item-label">Arrow</span>
            <span class="more-item-badge" id="moreBadgeArrow" style="display:none;">●</span>
          </button>
          <button class="more-menu-item" id="moreItemText" type="button" aria-label="Text" style="display:none;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>
            <span class="more-item-label">Text</span>
            <span class="more-item-badge" id="moreBadgeText" style="display:none;">●</span>
          </button>
        </div>

        <div class="popover-divider" id="moreSepToolsColor" style="display:none;"></div>

        <!-- Group 2: Color Swatches Row (Matching Reference) -->
        <div class="more-group more-group-colors" id="moreGroupColor" style="display:none;">
          <div class="more-colors-row" id="moreColorsRow">
            <button class="color-dot" data-color="#ea1c24" style="background:#ea1c24;" title="Red" type="button" aria-label="Red"></button>
            <button class="color-dot" data-color="#1576fe" style="background:#1576fe;" title="Blue" type="button" aria-label="Blue"></button>
            <button class="color-dot" data-color="#229b47" style="background:#229b47;" title="Green" type="button" aria-label="Green"></button>
            <button class="color-dot active" data-color="#fb980c" style="background:#fb980c;" title="Orange" type="button" aria-label="Orange"></button>
            <button class="color-dot" data-color="#8437ef" style="background:#8437ef;" title="Purple" type="button" aria-label="Purple"></button>
            <button class="color-chevron-btn" id="btnMoreColorChevron" title="Full Color Palette & Custom Picker" type="button" aria-label="More colors">
              <svg width="12" height="8" viewBox="0 0 12 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1.5 1.5L6 6L10.5 1.5"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="popover-divider" id="moreSepColorActions" style="display:none;"></div>

        <!-- Group 3: History & Delete -->
        <div class="more-group" id="moreGroupActions" style="display:none;">
          <button class="more-menu-item" id="moreItemUndo" type="button" aria-label="Undo" disabled style="display:none;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
            <span class="more-item-label">Undo</span>
          </button>
          <button class="more-menu-item" id="moreItemRedo" type="button" aria-label="Redo" disabled style="display:none;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
            <span class="more-item-label">Redo</span>
          </button>
          <button class="more-menu-item" id="moreItemDelete" type="button" aria-label="Delete" disabled style="display:none;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
            <span class="more-item-label">Delete</span>
          </button>
        </div>

        <div class="popover-divider" id="moreSepActionsExport" style="display:none;"></div>

        <!-- Group 4: Copy PNG Primary Action -->
        <div class="more-group" id="moreGroupExport" style="display:none; padding: 2px 2px 0 2px;">
          <button class="dock-btn dock-btn-primary" id="moreItemExportPng" type="button" style="width: 100%; justify-content: center; height: 34px;" aria-label="Copy PNG">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
            <span id="moreCopyPngLabel">Copy PNG</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Inline Text Editor for Canvas -->
    <textarea class="canvas-inline-text-editor" id="canvasInlineTextEditor" style="display:none;" placeholder="Type here..."></textarea>

  </div>

  <script nonce="${nonce}" src="${mermaidUri}" defer></script>
  <script nonce="${nonce}" src="${jsUri}" defer></script>
<script>
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.code-tab-btn');
    if (!btn) return;
    var container = btn.closest('.code-tab-container');
    if (!container) return;
    var idx = btn.getAttribute('data-tab');
    container.querySelectorAll('.code-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    container.querySelectorAll('.code-tab-panel').forEach(function(p) { p.classList.remove('active'); });
    btn.classList.add('active');
    var target = container.querySelector('.code-tab-panel[data-tab="' + idx + '"]');
    if (target) target.classList.add('active');
  });
</script>
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
