import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption } from "../../../shared/models";
import { ToastProvider } from "../../components/toast/ToastProvider";
import { AppSettingsProvider } from "../../lib/app-settings";
import { StatusProvider } from "../../lib/status";

const CJK = /[㐀-鿿]/;

function withProviders(child: ReactNode): string {
  return renderToStaticMarkup(createElement(ToastProvider, null,
    createElement(AppSettingsProvider, null,
      createElement(StatusProvider, null, child))));
}

test("English Google guide, Settings AI, return errors, and Claude descriptions have no leftover CJK", async (t) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { location: { search: "?lang=en", origin: "http://127.0.0.1" } } as Window & typeof globalThis;
  Reflect.deleteProperty(globalThis, "document");
  t.after(() => {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else globalThis.document = previousDocument;
  });

  const [{ GoogleGuide }, { AiTab }, { modelDescription }, { onboardingCopy }, { settingsCopy }] = await Promise.all([
    import("./GoogleGuide"),
    import("./AiTab"),
    import("./ModelSettings"),
    import("../../copy/onboarding"),
    import("../../copy/settings"),
  ]);

  const guide = withProviders(createElement(GoogleGuide));
  assert.match(guide, /Connect your Google account/);
  assert.match(guide, /Open consent screen/);
  assert.doesNotMatch(guide, CJK);

  const ai = withProviders(createElement(AiTab));
  assert.match(ai, /Connection method/);
  assert.match(ai, /Shared across all AI features/);
  assert.doesNotMatch(ai, CJK);

  const localized = settingsCopy();
  for (const reason of Object.values(localized.GOOGLE_RETURN_ERRORS)) assert.doesNotMatch(reason, CJK);
  assert.doesNotMatch(localized.GOOGLE_RETURN.failed(localized.GOOGLE_RETURN_ERRORS.denied), CJK);
  assert.doesNotMatch(localized.GOOGLE_RETURN.unknown, CJK);
  assert.deepEqual(localized.SCOPE_LABELS, {
    "gmail.modify": "Gmail",
    "calendar.readonly": "Read calendar",
    "calendar.events": "Add events",
  });

  const copy = onboardingCopy();
  for (const id of ["sonnet", "haiku", "opus", "fable"] as const) {
    const model = { id, name: id, description: "後端說明", isDefault: false, reasoningEfforts: [] } satisfies ModelOption;
    assert.equal(modelDescription(copy, model), copy.settings.model.descriptions[id]);
    assert.doesNotMatch(modelDescription(copy, model), CJK);
  }
  const unknown = { id: "future", name: "Future", description: "Server fallback", isDefault: false, reasoningEfforts: [] } satisfies ModelOption;
  assert.equal(modelDescription(copy, unknown), "Server fallback");
});

test("copy and rendered surfaces follow live zh-TW and English switches after module load", async (t) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { location: { search: "", hash: "#/settings/appearance", origin: "http://127.0.0.1" } } as Window & typeof globalThis;
  Reflect.deleteProperty(globalThis, "document");
  t.after(() => {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else globalThis.document = previousDocument;
  });

  const [{ commonCopy }, { settingsCopy }, { default: SettingsPage }, { AppSwitcherMenu, switcherRows }, { pageLabel }, { fallbackHead }] = await Promise.all([
    import("../../copy/common"),
    import("../../copy/settings"),
    import("./SettingsPage"),
    import("../../suite/AppSwitcher"),
    import("../../app/nav"),
    import("../../app/routes"),
  ]);

  assert.equal(commonCopy().SHELL.profileFallback, "我的工作台");
  assert.equal(settingsCopy().GOOGLE_GUIDE.copy, "複製");
  assert.equal(pageLabel({ name: "settings", tab: "appearance" }), "連線與設定");
  assert.equal(fallbackHead({ name: "settings", tab: "appearance" })?.title, "連線與設定");
  const chinese = withProviders(createElement(SettingsPage, { route: { name: "settings", tab: "appearance" } }));
  assert.match(chinese, /aria-label="設定分頁"/);
  assert.match(chinese, /主題/);

  window.location.search = "?lang=en";
  assert.equal(commonCopy().SHELL.profileFallback, "My workspace");
  assert.equal(commonCopy().SHELL.streakTitle(3), "3-day streak");
  assert.equal(commonCopy().SHELL.srParens("3 unread"), "(3 unread)");
  assert.equal(settingsCopy().GOOGLE_GUIDE.copy, "Copy");
  assert.equal(pageLabel({ name: "settings", tab: "appearance" }), "Settings");
  assert.equal(fallbackHead({ name: "settings", tab: "appearance" })?.title, "Settings");

  const english = withProviders(createElement(SettingsPage, { route: { name: "settings", tab: "appearance" } }));
  assert.match(english, /aria-label="Settings tabs"/);
  assert.match(english, /Single-key shortcuts/);
  assert.match(english, /Start week on Monday/);
  assert.doesNotMatch(english, CJK);

  const switcher = renderToStaticMarkup(createElement(AppSwitcherMenu, { manifest: "error", rows: switcherRows({}), onRetry: () => {} }));
  assert.match(switcher, /aria-label="Switch BELL products"/);
  assert.match(switcher, /placeholder="Switch to…"/);
  assert.match(switcher, /Couldn&#x27;t load BELL products/);
  assert.doesNotMatch(switcher, CJK);
  const readySwitcher = renderToStaticMarkup(createElement(AppSwitcherMenu, { manifest: "ready", rows: switcherRows({}) }));
  assert.match(readySwitcher, /Not linked/);
  assert.match(readySwitcher, /No matching products/);
  assert.doesNotMatch(readySwitcher, CJK);

  window.location.search = "";
  assert.equal(commonCopy().SHELL.profileFallback, "我的工作台");
  assert.equal(settingsCopy().GOOGLE_GUIDE.copy, "複製");
  const chineseAgain = withProviders(createElement(SettingsPage, { route: { name: "settings", tab: "appearance" } }));
  assert.match(chineseAgain, /aria-label="設定分頁"/);
  assert.match(chineseAgain, /單鍵快捷鍵/);
});

