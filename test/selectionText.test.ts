import { assert } from "chai";
import { normalizeSelectedText } from "../src/modules/chatPanel";

describe("selected PDF text normalization", function () {
  it("joins visual line wraps but preserves paragraphs", function () {
    assert.equal(
      normalizeSelectedText("First visual\nline.\n\nSecond paragraph."),
      "First visual line.\n\nSecond paragraph.",
    );
  });

  it("repairs line-end hyphenation and soft hyphens", function () {
    assert.equal(
      normalizeSelectedText("inter-\nnational and soft\u00adhyphen"),
      "international and softhyphen",
    );
  });

  it("normalizes copied whitespace", function () {
    assert.equal(normalizeSelectedText("  A   B \r\n C  "), "A B C");
  });
});
