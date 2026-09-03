# Zotero AI

[![Zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License](https://img.shields.io/badge/License-AGPL--3.0-orange?style=flat-square)](LICENSE)

An AI assistant embedded in [Zotero](https://www.zotero.org) 7, with a Gemini-inspired chat interface. Chat with the paper you are currently reading, ask questions that span multiple papers in your library, and get grounded answers with full-text context — without leaving Zotero.

## Features

- **Context-aware chat** — Ask about the paper you are viewing. Its title, metadata, abstract and (optionally) full text are injected as context automatically.
- **Reader + library integration** — The chat lives in the item pane and in the reader's left sidebar, so it follows whatever you are reading.
- **Full-text analysis** — Toggle the paper's full text on/off; a live meter shows context-window usage.
- **Cross-document research (agentic)** — Mention other papers and the assistant searches your Zotero library for them, injects their abstract/full text, and falls back to a web (Crossref) lookup when a reference is not in your library.
- **Conversation history** — Persistent, searchable and filterable by paper; rename, regenerate, edit messages, and delete with undo.
- **Auto-generated titles** — Conversation titles are summarized by the model, Gemini-style.
- **Prompt presets** — One-click prompts for summarizing, extracting key points, methods analysis, explaining a selection, and translating.
- **Insert selection** — Quote the currently selected PDF text straight into the composer.
- **Rich Markdown** — Headings, ordered/unordered and nested lists, tables, code blocks with a copy button, blockquotes and links.
- **Streaming with reasoning** — Responses stream in real time; reasoning models show a collapsible "thinking" panel.
- **Any OpenAI-compatible API** — Works with OpenAI, DeepSeek, SiliconFlow, OpenRouter, Ollama, one-api, etc.
- **i18n & dark mode** — English and Simplified Chinese UI, with automatic dark-mode theming.

## Installation

### From a release

1. Download the latest `.xpi` from the [Releases](https://github.com/Verandathu/Zotero-AI/releases) page.
2. In Zotero, go to _Tools → Plugins → ⚙️ → Install Plugin From File…_ and select the `.xpi`.

### From source

```sh
npm install
npm run build
```

The built `.xpi` is written to `.scaffold/build/`.

## Configuration

After installation, open _Tools → Plugins → Zotero AI → Options_ (or _Preferences → Zotero AI_):

| Setting                       | Description                                                      |
| ----------------------------- | ---------------------------------------------------------------- |
| **Base URL**                  | OpenAI-compatible API endpoint, e.g. `https://api.openai.com/v1` |
| **API Key**                   | Your API key                                                     |
| **Model**                     | Model name, e.g. `gpt-4o-mini`                                   |
| **Temperature**               | Sampling temperature (0–2)                                       |
| **Max tokens**                | Output token cap (0 = unlimited)                                 |
| **Include full text**         | Inject the paper's full text into the context                    |
| **Full text character limit** | Cap on full-text characters (0 = unlimited)                      |
| **Context window**            | Model context-window size in tokens (default 128K)               |
| **System prompt**             | Custom system prompt (empty = built-in default)                  |
| **Quick prompts**             | JSON array of `{ label, prompt, forSelection? }`                 |
| **Cross-document research**   | Automatically find referenced papers (library first, then web)   |
| **Max referenced works**      | Cap on how many references to resolve per message                |

## Usage

1. Open a PDF in the reader, or select an item in the library.
2. Open the **AI Chat** pane (item pane) or the **Zotero AI** view in the reader sidebar.
3. Type a question, or pick a prompt preset.
4. Use the history drawer (☰) to switch, search, rename, or delete conversations.

> **Tip:** Select a passage in the PDF, then click the quote button (❝) to insert it into your question.

## Development

```sh
npm install       # install dependencies
cp .env.example .env   # then fill in your Zotero binary/profile paths
npm start         # start Zotero with the plugin, with hot reload
npm run build     # build the production .xpi
npm run lint:check  # lint + format check
npm test          # run the plugin tests (requires a Zotero test environment)
```

## License

[GNU Affero General Public License v3.0](LICENSE).

---

Built on the [Zotero plugin template](https://github.com/windingwind/zotero-plugin-template) and [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold).
