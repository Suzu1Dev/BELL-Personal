import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BotContextStatus, BotSessionView } from "../../../shared/bot";
import { prCardView, PrTodayView } from "../../suite/PrTodayCard";
import { BotWorkspaceView } from "../bot/BotPage";
import { parseBotBlocks, PersonalBotView, type PersonalBotViewProps } from "./PersonalBotCard";

const noop = () => {};
const stripHtml = (html: string) => html.replace(/<[^>]+>/g, "");

function baseBotProps(overrides: Partial<PersonalBotViewProps> = {}): PersonalBotViewProps {
  const context: BotContextStatus = {
    aiEnabled: true,
    autonomy: "balanced",
    runningJobId: null,
    explain: { configured: true, ready: true, link: "https://explain.bell.example" },
    pr: { configured: true, connected: true, link: "https://pr.bell.example" },
  };
  return {
    session: { id: "ses-1", messages: [], updatedAt: "2026-11-12T09:00:00.000Z" },
    context,
    expanded: true,
    draft: "",
    sending: false,
    onDraftChange: noop,
    onSubmit: noop,
    onToggleExpanded: noop,
    onReset: noop,
    onApproveOp: noop,
    onDismissOp: noop,
    onUndoOp: noop,
    onQuickCapture: noop,
    ...overrides,
  };
}

test("PersonalBotView renders starter prompts, BELL Suite status pills, mascot, and autonomy badge when empty", () => {
  const html = renderToStaticMarkup(createElement(PersonalBotView, baseBotProps()));
  const text = stripHtml(html);
  assert.match(html, /class="card personal-bot is-compact"/);
  assert.match(html, /class="bot-mascot-stage is-idle"/);
  assert.match(text, /Personal Bot/);
  assert.match(text, /Personal/);
  assert.match(text, /Explain/);
  assert.match(text, /PR/);
  assert.match(text, /分級權限/);
  assert.match(text, /整理我今天最重要的事與學習進度/);
  assert.doesNotMatch(text, /新對話/);

  const typingHtml = renderToStaticMarkup(createElement(PersonalBotView, baseBotProps({ draft: "幫我排程" })));
  assert.match(typingHtml, /class="bot-mascot-stage is-typing"/);
});

test("PersonalBotView renders Permission Broker approval cards and executed operations with Undo and deep links", () => {
  const session: BotSessionView = {
    id: "ses-2",
    updatedAt: "2026-11-12T09:05:00.000Z",
    messages: [
      {
        id: "m-1",
        role: "user",
        text: "幫我新增待辦並啟動 PR 任務",
        createdAt: "2026-11-12T09:04:00.000Z",
      },
      {
        id: "m-2",
        role: "assistant",
        text: "已新增待辦；PR 任務請確認後啟動。",
        createdAt: "2026-11-12T09:05:00.000Z",
        operations: [
          {
            id: "op-1",
            kind: "todo.create",
            tier: "safe",
            app: "personal",
            status: "executed",
            label: "新增待辦「整理專題簡報」",
            detail: "2026-11-12 16:00",
            resultHref: "#/tasks?focus=todo-1",
            undoable: true,
            updatedAt: "2026-11-12T09:05:00.000Z",
          },
          {
            id: "op-2",
            kind: "pr.create_run",
            tier: "sensitive",
            app: "pr",
            status: "pending_approval",
            label: "在 BELL PR 啟動程式碼任務「修復 OAuth 測試」",
            detail: "bell-personal",
            undoable: false,
            updatedAt: "2026-11-12T09:05:00.000Z",
          },
        ],
        followUps: ["查看今日空檔"],
      },
    ],
  };

  const html = renderToStaticMarkup(createElement(PersonalBotView, baseBotProps({ session })));
  const text = stripHtml(html);
  assert.match(text, /已完成/);
  assert.match(text, /新增待辦「整理專題簡報」/);
  assert.match(text, /復原/);
  assert.match(html, /href="#\/tasks\?focus=todo-1"/);
  assert.match(text, /需要確認/);
  assert.match(text, /BELL PR/);
  assert.match(text, /核准執行/);
  assert.match(text, /略過/);
  assert.match(text, /查看今日空檔/);
  assert.match(text, /新對話/);
});

test("parseBotBlocks formats numbered lists, bullet lists, headings, bold and inline code cleanly", () => {
  const blocks = parseBotBlocks("### 今日重點\n1. 先回 **林教授** 的信\n2. 完成 `OS Lab 3`\n\n- 下午空檔 2 小時");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]?.kind, "heading");
  assert.equal(blocks[1]?.kind, "ol");
  assert.equal(blocks[2]?.kind, "ul");

  const session: BotSessionView = {
    id: "ses-3",
    updatedAt: "2026-11-12T09:10:00.000Z",
    messages: [
      {
        id: "m-list",
        role: "assistant",
        text: "1. 完成 **作業系統**\n2. 檢查 `PKCE` 流程",
        createdAt: "2026-11-12T09:10:00.000Z",
      },
    ],
  };
  const html = renderToStaticMarkup(createElement(PersonalBotView, baseBotProps({ session })));
  assert.match(html, /<ol class="bot-list is-ordered">/);
  assert.match(html, /<strong>作業系統<\/strong>/);
  assert.match(html, /<code class="bot-code">PKCE<\/code>/);
});

