import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PAGE_HEADS } from "../copy/common";
import { onboardingCopy } from "../copy/onboarding";
import { PageHead } from "./PageHead";

const render = (props: Parameters<typeof PageHead>[0]) => renderToStaticMarkup(createElement(PageHead, props));

test("empty eyebrows and subtitles leave no elements behind", () => {
  const html = render({ eyebrow: "", title: "收件匣", sub: "" });
  assert.match(html, /<h1 class="page-title kp">收件匣<\/h1>/);
  assert.doesNotMatch(html, /class="eyebrow"|class="page-sub/);
  assert.doesNotMatch(render({ title: "待辦" }), /class="eyebrow"|class="page-sub/);
});

test("settings guidance uses localized copy, and a project description exposes its full text", () => {
  const copy = onboardingCopy();
  const settings = render({ title: copy.settings.title, sub: copy.settings.lead });
  assert.match(settings, /<h1 class="page-title kp">連線與設定<\/h1>/);
  assert.match(settings, /class="page-sub kp" title="帳號與金鑰只留在這台電腦上，不會傳到瀏覽器。"/);
  const description = "第一行專案描述。第二行仍然完整保留，供兩行截斷後的 title 提示使用。";
  const project = render({ title: "BELL", sub: description, className: "project-detail-head" });
  assert.match(project, /class="page-head project-detail-head"/);
  assert.match(project, new RegExp(`class="page-sub kp" title="${description}"`));
});

test("page copy removes explanatory lines without changing setup copy", () => {
  for (const head of Object.values(PAGE_HEADS)) assert.equal(head.eyebrow, "");
  for (const name of ["today", "inbox", "calendar", "tasks", "work", "events", "ideas", "habits", "guide", "notFound"] as const) {
    assert.equal(PAGE_HEADS[name].sub, "", name);
  }
  for (const name of ["settings", "setup", "googleGuide"] as const) assert.ok(PAGE_HEADS[name].sub, name);
  assert.deepEqual(Object.fromEntries(["today", "inbox", "calendar", "tasks", "work", "events", "ideas", "habits"].map((name) => [name, PAGE_HEADS[name as keyof typeof PAGE_HEADS].title])), {
    today: "把今天安排得剛剛好。",
    inbox: "先處理需要你回覆的。",
    calendar: "把今天安排得剛剛好。",
    tasks: "一件一件來。",
    work: "作業、專案和 PR，都在這裡。",
    events: "值得去的，先標起來。",
    ideas: "讓好靈感不再溜走。",
    habits: "小習慣，天天累積。",
  });
});
