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
  let isProgrammaticScroll = false;
  let programmaticScrollTimer = null;

  // Sync state tracking across toggle events
  let lastScrollSource = 'editor'; // 'editor' | 'preview'
  let lastEditorScrollTime = 0;
  let lastPreviewScrollTime = 0;
  let lastEditorLine = 0;
  let lastEditorPercentage = 0;

  function markProgrammaticScroll(duration = 200) {
    isProgrammaticScroll = true;
    if (programmaticScrollTimer) {
      clearTimeout(programmaticScrollTimer);
    }
    programmaticScrollTimer = setTimeout(() => {
      isProgrammaticScroll = false;
    }, duration);
  }

  function getCurrentPreviewTopLine() {
    const root = markdownRoot || document.getElementById('markdownRoot');
    if (!previewContentArea || !root) return 0;
    const containerRect = previewContentArea.getBoundingClientRect();
    const elements = Array.from(root.querySelectorAll('[data-line]'));
    if (elements.length === 0) return 0;

    const zoom = currentZoom || 1.0;
    let detectedLine = 0;
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const elRect = el.getBoundingClientRect();
      const relativeTop = (elRect.top - containerRect.top) / zoom;
      if (relativeTop <= 45) {
        detectedLine = parseInt(el.getAttribute('data-line'), 10);
      } else {
        break;
      }
    }
    return detectedLine;
  }

  const previewToolbar = document.getElementById('previewToolbar');
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

  // Dynamic Responsive Width Engine for Zoom Out & Responsive Layout
  function updateContentWidth() {
    if (!markdownRoot) return;

    // Available content width inside previewContentArea (excluding 52px left + 52px right padding = 104px)
    const container = previewContentArea || document.body;
    const clientW = container.clientWidth || window.innerWidth;
    const availableWidth = Math.max(0, clientW - 104);

    if (currentZoom >= 1.0) {
      markdownRoot.style.maxWidth = '840px';
    } else if (currentZoom <= 0.5 || availableWidth <= 840) {
      markdownRoot.style.maxWidth = '100%';
    } else {
      // Zoom out range: 1.0 down to 0.5
      // Progressive expansion: at 0.5 it fills 100% of available space.
      const progress = (1.0 - currentZoom) / 0.5; // 0.0 at 1.0, 1.0 at 0.5
      const visualTargetWidth = 840 + progress * (availableWidth - 840);
      // Convert visual target width to layout coordinates (divided by currentZoom)
      const layoutMaxWidth = Math.round(visualTargetWidth / currentZoom);
      markdownRoot.style.maxWidth = layoutMaxWidth + 'px';
    }
  }

  // Zoom Engine
  function applyZoom(zoomVal) {
    currentZoom = Math.min(2.0, Math.max(0.5, Math.round(zoomVal * 10) / 10));
    if (markdownRoot) {
      markdownRoot.style.zoom = String(currentZoom);
    }
    updateContentWidth();
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

  let isLoadingDismissed = false;

  function dismissLoading() {
    if (isLoadingDismissed) return;
    isLoadingDismissed = true;

    const overlay = document.getElementById('previewLoadingOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
      setTimeout(() => {
        try { overlay.remove(); } catch (_) {}
      }, 300);
    }

    // Re-verify alignment with editor once layout settles and skeleton overlay clears
    if (isSyncEnabled && typeof lastEditorLine === 'number' && lastEditorLine >= 0) {
      requestAnimationFrame(() => {
        scrollToTargetLine(lastEditorLine, lastEditorPercentage);
        // Explicitly guarantee topbar is visible after initial auto-scroll alignment
        showToolbar();
      });
    } else {
      showToolbar();
    }
  }

  // Mermaid render with safety and theme adaptation
  function renderMermaidDiagrams() {
    const mermaidNodes = document.querySelectorAll('.mermaid:not([data-processed="true"])');
    if (!mermaidNodes || mermaidNodes.length === 0) {
      dismissLoading();
      return;
    }

    if (!window.mermaid) {
      dismissLoading();
      return;
    }

    const dark = isDarkMode();

    try {
      if (!mermaidInitialized) {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          flowchart: {
            htmlLabels: false,
            useMaxWidth: true
          },
          sequence: {
            useMaxWidth: true
          },
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
      }).then(() => {
        dismissLoading();
      }).catch((err) => {
        console.error('Mermaid async render error:', err);
        dismissLoading();
      });
    } catch (err) {
      console.error('Mermaid render error:', err);
      dismissLoading();
    }
  }

  // Navigate to heading in both Preview and Markdown Editor
  function navigateToHeading(h) {
    const target = h.id ? document.getElementById(h.id) : null;

    // Resolve line number
    let line = typeof h.line === 'number' ? h.line : undefined;
    if (line === undefined && target) {
      const lineAttr = target.getAttribute('data-line');
      if (lineAttr !== null) {
        line = parseInt(lineAttr, 10);
      }
    }

    // 1. Smoothly scroll preview to heading
    if (target && previewContentArea) {
      markProgrammaticScroll(600);
      const targetTop = getElementScrollTop(target);
      previewContentArea.scrollTo({
        top: Math.max(0, targetTop - 40),
        behavior: 'smooth'
      });
    }

    // 2. Highlight clicked outline item immediately
    if (tocContainer && h.id) {
      tocContainer.querySelectorAll('a').forEach((el) => {
        const isMatch = el.getAttribute('data-target-id') === h.id || el.getAttribute('href') === `#${h.id}`;
        el.classList.toggle('active', isMatch);
      });
    }

    // 3. Synchronize Markdown editor to the exact heading line with cursor positioning!
    if (typeof line === 'number' && !isNaN(line)) {
      lastEditorLine = line;
      lastPreviewScrollTime = Date.now();
      vscode.postMessage({
        command: 'scrollEditorToLine',
        line: line,
        setSelection: true
      });
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
      if (typeof h.line === 'number') {
        a.dataset.tocLine = String(h.line);
      }

      a.addEventListener('click', (e) => {
        e.preventDefault();
        navigateToHeading(h);
      });

      li.appendChild(a);
      ul.appendChild(li);
    });

    tocContainer.innerHTML = '';
    tocContainer.appendChild(ul);
  }

  function bindInitialTocLinks() {
    if (!tocContainer) return;
    tocContainer.querySelectorAll('a').forEach((a) => {
      if (a.dataset.bound) return;
      a.dataset.bound = 'true';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = a.getAttribute('data-target-id') || (a.getAttribute('href') || '').replace(/^#/, '');
        const lineAttr = a.getAttribute('data-toc-line') || a.getAttribute('data-line');
        const line = lineAttr !== null ? parseInt(lineAttr, 10) : undefined;
        navigateToHeading({ id: targetId, line: line });
      });
    });
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

  // Resolve the SVG element belonging strictly to the button's diagram card
  function getDiagramSvg(btn) {
    const card = btn.closest('.antigravity-diagram-card');
    if (card) {
      const bodySvg = card.querySelector('.diagram-body svg');
      if (bodySvg) return bodySvg;
      const anySvg = card.querySelector('svg:not(.diagram-type svg)');
      if (anySvg) return anySvg;
    }
    const targetId = btn.getAttribute('data-target');
    if (targetId) {
      const el = document.getElementById(targetId);
      if (el) {
        if (el.tagName && el.tagName.toLowerCase() === 'svg') return el;
        const childSvg = el.querySelector('svg');
        if (childSvg) return childSvg;
      }
    }
    return null;
  }

  // Helper to convert SVG element to high-res PNG data URL with theme-adaptive background
  function convertSvgToPngDataUrl(svgElement, callback) {
    try {
      const clonedSvg = svgElement.cloneNode(true);

      // Sanitize any foreignObject if present to prevent Chromium canvas tainting
      const foreignObjects = clonedSvg.querySelectorAll('foreignObject');
      if (foreignObjects.length > 0) {
        foreignObjects.forEach((fo) => {
          const text = fo.textContent ? fo.textContent.trim() : '';
          const fx = parseFloat(fo.getAttribute('x') || '0') + (parseFloat(fo.getAttribute('width') || '0') / 2);
          const fy = parseFloat(fo.getAttribute('y') || '0') + (parseFloat(fo.getAttribute('height') || '0') / 2);
          const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          textEl.setAttribute('x', String(fx));
          textEl.setAttribute('y', String(fy));
          textEl.setAttribute('text-anchor', 'middle');
          textEl.setAttribute('dominant-baseline', 'central');
          textEl.setAttribute('fill', isDarkMode() ? '#c9d1d9' : '#1f2328');
          textEl.setAttribute('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif');
          textEl.setAttribute('font-size', '14px');
          textEl.textContent = text;
          if (fo.parentNode) {
            fo.parentNode.replaceChild(textEl, fo);
          }
        });
      }

      let bbox = null;
      try {
        if (typeof svgElement.getBBox === 'function') {
          bbox = svgElement.getBBox();
        }
      } catch (_) {}

      const rect = svgElement.getBoundingClientRect();
      const viewBox = svgElement.viewBox && svgElement.viewBox.baseVal;
      let width = 800;
      let height = 600;

      if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
        width = Math.round(viewBox.width);
        height = Math.round(viewBox.height);
      } else if (bbox && bbox.width > 0 && bbox.height > 0) {
        width = Math.round(bbox.width);
        height = Math.round(bbox.height);
      } else if (rect.width > 0 && rect.height > 0) {
        width = Math.round(rect.width);
        height = Math.round(rect.height);
      }

      width = Math.max(100, width);
      height = Math.max(80, height);

      clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clonedSvg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      clonedSvg.setAttribute('width', String(width));
      clonedSvg.setAttribute('height', String(height));
      if (!clonedSvg.getAttribute('viewBox')) {
        clonedSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      }

      // Ensure internal diagram CSS styles are preserved
      if (!clonedSvg.querySelector('style')) {
        const docStyles = document.querySelectorAll('style[id*="mermaid"]');
        docStyles.forEach((s) => {
          clonedSvg.insertBefore(s.cloneNode(true), clonedSvg.firstChild);
        });
      }

      // Add background rect matching active theme so PNG is clean and legible
      const dark = isDarkMode();
      const bgColor = dark ? '#0d1117' : '#ffffff';
      const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bgRect.setAttribute('x', '0');
      bgRect.setAttribute('y', '0');
      bgRect.setAttribute('width', '100%');
      bgRect.setAttribute('height', '100%');
      bgRect.setAttribute('fill', bgColor);
      clonedSvg.insertBefore(bgRect, clonedSvg.firstChild);

      const svgString = new XMLSerializer().serializeToString(clonedSvg);
      const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl = URL.createObjectURL(svgBlob);

      const img = new Image();
      const scale = 2; // Crisp 2x retina resolution

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = width * scale;
          canvas.height = height * scale;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.scale(scale, scale);
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/png');
            URL.revokeObjectURL(svgUrl);
            callback(null, dataUrl, canvas, svgString);
          } else {
            URL.revokeObjectURL(svgUrl);
            callback(new Error('Canvas context not available'));
          }
        } catch (canvasErr) {
          URL.revokeObjectURL(svgUrl);
          callback(canvasErr);
        }
      };

      img.onerror = (imgErr) => {
        URL.revokeObjectURL(svgUrl);
        callback(imgErr || new Error('Image load failed'));
      };

      img.src = svgUrl;
    } catch (err) {
      callback(err);
    }
  }

    // 2b. Copy PNG for Mermaid
    document.querySelectorAll('.copy-png-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const svg = getDiagramSvg(btn);
        if (!svg) {
          console.warn('[Copy PNG] SVG element not found for card');
          return;
        }

        const originalText = btn.textContent;
        btn.textContent = 'Copying...';
        btn.disabled = true;

        convertSvgToPngDataUrl(svg, async (err, dataUrl, canvas) => {
          if (err || !dataUrl) {
            btn.textContent = 'Failed';
            setTimeout(() => {
              btn.textContent = originalText;
              btn.disabled = false;
            }, 2000);
            return;
          }

          let copiedViaNavigator = false;
          if (canvas && canvas.toBlob && navigator.clipboard && window.ClipboardItem) {
            try {
              await new Promise((resolve, reject) => {
                canvas.toBlob(async (blob) => {
                  if (!blob) return reject(new Error('No blob'));
                  try {
                    await navigator.clipboard.write([
                      new ClipboardItem({ 'image/png': blob })
                    ]);
                    copiedViaNavigator = true;
                    resolve();
                  } catch (clipErr) {
                    reject(clipErr);
                  }
                }, 'image/png');
              });
            } catch (_) {
              copiedViaNavigator = false;
            }
          }

          if (!copiedViaNavigator) {
            vscode.postMessage({
              command: 'copyImageToClipboard',
              dataUrl: dataUrl
            });
          }

          btn.disabled = false;
          btn.textContent = 'Copied PNG!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = originalText;
            btn.classList.remove('copied');
          }, 2000);
        });
      });
    });

    // 2c. Copy PNG for PlantUML
    document.querySelectorAll('.copy-puml-png-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const card = btn.closest('.antigravity-diagram-card');
        const img = (card && card.querySelector('.plantuml-svg-img')) || document.getElementById(btn.getAttribute('data-target'));
        if (!img) return;

        const originalText = btn.textContent;
        btn.textContent = 'Copying...';
        btn.disabled = true;

        const svgSrc = img.getAttribute('src') || '';
        const pngSrc = svgSrc.replace(/\/svg\//, '/png/');

        vscode.postMessage({
          command: 'copyImageToClipboard',
          imageUrl: pngSrc
        });

        btn.disabled = false;
        btn.textContent = 'Copied PNG!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = originalText;
          btn.classList.remove('copied');
        }, 2000);
      });
    });

    // 2d. Fullscreen Interactive Pan & Zoom Modal for Diagrams
    document.querySelectorAll('.modal-expand-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const card = btn.closest('.antigravity-diagram-card');
        const titleSpan = card ? card.querySelector('.diagram-type span') : null;
        const title = (titleSpan && titleSpan.textContent) ? titleSpan.textContent.trim() : 'Diagram Interactive View';

        // Try Mermaid SVG first
        const svg = getDiagramSvg(btn);
        if (svg) {
          openDiagramModal(svg, title);
          return;
        }

        // Try PlantUML image
        const img = card ? card.querySelector('.plantuml-svg-img') : document.getElementById(btn.getAttribute('data-target'));
        if (img) {
          openDiagramModal(img, title);
          return;
        }
      });
    });

    // 3. Save PNG for Mermaid
    document.querySelectorAll('.export-png-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const svg = getDiagramSvg(btn);
        if (!svg) {
          console.warn('[Save PNG] SVG element not found for card');
          return;
        }

        const originalText = btn.textContent;
        btn.textContent = 'Saving...';
        btn.disabled = true;

        convertSvgToPngDataUrl(svg, (err, dataUrl) => {
          btn.disabled = false;
          if (err || !dataUrl) {
            console.error('Save PNG error:', err);
            btn.textContent = 'Error';
            setTimeout(() => { btn.textContent = originalText; }, 2000);
            return;
          }

          btn.textContent = 'Saved!';
          setTimeout(() => { btn.textContent = originalText; }, 1500);

          vscode.postMessage({
            command: 'saveImage',
            data: dataUrl,
            defaultName: `${targetId}.png`
          });
        });
      });
    });

    // 4. Save SVG for Mermaid
    document.querySelectorAll('.export-svg-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target') || 'diagram';
        const svg = getDiagramSvg(btn);
        if (svg) {
          const svgData = new XMLSerializer().serializeToString(svg);
          vscode.postMessage({
            command: 'saveSvg',
            svg: svgData,
            defaultName: `${targetId}.svg`
          });
          const orig = btn.textContent;
          btn.textContent = 'Saved!';
          setTimeout(() => { btn.textContent = orig; }, 1500);
        }
      });
    });

    // 5. Save PNG for PlantUML
    document.querySelectorAll('.export-puml-png-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const card = btn.closest('.antigravity-diagram-card');
        const targetId = btn.getAttribute('data-target') || 'plantuml-diagram';
        const img = (card && card.querySelector('.plantuml-svg-img')) || document.getElementById(targetId);
        if (!img) return;

        const originalText = btn.textContent;
        btn.textContent = 'Saving...';
        btn.disabled = true;

        const svgSrc = img.getAttribute('src') || '';
        const pngSrc = svgSrc.replace(/\/svg\//, '/png/');

        vscode.postMessage({
          command: 'saveImage',
          imageUrl: pngSrc,
          defaultName: `${targetId}.png`
        });

        btn.textContent = 'Saved!';
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = originalText;
        }, 1500);
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

    // 5. Internal Anchor links in markdown content
    document.querySelectorAll('.antigravity-preview-content a[href^="#"]').forEach((a) => {
      if (a.dataset.anchorBound) return;
      a.dataset.anchorBound = 'true';

      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href');
        if (!href || href === '#') return;
        const targetId = decodeURIComponent(href.slice(1));
        const target = document.getElementById(targetId);
        if (target) {
          e.preventDefault();
          const lineAttr = target.getAttribute('data-line');
          const line = lineAttr !== null ? parseInt(lineAttr, 10) : undefined;
          navigateToHeading({ id: targetId, line: line });
        }
      });
    });

    // 6. Bind initial TOC links if rendered statically
    bindInitialTocLinks();
  }

  // Calculate absolute scroll position of an element relative to previewContentArea
  function getElementScrollTop(el) {
    if (!previewContentArea) return 0;
    const containerRect = previewContentArea.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const zoom = currentZoom || 1.0;
    return previewContentArea.scrollTop + (elRect.top - containerRect.top) / zoom;
  }

  // Line-accurate Scroll Synchronization Engine (Editor -> Preview)
  function scrollToTargetLine(targetLine, fallbackPercentage) {
    const root = markdownRoot || document.getElementById('markdownRoot');
    if (!previewContentArea || !root) return;
    markProgrammaticScroll(400);

    if (targetLine <= 0) {
      previewContentArea.scrollTop = 0;
      return;
    }

    const elements = Array.from(root.querySelectorAll('[data-line]'));
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
      previewContentArea.scrollTop = Math.max(0, getElementScrollTop(nextEl) - 40);
      return;
    }

    if (prevEl && !nextEl) {
      const maxScroll = previewContentArea.scrollHeight - previewContentArea.clientHeight;
      if (typeof fallbackPercentage === 'number' && fallbackPercentage > 0.95) {
        previewContentArea.scrollTop = maxScroll;
      } else {
        previewContentArea.scrollTop = Math.max(0, getElementScrollTop(prevEl) - 40);
      }
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

      previewContentArea.scrollTop = Math.max(0, targetY - 40);
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
      }, 250);
    }

    previewContentArea.addEventListener('wheel', markUserScrolling, { passive: true });
    previewContentArea.addEventListener('touchmove', markUserScrolling, { passive: true });
    previewContentArea.addEventListener('pointerdown', markUserScrolling, { passive: true });

    previewContentArea.addEventListener('scroll', () => {
      if (previewContentArea.scrollLeft !== 0) {
        previewContentArea.scrollLeft = 0;
      }

      if (isProgrammaticScroll) {
        return;
      }

      // Any scroll that is not programmatic is user-driven (wheel, trackpad, scrollbar drag, keyboard)
      markUserScrolling();
      lastScrollSource = 'preview';
      lastPreviewScrollTime = Date.now();

      if (!isSyncEnabled) return;

      const now = Date.now();
      if (now - lastEditorScrollSendTime < 30) return;
      lastEditorScrollSendTime = now;

      const detectedLine = getCurrentPreviewTopLine();

      vscode.postMessage({
        command: 'scrollEditorToLine',
        line: detectedLine,
        setSelection: false
      });
    }, { passive: true });
  }

  // Auto-hide and auto-show toolbar on scroll with deliberate distance threshold & gentle animation
  let showToolbar = () => {};
  let hideToolbar = () => {};

  function setupAutoHideToolbar() {
    if (!previewToolbar || !previewContentArea) return;

    let lastScrollTop = previewContentArea.scrollTop;
    let isToolbarHidden = false;
    let isMouseNearTop = false;
    let accumulatedUp = 0;
    let accumulatedDown = 0;

    hideToolbar = function() {
      if (isToolbarHidden || isTocOpen) return;
      isToolbarHidden = true;
      previewToolbar.classList.add('toolbar-hidden');
    };

    showToolbar = function() {
      if (!isToolbarHidden) {
        lockRootScroll();
        return;
      }
      isToolbarHidden = false;
      previewToolbar.classList.remove('toolbar-hidden');
      accumulatedDown = 0;
      accumulatedUp = 0;
      lockRootScroll();
    };

    // Scroll listener on the content area
    previewContentArea.addEventListener('scroll', () => {
      const currentScrollTop = previewContentArea.scrollTop;
      const delta = currentScrollTop - lastScrollTop;

      // 0. Ignore programmatic scrolling (editor sync, initial page load alignment, outline click)
      if (isProgrammaticScroll) {
        lastScrollTop = currentScrollTop;
        accumulatedDown = 0;
        accumulatedUp = 0;
        return;
      }

      // 1. At or near document top: ALWAYS show toolbar immediately
      if (currentScrollTop <= 35) {
        showToolbar();
        accumulatedUp = 0;
        accumulatedDown = 0;
        lastScrollTop = currentScrollTop;
        return;
      }

      // 2. If Outline drawer is active: stay visible
      if (isTocOpen) {
        showToolbar();
        accumulatedUp = 0;
        accumulatedDown = 0;
        lastScrollTop = currentScrollTop;
        return;
      }

      // 3. If mouse is hovering near top edge: keep toolbar visible
      if (isMouseNearTop) {
        lastScrollTop = currentScrollTop;
        return;
      }

      // 4. Prevent bottom overscroll bounce from triggering false show
      const maxScroll = previewContentArea.scrollHeight - previewContentArea.clientHeight;
      if (currentScrollTop >= maxScroll - 10 && delta > 0) {
        lastScrollTop = currentScrollTop;
        return;
      }

      // 5. Track directional accumulated scroll with balanced thresholds
      if (delta > 0) {
        // User is scrolling DOWN
        accumulatedDown += delta;
        accumulatedUp = 0;

        // Require deliberate downward scroll distance (>= 45px) matching the scroll-up feel
        if (accumulatedDown >= 45 && currentScrollTop > 50) {
          hideToolbar();
        }
      } else if (delta < 0) {
        // User is scrolling UP
        accumulatedUp += Math.abs(delta);
        accumulatedDown = 0;

        // Require deliberate upward scroll distance (>= 45px) matching the scroll-down feel
        if (accumulatedUp >= 45) {
          showToolbar();
        }
      }

      lastScrollTop = currentScrollTop;
    }, { passive: true });

    // Effortless mouse peek: moving mouse near top edge smoothly reveals toolbar
    window.addEventListener('mousemove', (e) => {
      if (e.clientY <= 25) {
        isMouseNearTop = true;
        showToolbar();
      } else if (e.clientY > 65) {
        if (isMouseNearTop) {
          isMouseNearTop = false;
          if (previewContentArea.scrollTop > 50 && !isTocOpen) {
            hideToolbar();
          }
        }
      }
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
        if (isProgrammaticScroll) return;
        const headings = document.querySelectorAll('.antigravity-heading');
        if (headings.length === 0 || !tocContainer) return;

        const containerRect = previewContentArea.getBoundingClientRect();
        let activeId = '';

        headings.forEach((heading) => {
          const rect = heading.getBoundingClientRect();
          if (rect.top - containerRect.top <= 80) {
            activeId = heading.id;
          }
        });

        if (activeId) {
          tocContainer.querySelectorAll('a').forEach((a) => {
            const isMatch = a.dataset.targetId === activeId || a.getAttribute('href') === `#${activeId}`;
            if (isMatch) {
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
        updateContentWidth();
        updateTocList(message.headings);
        bindInteractions();
        renderMermaidDiagrams();
        break;

      case 'syncScroll':
        lastEditorLine = message.line;
        lastEditorPercentage = message.percentage;
        lastEditorScrollTime = Date.now();
        if (!isUserScrollingWebview) {
          lastScrollSource = 'editor';
        }

        if (isUserScrollingWebview) return;

        if (isSyncEnabled && previewContentArea) {
          if (typeof message.line === 'number') {
            scrollToTargetLine(message.line, message.percentage);
          } else if (typeof message.percentage === 'number') {
            markProgrammaticScroll();
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
    if (isTocOpen) {
      previewToolbar?.classList.remove('toolbar-hidden');
    }
    setTimeout(updateContentWidth, 200);
  });

  btnCloseToc?.addEventListener('click', () => {
    isTocOpen = false;
    tocDrawer?.classList.add('closed');
    btnToggleToc?.classList.remove('active-state');
    setTimeout(updateContentWidth, 200);
  });

  btnToggleSync?.addEventListener('click', () => {
    isSyncEnabled = !isSyncEnabled;
    btnToggleSync.classList.toggle('active-state', isSyncEnabled);

    if (isSyncEnabled) {
      if (lastScrollSource === 'preview' && (lastPreviewScrollTime > lastEditorScrollTime)) {
        // Case 2: Preview was scrolled while Sync was OFF -> immediately sync Editor to Preview
        const line = getCurrentPreviewTopLine();
        vscode.postMessage({
          command: 'scrollEditorToLine',
          line: line
        });
      } else {
        // Case 1: Editor was scrolled while Sync was OFF -> immediately sync Preview to Editor
        if (typeof lastEditorLine === 'number' && lastEditorLine >= 0) {
          scrollToTargetLine(lastEditorLine, lastEditorPercentage);
        }
        vscode.postMessage({ command: 'requestSyncFromEditor' });
      }
    }
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

  // Apply initial zoom and responsive content width
  if (markdownRoot) {
    if (currentZoom !== 1.0) {
      markdownRoot.style.zoom = String(currentZoom);
    }
    updateContentWidth();
  }

  // Handle window resize to adapt width dynamically
  window.addEventListener('resize', () => {
    updateContentWidth();
  });
  if (zoomLevelEl) {
    zoomLevelEl.textContent = `${Math.round(currentZoom * 100)}%`;
  }


  // Interactive Task List Checkbox Click Handler (Two-Way Sync)
  document.addEventListener('change', (e) => {
    const target = e.target;
    if (target && target.classList.contains('task-list-item-checkbox')) {
      const lineAttr = target.getAttribute('data-line');
      const line = lineAttr !== null ? parseInt(lineAttr, 10) : -1;
      const isChecked = target.checked;

      // Optimistic visual update
      const listItem = target.closest('.task-list-item');
      if (listItem) {
        listItem.classList.toggle('checked', isChecked);
      }

      if (line >= 0) {
        vscode.postMessage({
          command: 'toggleTask',
          line: line,
          checked: isChecked
        });
      }
    }
  });

  // Diagram Lightbox Pan & Zoom Modal State & Controls
  let modalScale = 1.0;
  let modalTranslate = { x: 0, y: 0 };
  let isDraggingModal = false;
  let dragStartPointer = { x: 0, y: 0 };
  let currentDiagramWidth = 800;
  let currentDiagramHeight = 600;
  let isModalOpen = false;
  let modalRafId = null;
  let lastRenderedScale = -1;

  const modalOverlay = document.getElementById('diagramModalOverlay');
  const modalBackdrop = document.getElementById('diagramModalBackdrop');
  const modalTitleEl = document.getElementById('diagramModalTitle');
  const modalViewport = document.getElementById('diagramModalViewport');
  const modalCanvas = document.getElementById('diagramModalCanvas');
  const modalZoomLevel = document.getElementById('modalZoomLevel');
  const btnModalZoomIn = document.getElementById('btnModalZoomIn');
  const btnModalZoomOut = document.getElementById('btnModalZoomOut');
  const btnModalZoomReset = document.getElementById('btnModalZoomReset');
  const btnModalFit = document.getElementById('btnModalFit');
  const btnModalClose = document.getElementById('btnModalClose');

  function scheduleModalTransform() {
    if (modalRafId) return;
    modalRafId = requestAnimationFrame(() => {
      modalRafId = null;
      applyModalTransform();
    });
  }

  function applyModalTransform() {
    if (!modalCanvas) return;
    // Pure GPU compositor transform (translate3d) - zero CPU repaint
    modalCanvas.style.transform = `translate3d(${modalTranslate.x}px, ${modalTranslate.y}px, 0) scale(${modalScale})`;

    // Only touch DOM text if zoom percentage integer actually changed
    const currentPercent = Math.round(modalScale * 100);
    if (modalZoomLevel && currentPercent !== lastRenderedScale) {
      lastRenderedScale = currentPercent;
      modalZoomLevel.textContent = `${currentPercent}%`;
    }
  }

  function fitModalDiagram() {
    if (!modalViewport || !modalCanvas) return;
    const padding = 60;
    const vw = Math.max(160, modalViewport.clientWidth - padding);
    const vh = Math.max(120, modalViewport.clientHeight - padding);

    const scaleX = vw / Math.max(1, currentDiagramWidth);
    const scaleY = vh / Math.max(1, currentDiagramHeight);
    modalScale = Math.min(scaleX, scaleY, 2.5);
    modalScale = Math.max(0.1, Math.min(10.0, modalScale));

    modalTranslate.x = (modalViewport.clientWidth - currentDiagramWidth * modalScale) / 2;
    modalTranslate.y = (modalViewport.clientHeight - currentDiagramHeight * modalScale) / 2;
    applyModalTransform();
  }

  function resetModalZoom() {
    if (!modalViewport) return;
    modalScale = 1.0;
    modalTranslate.x = (modalViewport.clientWidth - currentDiagramWidth) / 2;
    modalTranslate.y = (modalViewport.clientHeight - currentDiagramHeight) / 2;
    applyModalTransform();
  }

  function openDiagramModal(element, title = 'Diagram Interactive View') {
    if (!modalOverlay || !modalCanvas || !modalViewport) return;

    if (modalTitleEl) {
      modalTitleEl.textContent = title;
    }

    modalCanvas.innerHTML = '';
    const clone = element.cloneNode(true);

    let width = 800;
    let height = 600;

    if (element.tagName && element.tagName.toLowerCase() === 'svg') {
      let bbox = null;
      try {
        if (typeof element.getBBox === 'function') {
          bbox = element.getBBox();
        }
      } catch (_) {}

      const rect = element.getBoundingClientRect();
      const viewBox = element.viewBox && element.viewBox.baseVal;

      if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
        width = Math.round(viewBox.width);
        height = Math.round(viewBox.height);
      } else if (bbox && bbox.width > 0 && bbox.height > 0) {
        width = Math.round(bbox.width);
        height = Math.round(bbox.height);
      } else if (rect.width > 0 && rect.height > 0) {
        width = Math.round(rect.width);
        height = Math.round(rect.height);
      }

      clone.setAttribute('width', String(width));
      clone.setAttribute('height', String(height));
      if (!clone.getAttribute('viewBox')) {
        clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
      }
      clone.style.width = `${width}px`;
      clone.style.height = `${height}px`;
      clone.style.maxWidth = 'none';
      clone.style.maxHeight = 'none';
    } else if (element.tagName && element.tagName.toLowerCase() === 'img') {
      width = element.naturalWidth || element.width || 800;
      height = element.naturalHeight || element.height || 600;
      clone.style.width = `${width}px`;
      clone.style.height = `${height}px`;
      clone.style.maxWidth = 'none';
      clone.style.maxHeight = 'none';
    }

    currentDiagramWidth = Math.max(100, width);
    currentDiagramHeight = Math.max(80, height);

    modalCanvas.style.width = `${currentDiagramWidth}px`;
    modalCanvas.style.height = `${currentDiagramHeight}px`;
    modalCanvas.appendChild(clone);

    isModalOpen = true;
    document.body.classList.add('modal-open');
    document.documentElement.classList.add('modal-open');
    modalOverlay.classList.add('active');
    modalOverlay.setAttribute('aria-hidden', 'false');

    fitModalDiagram();
  }

  function closeDiagramModal() {
    if (!modalOverlay) return;
    isModalOpen = false;
    isDraggingModal = false;

    if (modalViewport) {
      modalViewport.classList.remove('dragging');
    }

    document.body.classList.remove('modal-open');
    document.documentElement.classList.remove('modal-open');

    modalOverlay.classList.remove('active');
    modalOverlay.setAttribute('aria-hidden', 'true');

    if (modalCanvas) {
      modalCanvas.innerHTML = '';
      modalCanvas.style.transform = '';
      modalCanvas.style.width = '';
      modalCanvas.style.height = '';
    }
  }

  function setupDiagramModal() {
    if (!modalViewport || !modalOverlay) return;

    function zoomModalAtPoint(point, factor) {
      const newScale = Math.min(10.0, Math.max(0.1, modalScale * factor));
      if (Math.abs(newScale - modalScale) < 0.0001) return;

      const diagramX = (point.x - modalTranslate.x) / modalScale;
      const diagramY = (point.y - modalTranslate.y) / modalScale;

      modalScale = newScale;
      modalTranslate.x = point.x - diagramX * newScale;
      modalTranslate.y = point.y - diagramY * newScale;
      scheduleModalTransform();
    }

    if (btnModalZoomIn) {
      btnModalZoomIn.addEventListener('click', (e) => {
        e.stopPropagation();
        const center = { x: modalViewport.clientWidth / 2, y: modalViewport.clientHeight / 2 };
        zoomModalAtPoint(center, 1.2);
      });
    }

    if (btnModalZoomOut) {
      btnModalZoomOut.addEventListener('click', (e) => {
        e.stopPropagation();
        const center = { x: modalViewport.clientWidth / 2, y: modalViewport.clientHeight / 2 };
        zoomModalAtPoint(center, 0.83);
      });
    }

    if (btnModalZoomReset) {
      btnModalZoomReset.addEventListener('click', (e) => {
        e.stopPropagation();
        resetModalZoom();
      });
    }

    if (btnModalFit) {
      btnModalFit.addEventListener('click', (e) => {
        e.stopPropagation();
        fitModalDiagram();
      });
    }

    if (btnModalClose) {
      btnModalClose.addEventListener('click', (e) => {
        e.stopPropagation();
        closeDiagramModal();
      });
    }

    if (modalBackdrop) {
      modalBackdrop.addEventListener('click', () => {
        closeDiagramModal();
      });
    }

    // High-performance wheel listener for trackpad pinch/pan and mouse wheel
    modalViewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = modalViewport.getBoundingClientRect();
      const pointer = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };

      // Case 1: Pinch-to-zoom on trackpad (macOS / Chromium sets e.ctrlKey = true)
      // or user holding Cmd / Ctrl / Alt
      if (e.ctrlKey || e.metaKey || e.altKey) {
        const zoomSensitivity = 0.0035;
        const clampedDelta = Math.max(-35, Math.min(35, e.deltaY));
        const factor = Math.exp(-clampedDelta * zoomSensitivity);
        zoomModalAtPoint(pointer, factor);
        return;
      }

      // Case 2: Physical notched mouse wheel
      const isPhysicalMouseWheel = e.deltaMode !== 0 || (
        Math.abs(e.deltaY) >= 60 &&
        Math.abs(e.deltaX) === 0 &&
        Number.isInteger(e.deltaY)
      );

      if (isPhysicalMouseWheel) {
        const factor = e.deltaY < 0 ? 1.08 : 0.92;
        zoomModalAtPoint(pointer, factor);
        return;
      }

      // Case 3: Trackpad two-finger pan (geser)
      const panDamping = 0.85;
      modalTranslate.x -= e.deltaX * panDamping;
      modalTranslate.y -= e.deltaY * panDamping;
      scheduleModalTransform();
    }, { passive: false });

    // Pointer Drag (Pan) with mouse or single-touch drag
    modalViewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.modal-control-btn') || e.target.closest('.modal-zoom-indicator-btn')) return;
      isDraggingModal = true;
      dragStartPointer.x = e.clientX - modalTranslate.x;
      dragStartPointer.y = e.clientY - modalTranslate.y;
      modalViewport.classList.add('dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDraggingModal) return;
      if (e.buttons === 0) {
        isDraggingModal = false;
        modalViewport.classList.remove('dragging');
        return;
      }
      modalTranslate.x = e.clientX - dragStartPointer.x;
      modalTranslate.y = e.clientY - dragStartPointer.y;
      scheduleModalTransform();
    });

    window.addEventListener('mouseup', () => {
      if (isDraggingModal) {
        isDraggingModal = false;
        if (modalViewport) {
          modalViewport.classList.remove('dragging');
        }
      }
    });

    window.addEventListener('blur', () => {
      if (isDraggingModal) {
        isDraggingModal = false;
        if (modalViewport) {
          modalViewport.classList.remove('dragging');
        }
      }
    });

    // Double-click to toggle fit / 100%
    modalViewport.addEventListener('dblclick', (e) => {
      if (e.target.closest('.modal-control-btn') || e.target.closest('.modal-zoom-indicator-btn')) return;
      if (Math.abs(modalScale - 1.0) < 0.05) {
        fitModalDiagram();
      } else {
        resetModalZoom();
      }
    });

    // Keyboard controls
    window.addEventListener('keydown', (e) => {
      if (!isModalOpen) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeDiagramModal();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        const center = { x: modalViewport.clientWidth / 2, y: modalViewport.clientHeight / 2 };
        zoomModalAtPoint(center, 1.2);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        const center = { x: modalViewport.clientWidth / 2, y: modalViewport.clientHeight / 2 };
        zoomModalAtPoint(center, 0.83);
      } else if (e.key === '0') {
        e.preventDefault();
        resetModalZoom();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        fitModalDiagram();
      }
    });
  }

  // Initial setup
  setupDiagramModal();
  bindInteractions();
  setupScrollSpy();
  setupReverseScrollSync();
  setupAutoHideToolbar();

  renderMermaidDiagrams();

  // Safety fallback dismiss after 350ms
  setTimeout(() => {
    dismissLoading();
  }, 350);

  // Hard lock root window and document scrolling to (0, 0)
  function lockRootScroll() {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
    if (document.documentElement && (document.documentElement.scrollLeft !== 0 || document.documentElement.scrollTop !== 0)) {
      document.documentElement.scrollLeft = 0;
      document.documentElement.scrollTop = 0;
    }
    if (document.body && (document.body.scrollLeft !== 0 || document.body.scrollTop !== 0)) {
      document.body.scrollLeft = 0;
      document.body.scrollTop = 0;
    }
  }

  window.addEventListener('scroll', lockRootScroll, { passive: true });
  document.addEventListener('scroll', lockRootScroll, { passive: true });
  lockRootScroll();

  // Notify extension that webview is ready
  vscode.postMessage({ command: 'ready' });
})();
