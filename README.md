# Antigravity Markdown Preview

A rich, aesthetic, high-performance Markdown preview extension designed specifically for **Antigravity IDE** (and VS Code-compatible editors).

![Antigravity Preview](https://img.shields.io/badge/Antigravity-Ready-38bdf8?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square)
[![Developer](https://img.shields.io/badge/Developer-Mlkyjuicee-10b981?style=flat-square&logo=github)](https://github.com/affandilham)
[![Telegram](https://img.shields.io/badge/Telegram-@affandilham-229ED9?style=flat-square&logo=telegram)](https://t.me/affandilham)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

---

## Features

- **In-Page Search (`Cmd + F` Quick Find)**: Floating search bar with live text highlighting, match counter (`X/Y`), auto-scroll navigation (`Enter` / `Shift + Enter`), and clean `Esc` dismiss.
- **Interactive Task Lists (2-Way Sync)**: Check and uncheck `- [ ]` / `- [x]` items directly in the preview, automatically updating the source markdown file in real-time.
- **Copy Diagram as PNG to Clipboard**: One-click rasterization of Mermaid and PlantUML diagrams into crisp 2x retina PNG directly into your OS system clipboard (ready to `Cmd + V` into Slack, Figma, or Notion).
- **Fullscreen Diagram Lightbox Modal**: Click the `⛶` button on any diagram to open a full-viewport modal with mouse-wheel zoom, drag-to-pan, and keyboard controls (`+`, `-`, `0`, `f`, `Esc`).
- **KaTeX / LaTeX Math Support**: Instant rendering of inline math (`$E = mc^2$`), block math (`$$`), and fenced math blocks with currency protection (`$10-$20`).
- **Tabbed Code Blocks**: Clean multi-language tabbed panels (`=== Tab Title`) with smooth switching and isolated copy buttons.
- **3D Skeuomorphic Keyboard Keys (`<kbd>`)**: Tactile, elevated keyboard keycap design with drop shadows, bevels, and pressed-down click effect.
- **GitHub-Style Alerts**: Native support for `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]` with custom glowing SVG accents.
- **Rich Code Blocks**: Syntax highlighting via `highlight.js` (190+ languages), line numbering, macOS window dots, language badges, and single-click copy buttons.
- **Collapsible Sections**: Native `<details><summary>` and custom block syntax `::: details Title ... :::`.
- **Horizontal Rule (HR)**: Beautiful typography gradient divider with subtle center badge.
- **Embedded Media & Views**: Responsive embedding for YouTube videos, HTML5 `<video>`, `<audio>`, and web iframes.
- **Interactive Mermaid Diagrams**: Instant client-side SVG rendering for Flowcharts, Sequence diagrams, Class diagrams, State diagrams, Gantt charts, Mindmaps, and Git graphs. Includes "Copy Definition" and "Save SVG" actions.
- **PlantUML Diagrams**: Zero-configuration PlantUML rendering via built-in deflate encoder and Kroki SVG generation.
- **Table of Contents (TOC)**:
  - Inline `[TOC]` or `[[toc]]` generation.
  - Collapsible interactive Sidebar/Drawer TOC with scroll-spy tracking of active headings.
- **Responsive Tables**: GFM table support with alternating zebra stripes, rounded borders, overflow scroll wrapper, and "Copy Table as TSV" functionality.
- **Live Sync & Glassmorphism Toolbar**:
  - Real-time live update with debounced editing.
  - Editor-to-preview scroll synchronization.
  - Zoom in/out/reset controls.
  - One-click export to standalone HTML or Print to PDF.
  - Document word count and estimated reading time.

---

## Keyboard Shortcuts & Commands

| Action | Shortcut (macOS) | Shortcut (Win/Linux) | Command ID |
| :----- | :--------------- | :------------------- | :--------- |
| Open Preview to the Side | `Cmd+Shift+V` / `Cmd+K V` | `Ctrl+Shift+V` / `Ctrl+K V` | `antigravity.markdownPreview.openToSide` |
| Open Preview in Active Tab | - | - | `antigravity.markdownPreview.open` |
| Export Standalone HTML | - | - | `antigravity.markdownPreview.exportHtml` |

---

## Installation & Setup

### Local Install to Antigravity IDE

To compile and link the extension directly into your local Antigravity IDE:

```bash
cd /Users/mlkyjuicee/Documents/antigravity-markdown-preview
npm install
npm run install-extension
```

Then reload Antigravity IDE:
1. Press `Cmd+Shift+P` (or `F1`).
2. Type `Developer: Reload Window` and press Enter.
3. Open any `.md` file (or `demo.md`) and press `Cmd+Shift+V`!

---

## Extension Settings

Configure via **Settings** (`Cmd+,`) -> Search `Antigravity Markdown Preview`:

- `antigravity.markdownPreview.scrollSync`: Enable or disable scroll synchronization between editor and preview (default: `true`).
- `antigravity.markdownPreview.plantumlServer`: Server URL for PlantUML rendering (default: `https://kroki.io`).
- `antigravity.markdownPreview.codeLineNumbers`: Show line numbers in code blocks (default: `true`).

---

## Development & Building

```bash
# Compile TypeScript with esbuild in watch mode
npm run watch

# Production bundle
npm run build
```

---

## 👨‍💻 Author & Maintainer

**Mlkyjuicee**
- 🐙 GitHub: [@affandilham](https://github.com/affandilham)
- ✈️ Telegram: [@affandilham](https://t.me/affandilham)

Developed with ❤️ for high-performance documentation and engineering workflows on Antigravity IDE.

---

## License

MIT License © 2026 Mlkyjuicee.
