import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, TextInput } from "./Field";

test("Field preserves an external description alongside its own hint and error", () => {
  const html = renderToStaticMarkup(createElement(Field, { label: "密碼", hint: "內建提示", error: "請修正", children: createElement(TextInput, { "aria-describedby": "outside-hint" }) as Parameters<typeof Field>[0]["children"] }));
  assert.match(html, /aria-describedby="outside-hint [^"]+-hint [^"]+-error"/);
  assert.match(html, /aria-invalid="true"/);
});