test("BotWorkspaceView renders conversation history rail, folder filter tags, and active session tag controls", () => {
  const html = renderToStaticMarkup(
    createElement(BotWorkspaceView, {
      session: {
        id: "s-active",
        title: "整理本週作業與排程",
        folder: "daily",
        pinned: true,
        updatedAt: "2026-11-13T05:30:00.000Z",
        messages: [
          { id: "m1", role: "user", text: "整理本週作業與排程", createdAt: "2026-11-13T05:29:00.000Z" },
          { id: "m2", role: "assistant", text: "已為你整理好本週重點。", createdAt: "2026-11-13T05:30:00.000Z" },
        ],
      },
      sessions: [
        {
          id: "s-active",
          title: "整理本週作業與排程",
          preview: "已為你整理好本週重點。",
          folder: "daily",
          pinned: true,
          messageCount: 2,
          createdAt: "2026-11-13T05:29:00.000Z",
          updatedAt: "2026-11-13T05:30:00.000Z",
        },
        {
          id: "s-suite",
          title: "產生作業系統 Deadlock 講義",
          preview: "已在 BELL Explain 建立筆記。",
          folder: "suite",
          pinned: false,
          messageCount: 4,
          createdAt: "2026-11-12T18:00:00.000Z",
          updatedAt: "2026-11-12T18:05:00.000Z",
        },
      ],
      context: {
        aiEnabled: true,
        autonomy: "balanced",
        runningJobId: null,
        explain: { configured: true, ready: true },
        pr: { configured: true, connected: true },
      },
      draft: "",
      sending: false,
      onDraftChange: noop,
      onSubmit: noop,
      onReset: noop,
      onSelectSession: noop,
      onPatchSession: noop,
      onDeleteSession: noop,
      onApproveOp: noop,
      onDismissOp: noop,
      onUndoOp: noop,
    }),
  );
  const text = stripHtml(html);
  assert.match(html, /class="bot-studio"/);
  assert.match(text, /對話紀錄/);
  assert.match(text, /今日與排程/);
  assert.match(text, /待辦與靈感/);
  assert.match(text, /Explain \/ PR/);
  assert.match(text, /產生作業系統 Deadlock 講義/);
  assert.match(text, /已為你整理好本週重點。/);
});

test("PrTodayView renders active runs with safe sibling routes and supports English locale without CJK", () => {
  const readyView = prCardView({
    pollState: "ready",
    links: { pr: "https://pr.bell.example" },
    timeZone: "Asia/Taipei",
    now: new Date("2026-11-12T10:05:00.000Z"),
    data: {
      schemaVersion: 1,
      sources: [
        {
          appId: "pr",
          status: "ready",
          lastSuccessAt: "2026-11-12T10:00:00.000Z",
          feed: {
            schemaVersion: 1,
            appId: "pr",
            generatedAt: "2026-11-12T10:00:00.000Z",
            counts: { needsYou: 1, waiting: 2 },
            items: [
              {
                sourceApp: "pr",
                type: "run",
                id: "run_1",
                title: "OAuth PKCE",
                detail: "Plan ready",
                href: "#/runs/run_1",
                state: "needs-you",
                updatedAt: "2026-11-12T09:58:00.000Z",
              },
            ],
            truncated: false,
          },
        },
      ],
    },
  });
  assert.equal(readyView.kind, "ready");
  assert.equal(readyView.runs[0]?.href, "https://pr.bell.example/#/runs/run_1");
  const zhHtml = renderToStaticMarkup(createElement(PrTodayView, { view: readyView }));
  assert.match(stripHtml(zhHtml), /1 項待你處理 · 2 項進行中/);
  assert.match(zhHtml, /href="https:\/\/pr\.bell\.example\/#\/runs\/run_1"/);

  const enView = prCardView({
    pollState: "ready",
    locale: "en",
    links: { pr: "https://pr.bell.example" },
    now: new Date("2026-11-12T10:05:00.000Z"),
    data: {
      schemaVersion: 1,
      sources: [
        {
          appId: "pr",
          status: "ready",
          lastSuccessAt: "2026-11-12T10:00:00.000Z",
          feed: {
            schemaVersion: 1,
            appId: "pr",
            generatedAt: "2026-11-12T10:00:00.000Z",
            counts: { needsYou: 1, waiting: 2 },
            items: [],
            truncated: false,
          },
        },
      ],
    },
  });
  assert.equal(enView.headline, "1 need you · 2 in progress");
  assert.doesNotMatch(enView.headline ?? "", /[\u4e00-\u9fff]/);
});
