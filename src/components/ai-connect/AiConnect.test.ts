import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiConnection, AiLoginPrompt } from "../../../shared/ai-connections";
import { onboardingCopy } from "../../copy/onboarding";
import strings from "../../copy/onboarding-strings.json";
import { RefreshCw } from "../Icon";
import { Choose, claudePasteFlowVisible, claudeSubmitVisible, LoginFlow, shouldFocusLoginFailure } from "./AiConnect";

const prompt: AiLoginPrompt = { kind: "paste_code", url: "https://claude.ai/oauth/authorize", expiresAt: "2026-11-10T00:15:00.000Z" };
const connection = (failure: AiConnection["failure"]): AiConnection => ({ method: "claude", cli: "claude", installed: true, state: "failed", failure, prompt });
const noop = () => {};
const rejectedFlow = (busy = false) => renderToStaticMarkup(createElement(LoginFlow, {
  copy: onboardingCopy(), method: "claude", connection: connection("code_rejected"), prompt, busy, code: "BAD",
  onCode: noop, onSubmitCode: noop, onRetry: noop, onBack: noop, onUseKey: noop,
}));

for (const locale of ["zh-TW", "en"] as const) {
  test(`AI option load failure uses load copy and retries in ${locale}`, () => {
    const copy = strings[locale];
    let retries = 0;
    const props: Parameters<typeof Choose>[0] = {
      copy,
      data: undefined,
      detected: undefined,
      loadError: true,
      onRetry: () => { retries += 1; },
      onLogin: () => undefined,
      onKey: () => undefined,
      onUse: () => undefined,
    };
    const tree = Choose(props);
    const notice = tree.props.children[1];
    assert.equal(notice.props.title, copy.ai.errors.loadFailedTitle);
    assert.notEqual(notice.props.title, copy.ai.errors.failedTitle);
    assert.equal(notice.props.children, copy.ai.errors.networkBody);
    assert.equal(notice.props.actions.props.icon, RefreshCw);
    assert.equal(notice.props.actions.props.onClick, props.onRetry);
    notice.props.actions.props.onClick();
    assert.equal(retries, 1);

    const html = renderToStaticMarkup(createElement(Choose, props));
    assert.match(html, /lucide-refresh-cw/);
  });
}

test("login failures hide submit; only a rejected code keeps its read-only flow visible", () => {
  assert.equal(claudePasteFlowVisible(connection("timed_out"), prompt), false);
  assert.equal(claudeSubmitVisible(connection("timed_out"), prompt), false);
  assert.equal(claudePasteFlowVisible(connection("code_rejected"), prompt), true);
  assert.equal(claudeSubmitVisible(connection("code_rejected"), prompt), false);
  assert.equal(claudePasteFlowVisible(undefined, prompt), true);
  assert.equal(claudeSubmitVisible(undefined, prompt), true);
});

test("a stale rejected state does not steal focus when the dialog reopens", () => {
  assert.equal(shouldFocusLoginFailure("code_rejected", "code_rejected", false), false);
  assert.equal(shouldFocusLoginFailure(undefined, "code_rejected", true), false);
  assert.equal(shouldFocusLoginFailure(undefined, "code_rejected", false), true);
  assert.equal(shouldFocusLoginFailure("code_rejected", undefined, false), false);
});

test("a rejected code disables the stale sign-in link for mouse and keyboard", () => {
  const html = rejectedFlow();
  assert.match(html, /<a\b[^>]*\baria-disabled="true"/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>.*?再試一次/);
});

test("a rejected code hides the paste hint but keeps the error", () => {
  const html = rejectedFlow();
  assert.ok(!html.includes('class="field-hint kp"'));
  assert.match(html, /class="field-error kp"[^>]*role="alert"/);
});

test("retry is disabled while a replacement sign-in starts", () => {
  assert.match(rejectedFlow(true), /<button[^>]*disabled=""[^>]*>.*?再試一次/);
});
