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
    // --------------------------------------------------------------------------
  // Bracket Matching / Bracket Pair Indicator in Code Blocks
  // --------------------------------------------------------------------------
  const BRACKET_PAIRS = { '{': '}', '(': ')', '[': ']', '}': '{', ')': '(', ']': '[' };
  const BRACKET_OPENINGS = new Set(['{', '(', '[']);

  function initBracketMatching() {
    document.querySelectorAll('.antigravity-code-block pre code').forEach((codeEl) => {
      if (codeEl.dataset.bracketsBound) return;
      codeEl.dataset.bracketsBound = 'true';

      const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT, null);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (/[{}()[\]]/.test(node.nodeValue)) {
          textNodes.push(node);
        }
      }

      for (let i = 0; i < textNodes.length; i++) {
        const textNode = textNodes[i];
        const text = textNode.nodeValue;
        const parts = text.split(/([{}()[\]])/);
        if (parts.length <= 1) continue;

        const frag = document.createDocumentFragment();
        for (let j = 0; j < parts.length; j++) {
          const part = parts[j];
          if (BRACKET_PAIRS[part]) {
            const span = document.createElement('span');
            span.className = 'code-bracket';
            span.textContent = part;
            frag.appendChild(span);
          } else if (part.length > 0) {
            frag.appendChild(document.createTextNode(part));
          }
        }
        textNode.parentNode.replaceChild(frag, textNode);
      }
    });
  }

  // Delegated click handler for bracket matching
  document.addEventListener('click', (e) => {
    const bracketEl = e.target.closest('.code-bracket');

    if (!bracketEl) {
      document.querySelectorAll('.code-bracket.bracket-active, .code-bracket.bracket-match').forEach((el) => {
        el.classList.remove('bracket-active', 'bracket-match');
      });
      return;
    }

    const codeEl = bracketEl.closest('pre code');
    if (!codeEl) return;

    if (bracketEl.classList.contains('bracket-active')) {
      document.querySelectorAll('.code-bracket.bracket-active, .code-bracket.bracket-match').forEach((el) => {
        el.classList.remove('bracket-active', 'bracket-match');
      });
      return;
    }

    document.querySelectorAll('.code-bracket.bracket-active, .code-bracket.bracket-match').forEach((el) => {
      el.classList.remove('bracket-active', 'bracket-match');
    });

    const allBrackets = Array.from(codeEl.querySelectorAll('.code-bracket'));
    const targetIdx = allBrackets.indexOf(bracketEl);
    if (targetIdx === -1) return;

    const char = bracketEl.textContent.trim();
    const isOpening = BRACKET_OPENINGS.has(char);
    const matchChar = BRACKET_PAIRS[char];
    if (!matchChar) return;

    let matchIdx = -1;
    let depth = 0;

    if (isOpening) {
      for (let i = targetIdx; i < allBrackets.length; i++) {
        const c = allBrackets[i].textContent.trim();
        if (c === char) depth++;
        else if (c === matchChar) {
          depth--;
          if (depth === 0) {
            matchIdx = i;
            break;
          }
        }
      }
    } else {
      for (let i = targetIdx; i >= 0; i--) {
        const c = allBrackets[i].textContent.trim();
        if (c === char) depth++;
        else if (c === matchChar) {
          depth--;
          if (depth === 0) {
            matchIdx = i;
            break;
          }
        }
      }
    }

    bracketEl.classList.add('bracket-active');
    if (matchIdx !== -1) {
      allBrackets[matchIdx].classList.add('bracket-match');
    }
  });

  function bindInteractions() {
    initBracketMatching();
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

        // 3. Tabbed code blocks switcher
    document.querySelectorAll('.code-tab-btn').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';

      btn.addEventListener('click', () => {
        const container = btn.closest('.code-tab-container');
        if (!container) return;

        const targetIndex = btn.getAttribute('data-tab');
        if (targetIndex === null) return;

        container.querySelectorAll('.code-tab-btn').forEach((b) => b.classList.remove('active'));
        container.querySelectorAll('.code-tab-panel').forEach((p) => p.classList.remove('active'));

        btn.classList.add('active');
        const targetPanel = container.querySelector(`.code-tab-panel[data-tab="${targetIndex}"]`);
        if (targetPanel) {
          targetPanel.classList.add('active');
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

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const card = btn.closest('.antigravity-diagram-card');
        const titleSpan = card ? card.querySelector('.diagram-type span') : null;
        const title = (titleSpan && titleSpan.textContent) ? titleSpan.textContent.trim() : 'Diagram Interactive View';

        // 1. PlantUML Card check
        if (card && card.classList.contains('plantuml-card')) {
          const targetId = btn.getAttribute('data-target');
          const img = card.querySelector('.plantuml-svg-img') || (targetId ? document.getElementById(targetId) : null);
          if (img) {
            openDiagramModal(img, title);
            return;
          }
        }

        // 2. Try Mermaid diagram body SVG
        const svg = getDiagramSvg(btn);
        if (svg) {
          openDiagramModal(svg, title);
          return;
        }

        // 3. Fallback to any image inside diagram body
        const img = card ? (card.querySelector('.diagram-body img') || card.querySelector('img')) : null;
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
        if (window.__agSearch && window.__agSearch.isOpen && window.__agSearch.isOpen()) {
          window.__agSearch.reapply();
        }
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
    const root = document.getElementById('markdownRoot');
    vscode.postMessage({
      command: 'print',
      html: root ? root.innerHTML : ''
    });
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
    if (isModalOpen) {
      fitModalDiagram();
    }
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

  // ==========================================================================
  // Diagram Annotation & Canvas Tools State (Desktop Pro Grade)
  // ==========================================================================
  let currentTool = 'pan'; // 'pan' | 'draw' | 'erase' | 'highlight' | 'shape' | 'arrow' | 'text'
  let currentColor = '#fb980c'; // default orange swatch as in reference
  let activeStrokeSize = 5; // 1 - 50 px, default 5
  let highlighterSize = 20; // default 20 px
  let currentShape = 'rect'; // 'rect' | 'circle' | 'ellipse' | 'line' | 'roundrect' | 'freeform'
  let activeFontSize = 16; // 8 - 72 px, default 16
  let fontStyle = { bold: false, italic: false, underline: false };

  let recentColors = ['#fb980c', '#ea1c24', '#1576fe', '#229b47', '#8437ef', '#a3e635', '#06b6d4', '#000000'];
  const defaultPalette = [
    '#ea1c24', '#f87171', '#fb980c', '#fbbf24', '#a3e635', '#229b47', '#10b981', '#06b6d4',
    '#1576fe', '#6366f1', '#8437ef', '#ec4899', '#78350f', '#000000', '#ffffff'
  ];

  let isDrawing = false;
  let isSpacePressed = false;
  let currentPreviewItem = null;
  let selectedItemId = null;
  let isMovingItem = false;
  let isResizingItem = false;
  let resizeHandleType = null;
  let itemDragStart = { x: 0, y: 0 };
  let itemInitialState = null;
  let hasItemModified = false;
  let eraseOccurred = false;
  let lastErasePos = null;

  let activePopoverId = null;
  let activePopoverAnchorEl = null;

  let currentDiagramKey = '';
  // Map diagramKey -> { items: Array<AnnotationItem>, history: Array<Array>, historyIndex: number }
  const diagramDataMap = new Map();

  let drawCanvas = null;
  let drawCtx = null;

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

  // Dock Elements
  const diagramModalDock = document.getElementById('diagramModalDock');
  const dockDragHandle = document.getElementById('dockDragHandle');
  const btnToolPan = document.getElementById('btnToolPan');
  const dockDividerCore = document.getElementById('dockDividerCore');
  const dockToolDrawWrapper = document.getElementById('dockToolDrawWrapper');
  const btnToolDraw = document.getElementById('btnToolDraw');
  const btnToolErase = document.getElementById('btnToolErase');
  const btnToolHighlight = document.getElementById('btnToolHighlight');
  const dockDividerShapes = document.getElementById('dockDividerShapes');
  const dockToolShapeWrapper = document.getElementById('dockToolShapeWrapper');
  const btnToolShape = document.getElementById('btnToolShape');
  const btnToolArrow = document.getElementById('btnToolArrow');
  const dockToolTextWrapper = document.getElementById('dockToolTextWrapper');
  const btnToolText = document.getElementById('btnToolText');
  const dockDividerColors = document.getElementById('dockDividerColors');
  const dockColorsGroup = document.getElementById('dockColorsGroup');
  const btnColorChevron = document.getElementById('btnColorChevron');
  const dockDividerActions = document.getElementById('dockDividerActions');
  const dockActionsGroup = document.getElementById('dockActionsGroup');
  const btnDrawUndo = document.getElementById('btnDrawUndo');
  const btnDrawRedo = document.getElementById('btnDrawRedo');
  const btnDrawDelete = document.getElementById('btnDrawDelete');
  const dockDividerExport = document.getElementById('dockDividerExport');
  const btnDrawExportPng = document.getElementById('btnDrawExportPng');
  const btnCopyPngLabel = document.getElementById('btnCopyPngLabel');
  const dockDividerMore = document.getElementById('dockDividerMore');
  const btnDockMore = document.getElementById('btnDockMore');
  const dockMoreDot = document.getElementById('dockMoreDot');

  // Popover Elements
  const popoverDraw = document.getElementById('popoverDraw');
  const popoverErase = document.getElementById('popoverErase');
  const popoverShapes = document.getElementById('popoverShapes');
  const popoverText = document.getElementById('popoverText');
  const popoverCustomColor = document.getElementById('popoverCustomColor');
  const popoverMore = document.getElementById('popoverMore');

  // Popover More Sub-elements
  const moreGroupTools = document.getElementById('moreGroupTools');
  const moreItemShape = document.getElementById('moreItemShape');
  const moreBadgeShape = document.getElementById('moreBadgeShape');
  const moreItemArrow = document.getElementById('moreItemArrow');
  const moreBadgeArrow = document.getElementById('moreBadgeArrow');
  const moreItemText = document.getElementById('moreItemText');
  const moreBadgeText = document.getElementById('moreBadgeText');
  const moreSepToolsColor = document.getElementById('moreSepToolsColor');
  const moreGroupColor = document.getElementById('moreGroupColor');
  const btnMoreColorChevron = document.getElementById('btnMoreColorChevron');
  const moreItemColor = document.getElementById('moreItemColor');
  const moreColorPreview = document.getElementById('moreColorPreview');
  const moreSepColorActions = document.getElementById('moreSepColorActions');
  const moreGroupActions = document.getElementById('moreGroupActions');
  const moreItemUndo = document.getElementById('moreItemUndo');
  const moreItemRedo = document.getElementById('moreItemRedo');
  const moreItemDelete = document.getElementById('moreItemDelete');
  const moreSepActionsExport = document.getElementById('moreSepActionsExport');
  const moreGroupExport = document.getElementById('moreGroupExport');
  const moreItemExportPng = document.getElementById('moreItemExportPng');
  const moreCopyPngLabel = document.getElementById('moreCopyPngLabel');

  // Inputs
  const drawStrokeNumber = document.getElementById('drawStrokeNumber');
  const drawStrokeSlider = document.getElementById('drawStrokeSlider');
  const eraseSizeNumber = document.getElementById('eraseSizeNumber');
  const eraseSizeSlider = document.getElementById('eraseSizeSlider');
  let activeEraserSize = 20;
  const textFontNumber = document.getElementById('textFontNumber');
  const textFontSlider = document.getElementById('textFontSlider');
  const btnFontBold = document.getElementById('btnFontBold');
  const btnFontItalic = document.getElementById('btnFontItalic');
  const btnFontUnderline = document.getElementById('btnFontUnderline');

  // Custom Color Picker
  const colorPickerSatVal = document.getElementById('colorPickerSatVal');
  const colorPickerHandle = document.getElementById('colorPickerHandle');
  const colorPickerHueBar = document.getElementById('colorPickerHueBar');
  const colorPickerHueThumb = document.getElementById('colorPickerHueThumb');
  const colorPickerPreview = document.getElementById('colorPickerPreview');
  const colorPickerHexInput = document.getElementById('colorPickerHexInput');
  let currentHue = 38;
  let currentSat = 0.96;
  let currentVal = 0.96;

  // Inline Canvas Text Editor
  const canvasInlineTextEditor = document.getElementById('canvasInlineTextEditor');

  function scheduleModalTransform() {
    if (modalRafId) return;
    modalRafId = requestAnimationFrame(() => {
      modalRafId = null;
      applyModalTransform();
    });
  }

  function applyModalTransform() {
    if (!modalCanvas) return;
    // Pure GPU compositor transform (translate3d) - zero CPU repaint for diagram
    modalCanvas.style.transform = `translate3d(${modalTranslate.x}px, ${modalTranslate.y}px, 0) scale(${modalScale})`;

    // Synchronize drawing annotations layer in real-time across unlimited viewport
    redrawAnnotations();

    // Only touch DOM text if zoom percentage integer actually changed
    const currentPercent = Math.round(modalScale * 100);
    if (modalZoomLevel && currentPercent !== lastRenderedScale) {
      lastRenderedScale = currentPercent;
      modalZoomLevel.textContent = `${currentPercent}%`;
    }
  }

  function fitModalDiagram() {
    if (!modalViewport || !modalCanvas) return;
    const vWidth = modalViewport.clientWidth || window.innerWidth;
    const vHeight = modalViewport.clientHeight || (window.innerHeight - 48);

    const padding = 80;
    const availW = Math.max(120, vWidth - padding);
    const availH = Math.max(100, vHeight - padding);

    const scaleX = availW / Math.max(1, currentDiagramWidth);
    const scaleY = availH / Math.max(1, currentDiagramHeight);
    modalScale = Math.min(scaleX, scaleY, 2.0);
    modalScale = Math.max(0.08, Math.min(10.0, modalScale));

    modalTranslate.x = Math.round((vWidth - currentDiagramWidth * modalScale) / 2);
    modalTranslate.y = Math.round((vHeight - currentDiagramHeight * modalScale) / 2);
    applyModalTransform();
  }

  function resetModalZoom() {
    if (!modalViewport) return;
    const vWidth = modalViewport.clientWidth || window.innerWidth;
    const vHeight = modalViewport.clientHeight || (window.innerHeight - 48);

    modalScale = 1.0;
    modalTranslate.x = Math.round((vWidth - currentDiagramWidth) / 2);
    modalTranslate.y = Math.round((vHeight - currentDiagramHeight) / 2);
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
      const rect = element.getBoundingClientRect();
      width = element.naturalWidth || Math.round(rect.width) || element.width || 800;
      height = element.naturalHeight || Math.round(rect.height) || element.height || 600;
      if (element.naturalWidth && element.naturalHeight) {
        width = element.naturalWidth;
        height = element.naturalHeight;
      } else if (rect.width > 50 && rect.height > 50) {
        width = Math.round(rect.width);
        height = Math.round(rect.height);
      }
      clone.style.width = `${width}px`;
      clone.style.height = `${height}px`;
      clone.style.maxWidth = 'none';
      clone.style.maxHeight = 'none';
      clone.style.display = 'block';

      // Auto re-fit if image finishes loading after modal opens
      clone.onload = () => {
        if (clone.naturalWidth && clone.naturalHeight) {
          currentDiagramWidth = clone.naturalWidth;
          currentDiagramHeight = clone.naturalHeight;
          modalCanvas.style.width = `${currentDiagramWidth}px`;
          modalCanvas.style.height = `${currentDiagramHeight}px`;
          fitModalDiagram();
        }
      };
    }

    currentDiagramWidth = Math.max(100, width);
    currentDiagramHeight = Math.max(80, height);

    modalCanvas.style.width = `${currentDiagramWidth}px`;
    modalCanvas.style.height = `${currentDiagramHeight}px`;
    modalCanvas.appendChild(clone);

    currentDiagramKey = element.id || (title.replace(/\s+/g, '_') + '_' + currentDiagramWidth + 'x' + currentDiagramHeight + '_' + (element.textContent ? element.textContent.trim().slice(0, 24) : ''));

    isModalOpen = true;
    document.body.classList.add('modal-open');
    document.documentElement.classList.add('modal-open');
    modalOverlay.classList.add('active');
    modalOverlay.setAttribute('aria-hidden', 'false');

    // Force reflow after display change from display:none to display:flex
    void modalOverlay.offsetHeight;
    
    // Initialize annotation canvas layer AFTER viewport is active and computed
    initDrawCanvas();
    fitModalDiagram();
    updateResponsiveDockLayout();

    // Re-fit and sync canvas in next frame to ensure geometry is 100% computed
    requestAnimationFrame(() => {
      if (isModalOpen) {
        syncCanvasSize();
        fitModalDiagram();
        updateResponsiveDockLayout();
      }
    });
  }

  function closeDiagramModal() {
    if (!modalOverlay) return;
    isModalOpen = false;
    isDraggingModal = false;

    if (modalViewport) {
      modalViewport.classList.remove('dragging');
    }

    if (diagramModalDock) {
      diagramModalDock.style.left = '';
      diagramModalDock.style.top = '';
      diagramModalDock.style.bottom = '';
      diagramModalDock.style.transform = '';
      diagramModalDock.classList.remove('dragging');
    }

    document.body.classList.remove('modal-open');
    document.documentElement.classList.remove('modal-open');

    modalOverlay.classList.remove('active');
    modalOverlay.setAttribute('aria-hidden', 'true');

    if (drawCanvas && drawCtx) {
      drawCtx.save();
      drawCtx.setTransform(1, 0, 0, 1, 0, 0);
      drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      drawCtx.restore();
    }

    if (modalCanvas) {
      modalCanvas.innerHTML = '';
      modalCanvas.style.transform = '';
      modalCanvas.style.width = '';
      modalCanvas.style.height = '';
    }
  }


  // ==========================================================================
  // ==========================================================================
  // Comprehensive Diagram Canvas & Annotation Engine (Desktop Pro Grade)
  // Supports: Pan, Draw (Smooth Bezier), Erase, Highlight, Shapes (Rect, Circle,
  // Ellipse, Line, Rounded Rect, Freeform), Arrow, Text, Custom Color Picker,
  // Undo/Redo Transactions, Object Moving/Resizing, and Retina PNG Export.
  // ==========================================================================

  function getDiagramData(key = currentDiagramKey) {
    if (!key) key = 'default_diagram';
    if (!diagramDataMap.has(key)) {
      diagramDataMap.set(key, {
        items: [],
        history: [[]],
        historyIndex: 0
      });
    }
    return diagramDataMap.get(key);
  }

  function pushHistory(newItems) {
    const data = getDiagramData();
    data.history = data.history.slice(0, data.historyIndex + 1);
    const snapshot = JSON.parse(JSON.stringify(newItems));
    data.history.push(snapshot);
    if (data.history.length > 50) {
      data.history.shift();
    }
    data.historyIndex = data.history.length - 1;
    data.items = JSON.parse(JSON.stringify(snapshot));
    updateUndoRedoState();
    updateDeleteButtonState();
  }

  function updateUndoRedoState() {
    const data = getDiagramData();
    const canUndo = data.historyIndex > 0;
    const canRedo = data.historyIndex < data.history.length - 1;
    if (btnDrawUndo) btnDrawUndo.disabled = !canUndo;
    if (btnDrawRedo) btnDrawRedo.disabled = !canRedo;
    if (moreItemUndo) moreItemUndo.disabled = !canUndo;
    if (moreItemRedo) moreItemRedo.disabled = !canRedo;
  }

  function updateDeleteButtonState() {
    const data = getDiagramData();
    const canDelete = data.items && data.items.length > 0;
    if (btnDrawDelete) {
      btnDrawDelete.disabled = !canDelete;
    }
    if (moreItemDelete) {
      moreItemDelete.disabled = !canDelete;
    }
  }

  function undo() {
    const data = getDiagramData();
    if (data.historyIndex > 0) {
      data.historyIndex--;
      data.items = JSON.parse(JSON.stringify(data.history[data.historyIndex]));
      selectedItemId = null;
      redrawAnnotations();
      updateUndoRedoState();
      updateDeleteButtonState();
      showModalToast('Undid action (Cmd+Z)');
    }
  }

  function redo() {
    const data = getDiagramData();
    if (data.historyIndex < data.history.length - 1) {
      data.historyIndex++;
      data.items = JSON.parse(JSON.stringify(data.history[data.historyIndex]));
      selectedItemId = null;
      redrawAnnotations();
      updateUndoRedoState();
      updateDeleteButtonState();
      showModalToast('Redid action (Cmd+Shift+Z)');
    }
  }

  function deleteSelectedItem() {
    const data = getDiagramData();
    if (data.items.length > 0) {
      data.items.pop();
      selectedItemId = null;
      pushHistory(data.items);
      redrawAnnotations();
      updateDeleteButtonState();
      updateUndoRedoState();
      showModalToast('Deleted annotation');
    }
  }

  // Tool Switching
  function setDrawingTool(tool) {
    currentTool = tool;

    // Toggle active state on dock buttons
    if (btnToolPan) btnToolPan.classList.toggle('active', tool === 'pan');
    if (btnToolDraw) btnToolDraw.classList.toggle('active', tool === 'draw');
    if (btnToolErase) btnToolErase.classList.toggle('active', tool === 'erase');
    if (btnToolHighlight) btnToolHighlight.classList.toggle('active', tool === 'highlight');
    if (btnToolShape) btnToolShape.classList.toggle('active', tool === 'shape');
    if (btnToolArrow) btnToolArrow.classList.toggle('active', tool === 'arrow');
    if (btnToolText) btnToolText.classList.toggle('active', tool === 'text');

    // Deselect active object when switching to creation tools
    if (tool !== 'pan' && selectedItemId) {
      selectedItemId = null;
      redrawAnnotations();
      updateDeleteButtonState();
    }

    updateDrawingCursor();
    updateResponsiveDockLayout();
  }

  function updateDrawingCursor() {
    if (!modalViewport || !drawCanvas) return;
    modalViewport.classList.remove(
      'mode-pan', 'mode-draw', 'mode-erase', 'mode-highlight',
      'mode-shape', 'mode-arrow', 'mode-text', 'space-panning'
    );

    if (isSpacePressed) {
      modalViewport.classList.add('space-panning');
      drawCanvas.style.pointerEvents = 'none';
      return;
    }

    drawCanvas.style.pointerEvents = 'auto';

    switch (currentTool) {
      case 'pan':
        modalViewport.classList.add('mode-pan');
        break;
      case 'draw':
        modalViewport.classList.add('mode-draw');
        break;
      case 'erase':
        modalViewport.classList.add('mode-erase');
        break;
      case 'highlight':
        modalViewport.classList.add('mode-highlight');
        break;
      case 'shape':
        modalViewport.classList.add('mode-shape');
        break;
      case 'arrow':
        modalViewport.classList.add('mode-arrow');
        break;
      case 'text':
        modalViewport.classList.add('mode-text');
        break;
      default:
        modalViewport.classList.add('mode-pan');
    }
  }

  // Canvas Geometry Synchronization
  function syncCanvasSize() {
    if (!drawCanvas || !modalViewport) return false;
    const rect = modalViewport.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);

    if (targetW <= 0 || targetH <= 0) return false;

    if (drawCanvas.width !== targetW || drawCanvas.height !== targetH) {
      drawCanvas.width = targetW;
      drawCanvas.height = targetH;
      drawCanvas.style.width = `${Math.round(rect.width)}px`;
      drawCanvas.style.height = `${Math.round(rect.height)}px`;
      drawCtx = drawCanvas.getContext('2d');
      return true;
    }
    return false;
  }

  function initDrawCanvas() {
    if (!modalViewport) return;
    drawCanvas = document.getElementById('diagramDrawCanvas');
    if (!drawCanvas) {
      drawCanvas = document.createElement('canvas');
      drawCanvas.className = 'diagram-draw-canvas';
      drawCanvas.id = 'diagramDrawCanvas';
      modalViewport.appendChild(drawCanvas);
    }

    syncCanvasSize();
    setupDrawCanvasPointerEvents();
    redrawAnnotations();
    updateDrawingCursor();
    updateUndoRedoState();
    updateDeleteButtonState();
    renderRecentColors();
    renderMoreColors();
    renderTextColors();
    updateCustomColorPickerUI();
  }

  function getUnscaledCoords(e) {
    if (!drawCanvas) return { x: 0, y: 0, screenX: e.clientX, screenY: e.clientY };
    const rect = drawCanvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    return {
      x: (screenX - modalTranslate.x) / modalScale,
      y: (screenY - modalTranslate.y) / modalScale,
      screenX: e.clientX,
      screenY: e.clientY
    };
  }

  // Bounding Box Calculation
  function getItemBounds(item) {
    if (!item) return { x: 0, y: 0, width: 0, height: 0 };
    if (item.type === 'stroke') {
      if (!item.points || item.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of item.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const pad = (item.size || 5) / 2;
      return { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 };
    }
    if (item.type === 'shape') {
      if (item.shapeType === 'freeform' && item.points && item.points.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of item.points) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        const pad = (item.strokeWidth || 3) / 2;
        return { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 };
      }
      const x = Math.min(item.x, item.x + item.width);
      const y = Math.min(item.y, item.y + item.height);
      const w = Math.abs(item.width);
      const h = Math.abs(item.height);
      return { x, y, width: w, height: h };
    }
    if (item.type === 'arrow') {
      const minX = Math.min(item.x1, item.x2);
      const minY = Math.min(item.y1, item.y2);
      const maxX = Math.max(item.x1, item.x2);
      const maxY = Math.max(item.y1, item.y2);
      const pad = 8;
      return { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 };
    }
    if (item.type === 'text') {
      return { x: item.x, y: item.y, width: item.width || 60, height: item.height || 20 };
    }
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  // Hit Testing
  function distToSegment(p, v, w) {
    const l2 = (v.x - w.x) * (v.x - w.x) + (v.y - w.y) * (v.y - w.y);
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  }

  function hitTestItem(item, pos, tolerance = 8) {
    if (!item) return false;
    const b = getItemBounds(item);
    if (
      pos.x < b.x - tolerance ||
      pos.x > b.x + b.width + tolerance ||
      pos.y < b.y - tolerance ||
      pos.y > b.y + b.height + tolerance
    ) {
      return false;
    }

    if (item.type === 'stroke') {
      const pts = item.points;
      if (!pts || pts.length === 0) return false;
      const r = (item.size || 5) / 2 + tolerance;
      if (pts.length === 1) {
        return Math.hypot(pos.x - pts[0].x, pos.y - pts[0].y) <= r;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(pos, pts[i], pts[i + 1]) <= r) return true;
      }
      return false;
    }

    if (item.type === 'shape') {
      if (item.shapeType === 'freeform' && item.points) {
        const pts = item.points;
        const r = (item.strokeWidth || 3) / 2 + tolerance;
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSegment(pos, pts[i], pts[i + 1]) <= r) return true;
        }
        return false;
      }
      if (item.shapeType === 'line') {
        const p1 = { x: item.x, y: item.y };
        const p2 = { x: item.x + item.width, y: item.y + item.height };
        return distToSegment(pos, p1, p2) <= (item.strokeWidth || 3) / 2 + tolerance;
      }
      // For rectangle, circle, ellipse, rounded rect: hit if within perimeter or interior
      return (
        pos.x >= b.x - tolerance &&
        pos.x <= b.x + b.width + tolerance &&
        pos.y >= b.y - tolerance &&
        pos.y <= b.y + b.height + tolerance
      );
    }

    if (item.type === 'arrow') {
      const p1 = { x: item.x1, y: item.y1 };
      const p2 = { x: item.x2, y: item.y2 };
      return distToSegment(pos, p1, p2) <= (item.strokeWidth || 3) / 2 + tolerance;
    }

    if (item.type === 'text') {
      return (
        pos.x >= b.x &&
        pos.x <= b.x + b.width &&
        pos.y >= b.y &&
        pos.y <= b.y + b.height
      );
    }

    return false;
  }

  // Point densification for smooth interpolation and precise partial erasing
  function densifyPoints(points, maxSpacing = 3) {
    if (!points || points.length <= 1) return points ? [...points] : [];
    const dense = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (dist > maxSpacing) {
        const steps = Math.ceil(dist / maxSpacing);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          dense.push({
            x: p1.x + (p2.x - p1.x) * t,
            y: p1.y + (p2.y - p1.y) * t
          });
        }
      }
      dense.push(p2);
    }
    return dense;
  }

  // Segment-level partial eraser: only erases intersecting points of freehand strokes
  function eraseAlongPath(pPrev, pCurr) {
    if (!pCurr) return false;
    const pStart = pPrev || pCurr;
    const data = getDiagramData();
    if (!data.items || data.items.length === 0) return false;

    const eraseRadius = Math.max(2, activeEraserSize / 2);
    let changed = false;
    const nextItems = [];

    const pad = eraseRadius + 30;
    const sweptMinX = Math.min(pStart.x, pCurr.x) - pad;
    const sweptMaxX = Math.max(pStart.x, pCurr.x) + pad;
    const sweptMinY = Math.min(pStart.y, pCurr.y) - pad;
    const sweptMaxY = Math.max(pStart.y, pCurr.y) + pad;

    for (const item of data.items) {
      // 1. Freehand strokes and freeform shapes: erase only intersecting path segments
      const isFreehand = item.type === 'stroke' || (item.type === 'shape' && item.shapeType === 'freeform');
      if (isFreehand && item.points && item.points.length > 0) {
        const b = getItemBounds(item);
        if (b.x > sweptMaxX || b.x + b.width < sweptMinX ||
            b.y > sweptMaxY || b.y + b.height < sweptMinY) {
          nextItems.push(item);
          continue;
        }

        const strokeWidth = item.size || item.strokeWidth || 4;
        const threshold = eraseRadius + strokeWidth / 2;
        const dense = densifyPoints(item.points, Math.max(1.5, 3 / modalScale));

        const keptSegments = [];
        let currentSegment = [];
        let itemErased = false;

        for (let i = 0; i < dense.length; i++) {
          const pt = dense[i];
          const dist = distToSegment(pt, pStart, pCurr);
          if (dist > threshold) {
            currentSegment.push(pt);
          } else {
            itemErased = true;
            if (currentSegment.length > 0) {
              keptSegments.push(currentSegment);
              currentSegment = [];
            }
          }
        }
        if (currentSegment.length > 0) {
          keptSegments.push(currentSegment);
        }

        if (!itemErased) {
          nextItems.push(item);
        } else {
          changed = true;
          for (const seg of keptSegments) {
            if (seg.length >= 2 || (seg.length === 1 && item.points.length === 1)) {
              nextItems.push({
                ...item,
                id: `${item.type}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                points: seg
              });
            }
          }
        }
        continue;
      }

      // 2. Atomic shapes (rect, circle, arrow, line, text): erase when path intersects
      const hitStart = hitTestItem(item, pStart, eraseRadius);
      const hitEnd = hitTestItem(item, pCurr, eraseRadius);
      const hitMid = hitTestItem(item, { x: (pStart.x + pCurr.x) / 2, y: (pStart.y + pCurr.y) / 2 }, eraseRadius);

      if (hitStart || hitEnd || hitMid) {
        changed = true;
      } else {
        nextItems.push(item);
      }
    }

    if (changed) {
      data.items = nextItems;
      eraseOccurred = true;
      redrawAnnotations();
      return true;
    }
    return false;
  }

  function eraseAtPoint(pos) {
    return eraseAlongPath(pos, pos);
  }

  // Color Utilities
  function hsvToRgb(h, s, v) {
    let r, g, b;
    const i = Math.floor((h / 60) % 6);
    const f = h / 60 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    switch (i) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }
    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255)
    };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function hexToHsv(hex) {
    let clean = hex.replace('#', '');
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    const num = parseInt(clean, 16);
    const r = ((num >> 16) & 255) / 255;
    const g = ((num >> 8) & 255) / 255;
    const b = (num & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max !== min) {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    return { h, s, v };
  }

  function setActiveColor(hex) {
    if (!hex || !/^#[0-9a-fA-F]{6}$/i.test(hex)) return;
    currentColor = hex.toLowerCase();

    // Deduplicate and push to recentColors (max 8)
    recentColors = [currentColor, ...recentColors.filter(c => c.toLowerCase() !== currentColor)].slice(0, 8);
    renderRecentColors();
    renderMoreColors();
    renderTextColors();

    // Update active ring on dock swatches
    const dockColorDots = document.querySelectorAll('#dockColors .color-dot');
    dockColorDots.forEach(dot => {
      const c = (dot.dataset.color || '').toLowerCase();
      dot.classList.toggle('active', c === currentColor);
    });

    const moreDots = document.querySelectorAll('#moreColorsRow .color-dot');
    moreDots.forEach(dot => {
      const c = (dot.dataset.color || '').toLowerCase();
      dot.classList.toggle('active', c === currentColor);
    });

    // Update custom color picker state
    const hsv = hexToHsv(currentColor);
    currentHue = hsv.h;
    currentSat = hsv.s;
    currentVal = hsv.v;
    updateCustomColorPickerUI();

    // If an object is currently selected, apply color immediately
    if (selectedItemId) {
      const data = getDiagramData();
      const item = data.items.find(i => i.id === selectedItemId);
      if (item) {
        item.color = currentColor;
        pushHistory(data.items);
        redrawAnnotations();
      }
    }
  }

  function updateCustomColorPickerUI() {
    if (!colorPickerSatVal || !colorPickerHandle || !colorPickerHueBar || !colorPickerHueThumb) return;
    colorPickerSatVal.style.backgroundColor = `hsl(${Math.round(currentHue)}, 100%, 50%)`;

    // Position handles
    colorPickerHandle.style.left = `${Math.round(currentSat * 100)}%`;
    colorPickerHandle.style.top = `${Math.round((1 - currentVal) * 100)}%`;
    colorPickerHueThumb.style.left = `${Math.round((currentHue / 360) * 100)}%`;
    colorPickerHueThumb.style.backgroundColor = `hsl(${Math.round(currentHue)}, 100%, 50%)`;

    if (colorPickerPreview) {
      colorPickerPreview.style.backgroundColor = currentColor;
    }
    if (colorPickerHexInput && document.activeElement !== colorPickerHexInput) {
      colorPickerHexInput.value = currentColor.replace('#', '').toUpperCase();
    }
  }

  function renderRecentColors() {
    const container = document.getElementById('drawRecentColors');
    if (!container) return;
    container.innerHTML = '';
    recentColors.forEach(color => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `swatch-dot ${color.toLowerCase() === currentColor.toLowerCase() ? 'active' : ''}`;
      dot.style.backgroundColor = color;
      dot.title = color;
      dot.setAttribute('aria-label', `Color ${color}`);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveColor(color);
      });
      container.appendChild(dot);
    });
  }

  function renderMoreColors() {
    const container = document.getElementById('drawMoreColors');
    if (!container) return;
    container.innerHTML = '';
    defaultPalette.forEach(color => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `swatch-dot ${color.toLowerCase() === currentColor.toLowerCase() ? 'active' : ''}`;
      dot.style.backgroundColor = color;
      dot.title = color;
      dot.setAttribute('aria-label', `Palette color ${color}`);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveColor(color);
      });
      container.appendChild(dot);
    });

    // Plus "+" button for Custom Color Picker
    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'btn-open-custom-color';
    plusBtn.title = 'Custom Color Picker';
    plusBtn.setAttribute('aria-label', 'Open custom color picker');
    plusBtn.innerHTML = '+';
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Anchor to the dock's Draw button so popoverCustomColor opens cleanly above the dock
      // instead of jumping to the top of the viewport when popoverDraw closes
      const anchor = (btnToolDraw && btnToolDraw.isConnected) ? btnToolDraw : plusBtn;
      togglePopover(popoverCustomColor, anchor);
    });
    container.appendChild(plusBtn);
  }

  function renderTextColors() {
    const container = document.getElementById('textColorsRow');
    if (!container) return;
    container.innerHTML = '';
    recentColors.forEach(color => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `swatch-dot ${color.toLowerCase() === currentColor.toLowerCase() ? 'active' : ''}`;
      dot.style.backgroundColor = color;
      dot.title = color;
      dot.setAttribute('aria-label', `Text color ${color}`);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        setActiveColor(color);
      });
      container.appendChild(dot);
    });
  }

  // Popovers Positioning & Lifecycle Management
  function closeAllPopovers() {
    [popoverDraw, popoverErase, popoverShapes, popoverText, popoverCustomColor, popoverMore].forEach(p => {
      if (p) p.style.display = 'none';
    });
    if (btnDockMore) btnDockMore.classList.remove('active');
    activePopoverId = null;
    activePopoverAnchorEl = null;
  }

  function togglePopover(popoverEl, anchorEl) {
    if (!popoverEl || !anchorEl || !modalViewport) return;
    if (activePopoverId === popoverEl.id && popoverEl.style.display !== 'none') {
      closeAllPopovers();
      return;
    }
    closeAllPopovers();
    popoverEl.style.display = 'block';
    activePopoverId = popoverEl.id;
    activePopoverAnchorEl = anchorEl;
    if ((popoverEl.id === 'popoverMore' || anchorEl === btnDockMore) && btnDockMore) {
      btnDockMore.classList.add('active');
    }
    positionActivePopover();
  }

  function positionActivePopover() {
    if (!activePopoverId || !activePopoverAnchorEl) return;
    const popoverEl = document.getElementById(activePopoverId);
    if (!popoverEl || popoverEl.style.display === 'none') return;

    let btnRect = activePopoverAnchorEl.getBoundingClientRect();
    const parentEl = popoverEl.offsetParent || modalOverlay || document.body;
    const parentRect = parentEl.getBoundingClientRect();

    // Guard: If anchor element is hidden or has 0 dimensions (e.g. child inside closed popover),
    // fallback to a visible dock button or the dock container
    if (btnRect.width === 0 && btnRect.height === 0) {
      if (btnToolDraw && btnToolDraw.getBoundingClientRect().width > 0) {
        btnRect = btnToolDraw.getBoundingClientRect();
      } else if (diagramModalDock && diagramModalDock.getBoundingClientRect().width > 0) {
        btnRect = diagramModalDock.getBoundingClientRect();
      }
    }

    const popW = popoverEl.offsetWidth || 200;
    const popH = popoverEl.offsetHeight || 220;

    const arrowEl = popoverEl.querySelector('.popover-arrow');
    const isAnchorNearBottom = (btnRect.top - parentRect.top) > (parentRect.height / 2);

    let popLeft = (btnRect.left + btnRect.width / 2) - parentRect.left - popW / 2;
    popLeft = Math.max(10, Math.min(parentRect.width - popW - 10, popLeft));
    popoverEl.style.left = `${Math.round(popLeft)}px`;

    const btnCenterX = (btnRect.left + btnRect.width / 2) - parentRect.left;
    const arrowLeft = Math.max(14, Math.min(popW - 26, btnCenterX - popLeft - 6));

    if (isAnchorNearBottom) {
      // Show ABOVE anchor with arrow pointing down (close 8px gap)
      const popTop = (btnRect.top - parentRect.top) - popH - 8;
      popoverEl.style.top = `${Math.round(popTop)}px`;
      if (arrowEl) {
        arrowEl.className = 'popover-arrow arrow-down';
        arrowEl.style.left = `${Math.round(arrowLeft)}px`;
      }
    } else {
      // Show BELOW anchor with arrow pointing up (close 8px gap)
      const popTop = (btnRect.bottom - parentRect.top) + 8;
      popoverEl.style.top = `${Math.round(popTop)}px`;
      if (arrowEl) {
        arrowEl.className = 'popover-arrow arrow-up';
        arrowEl.style.left = `${Math.round(arrowLeft)}px`;
      }
    }
  }

  // Pointer Events on Drawing Canvas
  let lastPointerScreen = { x: 0, y: 0 };
  let hasPointerMoved = false;

  function setupDrawCanvasPointerEvents() {
    if (!drawCanvas || drawCanvas.dataset.eventsAttached) return;
    drawCanvas.dataset.eventsAttached = 'true';

    drawCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || isSpacePressed) return;
      hasPointerMoved = false;
      eraseOccurred = false;
      hasItemModified = false;

      const pos = getUnscaledCoords(e);
      lastPointerScreen.x = e.clientX;
      lastPointerScreen.y = e.clientY;

      // Close popovers on canvas interaction
      closeAllPopovers();

      const data = getDiagramData();

      // Case 1: PAN MODE -> Allow smooth viewport panning
      if (currentTool === 'pan') {
        return;
      }

      // Case 2: ERASE MODE
      if (currentTool === 'erase') {
        e.preventDefault();
        e.stopPropagation();
        isDrawing = true;
        eraseOccurred = false;
        lastErasePos = { x: pos.x, y: pos.y };
        try { drawCanvas.setPointerCapture(e.pointerId); } catch (_) {}
        eraseAlongPath(pos, pos);
        return;
      }

      // Case 3: TEXT MODE
      if (currentTool === 'text') {
        e.preventDefault();
        e.stopPropagation();
        // Check if clicked existing text
        let clickedText = null;
        for (let i = data.items.length - 1; i >= 0; i--) {
          if (data.items[i].type === 'text' && hitTestItem(data.items[i], pos, 4)) {
            clickedText = data.items[i];
            break;
          }
        }
        if (clickedText) {
          openInlineTextEditor(clickedText, pos);
          return;
        }
        // Spawn new text
        openInlineTextEditor(null, pos);
        return;
      }

      // Case 4: DRAW / HIGHLIGHT / SHAPE / ARROW
      e.preventDefault();
      e.stopPropagation();
      isDrawing = true;
      try { drawCanvas.setPointerCapture(e.pointerId); } catch (_) {}

      if (currentTool === 'draw' || currentTool === 'highlight') {
        const size = currentTool === 'highlight' ? highlighterSize : activeStrokeSize;
        currentPreviewItem = {
          id: 'stroke_' + Math.random().toString(36).slice(2, 9),
          type: 'stroke',
          tool: currentTool,
          color: currentColor,
          size: size,
          points: [{ x: pos.x, y: pos.y }]
        };
      } else if (currentTool === 'shape') {
        currentPreviewItem = {
          id: 'shape_' + Math.random().toString(36).slice(2, 9),
          type: 'shape',
          shapeType: currentShape,
          color: currentColor,
          strokeWidth: activeStrokeSize,
          x: pos.x,
          y: pos.y,
          width: 0,
          height: 0,
          points: currentShape === 'freeform' ? [{ x: pos.x, y: pos.y }] : undefined
        };
      } else if (currentTool === 'arrow') {
        currentPreviewItem = {
          id: 'arrow_' + Math.random().toString(36).slice(2, 9),
          type: 'arrow',
          color: currentColor,
          strokeWidth: activeStrokeSize,
          x1: pos.x,
          y1: pos.y,
          x2: pos.x,
          y2: pos.y
        };
      }

      redrawAnnotations();
    });

    drawCanvas.addEventListener('pointermove', (e) => {
      // 1. Erase dragging
      if (isDrawing && currentTool === 'erase') {
        e.preventDefault();
        e.stopPropagation();
        const pos = getUnscaledCoords(e);
        eraseAlongPath(lastErasePos, pos);
        lastErasePos = { x: pos.x, y: pos.y };
        return;
      }

      // 4. Drawing / Shape preview dragging
      if (!isDrawing || !currentPreviewItem) return;
      e.preventDefault();
      e.stopPropagation();

      const dx = e.clientX - lastPointerScreen.x;
      const dy = e.clientY - lastPointerScreen.y;
      if (dx * dx + dy * dy < 1.0) return;
      lastPointerScreen.x = e.clientX;
      lastPointerScreen.y = e.clientY;
      hasPointerMoved = true;

      const pos = getUnscaledCoords(e);

      if (currentPreviewItem.type === 'stroke') {
        const pts = currentPreviewItem.points;
        if (pts.length > 0) {
          const last = pts[pts.length - 1];
          const dist = Math.hypot(pos.x - last.x, pos.y - last.y);
          if (dist > 3) {
            const steps = Math.ceil(dist / 3);
            for (let s = 1; s < steps; s++) {
              const t = s / steps;
              pts.push({
                x: last.x + (pos.x - last.x) * t,
                y: last.y + (pos.y - last.y) * t
              });
            }
          }
        }
        pts.push({ x: pos.x, y: pos.y });
      } else if (currentPreviewItem.type === 'shape') {
        if (currentPreviewItem.shapeType === 'freeform') {
          const pts = currentPreviewItem.points;
          if (pts && pts.length > 0) {
            const last = pts[pts.length - 1];
            const dist = Math.hypot(pos.x - last.x, pos.y - last.y);
            if (dist > 3) {
              const steps = Math.ceil(dist / 3);
              for (let s = 1; s < steps; s++) {
                const t = s / steps;
                pts.push({
                  x: last.x + (pos.x - last.x) * t,
                  y: last.y + (pos.y - last.y) * t
                });
              }
            }
          }
          currentPreviewItem.points.push({ x: pos.x, y: pos.y });
        } else {
          currentPreviewItem.width = pos.x - currentPreviewItem.x;
          currentPreviewItem.height = pos.y - currentPreviewItem.y;
        }
      } else if (currentPreviewItem.type === 'arrow') {
        currentPreviewItem.x2 = pos.x;
        currentPreviewItem.y2 = pos.y;
      }

      redrawAnnotations();
    });

    const finishPointerAction = (e) => {
      // 1. Erasing finish
      if (currentTool === 'erase' && isDrawing) {
        isDrawing = false;
        lastErasePos = null;
        try { drawCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
        if (eraseOccurred) {
          pushHistory(getDiagramData().items);
          updateUndoRedoState();
          updateDeleteButtonState();
        }
        return;
      }

      // 2. Drawing item finish
      if (!isDrawing) return;
      isDrawing = false;
      try { drawCanvas.releasePointerCapture(e.pointerId); } catch (_) {}

      if (currentPreviewItem) {
        const data = getDiagramData();
        let shouldCommit = false;

        if (currentPreviewItem.type === 'stroke') {
          shouldCommit = currentPreviewItem.points.length > 0;
        } else if (currentPreviewItem.type === 'shape') {
          if (currentPreviewItem.shapeType === 'freeform') {
            shouldCommit = currentPreviewItem.points && currentPreviewItem.points.length > 1;
          } else {
            shouldCommit = Math.hypot(currentPreviewItem.width, currentPreviewItem.height) > 4;
          }
        } else if (currentPreviewItem.type === 'arrow') {
          shouldCommit = Math.hypot(currentPreviewItem.x2 - currentPreviewItem.x1, currentPreviewItem.y2 - currentPreviewItem.y1) > 5;
        }

        if (shouldCommit) {
          data.items.push(currentPreviewItem);
          selectedItemId = null;
          currentPreviewItem = null;
          pushHistory(data.items);
        } else {
          currentPreviewItem = null;
        }

        redrawAnnotations();
        updateDeleteButtonState();
      }
    };

    drawCanvas.addEventListener('pointerup', finishPointerAction);
    drawCanvas.addEventListener('pointercancel', finishPointerAction);
  }

  // Inline Canvas Text Editor
  function openInlineTextEditor(existingItem, pos) {
    if (!canvasInlineTextEditor || !modalViewport) return;

    const screenX = (existingItem ? existingItem.x : pos.x) * modalScale + modalTranslate.x;
    const screenY = (existingItem ? existingItem.y : pos.y) * modalScale + modalTranslate.y;

    canvasInlineTextEditor.style.display = 'block';
    canvasInlineTextEditor.style.left = `${Math.round(screenX)}px`;
    canvasInlineTextEditor.style.top = `${Math.round(screenY)}px`;
    canvasInlineTextEditor.style.fontSize = `${Math.round((existingItem ? existingItem.fontSize : activeFontSize) * modalScale)}px`;
    canvasInlineTextEditor.style.fontWeight = (existingItem ? existingItem.bold : fontStyle.bold) ? '700' : '400';
    canvasInlineTextEditor.style.fontStyle = (existingItem ? existingItem.italic : fontStyle.italic) ? 'italic' : 'normal';
    canvasInlineTextEditor.style.textDecoration = (existingItem ? existingItem.underline : fontStyle.underline) ? 'underline' : 'none';
    canvasInlineTextEditor.style.color = existingItem ? existingItem.color : currentColor;
    canvasInlineTextEditor.value = existingItem ? existingItem.text : '';

    canvasInlineTextEditor.focus();
    if (existingItem) {
      canvasInlineTextEditor.select();
    }

    const commitText = () => {
      if (canvasInlineTextEditor.style.display === 'none') return;
      const text = canvasInlineTextEditor.value.trim();
      canvasInlineTextEditor.style.display = 'none';

      const data = getDiagramData();
      if (existingItem) {
        if (text.length === 0) {
          data.items = data.items.filter(i => i.id !== existingItem.id);
          selectedItemId = null;
        } else {
          existingItem.text = text;
          existingItem.width = Math.max(50, text.length * existingItem.fontSize * 0.65);
          existingItem.height = existingItem.fontSize * 1.35;
        }
        pushHistory(data.items);
      } else if (text.length > 0) {
        const textW = Math.max(50, text.length * activeFontSize * 0.65);
        const textH = activeFontSize * 1.35;
        const newItem = {
          id: 'text_' + Math.random().toString(36).slice(2, 9),
          type: 'text',
          text: text,
          color: currentColor,
          fontSize: activeFontSize,
          bold: fontStyle.bold,
          italic: fontStyle.italic,
          underline: fontStyle.underline,
          x: pos.x,
          y: pos.y,
          width: textW,
          height: textH
        };
        data.items.push(newItem);
        selectedItemId = null;
        pushHistory(data.items);
      }
      redrawAnnotations();
      updateDeleteButtonState();
    };

    canvasInlineTextEditor.onblur = commitText;
    canvasInlineTextEditor.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitText();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        canvasInlineTextEditor.style.display = 'none';
      }
    };
  }

  // Render Engine (Canvas)
  function redrawAnnotations(skipSelectionHandles = false) {
    if (!drawCanvas || !modalViewport) return;
    syncCanvasSize();
    if (!drawCtx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);

    drawCtx.save();
    drawCtx.setTransform(1, 0, 0, 1, 0, 0);
    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

    // Map into virtual diagram space
    drawCtx.setTransform(
      dpr * modalScale,
      0,
      0,
      dpr * modalScale,
      dpr * modalTranslate.x,
      dpr * modalTranslate.y
    );

    const data = getDiagramData();
    const allItems = currentPreviewItem ? [...data.items, currentPreviewItem] : data.items;

    // 1. Render all annotation items
    for (const item of allItems) {
      if (!item) continue;
      drawCtx.save();

      if (item.type === 'stroke') {
        const pts = item.points;
        if (!pts || pts.length === 0) { drawCtx.restore(); continue; }

        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';
        drawCtx.globalAlpha = item.tool === 'highlight' ? 0.35 : 1.0;
        drawCtx.lineWidth = item.size;
        drawCtx.strokeStyle = item.color;
        drawCtx.fillStyle = item.color;

        if (pts.length === 1) {
          drawCtx.beginPath();
          drawCtx.arc(pts[0].x, pts[0].y, item.size / 2, 0, Math.PI * 2);
          drawCtx.fill();
        } else if (pts.length === 2) {
          drawCtx.beginPath();
          drawCtx.moveTo(pts[0].x, pts[0].y);
          drawCtx.lineTo(pts[1].x, pts[1].y);
          drawCtx.stroke();
        } else {
          drawCtx.beginPath();
          drawCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length - 1; i++) {
            const midX = (pts[i].x + pts[i + 1].x) / 2;
            const midY = (pts[i].y + pts[i + 1].y) / 2;
            drawCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
          }
          drawCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
          drawCtx.stroke();
        }
      } else if (item.type === 'shape') {
        drawCtx.lineWidth = item.strokeWidth || 3;
        drawCtx.strokeStyle = item.color;
        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';

        if (item.shapeType === 'freeform' && item.points) {
          const pts = item.points;
          if (pts.length > 1) {
            drawCtx.beginPath();
            drawCtx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length - 1; i++) {
              const midX = (pts[i].x + pts[i + 1].x) / 2;
              const midY = (pts[i].y + pts[i + 1].y) / 2;
              drawCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
            }
            drawCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
            drawCtx.stroke();
          }
        } else if (item.shapeType === 'rect') {
          drawCtx.strokeRect(item.x, item.y, item.width, item.height);
        } else if (item.shapeType === 'circle') {
          const r = Math.hypot(item.width, item.height) / 2;
          const cx = item.x + item.width / 2;
          const cy = item.y + item.height / 2;
          drawCtx.beginPath();
          drawCtx.arc(cx, cy, Math.abs(r), 0, Math.PI * 2);
          drawCtx.stroke();
        } else if (item.shapeType === 'ellipse') {
          const cx = item.x + item.width / 2;
          const cy = item.y + item.height / 2;
          const rx = Math.abs(item.width / 2);
          const ry = Math.abs(item.height / 2);
          if (rx > 0 && ry > 0) {
            drawCtx.beginPath();
            drawCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            drawCtx.stroke();
          }
        } else if (item.shapeType === 'line') {
          drawCtx.beginPath();
          drawCtx.moveTo(item.x, item.y);
          drawCtx.lineTo(item.x + item.width, item.y + item.height);
          drawCtx.stroke();
        } else if (item.shapeType === 'roundrect') {
          const x = Math.min(item.x, item.x + item.width);
          const y = Math.min(item.y, item.y + item.height);
          const w = Math.abs(item.width);
          const h = Math.abs(item.height);
          const r = Math.min(12, w / 4, h / 4);
          drawCtx.beginPath();
          drawCtx.roundRect(x, y, w, h, r);
          drawCtx.stroke();
        }
      } else if (item.type === 'arrow') {
        drawCtx.lineWidth = item.strokeWidth || 3;
        drawCtx.strokeStyle = item.color;
        drawCtx.fillStyle = item.color;
        drawCtx.lineCap = 'round';
        drawCtx.lineJoin = 'round';

        // Draw main line
        drawCtx.beginPath();
        drawCtx.moveTo(item.x1, item.y1);
        drawCtx.lineTo(item.x2, item.y2);
        drawCtx.stroke();

        // Draw Arrowhead
        const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
        const headLen = Math.max(12, (item.strokeWidth || 3) * 3.5);
        drawCtx.beginPath();
        drawCtx.moveTo(item.x2, item.y2);
        drawCtx.lineTo(
          item.x2 - headLen * Math.cos(angle - Math.PI / 6),
          item.y2 - headLen * Math.sin(angle - Math.PI / 6)
        );
        drawCtx.lineTo(
          item.x2 - headLen * Math.cos(angle + Math.PI / 6),
          item.y2 - headLen * Math.sin(angle + Math.PI / 6)
        );
        drawCtx.closePath();
        drawCtx.fill();
      } else if (item.type === 'text') {
        const weight = item.bold ? '700' : '400';
        const style = item.italic ? 'italic' : 'normal';
        drawCtx.font = `${style} ${weight} ${item.fontSize || 16}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        drawCtx.fillStyle = item.color;
        drawCtx.textBaseline = 'top';
        drawCtx.fillText(item.text, item.x, item.y);

        if (item.underline) {
          const metrics = drawCtx.measureText(item.text);
          const textW = metrics.width;
          const lineY = item.y + (item.fontSize || 16) * 1.1;
          drawCtx.lineWidth = Math.max(1, (item.fontSize || 16) / 14);
          drawCtx.strokeStyle = item.color;
          drawCtx.beginPath();
          drawCtx.moveTo(item.x, lineY);
          drawCtx.lineTo(item.x + textW, lineY);
          drawCtx.stroke();
        }
      }

      drawCtx.restore();
    }



    drawCtx.restore();
  }

  // Toast Notification
  function showModalToast(msg) {
    if (!modalOverlay) return;
    let toast = document.getElementById('diagramDrawToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'diagramDrawToast';
      toast.className = 'draw-toast';
      modalOverlay.appendChild(toast);
    }
    toast.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg> <span>${msg}</span>`;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 2000);
  }

  // High-Resolution Retina PNG Export
  // SVG Sanitization for Canvas Rasterization without Tainting
  function prepareSvgForExport(originalSvg, width, height) {
    const clone = originalSvg.cloneNode(true);

    // 1. Convert all <foreignObject> elements to clean native SVG <text> elements
    // This is CRITICAL: Chromium security marks any canvas as tainted if it draws
    // an SVG containing <foreignObject>, causing canvas.toDataURL() to throw SecurityError.
    const foreignObjects = Array.from(clone.querySelectorAll('foreignObject'));
    const isDark = document.body.getAttribute('data-vscode-theme-kind') !== 'vscode-light';
    const defaultTextColor = isDark ? '#e6edf3' : '#1f2328';

    foreignObjects.forEach((fo, idx) => {
      const x = parseFloat(fo.getAttribute('x') || '0');
      const y = parseFloat(fo.getAttribute('y') || '0');
      const w = parseFloat(fo.getAttribute('width') || '0');
      const h = parseFloat(fo.getAttribute('height') || '0');

      // Find corresponding original element to read accurate computed styles
      const originalFos = originalSvg.querySelectorAll('foreignObject');
      const origFo = (idx < originalFos.length) ? originalFos[idx] : null;
      const sourceEl = (origFo && (origFo.querySelector('.nodeLabel') || origFo.querySelector('div') || origFo.querySelector('span'))) ||
                       fo.querySelector('.nodeLabel') || fo.querySelector('div') || fo.querySelector('span') || fo;

      let fontSize = '14px';
      let fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      let fontWeight = '500';
      let color = defaultTextColor;

      if (sourceEl) {
        try {
          const st = window.getComputedStyle(sourceEl);
          if (st.fontSize) fontSize = st.fontSize;
          if (st.fontFamily) fontFamily = st.fontFamily;
          if (st.fontWeight) fontWeight = st.fontWeight;
          if (st.color && st.color !== 'rgba(0, 0, 0, 0)') color = st.color;
        } catch (_) {}
      }

      const textContent = (fo.textContent || '').trim();
      if (!textContent) {
        fo.remove();
        return;
      }

      const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textEl.setAttribute('x', String(x + w / 2));
      textEl.setAttribute('y', String(y + h / 2));
      textEl.setAttribute('text-anchor', 'middle');
      textEl.setAttribute('dominant-baseline', 'central');
      textEl.setAttribute('alignment-baseline', 'middle');
      textEl.setAttribute('fill', color);
      textEl.setAttribute('font-size', fontSize);
      textEl.setAttribute('font-family', fontFamily);
      textEl.setAttribute('font-weight', fontWeight);

      const lines = textContent.split(/\r?\n|<br\s*\/?>/gi).filter(s => s.trim().length > 0);
      if (lines.length <= 1) {
        textEl.textContent = textContent;
      } else {
        const parsedSize = parseFloat(fontSize) || 14;
        const lineHeight = parsedSize * 1.25;
        const startY = (y + h / 2) - ((lines.length - 1) * lineHeight) / 2;
        lines.forEach((line, lineIdx) => {
          const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
          tspan.setAttribute('x', String(x + w / 2));
          tspan.setAttribute('y', String(startY + lineIdx * lineHeight));
          tspan.setAttribute('dominant-baseline', 'central');
          tspan.setAttribute('alignment-baseline', 'middle');
          tspan.textContent = line.trim();
          textEl.appendChild(tspan);
        });
      }

      if (fo.parentNode) {
        fo.parentNode.replaceChild(textEl, fo);
      }
    });

    // 2. Ensure XML namespaces and dimensions
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    if (!clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }

    // 3. Remove any @import in styles that would trigger cross-origin network fetch
    clone.querySelectorAll('style').forEach(s => {
      s.textContent = s.textContent.replace(/@import\s+url\([^)]+\);?/gi, '');
    });

    // 4. Inject diagram CSS rules if missing in the SVG clone
    if (!clone.querySelector('style')) {
      const docStyles = document.querySelectorAll('style[id*="mermaid"]');
      docStyles.forEach((s) => {
        if (s.textContent) {
          const cleanCss = s.textContent.replace(/@import\s+url\([^)]+\);?/gi, '');
          const styleTag = document.createElementNS('http://www.w3.org/2000/svg', 'style');
          styleTag.textContent = cleanCss;
          clone.insertBefore(styleTag, clone.firstChild);
        }
      });
    }

    // 5. Remove any external image elements that could taint canvas
    clone.querySelectorAll('image').forEach(img => {
      const href = img.getAttribute('href') || img.getAttribute('xlink:href') || '';
      if (href.startsWith('http://') || href.startsWith('https://')) {
        img.remove();
      }
    });

    return clone;
  }

  // High-Resolution Retina PNG Export
  async function exportAnnotatedDiagramPng() {
    if (!modalCanvas) return;
    const svgOrImg = modalCanvas.querySelector('svg, img');
    if (!svgOrImg) return;

    try {
      showModalToast('Rasterizing annotated diagram...');
      const scale = 2; // 2x crisp Retina output

      let minX = 0;
      let minY = 0;
      let maxX = currentDiagramWidth;
      let maxY = currentDiagramHeight;

      const data = getDiagramData();
      for (const item of data.items) {
        const b = getItemBounds(item);
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }

      const padding = 32;
      minX -= padding;
      minY -= padding;
      maxX += padding;
      maxY += padding;

      const exportWidth = Math.round(maxX - minX);
      const exportHeight = Math.round(maxY - minY);

      const offCanvas = document.createElement('canvas');
      offCanvas.width = Math.round(exportWidth * scale);
      offCanvas.height = Math.round(exportHeight * scale);
      const offCtx = offCanvas.getContext('2d');

      const isDark = document.body.getAttribute('data-vscode-theme-kind') !== 'vscode-light';
      offCtx.fillStyle = isDark ? '#0d1117' : '#ffffff';
      offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);

      const diagramOffsetX = -minX * scale;
      const diagramOffsetY = -minY * scale;

      // Draw Diagram without tainting canvas
      if (svgOrImg.tagName.toLowerCase() === 'svg') {
        const sanitizedSvg = prepareSvgForExport(svgOrImg, currentDiagramWidth, currentDiagramHeight);
        const svgXml = new XMLSerializer().serializeToString(sanitizedSvg);
        const img = new Image();
        const svgBlob = new Blob([svgXml], { type: 'image/svg+xml;charset=utf-8' });
        const blobUrl = URL.createObjectURL(svgBlob);
        await new Promise((resolve, reject) => {
          img.onload = () => {
            offCtx.drawImage(img, diagramOffsetX, diagramOffsetY, currentDiagramWidth * scale, currentDiagramHeight * scale);
            URL.revokeObjectURL(blobUrl);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(blobUrl);
            reject(new Error('Failed to load SVG into raster image'));
          };
          img.src = blobUrl;
        });
      } else {
        // For <img> tags, if cross-origin, attempt draw or fallback
        try {
          offCtx.drawImage(svgOrImg, diagramOffsetX, diagramOffsetY, currentDiagramWidth * scale, currentDiagramHeight * scale);
        } catch (_) {}
      }

      // Draw Annotations (Strokes, Shapes, Arrows, Text)
      offCtx.save();
      offCtx.translate(diagramOffsetX, diagramOffsetY);
      offCtx.scale(scale, scale);

      for (const item of data.items) {
        if (!item) continue;
        offCtx.save();

        if (item.type === 'stroke') {
          const pts = item.points;
          if (pts && pts.length > 0) {
            offCtx.lineCap = 'round';
            offCtx.lineJoin = 'round';
            offCtx.globalAlpha = item.tool === 'highlight' ? 0.35 : 1.0;
            offCtx.lineWidth = item.size;
            offCtx.strokeStyle = item.color;
            offCtx.fillStyle = item.color;

            if (pts.length === 1) {
              offCtx.beginPath();
              offCtx.arc(pts[0].x, pts[0].y, item.size / 2, 0, Math.PI * 2);
              offCtx.fill();
            } else if (pts.length === 2) {
              offCtx.beginPath();
              offCtx.moveTo(pts[0].x, pts[0].y);
              offCtx.lineTo(pts[1].x, pts[1].y);
              offCtx.stroke();
            } else {
              offCtx.beginPath();
              offCtx.moveTo(pts[0].x, pts[0].y);
              for (let i = 1; i < pts.length - 1; i++) {
                const midX = (pts[i].x + pts[i + 1].x) / 2;
                const midY = (pts[i].y + pts[i + 1].y) / 2;
                offCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
              }
              offCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
              offCtx.stroke();
            }
          }
        } else if (item.type === 'shape') {
          offCtx.lineWidth = item.strokeWidth || 3;
          offCtx.strokeStyle = item.color;
          offCtx.lineCap = 'round';
          offCtx.lineJoin = 'round';

          if (item.shapeType === 'freeform' && item.points) {
            const pts = item.points;
            if (pts.length > 1) {
              offCtx.beginPath();
              offCtx.moveTo(pts[0].x, pts[0].y);
              for (let i = 1; i < pts.length - 1; i++) {
                const midX = (pts[i].x + pts[i + 1].x) / 2;
                const midY = (pts[i].y + pts[i + 1].y) / 2;
                offCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
              }
              offCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
              offCtx.stroke();
            }
          } else if (item.shapeType === 'rect') {
            offCtx.strokeRect(item.x, item.y, item.width, item.height);
          } else if (item.shapeType === 'circle') {
            const r = Math.hypot(item.width, item.height) / 2;
            const cx = item.x + item.width / 2;
            const cy = item.y + item.height / 2;
            offCtx.beginPath();
            offCtx.arc(cx, cy, Math.abs(r), 0, Math.PI * 2);
            offCtx.stroke();
          } else if (item.shapeType === 'ellipse') {
            const cx = item.x + item.width / 2;
            const cy = item.y + item.height / 2;
            const rx = Math.abs(item.width / 2);
            const ry = Math.abs(item.height / 2);
            if (rx > 0 && ry > 0) {
              offCtx.beginPath();
              offCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
              offCtx.stroke();
            }
          } else if (item.shapeType === 'line') {
            offCtx.beginPath();
            offCtx.moveTo(item.x, item.y);
            offCtx.lineTo(item.x + item.width, item.y + item.height);
            offCtx.stroke();
          } else if (item.shapeType === 'roundrect') {
            const x = Math.min(item.x, item.x + item.width);
            const y = Math.min(item.y, item.y + item.height);
            const w = Math.abs(item.width);
            const h = Math.abs(item.height);
            const r = Math.min(12, w / 4, h / 4);
            offCtx.beginPath();
            offCtx.roundRect(x, y, w, h, r);
            offCtx.stroke();
          }
        } else if (item.type === 'arrow') {
          offCtx.lineWidth = item.strokeWidth || 3;
          offCtx.strokeStyle = item.color;
          offCtx.fillStyle = item.color;
          offCtx.lineCap = 'round';
          offCtx.lineJoin = 'round';

          offCtx.beginPath();
          offCtx.moveTo(item.x1, item.y1);
          offCtx.lineTo(item.x2, item.y2);
          offCtx.stroke();

          const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
          const headLen = Math.max(12, (item.strokeWidth || 3) * 3.5);
          offCtx.beginPath();
          offCtx.moveTo(item.x2, item.y2);
          offCtx.lineTo(
            item.x2 - headLen * Math.cos(angle - Math.PI / 6),
            item.y2 - headLen * Math.sin(angle - Math.PI / 6)
          );
          offCtx.lineTo(
            item.x2 - headLen * Math.cos(angle + Math.PI / 6),
            item.y2 - headLen * Math.sin(angle + Math.PI / 6)
          );
          offCtx.closePath();
          offCtx.fill();
        } else if (item.type === 'text') {
          const weight = item.bold ? '700' : '400';
          const style = item.italic ? 'italic' : 'normal';
          offCtx.font = `${style} ${weight} ${item.fontSize || 16}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          offCtx.fillStyle = item.color;
          offCtx.textBaseline = 'top';
          offCtx.fillText(item.text, item.x, item.y);

          if (item.underline) {
            const metrics = offCtx.measureText(item.text);
            const textW = metrics.width;
            const lineY = item.y + (item.fontSize || 16) * 1.1;
            offCtx.lineWidth = Math.max(1, (item.fontSize || 16) / 14);
            offCtx.strokeStyle = item.color;
            offCtx.beginPath();
            offCtx.moveTo(item.x, lineY);
            offCtx.lineTo(item.x + textW, lineY);
            offCtx.stroke();
          }
        }

        offCtx.restore();
      }

      offCtx.restore();

      // Export as PNG Data URL (Origin clean)
      const dataUrl = offCanvas.toDataURL('image/png');

      // Try browser clipboard API with Blob
      let copiedViaNavigator = false;
      if (offCanvas.toBlob && navigator.clipboard && window.ClipboardItem) {
        try {
          await new Promise((resolve, reject) => {
            offCanvas.toBlob(async (blob) => {
              if (!blob) return reject(new Error('No blob'));
              try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                copiedViaNavigator = true;
                resolve();
              } catch (e) {
                reject(e);
              }
            }, 'image/png');
          });
        } catch (_) {
          copiedViaNavigator = false;
        }
      }

      // Always notify extension host to write to system clipboard
      vscode.postMessage({ command: 'copyPng', dataUrl });
      vscode.postMessage({ command: 'copyImageToClipboard', dataUrl });

      // Visual feedback
      if (btnCopyPngLabel && btnDrawExportPng) {
        btnCopyPngLabel.textContent = 'Copied!';
        btnDrawExportPng.classList.add('copied');
        setTimeout(() => {
          btnCopyPngLabel.textContent = 'Copy PNG';
          btnDrawExportPng.classList.remove('copied');
        }, 1300);
      }
      showModalToast('Copied Diagram & Annotations to Clipboard!');
    } catch (err) {
      showModalToast('Failed to export PNG: ' + (err.message || err));
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

    // 1. Tool Selection Handlers
    if (btnToolPan) {
      btnToolPan.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        setDrawingTool('pan');
      });
    }

    if (btnToolDraw) {
      btnToolDraw.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentTool === 'draw') {
          togglePopover(popoverDraw, btnToolDraw);
        } else {
          setDrawingTool('draw');
          togglePopover(popoverDraw, btnToolDraw);
        }
      });
    }

    if (btnToolErase) {
      btnToolErase.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentTool === 'erase') {
          togglePopover(popoverErase, btnToolErase);
        } else {
          setDrawingTool('erase');
          togglePopover(popoverErase, btnToolErase);
        }
      });
    }

    // Erase Size Numeric & Slider 2-Way Sync
    if (eraseSizeSlider && eraseSizeNumber) {
      eraseSizeSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        activeEraserSize = Math.max(4, Math.min(100, parseInt(eraseSizeSlider.value) || 20));
        eraseSizeNumber.value = activeEraserSize;
      });

      eraseSizeNumber.addEventListener('input', (e) => {
        e.stopPropagation();
        const val = Math.max(4, Math.min(100, parseInt(eraseSizeNumber.value) || 20));
        activeEraserSize = val;
        eraseSizeSlider.value = val;
      });
    }

    if (btnToolHighlight) {
      btnToolHighlight.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        setDrawingTool('highlight');
      });
    }

    if (btnToolShape) {
      btnToolShape.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentTool === 'shape') {
          togglePopover(popoverShapes, btnToolShape);
        } else {
          setDrawingTool('shape');
          togglePopover(popoverShapes, btnToolShape);
        }
      });
    }

    if (btnToolArrow) {
      btnToolArrow.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        setDrawingTool('arrow');
      });
    }

    if (btnToolText) {
      btnToolText.addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentTool === 'text') {
          togglePopover(popoverText, btnToolText);
        } else {
          setDrawingTool('text');
          togglePopover(popoverText, btnToolText);
        }
      });
    }

    // 2. Stroke Size Numeric & Slider 2-Way Sync
    if (drawStrokeSlider && drawStrokeNumber) {
      drawStrokeSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        activeStrokeSize = Math.max(1, Math.min(50, parseInt(drawStrokeSlider.value) || 5));
        drawStrokeNumber.value = activeStrokeSize;
      });

      drawStrokeNumber.addEventListener('input', (e) => {
        e.stopPropagation();
        const val = Math.max(1, Math.min(50, parseInt(drawStrokeNumber.value) || 5));
        activeStrokeSize = val;
        drawStrokeSlider.value = val;
      });
    }

    // 3. Shape Picker Cards
    document.querySelectorAll('.shape-card').forEach(card => {
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.shape-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        currentShape = card.dataset.shape || 'rect';
        setDrawingTool('shape');
      });
    });

    // 4. Text Settings (Font Size 2-Way Sync & Font Styles)
    if (textFontSlider && textFontNumber) {
      textFontSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        activeFontSize = Math.max(8, Math.min(72, parseInt(textFontSlider.value) || 16));
        textFontNumber.value = activeFontSize;
      });

      textFontNumber.addEventListener('input', (e) => {
        e.stopPropagation();
        const val = Math.max(8, Math.min(72, parseInt(textFontNumber.value) || 16));
        activeFontSize = val;
        textFontSlider.value = val;
      });
    }

    if (btnFontBold) {
      btnFontBold.addEventListener('click', (e) => {
        e.stopPropagation();
        fontStyle.bold = !fontStyle.bold;
        btnFontBold.classList.toggle('active', fontStyle.bold);
      });
    }

    if (btnFontItalic) {
      btnFontItalic.addEventListener('click', (e) => {
        e.stopPropagation();
        fontStyle.italic = !fontStyle.italic;
        btnFontItalic.classList.toggle('active', fontStyle.italic);
      });
    }

    if (btnFontUnderline) {
      btnFontUnderline.addEventListener('click', (e) => {
        e.stopPropagation();
        fontStyle.underline = !fontStyle.underline;
        btnFontUnderline.classList.toggle('active', fontStyle.underline);
      });
    }

    // 5. Custom Color Picker (2D Sat/Val + Hue Slider + Hex Input)
    let isDraggingSatVal = false;
    let isDraggingHue = false;

    if (colorPickerSatVal && colorPickerHandle) {
      const updateSatValFromEvent = (e) => {
        const rect = colorPickerSatVal.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        currentSat = x / rect.width;
        currentVal = 1 - (y / rect.height);
        const rgb = hsvToRgb(currentHue, currentSat, currentVal);
        setActiveColor(rgbToHex(rgb.r, rgb.g, rgb.b));
      };

      colorPickerSatVal.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        isDraggingSatVal = true;
        try { colorPickerSatVal.setPointerCapture(e.pointerId); } catch (_) {}
        updateSatValFromEvent(e);
      });

      colorPickerSatVal.addEventListener('pointermove', (e) => {
        if (!isDraggingSatVal) return;
        e.stopPropagation();
        updateSatValFromEvent(e);
      });

      const stopSatVal = (e) => {
        if (isDraggingSatVal) {
          isDraggingSatVal = false;
          try { colorPickerSatVal.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      };
      colorPickerSatVal.addEventListener('pointerup', stopSatVal);
      colorPickerSatVal.addEventListener('pointercancel', stopSatVal);
    }

    if (colorPickerHueBar && colorPickerHueThumb) {
      const updateHueFromEvent = (e) => {
        const rect = colorPickerHueBar.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        currentHue = (x / rect.width) * 360;
        const rgb = hsvToRgb(currentHue, currentSat, currentVal);
        setActiveColor(rgbToHex(rgb.r, rgb.g, rgb.b));
      };

      colorPickerHueBar.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        isDraggingHue = true;
        try { colorPickerHueBar.setPointerCapture(e.pointerId); } catch (_) {}
        updateHueFromEvent(e);
      });

      colorPickerHueBar.addEventListener('pointermove', (e) => {
        if (!isDraggingHue) return;
        e.stopPropagation();
        updateHueFromEvent(e);
      });

      const stopHue = (e) => {
        if (isDraggingHue) {
          isDraggingHue = false;
          try { colorPickerHueBar.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      };
      colorPickerHueBar.addEventListener('pointerup', stopHue);
      colorPickerHueBar.addEventListener('pointercancel', stopHue);
    }

    if (colorPickerHexInput) {
      colorPickerHexInput.addEventListener('input', (e) => {
        e.stopPropagation();
        let val = colorPickerHexInput.value.replace(/[^0-9a-fA-F]/g, '');
        if (val.length === 6) {
          setActiveColor('#' + val);
        }
      });
    }

    // 6. Dock Swatches & Color Chevron
    document.querySelectorAll('#dockColors .color-dot').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        setActiveColor(dot.dataset.color || '#f59e0b');
        if (currentTool === 'pan' || currentTool === 'erase') {
          setDrawingTool('draw');
        }
      });
    });

    if (btnColorChevron) {
      btnColorChevron.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePopover(popoverCustomColor, btnColorChevron);
      });
    }

    // 7. Undo, Redo, Delete, Copy PNG Actions
    if (btnDrawUndo) {
      btnDrawUndo.addEventListener('click', (e) => {
        e.stopPropagation();
        undo();
      });
    }

    if (btnDrawRedo) {
      btnDrawRedo.addEventListener('click', (e) => {
        e.stopPropagation();
        redo();
      });
    }

    if (btnDrawDelete) {
      btnDrawDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSelectedItem();
      });
    }

    if (btnDrawExportPng) {
      btnDrawExportPng.addEventListener('click', (e) => {
        e.stopPropagation();
        exportAnnotatedDiagramPng();
      });
    }

    // 8. Dynamic Priority-Based Responsive Layout & Draggable Dock Handle (Mentok ke Sisi Bawah)
    let isDraggingDock = false;
    let dockDragOffset = { x: 0, y: 0 };

    const naturalItemWidths = {
      dragHandle: 28,
      pan: 72,
      dividerCore: 13,
      draw: 80,
      erase: 82,
      highlight: 94,
      dividerShapes: 13,
      shape: 82,
      arrow: 76,
      text: 72,
      dividerColors: 13,
      color: 150,
      dividerActions: 13,
      undo: 32,
      redo: 32,
      delete: 32,
      dividerExport: 13,
      exportPng: 106,
      dividerMore: 13,
      moreBtn: 38,
      dockPadding: 24
    };

    let hasSampledWidths = false;
    function sampleItemWidths() {
      if (hasSampledWidths || !diagramModalDock) return;
      try {
        if (dockDragHandle && dockDragHandle.offsetWidth) naturalItemWidths.dragHandle = dockDragHandle.offsetWidth + 4;
        if (btnToolPan && btnToolPan.offsetWidth) naturalItemWidths.pan = btnToolPan.offsetWidth + 4;
        if (dockToolDrawWrapper && dockToolDrawWrapper.offsetWidth) naturalItemWidths.draw = dockToolDrawWrapper.offsetWidth + 4;
        if (btnToolErase && btnToolErase.offsetWidth) naturalItemWidths.erase = btnToolErase.offsetWidth + 4;
        if (btnToolHighlight && btnToolHighlight.offsetWidth) naturalItemWidths.highlight = btnToolHighlight.offsetWidth + 4;
        if (dockToolShapeWrapper && dockToolShapeWrapper.offsetWidth) naturalItemWidths.shape = dockToolShapeWrapper.offsetWidth + 4;
        if (btnToolArrow && btnToolArrow.offsetWidth) naturalItemWidths.arrow = btnToolArrow.offsetWidth + 4;
        if (dockToolTextWrapper && dockToolTextWrapper.offsetWidth) naturalItemWidths.text = dockToolTextWrapper.offsetWidth + 4;
        if (dockColorsGroup && dockColorsGroup.offsetWidth) naturalItemWidths.color = dockColorsGroup.offsetWidth + 4;
        if (btnDrawUndo && btnDrawUndo.offsetWidth) naturalItemWidths.undo = btnDrawUndo.offsetWidth + 2;
        if (btnDrawRedo && btnDrawRedo.offsetWidth) naturalItemWidths.redo = btnDrawRedo.offsetWidth + 2;
        if (btnDrawDelete && btnDrawDelete.offsetWidth) naturalItemWidths.delete = btnDrawDelete.offsetWidth + 2;
        if (btnDrawExportPng && btnDrawExportPng.offsetWidth) naturalItemWidths.exportPng = btnDrawExportPng.offsetWidth + 4;
        if (btnDockMore && btnDockMore.offsetWidth) naturalItemWidths.moreBtn = btnDockMore.offsetWidth + 4;
        hasSampledWidths = true;
      } catch (_) {}
    }

    function updateResponsiveDockLayout() {
      if (!diagramModalDock || !modalOverlay) return;
      sampleItemWidths();

      const containerW = modalViewport ? modalViewport.clientWidth : (modalOverlay.clientWidth || window.innerWidth);
      const availWidth = Math.max(280, containerW - 32);

      const baseWidth = naturalItemWidths.dragHandle + naturalItemWidths.pan + naturalItemWidths.dividerCore +
        naturalItemWidths.draw + naturalItemWidths.erase + naturalItemWidths.highlight + naturalItemWidths.dockPadding;

      const allCollapsableWidth = naturalItemWidths.dividerShapes + naturalItemWidths.shape +
        naturalItemWidths.arrow + naturalItemWidths.text + naturalItemWidths.dividerColors +
        naturalItemWidths.color + naturalItemWidths.dividerActions + naturalItemWidths.undo +
        naturalItemWidths.redo + naturalItemWidths.delete + naturalItemWidths.dividerExport +
        naturalItemWidths.exportPng;

      const inMore = {
        shape: false,
        arrow: false,
        text: false,
        color: false,
        undo: false,
        redo: false,
        delete: false,
        exportPng: false
      };

      if (baseWidth + allCollapsableWidth <= availWidth) {
        // Everything fits comfortably in the toolbar
        if (dockToolShapeWrapper) dockToolShapeWrapper.style.display = '';
        if (btnToolArrow) btnToolArrow.style.display = '';
        if (dockToolTextWrapper) dockToolTextWrapper.style.display = '';
        if (dockColorsGroup) dockColorsGroup.style.display = '';
        if (dockActionsGroup) dockActionsGroup.style.display = '';
        if (btnDrawUndo) btnDrawUndo.style.display = '';
        if (btnDrawRedo) btnDrawRedo.style.display = '';
        if (btnDrawDelete) btnDrawDelete.style.display = '';
        if (btnDrawExportPng) btnDrawExportPng.style.display = '';

        if (dockDividerShapes) dockDividerShapes.style.display = '';
        if (dockDividerColors) dockDividerColors.style.display = '';
        if (dockDividerActions) dockDividerActions.style.display = '';
        if (dockDividerExport) dockDividerExport.style.display = '';

        if (dockDividerMore) dockDividerMore.style.display = 'none';
        if (btnDockMore) {
          btnDockMore.style.display = 'none';
          btnDockMore.classList.remove('has-active-tool');
        }
        if (dockMoreDot) dockMoreDot.style.display = 'none';

        if (activePopoverId === 'popoverMore') {
          closeAllPopovers();
        }
        return;
      }

      // Does not fit all: reserve space for More button and divider
      const remainingWidth = availWidth - (baseWidth + naturalItemWidths.dividerMore + naturalItemWidths.moreBtn);

      // Candidate retention priority (HIGHEST PRIORITY TO KEEP -> COLLAPSE FIRST):
      // 1. Active tool (Shape / Arrow / Text) if currently active (Preserve active tool visibility)
      // 2. exportPng (Copy PNG is primary action, retain if possible)
      // 3. shape (if not active)
      // 4. arrow (if not active)
      // 5. text (if not active)
      // 6. color
      // 7. delete
      // 8. undo
      // 9. redo (collapses first)
      const retentionOrder = [];
      if (['shape', 'arrow', 'text'].includes(currentTool)) {
        retentionOrder.push(currentTool);
      }
      retentionOrder.push('exportPng');
      ['shape', 'arrow', 'text'].forEach(t => {
        if (!retentionOrder.includes(t)) retentionOrder.push(t);
      });
      retentionOrder.push('color');
      retentionOrder.push('actions');

      const visibleInDock = {
        shape: false,
        arrow: false,
        text: false,
        color: false,
        actions: false,
        exportPng: false
      };

      let currentUsedWidth = 0;
      for (const itemKey of retentionOrder) {
        let itemCost = 0;
        if (['shape', 'arrow', 'text'].includes(itemKey)) {
          itemCost = naturalItemWidths[itemKey] || 0;
          const hasAnyCreationTool = visibleInDock.shape || visibleInDock.arrow || visibleInDock.text;
          if (!hasAnyCreationTool) itemCost += naturalItemWidths.dividerShapes;
        } else if (itemKey === 'color') {
          itemCost = naturalItemWidths.color + naturalItemWidths.dividerColors;
        } else if (itemKey === 'actions') {
          itemCost = naturalItemWidths.undo + naturalItemWidths.redo + naturalItemWidths.delete + naturalItemWidths.dividerActions;
        } else if (itemKey === 'exportPng') {
          itemCost = naturalItemWidths.exportPng + naturalItemWidths.dividerExport;
        }

        if (currentUsedWidth + itemCost <= remainingWidth) {
          currentUsedWidth += itemCost;
          visibleInDock[itemKey] = true;
        } else {
          visibleInDock[itemKey] = false;
          if (itemKey === 'actions') {
            inMore.undo = true;
            inMore.redo = true;
            inMore.delete = true;
          } else {
            inMore[itemKey] = true;
          }
        }
      }

      // Apply visibility to toolbar DOM
      if (dockToolShapeWrapper) dockToolShapeWrapper.style.display = visibleInDock.shape ? '' : 'none';
      if (btnToolArrow) btnToolArrow.style.display = visibleInDock.arrow ? '' : 'none';
      if (dockToolTextWrapper) dockToolTextWrapper.style.display = visibleInDock.text ? '' : 'none';

      const hasAnyCreation = visibleInDock.shape || visibleInDock.arrow || visibleInDock.text;
      if (dockDividerShapes) dockDividerShapes.style.display = hasAnyCreation ? '' : 'none';

      if (dockColorsGroup) dockColorsGroup.style.display = visibleInDock.color ? '' : 'none';
      if (dockDividerColors) dockDividerColors.style.display = visibleInDock.color ? '' : 'none';

      if (dockActionsGroup) dockActionsGroup.style.display = visibleInDock.actions ? '' : 'none';
      if (btnDrawUndo) btnDrawUndo.style.display = visibleInDock.actions ? '' : 'none';
      if (btnDrawRedo) btnDrawRedo.style.display = visibleInDock.actions ? '' : 'none';
      if (btnDrawDelete) btnDrawDelete.style.display = visibleInDock.actions ? '' : 'none';
      if (dockDividerActions) dockDividerActions.style.display = visibleInDock.actions ? '' : 'none';

      if (btnDrawExportPng) btnDrawExportPng.style.display = visibleInDock.exportPng ? '' : 'none';
      if (dockDividerExport) dockDividerExport.style.display = visibleInDock.exportPng ? '' : 'none';

      // Show More button & divider
      if (dockDividerMore) dockDividerMore.style.display = '';
      if (btnDockMore) btnDockMore.style.display = 'inline-flex';

      // Active tool inside More indicator
      const activeToolInMore = ['shape', 'arrow', 'text'].includes(currentTool) && inMore[currentTool];
      if (btnDockMore) btnDockMore.classList.toggle('has-active-tool', !!activeToolInMore);
      if (dockMoreDot) dockMoreDot.style.display = activeToolInMore ? 'block' : 'none';

      // Update Popover More Content
      // Group 1: Tools
      if (moreItemShape) {
        moreItemShape.style.display = inMore.shape ? 'flex' : 'none';
        moreItemShape.classList.toggle('active', currentTool === 'shape');
        if (moreBadgeShape) moreBadgeShape.style.display = currentTool === 'shape' ? 'inline' : 'none';
      }
      if (moreItemArrow) {
        moreItemArrow.style.display = inMore.arrow ? 'flex' : 'none';
        moreItemArrow.classList.toggle('active', currentTool === 'arrow');
        if (moreBadgeArrow) moreBadgeArrow.style.display = currentTool === 'arrow' ? 'inline' : 'none';
      }
      if (moreItemText) {
        moreItemText.style.display = inMore.text ? 'flex' : 'none';
        moreItemText.classList.toggle('active', currentTool === 'text');
        if (moreBadgeText) moreBadgeText.style.display = currentTool === 'text' ? 'inline' : 'none';
      }
      const hasToolsInMore = inMore.shape || inMore.arrow || inMore.text;
      if (moreGroupTools) moreGroupTools.style.display = hasToolsInMore ? 'flex' : 'none';

      // Group 2: Color Swatches Row (Matching Reference Exact UI)
      const hasColorInMore = inMore.color;
      if (moreGroupColor) moreGroupColor.style.display = hasColorInMore ? 'flex' : 'none';
      const moreDots = document.querySelectorAll('#moreColorsRow .color-dot');
      moreDots.forEach(dot => {
        const c = (dot.dataset.color || '').toLowerCase();
        dot.classList.toggle('active', c === currentColor.toLowerCase());
      });

      // Group 3: History & Delete
      if (moreItemUndo) moreItemUndo.style.display = inMore.undo ? 'flex' : 'none';
      if (moreItemRedo) moreItemRedo.style.display = inMore.redo ? 'flex' : 'none';
      if (moreItemDelete) moreItemDelete.style.display = inMore.delete ? 'flex' : 'none';
      const hasActionsInMore = inMore.undo || inMore.redo || inMore.delete;
      if (moreGroupActions) moreGroupActions.style.display = hasActionsInMore ? 'flex' : 'none';

      // Group 4: Copy PNG
      const hasExportInMore = inMore.exportPng;
      if (moreGroupExport) moreGroupExport.style.display = hasExportInMore ? 'block' : 'none';

      // Conditional Separators (only if both adjacent groups have items)
      if (moreSepToolsColor) {
        moreSepToolsColor.style.display = (hasToolsInMore && hasColorInMore) ? 'block' : 'none';
      }
      if (moreSepColorActions) {
        moreSepColorActions.style.display = ((hasToolsInMore || hasColorInMore) && hasActionsInMore) ? 'block' : 'none';
      }
      if (moreSepActionsExport) {
        moreSepActionsExport.style.display = ((hasToolsInMore || hasColorInMore || hasActionsInMore) && hasExportInMore) ? 'block' : 'none';
      }

      // Sync Undo/Redo/Delete disabled states
      updateUndoRedoState();
      updateDeleteButtonState();

      // Re-clamp position if custom left/top was set
      if (diagramModalDock.style.top && diagramModalDock.style.top !== 'auto') {
        const parentRect = modalOverlay.getBoundingClientRect();
        const dockRect = diagramModalDock.getBoundingClientRect();
        let left = parseFloat(diagramModalDock.style.left) || 0;
        let top = parseFloat(diagramModalDock.style.top) || 0;

        left = Math.max(4, Math.min(parentRect.width - dockRect.width - 4, left));
        top = Math.max(48, Math.min(parentRect.height - dockRect.height, top));

        diagramModalDock.style.left = `${Math.round(left)}px`;
        diagramModalDock.style.top = `${Math.round(top)}px`;
      }

      if (activePopoverId) {
        positionActivePopover();
      }
    }

    window.syncDockResponsiveLayout = updateResponsiveDockLayout;
    if (diagramModalDock && modalOverlay) {
      const onDockPointerDown = (e) => {
        // Do not initiate drag if clicking buttons, dots, or inputs
        if (e.target.closest('.dock-btn') || e.target.closest('.color-dot') || e.target.closest('.color-chevron-btn')) return;
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        isDraggingDock = true;
        if (dockDragHandle) dockDragHandle.classList.add('dragging');
        diagramModalDock.classList.add('dragging');
        try { e.target.setPointerCapture(e.pointerId); } catch (_) {}

        const dockRect = diagramModalDock.getBoundingClientRect();
        const parentRect = modalOverlay.getBoundingClientRect();
        dockDragOffset.x = e.clientX - dockRect.left;
        dockDragOffset.y = e.clientY - dockRect.top;
      };

      if (dockDragHandle) {
        dockDragHandle.addEventListener('pointerdown', onDockPointerDown);
      }
      diagramModalDock.addEventListener('pointerdown', onDockPointerDown);

      const onDockDragMove = (e) => {
        if (!isDraggingDock) return;
        e.preventDefault();
        e.stopPropagation();

        const parentRect = modalOverlay.getBoundingClientRect();
        const dockRect = diagramModalDock.getBoundingClientRect();

        let newLeft = e.clientX - parentRect.left - dockDragOffset.x;
        let newTop = e.clientY - parentRect.top - dockDragOffset.y;

        // Clamping boundaries:
        // Left & Right: 4px from screen edges
        const minX = 4;
        const maxX = Math.max(4, parentRect.width - dockRect.width - 4);

        // Top: below header (48px)
        // Bottom: maxY = parentRect.height - dockRect.height (MENTOK KE SISI BAWAH 0px!)
        const minY = 48;
        const maxY = parentRect.height - dockRect.height;

        newLeft = Math.max(minX, Math.min(maxX, newLeft));
        newTop = Math.max(minY, Math.min(maxY, newTop));

        diagramModalDock.style.left = `${Math.round(newLeft)}px`;
        diagramModalDock.style.top = `${Math.round(newTop)}px`;
        diagramModalDock.style.bottom = 'auto';
        diagramModalDock.style.transform = 'none';

        positionActivePopover();
      };

      const onDockDragEnd = (e) => {
        if (!isDraggingDock) return;
        isDraggingDock = false;
        if (dockDragHandle) dockDragHandle.classList.remove('dragging');
        diagramModalDock.classList.remove('dragging');
        try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
      };

      window.addEventListener('pointermove', onDockDragMove);
      window.addEventListener('pointerup', onDockDragEnd);
      window.addEventListener('pointercancel', onDockDragEnd);
      window.addEventListener('resize', updateResponsiveDockLayout);
    }

    // Dock Isolation from canvas pointerdown
    if (diagramModalDock) {
      diagramModalDock.addEventListener('pointerdown', (e) => e.stopPropagation());
      diagramModalDock.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    // Popovers Isolation
    [popoverDraw, popoverErase, popoverShapes, popoverText, popoverCustomColor, popoverMore].forEach(p => {
      if (p) {
        p.addEventListener('pointerdown', (e) => e.stopPropagation());
        p.addEventListener('mousedown', (e) => e.stopPropagation());
      }
    });

    // Popover More trigger & action handlers
    if (btnDockMore) {
      btnDockMore.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePopover(popoverMore, btnDockMore);
      });
    }

    if (moreItemShape) {
      moreItemShape.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        setDrawingTool('shape');
        togglePopover(popoverShapes, btnDockMore);
      });
    }

    if (moreItemArrow) {
      moreItemArrow.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        setDrawingTool('arrow');
      });
    }

    if (moreItemText) {
      moreItemText.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        setDrawingTool('text');
        togglePopover(popoverText, btnDockMore);
      });
    }

    const moreSwatches = document.querySelectorAll('#moreColorsRow .color-dot');
    moreSwatches.forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = dot.dataset.color;
        if (c) {
          setActiveColor(c);
          if (currentTool === 'pan' || currentTool === 'erase') {
            setDrawingTool('draw');
          }
        }
      });
    });

    if (btnMoreColorChevron) {
      btnMoreColorChevron.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        togglePopover(popoverCustomColor, btnDockMore);
      });
    }

    if (moreItemUndo) {
      moreItemUndo.addEventListener('click', (e) => {
        e.stopPropagation();
        undo();
      });
    }

    if (moreItemRedo) {
      moreItemRedo.addEventListener('click', (e) => {
        e.stopPropagation();
        redo();
      });
    }

    if (moreItemDelete) {
      moreItemDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSelectedItem();
        closeAllPopovers();
      });
    }

    if (moreItemExportPng) {
      moreItemExportPng.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllPopovers();
        exportAnnotatedDiagramPng();
      });
    }

    // ResizeObserver for Container Measurement
    if (window.ResizeObserver && modalViewport) {
      const dockResizeObserver = new ResizeObserver(() => {
        if (isModalOpen) {
          updateResponsiveDockLayout();
        }
      });
      dockResizeObserver.observe(modalViewport);
    }
    // Close popovers on click outside
    document.addEventListener('pointerdown', (e) => {
      if (!activePopoverId) return;
      if (e.target.closest('.dock-popover') || e.target.closest('.diagram-modal-dock')) return;
      closeAllPopovers();
    });

    if (modalBackdrop) {
      modalBackdrop.addEventListener('click', () => {
        closeDiagramModal();
      });
    }

    // Wheel zooming & panning
    modalViewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = modalViewport.getBoundingClientRect();
      const pointer = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };

      if (e.ctrlKey || e.metaKey || e.altKey) {
        const zoomSensitivity = 0.0035;
        const clampedDelta = Math.max(-35, Math.min(35, e.deltaY));
        const factor = Math.exp(-clampedDelta * zoomSensitivity);
        zoomModalAtPoint(pointer, factor);
        return;
      }

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

      // Two-finger pan
      const panDamping = 0.85;
      modalTranslate.x -= e.deltaX * panDamping;
      modalTranslate.y -= e.deltaY * panDamping;
      scheduleModalTransform();
    }, { passive: false });

    // Pointer Drag (Pan) with mouse or single-touch drag in Pan mode
    modalViewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.modal-control-btn') || e.target.closest('.modal-zoom-indicator-btn') || e.target.closest('.diagram-modal-dock') || e.target.closest('.dock-popover') || e.target.closest('.diagram-modal-info-wrapper')) return;
      if (currentTool !== 'pan' && !isSpacePressed) return;

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
        if (modalViewport) modalViewport.classList.remove('dragging');
      }
    });

    window.addEventListener('blur', () => {
      if (isDraggingModal) {
        isDraggingModal = false;
        if (modalViewport) modalViewport.classList.remove('dragging');
      }
    });

    // Double-click to toggle fit
    modalViewport.addEventListener('dblclick', (e) => {
      if (e.target.closest('.modal-control-btn') || e.target.closest('.modal-zoom-indicator-btn') || e.target.closest('.diagram-modal-dock') || e.target.closest('.dock-popover')) return;
      if (Math.abs(modalScale - 1.0) < 0.05) {
        fitModalDiagram();
      } else {
        resetModalZoom();
      }
    });

    // Spacebar temporary pan
    window.addEventListener('keyup', (e) => {
      if (!isModalOpen) return;
      if (e.code === 'Space') {
        isSpacePressed = false;
        updateDrawingCursor();
      }
    });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (!isModalOpen) return;

      const isInputActive = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

      if (e.code === 'Space' && !e.repeat && !isInputActive) {
        isSpacePressed = true;
        updateDrawingCursor();
        return;
      }

      // Undo: Cmd+Z / Ctrl+Z
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Redo: Cmd+Shift+Z / Ctrl+Shift+Z / Ctrl+Y / Cmd+Y
      const isRedoShortcut =
        ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && e.shiftKey) ||
        ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y'));

      if (isRedoShortcut) {
        e.preventDefault();
        redo();
        return;
      }

      // Delete last annotation: Backspace / Delete (if not typing in input)
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isInputActive) {
        const data = getDiagramData();
        if (data.items && data.items.length > 0) {
          e.preventDefault();
          deleteSelectedItem();
          return;
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (activePopoverId) {
          closeAllPopovers();
        } else {
          closeDiagramModal();
        }
        return;
      }

      if (isInputActive) return;

      // Tool shortcuts
      if (e.key === 'v' || e.key === 'V') {
        setDrawingTool('pan');
      } else if (e.key === 'p' || e.key === 'P') {
        setDrawingTool('draw');
      } else if (e.key === 'e' || e.key === 'E') {
        setDrawingTool('erase');
      } else if (e.key === 'h' || e.key === 'H') {
        setDrawingTool('highlight');
      } else if (e.key === 's' || e.key === 'S') {
        setDrawingTool('shape');
      } else if (e.key === 'a' || e.key === 'A') {
        setDrawingTool('arrow');
      } else if (e.key === 't' || e.key === 'T') {
        setDrawingTool('text');
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
  // ==========================================================================
  // In-Page Search Feature (Cmd + F Quick Find)
  // ==========================================================================
  function setupInPageSearch() {
    const searchOverlay = document.getElementById("searchOverlay");
    const searchInput = document.getElementById("searchInput");
    const searchMatchesCount = document.getElementById("searchMatchesCount");
    const btnSearchPrev = document.getElementById("btnSearchPrev");
    const btnSearchNext = document.getElementById("btnSearchNext");
    const btnSearchClose = document.getElementById("btnSearchClose");
    const btnOpenSearch = document.getElementById("btnOpenSearch");
    const inputWrapper = searchOverlay ? searchOverlay.querySelector(".search-input-wrapper") : null;

    if (!searchOverlay || !searchInput || !markdownRoot) return;

    let isSearchOpen = false;
    let matches = [];
    let activeMatchIndex = -1;
    let debounceTimer = null;

    function clearHighlights() {
      const existingMarks = markdownRoot.querySelectorAll("mark.ag-search-match");
      if (existingMarks.length === 0) {
        matches = [];
        activeMatchIndex = -1;
        return;
      }

      const parents = new Set();
      existingMarks.forEach(mark => {
        const parent = mark.parentNode;
        if (parent) {
          parents.add(parent);
          const textNode = document.createTextNode(mark.textContent || "");
          parent.replaceChild(textNode, mark);
        }
      });

      parents.forEach(p => p.normalize());
      matches = [];
      activeMatchIndex = -1;
    }

    function updateMatchCount() {
      if (!searchMatchesCount) return;
      if (matches.length === 0) {
        if (searchInput.value.trim().length > 0) {
          searchMatchesCount.textContent = "0/0";
          inputWrapper?.classList.add("no-match");
        } else {
          searchMatchesCount.textContent = "0/0";
          inputWrapper?.classList.remove("no-match");
        }
      } else {
        inputWrapper?.classList.remove("no-match");
        searchMatchesCount.textContent = (activeMatchIndex + 1) + "/" + matches.length;
      }
    }

    function updateActiveMatch(shouldScroll = true) {
      matches.forEach(m => m.classList.remove("current"));

      if (activeMatchIndex >= 0 && activeMatchIndex < matches.length) {
        const currentMark = matches[activeMatchIndex];
        currentMark.classList.add("current");
        updateMatchCount();

        if (shouldScroll) {
          currentMark.scrollIntoView({
            behavior: "smooth",
            block: "center",
            inline: "nearest"
          });
        }
      } else {
        updateMatchCount();
      }
    }

    function goToNextMatch() {
      if (matches.length === 0) return;
      activeMatchIndex = (activeMatchIndex + 1) % matches.length;
      updateActiveMatch(true);
    }

    function goToPrevMatch() {
      if (matches.length === 0) return;
      activeMatchIndex = (activeMatchIndex - 1 + matches.length) % matches.length;
      updateActiveMatch(true);
    }

    function performSearch(query, preserveIndex = false) {
      clearHighlights();
      const q = query ? query.trim() : "";
      if (!q) {
        updateMatchCount();
        return;
      }

      const queryLower = q.toLowerCase();
      const walker = document.createTreeWalker(
        markdownRoot,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function(node) {
            if (!node.nodeValue || !node.nodeValue.trim()) {
              return NodeFilter.FILTER_SKIP;
            }
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;

            const tag = parent.tagName.toUpperCase();
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "MARK") {
              return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest("svg") || parent.closest(".katex-mathml") || parent.closest(".diagram-actions") || parent.closest(".copy-code-btn") || parent.closest(".code-tab-nav")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      const matchedTextNodes = [];
      let currentNode;
      while ((currentNode = walker.nextNode())) {
        if (currentNode.nodeValue.toLowerCase().includes(queryLower)) {
          matchedTextNodes.push(currentNode);
        }
      }

      matchedTextNodes.forEach(textNode => {
        const parent = textNode.parentNode;
        if (!parent) return;

        const text = textNode.nodeValue;
        const textLower = text.toLowerCase();
        const fragment = document.createDocumentFragment();
        let lastIdx = 0;
        let matchIdx;

        while ((matchIdx = textLower.indexOf(queryLower, lastIdx)) !== -1) {
          if (matchIdx > lastIdx) {
            fragment.appendChild(document.createTextNode(text.substring(lastIdx, matchIdx)));
          }

          const mark = document.createElement("mark");
          mark.className = "ag-search-match";
          mark.textContent = text.substring(matchIdx, matchIdx + q.length);
          fragment.appendChild(mark);
          matches.push(mark);

          lastIdx = matchIdx + q.length;
        }

        if (lastIdx < text.length) {
          fragment.appendChild(document.createTextNode(text.substring(lastIdx)));
        }

        parent.replaceChild(fragment, textNode);
      });

      if (matches.length > 0) {
        if (preserveIndex && activeMatchIndex >= 0 && activeMatchIndex < matches.length) {
          updateActiveMatch(false);
        } else {
          activeMatchIndex = 0;
          updateActiveMatch(true);
        }
      } else {
        updateMatchCount();
      }
    }

    function openSearchBar(prefillSelected = true) {
      isSearchOpen = true;
      searchOverlay.style.display = "flex";
      searchOverlay.classList.remove("search-hidden");
      searchOverlay.setAttribute("aria-hidden", "false");
      btnOpenSearch?.classList.add("active-state");

      if (prefillSelected) {
        const selection = window.getSelection ? window.getSelection().toString().trim() : "";
        if (selection && selection.length <= 80 && !selection.includes("\n")) {
          searchInput.value = selection;
        }
      }

      searchInput.focus();
      searchInput.select();

      if (searchInput.value) {
        performSearch(searchInput.value);
      } else {
        updateMatchCount();
      }
    }

    function closeSearchBar() {
      if (!isSearchOpen) return;
      isSearchOpen = false;
      searchOverlay.style.display = "none";
      searchOverlay.classList.add("search-hidden");
      searchOverlay.setAttribute("aria-hidden", "true");
      btnOpenSearch?.classList.remove("active-state");
      clearHighlights();
      updateMatchCount();
    }

    function toggleSearchBar() {
      if (isSearchOpen) {
        closeSearchBar();
      } else {
        openSearchBar();
      }
    }

    // Input events
    searchInput.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        performSearch(searchInput.value);
      }, 50);
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          goToPrevMatch();
        } else {
          goToNextMatch();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        goToNextMatch();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        goToPrevMatch();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearchBar();
      }
    });

    btnSearchNext?.addEventListener("click", (e) => {
      e.preventDefault();
      goToNextMatch();
    });

    btnSearchPrev?.addEventListener("click", (e) => {
      e.preventDefault();
      goToPrevMatch();
    });

    btnSearchClose?.addEventListener("click", (e) => {
      e.preventDefault();
      closeSearchBar();
    });

    btnOpenSearch?.addEventListener("click", (e) => {
      e.preventDefault();
      toggleSearchBar();
    });

    // Global Keydown Handler for Cmd/Ctrl + F and Escape
    window.addEventListener("keydown", (e) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (isCmdOrCtrl && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        openSearchBar(true);
      } else if (e.key === "Escape" && isSearchOpen) {
        e.preventDefault();
        closeSearchBar();
      }
    });

    window.__agSearch = {
      open: openSearchBar,
      close: closeSearchBar,
      toggle: toggleSearchBar,
      next: goToNextMatch,
      prev: goToPrevMatch,
      perform: performSearch,
      reapply: () => {
        if (isSearchOpen && searchInput.value) {
          performSearch(searchInput.value, true);
        }
      },
      isOpen: () => isSearchOpen
    };
  }

  // Initial setup
  setupInPageSearch();
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
