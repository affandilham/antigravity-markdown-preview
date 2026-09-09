(function () {
  const vscode = acquireVsCodeApi();

  let isSyncEnabled = true;
  let isTocOpen = false;
  let mermaidInitialized = false;

  const markdownRoot = document.getElementById('markdownRoot');
  const previewContentArea = document.getElementById('previewContentArea');
  const tocContainer = document.getElementById('tocContainer');
  const tocDrawer = document.getElementById('tocDrawer');
  const docTitleEl = document.getElementById('docTitle');
  const docStatsEl = document.getElementById('docStats');

  const btnToggleToc = document.getElementById('btnToggleToc');
  const btnCloseToc = document.getElementById('btnCloseToc');
  const btnToggleSync = document.getElementById('btnToggleSync');
  const btnExportHtml = document.getElementById('btnExportHtml');
  const btnPrint = document.getElementById('btnPrint');

  function isDarkMode() {
    return document.body.classList.contains('vscode-dark') || 
           (!document.body.classList.contains('vscode-light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // Mermaid render with safety and theme adaptation
  function renderMermaidDiagrams() {
    const mermaidNodes = document.querySelectorAll('.mermaid:not([data-processed="true"])');
    if (!mermaidNodes || mermaidNodes.length === 0) return;

    if (!window.mermaid) {
      console.warn('Mermaid library not loaded yet');
      return;
    }

    const dark = isDarkMode();

    try {
      if (!mermaidInitialized) {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          themeVariables: dark ? {
            darkMode: true,
            background: '#161b22',
            primaryColor: '#2f81f7',
            primaryTextColor: '#c9d1d9',
            primaryBorderColor: '#30363d',
            lineColor: '#8b949e',
            secondaryColor: '#21262d',
            tertiaryColor: '#161b22'
          } : {
            darkMode: false,
            background: '#ffffff',
            primaryColor: '#0969da',
            primaryTextColor: '#1f2328',
            primaryBorderColor: '#d0d7de',
            lineColor: '#57606a',
            secondaryColor: '#f6f8fa',
            tertiaryColor: '#ffffff'
          },
          securityLevel: 'loose'
        });
        mermaidInitialized = true;
      }

      window.mermaid.run({
        nodes: Array.from(mermaidNodes)
      }).catch((err) => {
        console.error('Mermaid async render error:', err);
      });
    } catch (err) {
      console.error('Mermaid render error:', err);
    }
  }

  // Render TOC
  function updateTocList(headings) {
    if (!tocContainer) return;
    if (!headings || headings.length === 0) {
      tocContainer.innerHTML = '<p class="toc-empty">No headings found.</p>';
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

  // Bind copy buttons and interactions
  function bindInteractions() {
    // 1. Copy code
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
          if (textSpan) textSpan.textContent = 'Copied';
          btn.classList.add('copied');

          setTimeout(() => {
            if (textSpan) textSpan.textContent = originalText;
            btn.classList.remove('copied');
          }, 1500);
        }
      });
    });

    // 2. Copy diagram code
    document.querySelectorAll('.copy-diagram-code-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-code');
        if (raw) {
          vscode.postMessage({ command: 'copyText', text: decodeURIComponent(raw) });
          const orig = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        }
      });
    });

    // 3. Save SVG for Mermaid
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

    // 4. Copy Table
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
            vscode.postMessage({ command: 'copyText', text: lines.join('\n') });
            const span = btn.querySelector('span');
            if (span) span.textContent = 'Copied';
            setTimeout(() => { if (span) span.textContent = 'Copy'; }, 1500);
          }
        }
      });
    });
  }

  // ScrollSpy for TOC
  let scrollSpyTimeout;
  function setupScrollSpy() {
    if (!previewContentArea) return;

    previewContentArea.addEventListener('scroll', () => {
      if (scrollSpyTimeout) return;
      scrollSpyTimeout = setTimeout(() => {
        scrollSpyTimeout = null;
        const headings = document.querySelectorAll('.antigravity-heading');
        if (headings.length === 0 || !tocContainer) return;

        const containerTop = previewContentArea.scrollTop;
        let activeId = '';

        headings.forEach((heading) => {
          if (containerTop >= heading.offsetTop - 60) {
            activeId = heading.id;
          }
        });

        if (activeId) {
          tocContainer.querySelectorAll('a').forEach((a) => {
            if (a.dataset.targetId === activeId) {
              a.classList.add('active');
            } else {
              a.classList.remove('active');
            }
          });
        }
      }, 50);
    });
  }

  // Smooth throttled scroll from editor
  let targetScrollPercent = null;
  let isRafScheduled = false;

  function performScroll() {
    if (targetScrollPercent !== null && previewContentArea) {
      const maxScroll = previewContentArea.scrollHeight - previewContentArea.clientHeight;
      if (maxScroll > 0) {
        previewContentArea.scrollTop = targetScrollPercent * maxScroll;
      }
      targetScrollPercent = null;
    }
    isRafScheduled = false;
  }

  // Extension Messages Listener
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
        updateTocList(message.headings);
        bindInteractions();
        renderMermaidDiagrams();
        break;

      case 'syncScroll':
        if (isSyncEnabled && typeof message.percentage === 'number') {
          targetScrollPercent = message.percentage;
          if (!isRafScheduled) {
            isRafScheduled = true;
            requestAnimationFrame(performScroll);
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

  btnExportHtml?.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportHtml' });
  });

  btnPrint?.addEventListener('click', () => {
    window.print();
  });

  // Initial setup
  bindInteractions();
  setupScrollSpy();

  // Delay mermaid initialization slightly so DOM paint finishes first
  setTimeout(() => {
    renderMermaidDiagrams();
  }, 100);

  // Notify extension that webview is ready
  vscode.postMessage({ command: 'ready' });
})();
