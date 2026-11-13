import test from "node:test";
import assert from "node:assert/strict";
import { mailSearchSection } from "./mailSearchSection";

test("the palette offers 搜尋信件「…」 in go mode and opens the 全部 view with the query", () => {
  const visited: string[] = [];
  const section = mailSearchSection({ mode: "go", text: "  HW5 作業 ", open: true }, (hash) => visited.push(hash));
  assert.equal(section?.title, "信件");
  const [option] = section!.options;
  assert.deepEqual([option.title, option.meta, option.enterLabel, option.tone], ["搜尋信件「HW5 作業」", "在所有信件中搜尋", "搜尋", "mail"]);
  option.run();
  assert.deepEqual(visited, ["#/inbox?view=all&q=HW5+%E4%BD%9C%E6%A5%AD"]);

  assert.equal(mailSearchSection({ mode: "go", text: "   " }), null, "nothing to search");
  assert.equal(mailSearchSection({ mode: "capture", text: "明天交報告" }), null, "a capture is not a search");
  const long = mailSearchSection({ mode: "go", text: "作".repeat(300) }, (hash) => visited.push(hash));
  long!.options[0].run();
  assert.equal(new URLSearchParams(visited.at(-1)!.split("?")[1]).get("q")!.length, 200, "the query is cut to the search limit");
});
