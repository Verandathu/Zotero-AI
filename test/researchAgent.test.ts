import { assert } from "chai";
import { extractReferences } from "../src/modules/researchAgent";

describe("reference extraction", function () {
  it("extracts quoted titles", function () {
    const refs = extractReferences('Compare "Attention Is All You Need".');
    assert.deepEqual(refs, ["Attention Is All You Need"]);
  });

  it("extracts author-year citations", function () {
    const refs = extractReferences("See Vaswani et al., 2017 for details.");
    assert.deepEqual(refs, ["Vaswani et al. (2017)"]);
  });

  it("extracts Title Case (Year) references", function () {
    const refs = extractReferences(
      "The Transformer Architecture (2017) introduced attention.",
    );
    assert.deepEqual(refs, ["The Transformer Architecture (2017)"]);
  });

  it("deduplicates and caps the list", function () {
    const repeated = Array.from(
      { length: 12 },
      () => '"Same Paper Title"',
    ).join(" ");
    const refs = extractReferences(repeated);
    assert.lengthOf(refs, 1);
  });

  it("returns nothing for ordinary questions", function () {
    assert.deepEqual(
      extractReferences("What is attention in deep learning?"),
      [],
    );
  });
});
