/**
 * A small, dependency-free Markdown-to-HTML renderer for the chat panel.
 * It covers the subset the model is asked to use: headings, fenced/inline
 * code, tables, ordered/unordered lists (including nesting), blockquotes,
 * horizontal rules and inline emphasis/links. Output is XHTML-safe (attribute
 * URLs are quoted, content is escaped) and every structural element is emitted
 * as a complete block so downstream lines are never re-wrapped.
 */

interface MarkdownOptions {
  /** Text for the "copy" affordance on fenced code blocks. */
  copyLabel?: string;
}

interface ListItem {
  indent: number;
  ordered: boolean;
  content: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_match, label: string, url: string) =>
        `<a href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
}

function codeBlock(code: string, copyLabel: string): string {
  return (
    `<div class="zoteroai-codeblock">` +
    `<button type="button" class="zoteroai-code-copy">${copyLabel}</button>` +
    `<pre><code>${code}</code></pre>` +
    `</div>`
  );
}

/** Parse a |---|:---:|---:| separator row into per-cell alignment. */
function parseAlignment(separator: string): Array<"left" | "center" | "right"> {
  return separator
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => {
      const c = cell.trim();
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return "left";
    });
}

function renderTable(rows: string[]): string {
  const parsed = rows.map((row) =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim())),
  );
  if (parsed.length < 2) return "";
  const header = parsed[0];
  const body = parsed.slice(2);
  const align = parseAlignment(rows[1]);
  const cell = (html: string, i: number, tag: string) => {
    const style =
      align[i] && align[i] !== "left" ? ` style="text-align:${align[i]}"` : "";
    return `<${tag}${style}>${html}</${tag}>`;
  };
  const head = `<tr>${header.map((h, i) => cell(h, i, "th")).join("")}</tr>`;
  const rowsHTML = body
    .map((row) => `<tr>${row.map((c, i) => cell(c, i, "td")).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${rowsHTML}</tbody></table>`;
}

/** Render a contiguous block of list items with arbitrary nesting depth. */
function renderListBlock(items: ListItem[]): string {
  if (!items.length) return "";
  const root = items[0].ordered ? "ol" : "ul";
  let html = "";
  let i = 0;
  while (i < items.length) {
    const { indent, content } = items[i];
    html += `<li>${renderInline(content)}`;
    // Collect deeper items that belong to this <li>
    const children: ListItem[] = [];
    let j = i + 1;
    while (j < items.length && items[j].indent > indent) {
      children.push(items[j]);
      j++;
    }
    if (children.length) html += renderListBlock(children);
    html += `</li>`;
    i = j;
  }
  return `<${root}>${html}</${root}>`;
}

export function renderMarkdownHTML(
  text: string,
  options: MarkdownOptions = {},
): string {
  const copyLabel = options.copyLabel || "Copy";
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let quoteBuf: string[] = [];

  const closeQuote = () => {
    if (quoteBuf.length) {
      out.push(
        `<blockquote>${quoteBuf.map((l) => renderInline(l)).join("<br>")}</blockquote>`,
      );
      quoteBuf = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (/^```/.test(line)) {
      if (inCode) {
        out.push(codeBlock(escapeHtml(codeBuf.join("\n")), copyLabel));
        codeBuf = [];
        inCode = false;
      } else {
        closeQuote();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    if (!line) {
      closeQuote();
      continue;
    }

    // Table: header followed by a separator row of |---|:---:|---:|
    if (
      /^\|.*\|$/.test(line) &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())
    ) {
      closeQuote();
      const tableRows: string[] = [line];
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1].trim())) {
        i++;
        tableRows.push(lines[i].trim());
      }
      out.push(renderTable(tableRows));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeQuote();
      const level = Math.min(4, heading[1].length + 1);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      closeQuote();
      out.push("<hr>");
      continue;
    }

    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      quoteBuf.push(quote[1]);
      continue;
    }

    // Lists (ordered / unordered) with indentation-aware nesting.
    const listMatch = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      closeQuote();
      const block: ListItem[] = [];
      let j = i;
      while (j < lines.length) {
        const m = lines[j].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        block.push({
          indent: m[1].replace(/\t/g, "  ").length,
          ordered: /^\d/.test(m[2]),
          content: m[3],
        });
        j++;
      }
      i = j - 1;
      out.push(renderListBlock(block));
      continue;
    }

    closeQuote();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  if (inCode && codeBuf.length) {
    out.push(codeBlock(escapeHtml(codeBuf.join("\n")), copyLabel));
  }
  closeQuote();
  return out.join("\n");
}
