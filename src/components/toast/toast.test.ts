import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OFFLINE_MESSAGE, OFFLINE_MESSAGE_EN } from "../../api";
import { ERRORS, TOAST } from "../../copy/common";
import { toastCopy } from "../../copy/suite";
import { ToastHost, ToastProvider, followUpPlan, isTransientError, latestUndo, replacedToasts, undoToastsEnded, type ToastInput } from "./ToastProvider";

const noop = () => {};

function renderToastHost(initialToasts: readonly ToastInput[], search = ""): string {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = { location: { search } };
  try {
    return renderToStaticMarkup(
      createElement(ToastProvider, { initialToasts, children: createElement(ToastHost) }),
    );
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
}

test("the same message replaces a visible toast instead of stacking another sticky copy", () => {
  const failed = ERRORS.actionFailed("重新整理摘要", "Claude 尚未登入。");
  const live = [
    { id: 1, kind: "error" as const, message: failed, leaving: false },
    { id: 2, kind: "undo" as const, message: "已完成「HW3」", leaving: false },
    { id: 3, kind: "error" as const, message: failed, leaving: true },
  ];
  assert.deepEqual(replacedToasts(live, { kind: "error", message: failed }), [1]);
  assert.deepEqual(replacedToasts(live, { kind: "error", message: ERRORS.actionFailed("封存", "Gmail 尚未連接。") }), []);
  assert.deepEqual(replacedToasts(live, { kind: "undo", message: "已完成「HW3」" }), [], "undo toasts have their own replace-and-commit rule");
});

test("only errors that say the service could not be reached close once it answers again", () => {
  assert.equal(isTransientError("error", ERRORS.actionFailed("封存", OFFLINE_MESSAGE)), true);
  assert.equal(isTransientError("error", `Couldn't archive: ${OFFLINE_MESSAGE_EN}`), true);
  assert.equal(isTransientError("error", "沒有記下來：無法連線至本機服務。草稿已保留。"), true);
  assert.equal(isTransientError("error", ERRORS.actionFailed("封存", "Gmail 尚未連接。")), false);
  assert.equal(isTransientError("error", "Couldn't archive: Gmail isn't connected."), false);
  assert.equal(isTransientError("plain", OFFLINE_MESSAGE), false);
  assert.equal(isTransientError("plain", OFFLINE_MESSAGE_EN), false);
});

/**
 * The provider's undo rules over a plain list (the same helpers ToastProvider
 * uses): an automatic tidy that lands 3–6 s after its capture follows it up.
 */
function undoStack() {
  let next = 1;
  const live: Array<{ id: number; kind: "undo"; message: string; leaving: boolean; passive?: boolean }> = [];
  const undone: string[] = [];
  const show = (message: string, passive = false) => {
    for (const id of undoToastsEnded(live, { kind: "undo", passive })) live.find((toast) => toast.id === id)!.leaving = true;
    const id = next++;
    live.push({ id, kind: "undo", message, leaving: false, ...(passive ? { passive } : {}) });
    return id;
  };
  return {
    live, undone, show,
    expire: (id: number) => { live.find((toast) => toast.id === id)!.leaving = true; },
    followUp: (previous: number, message: string) => {
      const plan = followUpPlan(live, previous);
      if (plan === "replace") Object.assign(live.find((toast) => toast.id === previous)!, { message });
      else show(message, plan === "passive");
      return plan;
    },
    /** Z / ⌘Z. */
    z: () => {
      const id = latestUndo(live);
      const toast = live.find((entry) => entry.id === id);
      if (toast) { toast.leaving = true; undone.push(toast.message); }
    },
    visible: () => live.filter((toast) => !toast.leaving).map((toast) => toast.message),
  };
}

const TIDIED = "已整理成「Deep Hacking 簡報」· 10/18（日）";

test("a tidy landing while its capture toast is up takes its place (SPEC §6.6.1 step 3)", () => {
  const toasts = undoStack();
  const capture = toasts.show("已加入待辦「Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection」· 10/18（日）");
  assert.equal(toasts.followUp(capture, TIDIED), "replace");
  assert.deepEqual(toasts.visible(), [TIDIED]);
  toasts.z();
  assert.deepEqual(toasts.undone, [TIDIED]);
});

test("capture → capture: the late tidy never takes the second capture's 復原 or Z", () => {
  const toasts = undoStack();
  const first = toasts.show("已加入待辦「Deep Hacking 簡報 生出來…」· 10/18（日）");
  toasts.show("已加入待辦「交報告」· 明天");
  assert.equal(toasts.followUp(first, TIDIED), "passive");
  assert.deepEqual(toasts.visible(), ["已加入待辦「交報告」· 明天", TIDIED], "both stay, each with its own 復原");
  toasts.z();
  assert.deepEqual(toasts.undone, ["已加入待辦「交報告」· 明天"], "Z undoes what the user did last");
});

test("capture → 完成 and capture → 刪除: their 復原 stays theirs; a later action does not end the tidy's", () => {
  for (const action of ["已完成「準備讀書會簡報：Ch.5 Deadlocks」", "已刪除「買牛奶」"]) {
    const toasts = undoStack();
    const capture = toasts.show("已加入待辦「Deep Hacking 簡報 生出來…」· 10/18（日）");
    toasts.show(action);
    assert.equal(toasts.followUp(capture, TIDIED), "passive", action);
    assert.ok(toasts.visible().includes(action), `${action} keeps its 復原`);
    toasts.show("已加入待辦「繳電費」· 明天");
    assert.ok(toasts.visible().includes(TIDIED), "a passive toast runs on its own timer");
    toasts.z();
    assert.deepEqual(toasts.undone, ["已加入待辦「繳電費」· 明天"]);
  }
});

test("a tidy landing after its capture toast timed out, with nothing else to undo, is a normal undo toast", () => {
  const toasts = undoStack();
  const capture = toasts.show("已加入待辦「Deep Hacking 簡報 生出來…」· 10/18（日）");
  toasts.expire(capture);
  assert.equal(toasts.followUp(capture, TIDIED), "normal");
  toasts.z();
  assert.deepEqual(toasts.undone, [TIDIED]);
});

test("ToastHost preserves zh-TW TOAST labels by default and renders English personalToast labels without CJK under ?lang=en", () => {
  assert.deepEqual(toastCopy("zh-TW"), TOAST);
  assert.deepEqual(toastCopy("en"), {
    undo: "Undo",
    retry: "Try again",
    dismiss: "Dismiss notification",
    regionLabel: "Notifications",
  });

  const zhHtml = renderToastHost([
    { kind: "undo", message: "已完成「HW3」", onUndo: noop },
    { kind: "error", message: OFFLINE_MESSAGE, onRetry: noop },
  ]);
  assert.match(zhHtml, /aria-label="通知"/);
  assert.match(zhHtml, />復原<kbd>/);
  assert.match(zhHtml, />重試<\/button>/);
  assert.match(zhHtml, /aria-label="關閉提示"/);

  const enHtml = renderToastHost([
    { kind: "undo", message: "Completed \"HW3\"", onUndo: noop },
    { kind: "error", message: OFFLINE_MESSAGE_EN, onRetry: noop },
  ], "?lang=en");
  assert.doesNotMatch(enHtml, /[\u3400-\u9fff\uf900-\ufaff]/, enHtml);
  assert.match(enHtml, /aria-label="Notifications"/);
  assert.match(enHtml, />Undo<kbd>/);
  assert.match(enHtml, />Try again<\/button>/);
  assert.match(enHtml, /aria-label="Dismiss notification"/);
});
