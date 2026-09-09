(function () {
  const vscode = acquireVsCodeApi();

  let isSyncEnabled = true;
  let isTocOpen = false;
  let mermaidInitialized = false;
  const bodyEl = document.body;
  const initialZoomAttr = bodyEl ? bodyEl.getAttribute('data-initial-zoom') : null;
  const persistedState = vscode.getState() || {};
  let currentZoom = persistedState.zoom || (initialZoomAttr ? parseFloat(initialZoomAttr) : 1.0);
  if (isNaN(currentZoom) || currentZoom <= 0) {
    currentZoom = 1.0;
  }

  // Bidirectional scroll sync flags
  let isUserScrollingWebview = false;
  let userScrollResetTimer = null;
  let lastEditorScrollSendTime = 0;

  const markdownRoot = document.getElementById('markdownRoot');
  const previewContentArea = document.getElementById('previewContentArea');
  const tocContainer = document.getElementById('tocContainer');
  const tocDrawer = document.getElementById('tocDrawer');

  const btnToggleToc = document.getElementById('btnToggleToc');
  const btnCloseToc = document.getElementById('btnCloseToc');
  const btnToggleSync = document.getElementById('btnToggleSync');
  const btnExportHtml = document.getElementById('btnExportHtml');
  const btnPrint = document.getElementById('btnPrint');

  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomReset = document.getElementById('btnZoomReset');
  const zoomLevelEl = document.getElementById('zoomLevel');

  function isDarkMode() {
    return document.body.classList.contains('vscode-dark') || 
           (!document.body.classList.contains('vscode-light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // Zoom Engine
  function applyZoom(zoomVal) {
    currentZoom = Math.min(2.0, Math.max(0.5, Math.round(zoomVal * 10) / 10));
    if (markdownRoot) {
      markdownRoot.style.zoom = String(currentZoom);
    }
    if (zoomLevelEl) {
      zoomLevelEl.textContent = `${Math.round(currentZoom * 100)}%`;
    }
    if (previewContentArea) {
      previewContentArea.scrollLeft = 0;
    }

    try {
      vscode.setState({ ...vscode.getState(), zoom: currentZoom });
    } catch (_) {}

    vscode.postMessage({
      command: 'saveZoomLevel',
      zoom: currentZoom
    });
  }

  function zoomIn() {
    applyZoom(currentZoom + 0.1);
  }

  function zoomOut() {
    applyZoom(currentZoom - 0.1);
  }

  function zoomReset() {
    applyZoom(1.0);
  }

  // Keyboard Shortcuts (Cmd/Ctrl + '=', '-', '0') and Cmd + Wheel
  window.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.metaKey || e.ctrlKey;
    if (!isCmdOrCtrl) return;

    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      zoomReset();
    }
  });

  previewContentArea?.addEventListener('wheel', (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else if (e.deltaY > 0) {
        zoomOut();
      }
    }
  }, { passive: false });

  // Mermaid render with safety and theme adaptation
  function renderMermaidDiagrams() {
    const mermaidNodes = document.querySelectorAll('.mermaid:not([data-processed="true"])');
    if (!mermaidNodes || mermaidNodes.length === 0) return;

    if (!window.mermaid) return;

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

  // Calculate absolute scroll position of an element relative to previewContentArea
  function getElementScrollTop(el) {
    if (!previewContentArea) return 0;
    const containerRect = previewContentArea.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    return previewContentArea.scrollTop + (elRect.top - containerRect.top);
  }

  // Line-accurate Scroll Synchronization Engine (Editor -> Preview)
  function scrollToTargetLine(targetLine, fallbackPercentage) {
    if (!previewContentArea) return;

    if (targetLine <= 0) {
      previewContentArea.scrollTop = 0;
      return;
    }

    const elements = Array.from(document.querySelectorAll('[data-line]'));
    if (elements.length === 0) {
      if (typeof fallbackPercentage === 'number') {
        const maxScroll = previewContentArea.scrollHeight - previewContentArea.clientHeight;
        previewContentArea.scrollTop = fallbackPercentage * maxScroll;
      }
      return;
    }

    let prevEl = null;
    let nextEl = null;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const elLine = parseInt(el.getAttribute('data-line'), 10);
      if (elLine <= targetLine) {
        prevEl = el;
      } else {
        nextEl = el;
        break;
      }
    }

    if (!prevEl && nextEl) {
      previewContentArea.scrollTop = Math.max(0, getElementScrollTop(nextEl) - 15);
      return;
    }

    if (prevEl && !nextEl) {
      previewContentArea.scrollTop = Math.max(0, getElementScrollTop(prevEl) - 15);
      return;
    }

    if (prevEl && nextEl) {
      const prevLine = parseInt(prevEl.getAttribute('data-line'), 10);
      const nextLine = parseInt(nextEl.getAttribute('data-line'), 10);
      const prevTop = getElementScrollTop(prevEl);
      const nextTop = getElementScrollTop(nextEl);

      const span = nextLine - prevLine;
      const ratio = span > 0 ? (targetLine - prevLine) / span : 0;
      const targetY = prevTop + ratio * (nextTop - prevTop);

      previewContentArea.scrollTop = Math.max(0, targetY - 15);
    }
  }

  // Reverse Scroll Synchronization Engine (Preview -> Editor)
  function setupReverseScrollSync() {
    if (!previewContentArea) return;

    function markUserScrolling() {
      isUserScrollingWebview = true;
      if (userScrollResetTimer) {
        clearTimeout(userScrollResetTimer);
      }
      userScrollResetTimer = setTimeout(() => {
        isUserScrollingWebview = false;
      }, 300);
    }

    previewContentArea.addEventListener('wheel', markUserScrolling, { passive: true });
    previewContentArea.addEventListener('touchmove', markUserScrolling, { passive: true });
    previewContentArea.addEventListener('pointerdown', markUserScrolling, { passive: true });

    previewContentArea.addEventListener('scroll', () => {
      if (previewContentArea.scrollLeft !== 0) {
        previewContentArea.scrollLeft = 0;
      }

      if (!isSyncEnabled || !isUserScrollingWebview) return;

      const now = Date.now();
      if (now - lastEditorScrollSendTime < 30) return;
      lastEditorScrollSendTime = now;

      const containerRect = previewContentArea.getBoundingClientRect();
      const elements = Array.from(document.querySelectorAll('[data-line]'));
      if (elements.length === 0) return;

      let detectedLine = 0;
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const elRect = el.getBoundingClientRect();
        if (elRect.top - containerRect.top <= 45) {
          detectedLine = parseInt(el.getAttribute('data-line'), 10);
        } else {
          break;
        }
      }

      vscode.postMessage({
        command: 'scrollEditorToLine',
        line: detectedLine
      });
    }, { passive: true });
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

  // Extension Messages Listener
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      case 'update':
        if (markdownRoot) {
          markdownRoot.innerHTML = message.html;
        }
        updateTocList(message.headings);
        bindInteractions();
        renderMermaidDiagrams();
        break;

      case 'syncScroll':
        if (isUserScrollingWebview) return;

        if (isSyncEnabled && previewContentArea) {
          if (typeof message.line === 'number') {
            scrollToTargetLine(message.line, message.percentage);
          } else if (typeof message.percentage === 'number') {
            const maxScroll = previewContentArea.scrollHeight - previewContentArea.clientHeight;
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

  btnExportHtml?.addEventListener('click', () => {
    vscode.postMessage({ command: 'exportHtml' });
  });

  btnPrint?.addEventListener('click', () => {
    window.print();
  });

  // Zoom Controls Event Listeners
  btnZoomIn?.addEventListener('click', zoomIn);
  btnZoomOut?.addEventListener('click', zoomOut);
  btnZoomReset?.addEventListener('click', zoomReset);

  // Apply initial zoom
  if (markdownRoot && currentZoom !== 1.0) {
    markdownRoot.style.zoom = String(currentZoom);
  }
  if (zoomLevelEl) {
    zoomLevelEl.textContent = `${Math.round(currentZoom * 100)}%`;
  }

  // Initial setup
  bindInteractions();
  setupScrollSpy();
  setupReverseScrollSync();

  setTimeout(() => {
    renderMermaidDiagrams();
  }, 100);

  // Hard lock horizontal window scrolling
  window.addEventListener('scroll', () => {
    if (window.scrollX !== 0) {
      window.scrollTo(0, window.scrollY);
    }
  });

  // Notify extension that webview is ready
  vscode.postMessage({ command: 'ready' });
})();