test("English non-default settings states, dialog, copy fields, and scope lists have no CJK", async (t) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { location: { search: "?lang=en", origin: "http://127.0.0.1" } } as Window & typeof globalThis;
  Reflect.deleteProperty(globalThis, "document");
  t.after(() => {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else globalThis.document = previousDocument;
  });

  const [{ CopyField }, { Dialog }, { commonCopy }, { settingsCopy }, { checkGoogleClient, checkPasteUrl, missingScopeNames }, { syncPhrase }] = await Promise.all([
    import("./GoogleGuide"),
    import("../../components/Dialog"),
    import("../../copy/common"),
    import("../../copy/settings"),
    import("./settings-forms"),
    import("./settings-view"),
  ]);
  const localized = settingsCopy();
  const guide = localized.GOOGLE_GUIDE;

  assert.equal(missingScopeNames("gmail.modify,calendar.events", localized.SCOPE_LABELS, localized.listSep), "Gmail, Add events");
  assert.equal(localized.SOURCES.google.connectedMissing("Gmail, Add events"), "Connected · Not granted: Gmail, Add events");
  const missingClient = checkGoogleClient({ clientId: "", clientSecret: "" });
  assert.deepEqual(missingClient.ok ? {} : missingClient.errors, {
    clientId: "Enter your client ID.",
    clientSecret: "Enter your client secret.",
  });
  const invalidClient = checkGoogleClient({ clientId: "invalid", clientSecret: "has space" });
  assert.deepEqual(invalidClient.ok ? {} : invalidClient.errors, {
    clientId: "Client ID must end with .apps.googleusercontent.com.",
    clientSecret: "Client secret must be at least 8 characters with no spaces.",
  });
  const invalidPaste = checkPasteUrl("not a URL");
  assert.equal(invalidPaste.ok ? undefined : invalidPaste.errors.url, guide.validation.pasteUrl.invalid);
  assert.equal(syncPhrase("2026-10-11T14:10:00.000Z", new Date("2026-10-12T00:42:00.000Z")), "yesterday at 22:10");
  assert.equal(localized.ERRORS.actionFailed("Disconnect", localized.ERRORS.offline), "Disconnect failed: Can't reach the local service. Make sure BELL Personal is running.");

  for (const label of ["App home URL", "Privacy policy URL", "Redirect URL"]) {
    const html = withProviders(createElement(CopyField, { label, value: "http://127.0.0.1/" }));
    assert.match(html, new RegExp(`aria-label="Copy ${label}"`));
    assert.doesNotMatch(html, CJK);
  }
  const dialog = renderToStaticMarkup(createElement(Dialog, { open: false, onClose: () => {}, title: "Settings", children: "Body" }));
  assert.match(dialog, /aria-label="Close dialog"/);
  assert.doesNotMatch(dialog, CJK);

  const { SHELL, APPEARANCE, ERRORS } = commonCopy();
  const nonDefault = [
    SHELL.streakTitle(1), SHELL.streakZero, SHELL.streakBody, SHELL.streakLink,
    SHELL.srParens("1 unread"), APPEARANCE.theme, APPEARANCE.singleKey,
    ERRORS.offline, guide.vaultOffTitle, guide.vaultOffBody, guide.loadFailed,
    localized.SETTINGS.disconnect, localized.SOURCES.google.disconnectTitle,
    localized.SOURCES.google.disconnectBody, localized.SOURCES.google.disconnectConfirm,
    localized.SOURCES.google.disconnectKeep, localized.SOURCES.google.disconnected,
    localized.SOURCES.google.disconnectedLocal,
  ];
  for (const value of nonDefault) assert.doesNotMatch(value, CJK, value);
});
