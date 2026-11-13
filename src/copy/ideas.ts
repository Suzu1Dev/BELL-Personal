import type { CaptureType } from "../../shared/connect";
import strings from "./ideas-strings.json";

export type ComposerTab = "idea" | "todo" | "note";
export type IdeasLocale = keyof typeof strings;

export function ideasLocale(): IdeasLocale {
  const query = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return query.get("lang") === "en" || (!query.has("lang") && typeof document !== "undefined" && document.documentElement.lang.startsWith("en")) ? "en" : "zh-TW";
}

const format = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));

export function ideasCopy(locale: IdeasLocale = ideasLocale()) {
  const i = strings[locale].ideas;
  const one = (n: number) => locale === "en" && n === 1;

  return {
    PAGE_HEAD_TITLE: i.pageHead.title,
    COMPOSER: {
      label: i.composer.label,
      tabsLabel: i.composer.tabsLabel,
      tabs: i.composer.tabs satisfies Record<ComposerTab, string>,
      placeholders: i.composer.placeholders satisfies Record<ComposerTab, string>,
      submit: i.composer.submit satisfies Record<ComposerTab, string>,
      enterType: i.composer.enterType satisfies Record<CaptureType, string>,
      saved: i.composer.saved,
      unsaved: i.composer.unsaved,
      submitHint: i.composer.submitHint,
      tooLong: (max: number) => format(i.composer.tooLong, { max }),
    },
    IDEAS: {
      searchLabel: i.searchLabel,
      searchPlaceholder: i.searchPlaceholder,
      tagsLabel: i.tagsLabel,
      allTags: i.allTags,
      pinned: i.pinned,
      today: i.today,
      yesterday: i.yesterday,
      count: (n: number) => format(one(n) ? i.countOne : i.count, { n }),
      emptyTitle: i.emptyTitle,
      emptyHint: i.emptyHint,
      noMatchTitle: i.noMatchTitle,
      noMatchHint: i.noMatchHint,
      clearFilters: i.clearFilters,
      loadErrorTitle: i.loadErrorTitle,
      archivedToggle: (_n?: number) => i.archivedToggle,
      backToActive: i.backToActive,
      archivedHead: i.archivedHead,
      actions: i.actions,
      linked: i.linked,
      proposalLabel: (tag: string) => format(i.proposalLabel, { tag }),
      proposalDismiss: (tag: string) => format(i.proposalDismiss, { tag }),
      proposalsTitle: i.proposalsTitle,
      suggestTags: i.suggestTags,
      suggesting: i.suggesting,
      toasts: {
        saved: i.toasts.saved,
        noteSaved: i.toasts.noteSaved,
        archived: i.toasts.archived,
        unarchived: i.toasts.unarchived,
        deleted: i.toasts.deleted,
        pinned: i.toasts.pinned,
        unpinned: i.toasts.unpinned,
        toTodo: (title: string) => format(i.toasts.toTodo, { title }),
        tagAdded: (tag: string) => format(i.toasts.tagAdded, { tag }),
        saveFailed: i.toasts.saveFailed,
        updateFailed: i.toasts.updateFailed,
        deleteFailed: i.toasts.deleteFailed,
        toTodoFailed: i.toasts.toTodoFailed,
        tagFailed: i.toasts.tagFailed,
        suggestFailed: i.toasts.suggestFailed,
      },
    },
  };
}

type IdeasCopy = ReturnType<typeof ideasCopy>;

function localized<T extends object>(select: (copy: IdeasCopy) => T): T {
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(select(ideasCopy()), property),
  });
}

export const COMPOSER = localized((copy) => copy.COMPOSER);
export const IDEAS = localized((copy) => copy.IDEAS);
