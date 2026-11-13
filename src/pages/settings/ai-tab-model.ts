import type { AiActiveStatus, AiConnection, AiNotReadyReason, AiSavedKey } from "../../../shared/ai-connections";
import type { ReasoningEffort } from "../../../shared/models";
import { format, onboardingLocale, type OnboardingCopy, type OnboardingLocale } from "../../copy/onboarding";

export function connectionReason(connection: AiConnection, active?: AiActiveStatus | null): AiNotReadyReason | undefined {
  return active && active.method === connection.method && !active.ready ? active.reason : connection.reason;
}

export function connectionMeta(copy: OnboardingCopy, connection: AiConnection, reason?: AiNotReadyReason): string {
  if (connection.state === "detected") {
    if (connection.source === "bell" && connection.savedKey) return savedKeyMeta(copy, connection.savedKey);
    if (connection.source === "cli") return `${copy.ai.signedIn} · ${connection.cli === "codex" ? copy.settings.viaCodex : copy.settings.viaClaude}`;
    return copy.ai.signedIn;
  }
  switch (reason) {
    case "cli_not_installed": return format(copy.ai.errors.notInstalled, { app: connection.cli === "codex" ? "Codex" : "Claude Code" });
    case "pending": return copy.settings.pending;
    case "wrong_login": return copy.settings.wrongLogin;
    case "key_unreadable": return copy.settings.keyUnreadable;
    case "vault_disabled": return copy.settings.vaultDisabled;
    case "key_missing": return copy.settings.keyNone;
    default: return connection.method === "chatgpt" || connection.method === "claude" ? copy.settings.notSignedIn : copy.settings.keyNone;
  }
}

export function connectionAction(copy: OnboardingCopy, connection: AiConnection, reason?: AiNotReadyReason): { kind: "open" | "remove"; label: string } | null {
  const login = connection.method === "chatgpt" || connection.method === "claude";
  if (connection.state === "detected") return !login && connection.source === "bell" ? { kind: "remove", label: copy.settings.remove } : null;
  if (reason === "cli_not_installed" || reason === "pending" || reason === "vault_disabled") return null;
  if (login) return { kind: "open", label: copy.settings.signIn };
  if (reason === "key_unreadable") return { kind: "open", label: copy.settings.replace };
  if (reason === "key_missing") return { kind: "open", label: copy.settings.add };
  return null;
}

export function savedKeyMeta(copy: OnboardingCopy, savedKey: AiSavedKey, locale: OnboardingLocale = onboardingLocale()): string {
  if (!savedKey.hint) return copy.ai.signedIn;
  if (!savedKey.verifiedAt) return savedKey.hint;
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(savedKey.verifiedAt));
  return format(copy.settings.keySaved, { masked: savedKey.hint, date });
}

export function nextRadioIndex(length: number, current: number, key: string): number {
  if (!length) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  return step ? (current + step + length) % length : -1;
}

export function modelSelectionDisabled(active: AiActiveStatus | null | undefined): boolean {
  return active?.ready !== true;
}

export function effortDefaultLabel(copy: OnboardingCopy, effort?: ReasoningEffort): string {
  return effort ? format(copy.settings.model.effortDefault, { level: copy.settings.model.effortLevels[effort] }) : copy.settings.model.effortValue;
}
