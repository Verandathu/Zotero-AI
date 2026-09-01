import { assert } from "chai";
import { renderMarkdownHTML } from "../src/utils/markdown";

describe("markdown renderer", function () {
  it("renders headings, inline emphasis and code in a paragraph", function () {
    const html = renderMarkdownHTML(
      "# Title\n\nSome **bold** and *italic* and `code`.",
    );
    assert.include(html, "<h2>Title</h2>");
    assert.include(html, "<strong>bold</strong>");
    assert.include(html, "<em>italic</em>");
    assert.include(html, "<code>code</code>");
  });

  it("preserves multi-line fenced code blocks verbatim", function () {
    const html = renderMarkdownHTML("```js\nconst a = 1;\nconst b = 2;\n```");
    assert.include(html, "<pre><code>const a = 1;\nconst b = 2;</code></pre>");
    assert.notInclude(html.split("const a = 1;")[1], "<p>");
  });

  it("renders ordered and unordered lists", function () {
    const html = renderMarkdownHTML("- one\n- two\n\n1. first\n2. second");
    assert.include(html, "<ul>");
    assert.include(html, "<li>one</li>");
    assert.include(html, "<li>two</li>");
    assert.include(html, "</ul>");
    assert.include(html, "<ol>");
    assert.include(html, "<li>first</li>");
    assert.include(html, "<li>second</li>");
    assert.include(html, "</ol>");
  });

  it("renders tables, blockquotes and horizontal rules", function () {
    const html = renderMarkdownHTML(
      "> quoted\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---",
    );
    assert.include(html, "<blockquote>quoted</blockquote>");
    assert.include(html, "<th>A</th><th>B</th>");
    assert.include(html, "<td>1</td><td>2</td>");
    assert.include(html, "<hr>");
  });

  it("escapes HTML and quotes in link URLs", function () {
    const html = renderMarkdownHTML(
      '<script>alert(1)</script> [x](https://a.com/"b)',
    );
    assert.notInclude(html, "<script>");
    assert.include(html, "&lt;script&gt;");
    assert.notInclude(html, 'href="https://a.com/"');
  });
});
