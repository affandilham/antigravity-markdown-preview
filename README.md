# Antigravity Markdown Preview

A rich, aesthetic, high-performance Markdown preview extension designed specifically for **Antigravity IDE** (and VS Code-compatible editors).

![Antigravity Preview](https://img.shields.io/badge/Antigravity-Ready-38bdf8?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

---

## Features

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

## License

Personal use / MIT.
