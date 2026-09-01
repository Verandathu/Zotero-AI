/**
 * A small, dependency-free Markdown-to-HTML renderer for the chat panel.
 * It covers the subset the model is asked to use: headings, fenced/inline
 * code, tables, ordered/unordered lists, blockquotes, horizontal rules and
 * inline emphasis/links. Output is XHTML-safe (attributes are URL-quoted and
 * every structural element is emitted as a complete block so downstream lines
 * are never re-wrapped).
 */

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

function renderTable(rows: string[]): string {
  const parsed = rows.map((row) =>
    row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim())),
  );
  if (!parsed.length) return "";
  const [header, , ...body] = parsed; // skip the |---|---| separator
  const head = `<tr>${header.map((cell) => `<th>${cell}</th>`).join("")}</tr>`;
  const rowsHTML = body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${rowsHTML}</tbody></table>`;
}

export function renderMarkdownHTML(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let quoteBuf: string[] = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
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
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
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
      closeList();
      closeQuote();
      continue;
    }

    // Table: header followed by a separator row of |---|:---:|---|
    if (
      /^\|.*\|$/.test(line) &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())
    ) {
      closeList();
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
      closeList();
      closeQuote();
      const level = Math.min(4, heading[1].length + 1);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      closeList();
      closeQuote();
      out.push("<hr>");
      continue;
    }

    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      quoteBuf.push(quote[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (unordered || ordered) {
      closeQuote();
      const type: "ul" | "ol" = unordered ? "ul" : "ol";
      if (listType !== type) {
        closeList();
        out.push(`<${type}>`);
        listType = type;
      }
      const content = unordered ? unordered[1] : ordered![1];
      out.push(`<li>${renderInline(content)}</li>`);
      continue;
    }

    closeList();
    closeQuote();
    out.push(`<p>${renderInline(line)}</p>`);
  }

  if (inCode && codeBuf.length) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  closeList();
  closeQuote();
  return out.join("\n");
}
