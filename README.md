<div align="center">
  <img src="https://raw.githubusercontent.com/affandilham/antigravity-markdown-preview/main/media/icon.png" width="96" height="96" alt="Antigravity Markdown Preview Icon" />
  <h1>Antigravity Markdown Preview</h1>
  <p>A fast, modern Markdown preview engine designed for <b>Antigravity IDE</b> and <b>VS Code</b>.</p>

  <p>
    <a href="https://marketplace.visualstudio.com/items?itemName=Affandilham.antigravity-markdown-preview"><img src="https://img.shields.io/badge/Marketplace-v0.1.0-007acc?style=flat-square" alt="Visual Studio Marketplace Version" /></a>
    <a href="https://open-vsx.org/extension/Affandilham/antigravity-markdown-preview"><img src="https://img.shields.io/open-vsx/v/Affandilham/antigravity-markdown-preview?style=flat-square&label=Open%20VSX&color=purple" alt="Open VSX Version" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License" /></a>
  </p>
</div>

---

## Overview

**Antigravity Markdown Preview** extends the built-in editor preview with a modern design system and advanced developer tooling. It bridges the gap between raw documentation and publishing-ready content by supporting diagrams, mathematical typesetting, interactive task management, and tabbed code blocks directly within the editor webview.

---

## Key Features

### 📊 Diagrams & Architecture
- **Mermaid Support**: Native client-side rendering for Flowcharts, Sequence diagrams, State machines, Class diagrams, ERDs, Gantt charts, and Mindmaps.
- **PlantUML Integration**: Zero-setup PlantUML rendering powered by deflate encoding and Kroki.
- **Fullscreen Lightbox**: Click any diagram to open an interactive zoom-and-pan modal.
- **Copy as PNG**: One-click diagram rasterization directly to the system clipboard at 2x resolution.

### 📐 Math & Typesetting
- **KaTeX Equations**: Fast LaTeX formula parsing for both inline (`$E = mc^2$`) and display block equations (`$$\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}$$`).
- **Escaped Currency Handling**: Built-in safeguards prevent normal currency notation (`$10 - $20`) from being incorrectly parsed as math blocks.

### ⚡ Interactive Workflows
- **Two-Way Task Lists**: Toggle `- [ ]` and `- [x]` checkboxes directly inside the preview; updates synchronize back to the markdown source file in real time.
- **In-Page Quick Search**: Press <kbd>Cmd</kbd> + <kbd>F</kbd> (or <kbd>Ctrl</kbd> + <kbd>F</kbd>) inside the preview to toggle a floating find bar with occurrence highlighting and keyboard navigation.
- **Collapsible Details**: Accessible accordions with smooth chevron rotation and clear section boundaries (`<details><summary>...</summary>...</details>`).
- **Sidebar Table of Contents**: Real-time outline tracking current reading position via scroll-spy.

### 💻 Code Presentation
- **Tabbed Code Blocks**: Group related code snippets across languages using clean tab headers.
- **Syntax Highlighting**: Pre-configured highlighting via `highlight.js` covering 190+ programming languages.
- **Code Block Utilities**: Display line numbers, language identifiers, and copy buttons on hover.

### 🏷️ GitHub-Flavored Markdown
- **Callout Alerts**: Full support for GitHub-style blockquote alerts:
  `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]`.
- **Keyboard Keys (`<kbd>`)**: Tactile, elevated keycap styling for documentation shortcuts.
- **Formatted Tables**: Responsive tables with zebra striping and horizontal overflow handling.

---

## Syntax Guide

### Tabbed Code Blocks
Group multi-language implementations with the `===` tab syntax:

````markdown
=== TypeScript
```typescript
const greeting: string = "Hello, Antigravity!";
console.log(greeting);
```

=== Dart
```dart
void main() {
  print("Hello, Antigravity!");
}
```

=== Python
```python
print("Hello, Antigravity!")
```
````

### GitHub Callout Alerts

```markdown
> [!NOTE]
> Informational callout highlighting background context.

> [!TIP]
> Practical advice to improve workflow efficiency.

> [!IMPORTANT]
> Critical step required for proper operation.

> [!WARNING]
> Advisory warning about edge cases or potential pitfalls.

> [!CAUTION]
> Safety-critical action requiring user attention.
```

### Interactive Task Lists

```markdown
- [x] Completed deliverable (synced)
- [ ] Pending task item (clickable in preview)
```

---

## Keyboard Shortcuts

| Command | macOS | Windows / Linux | Description |
| :--- | :--- | :--- | :--- |
| **Open Preview to Side** | <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd> | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd> | Opens the live preview panel in an adjacent editor column |
| **Open Preview in Active Tab** | <kbd>Cmd</kbd> + <kbd>K</kbd> <kbd>V</kbd> | <kbd>Ctrl</kbd> + <kbd>K</kbd> <kbd>V</kbd> | Opens the preview in the current column |
| **Quick Find inside Preview** | <kbd>Cmd</kbd> + <kbd>F</kbd> | <kbd>Ctrl</kbd> + <kbd>F</kbd> | Toggles the in-page search bar |
| **Print / Export PDF** | <kbd>Cmd</kbd> + <kbd>P</kbd> | <kbd>Ctrl</kbd> + <kbd>P</kbd> | Triggers the system print dialog from the preview |

---

## Settings

Settings can be customized in **Settings** (`Cmd+,` / `Ctrl+,`) under `Antigravity Markdown Preview`:

| Setting | Default | Description |
| :--- | :--- | :--- |
| `antigravity.markdownPreview.scrollSync` | `true` | Synchronize scrolling position between editor and preview |
| `antigravity.markdownPreview.codeLineNumbers` | `true` | Display line numbers inside code fences |
| `antigravity.markdownPreview.plantumlServer` | `https://kroki.io` | URL of the Kroki / PlantUML rendering endpoint |

---

## Installation

### From Marketplace
Search for `Antigravity Markdown Preview` in the Extensions view (<kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>X</kbd>) or install via command line:

```bash
# Visual Studio Marketplace
code --install-extension Affandilham.antigravity-markdown-preview

# Open VSX Registry (Antigravity IDE / VSCodium)
ovsx get Affandilham.antigravity-markdown-preview
```

---

## Development

```bash
# Clone the repository
git clone https://github.com/affandilham/antigravity-markdown-preview.git
cd antigravity-markdown-preview

# Install dependencies
npm install

# Compile in watch mode
npm run watch

# Production build
npm run build
```

---

## License

Distributed under the [MIT License](LICENSE). Copyright &copy; 2026 Affandilham (Mlkyjuicee).
