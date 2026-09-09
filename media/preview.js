(function () {
  const vscode = acquireVsCodeApi();

  // State
  let currentZoom = 1.0;
  let isSyncEnabled = true;
  let isTocOpen = true;

  // DOM Elements
  const markdownRoot = document.getElementById('markdownRoot');
  const previewContentArea = document.getElementById('previewContentArea');
  const tocContainer = document.getElementById('tocContainer');
  const tocDrawer = document.getElementById('tocDrawer');
  const docTitleEl = document.getElementById('docTitle');
  const docStatsEl = document.getElementById('docStats');
  const zoomLevelEl = document.getElementById('zoomLevel');

  const btnToggleToc = document.getElementById('btnToggleToc');
  const btnCloseToc = document.getElementById('btnCloseToc');
  const btnToggleSync = document.getElementById('btnToggleSync');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomReset = document.getElementById('btnZoomReset');
  const btnExportHtml = document.getElementById('btnExportHtml');
  const btnPrint = document.getElementById('btnPrint');

  // Initialize Mermaid if available
  function initMermaid() {
    if (window.mermaid) {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          themeVariables: {
            darkMode: true,
            background: '#161b22',
            primaryColor: '#38bdf8',
            primaryTextColor: '#e6edf3',
            primaryBorderColor: '#30363d',
            lineColor: '#58a6ff',
            secondaryColor: '#a855f7',
            tertiaryColor: '#10b981'
          },
          securityLevel: 'loose'
        });

        // Run rendering on all unrendered mermaid divs
        const mermaidElements = document.querySelectorAll('.mermaid:not([data-processed="true"])');
        if (mermaidElements.length > 0) {
          window.mermaid.run({
            nodes: mermaidElements
          });
        }
      } catch (err) {
        console.error('Mermaid render error:', err);
      }
    }
  }

  // Setup TOC DOM
  function renderToc(headings) {
    if (!tocContainer) return;
    if (!headings || headings.length === 0) {
      tocContainer.innerHTML = '<p class="toc-empty" style="color:var(--ag-muted);font-size:12px;padding:8px;">No headings in document.</p>';
      return;
    }

    const ul = document.createElement('ul');
    headings.forEach((h) => {
      const li = document.createElement('li');
      li.className = `toc-item-${Math.min(4, h.level)}`;

      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.text;
      a.dataset.targetId = h.id;

      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById(h.id);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });

      li.appendChild(a);
      ul.appendChild(li);
    });

    tocContainer.innerHTML = '';
    tocContainer.appendChild(ul);
  }

  // Attach button event listeners inside rendered markdown
  function bindMarkdownInteractions() {
    // 1. Copy Code Buttons
    document.querySelectorAll('.copy-code-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-code');
        if (raw) {
          const code = decodeURIComponent(raw);
          vscode.postMessage({ command: 'copyText', text: code });

          const textSpan = btn.querySelector('.copy-text');
          const originalText = textSpan ? textSpan.textContent : 'Copy';
          if (textSpan) textSpan.textContent = 'Copied!';
          btn.classList.add('copied');

          setTimeout(() => {
            if (textSpan) textSpan.textContent = originalText;
            btn.classList.remove('copied');
          }, 2000);
        }
      });
    });

    // 2. Copy Diagram Definition
    document.querySelectorAll('.copy-diagram-code-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-code');
        if (raw) {
          const code = decodeURIComponent(raw);
          vscode.postMessage({ command: 'copyText', text: code });

          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = orig;
          }, 2000);
        }
      });
    });

    // 3. Save SVG Button for Mermaid
    document.querySelectorAll('.export-svg-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        const container = document.getElementById(targetId);
        if (container) {
          const svg = container.querySelector('svg');
          if (svg) {
            const svgData = new XMLSerializer().serializeToString(svg);
            const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${targetId}.svg`;
            a.click();
            URL.revokeObjectURL(url);
          }
        }
      });
    });

    // 4. Copy Table as TSV/Markdown
    document.querySelectorAll('.copy-table-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const wrapperId = btn.getAttribute('data-target');
        const wrapper = document.getElementById(wrapperId);
        if (wrapper) {
          const table = wrapper.querySelector('table');
          if (table) {
            const rows = Array.from(table.querySelectorAll('tr'));
            const lines = rows.map((tr) => {
              const cells = Array.from(tr.querySelectorAll('th, td'));
              return cells.map((td) => td.innerText.trim()).join('\t');
            });
            const tsv = lines.join('\n');
            vscode.postMessage({ command: 'copyText', text: tsv });

            const span = btn.querySelector('span');
            if (span) span.textContent = 'Copied TSV!';
            setTimeout(() => {
              if (span) span.textContent = 'Copy';
            }, 2000);
          }
        }
      });
    });
  }

  // Active heading tracking in TOC on scroll
  function setupScrollSpy() {
    if (!previewContentArea) return;

    previewContentArea.addEventListener('scroll', () => {
      const headings = document.querySelectorAll('.antigravity-heading');
      if (headings.length === 0) return;

      const containerTop = previewContentArea.scrollTop;
      let currentActiveId = '';

      headings.forEach((heading) => {
        const top = heading.offsetTop - 80;
        if (containerTop >= top) {
          currentActiveId = heading.id;
        }
      });

      if (currentActiveId && tocContainer) {
        tocContainer.querySelectorAll('a').forEach((a) => {
          if (a.dataset.targetId === currentActiveId) {
            a.classList.add('active');
          } else {
            a.classList.remove('active');
          }
        });
      }
    });
  }

  // Handle Zoom
  function updateZoom(newZoom) {
    currentZoom = Math.min(1.8, Math.max(0.6, newZoom));
    if (markdownRoot) {
      markdownRoot.style.transform = `scale(${currentZoom})`;
    }
    if (zoomLevelEl) {
      zoomLevelEl.textContent = `${Math.round(currentZoom * 100)}%`;
    }
  }

  // Message Handler from Extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      case 'update':
        if (markdownRoot) {
          markdownRoot.innerHTML = message.html;
        }
        if (docTitleEl && message.title) {
          docTitleEl.textContent = message.title;
        }
        if (docStatsEl && message.stats) {
          docStatsEl.textContent = message.stats;
        }
        renderToc(message.headings);
        bindMarkdownInteractions();
        initMermaid();
        break;

      case 'syncScroll':
        if (isSyncEnabled && previewContentArea && typeof message.percentage === 'number') {
          const maxScroll = previewContentArea.scrollHeight - previewContentArea.clientHeight;
          if (maxScroll > 0) {
            previewContentArea.scrollTop = message.percentage * maxScroll;
          }
        }
        break;
    }
  });

  // UI Event Listeners
  btnToggleToc?.addEventListener('click', () => {
    isTocOpen = !isTocOpen;
    tocDrawer?.classList.toggle('closed', !isTocOpen);
    btnToggleToc.classList.toggle('active-state', isTocOpen);
  });

  btnCloseToc?.addEventListener('click', () => {
    isTocOpen = false;
    tocDrawer?.classList.add('closed');
    btnToggleToc?.classList.remove('active-state');
  });

  btnToggleSync?.addEventListener('click', () => {
    isSyncEnabled = !isSyncEnabled;
    btnToggleSync.classList.toggle('active-state', isSyncEnabled);
  });

  btnZoomIn?.addEventListener('click', () => updateZoom(currentZoom + 0.1));
  btnZoomOut?.addEventListener('click', () => updateZoom(currentZoom - 0.1));
  btnZoomReset?.addEventListener('click', () => updateZoom(1.0));

  btnExportHtml?.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportHtml' });
  });

  btnPrint?.addEventListener('click', () => {
    window.print();
  });

  // Initialize
  setupScrollSpy();
})();
