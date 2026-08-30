import { assert } from "chai";
import {
  estimateContextUsage,
  estimateTokens,
} from "../src/modules/contextEstimator";

describe("context estimator", function () {
  it("estimates CJK and Latin text conservatively", function () {
    assert.equal(estimateTokens("测试"), 2);
    assert.equal(estimateTokens("abcdefgh"), 2);
    assert.equal(estimateTokens("测试abcd"), 3);
  });

  it("includes message overhead and output reserve", function () {
    const usage = estimateContextUsage(
      [{ role: "user", content: "abcdefgh" }],
      100,
      10,
    );
    assert.equal(usage.used, 8);
    assert.equal(usage.reserved, 10);
    assert.equal(usage.remaining, 82);
    assert.equal(usage.percent, 18);
  });

  it("clamps exhausted context", function () {
    const usage = estimateContextUsage(
      [{ role: "system", content: "测试测试测试" }],
      5,
    );
    assert.equal(usage.remaining, 0);
    assert.equal(usage.percent, 100);
  });
});
