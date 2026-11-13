import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../api";
import { explainText, isMissing } from "./deep-link";

test("a deep-linked object is missing on a 404 (or an id the server rejects), not on a network or server error", () => {
  assert.equal(isMissing(new ApiError("找不到", 404)), true);
  assert.equal(isMissing(new ApiError("格式不對", 400)), true);
  assert.equal(isMissing(new ApiError("暫時無法使用", 503)), false);
  assert.equal(isMissing(new ApiError("錯誤", 500)), false);
  assert.equal(isMissing(new Error("offline")), false);
  assert.equal(isMissing(undefined), false);
});

test("解釋這個 text is the title, a blank line and the body, without empty parts", () => {
  assert.equal(explainText("讀論文", "第三章\n重點是 attention"), "讀論文\n\n第三章\n重點是 attention");
  assert.equal(explainText("讀論文", undefined), "讀論文");
  assert.equal(explainText("讀論文", "  "), "讀論文");
  assert.equal(explainText("", "只有內文"), "只有內文");
  assert.equal(explainText(" 標題 ", " 內文 ", null, "第二段"), "標題\n\n內文\n第二段");
});
