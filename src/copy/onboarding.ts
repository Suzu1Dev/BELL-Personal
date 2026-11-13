import strings from "./onboarding-strings.json";

export type OnboardingCopy = (typeof strings)["zh-TW"];
export type OnboardingLocale = keyof Omit<typeof strings, "$meta">;

const LIMITS: Array<[RegExp, number | null]> = [
  [/^(brand|listSep|stepOf)$/, null],
  [/^a11y\./, null],
  [/^skip$/, 18],
  [/^(back|next)$/, 12],
  [/^steps\./, 12],
  [/^nav\./, 20],
  [/^settings\.tabs\./, 16],
  [/(^|\.)(nextNone|use|submit|finish|go|connect|googleStart|retry|open|signIn|add|remove|restore|copy|show|checking|preparing|confirm|cancel)$|^src\.later$/, 22],
  [/(^|\.)(modelValue|effortValue)$/, 28],
  [/^ai\.skip$/, 16],
  [/(^|\.)(signedIn|inUse|expired|custom|customOff|githubFound)$/, 18],
  [/(^|\.)(subLabel|keyLabel|otherLabel|previewLabel|nextLabel|label|schoolId|schoolPw|canvas|moodle|canvasUrl|canvasToken|moreCities|otherWays|rerun|useKeyInstead)$|^src\.groups\.|^done\.rows\.|^src\.cities\./, 32],
  [/(^|\.)(title|name|chatgptTitle|claudeTitle|openChatgpt|openClaude|enterCode|pasteCode|expiredTitle|tipTitle|found|keyOpenai|keyAnthropic|weatherCity|model|effort|modelValue|effortValue|notSignedIn|keyNone|keySaved|notYet|foundMeta)$/, 44],
  [/(^|\.)(invalid|expiredBody|otherDevice)$/, 140],
  [/^ai\.errors\.\w+Title$/, 44],
  [/^ai\.errors\./, 140],
  [/.*/, 120],
];

const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat".split(" ");

function pseudo(value: string, key: string, max: boolean): string {
  const holes = value.match(/\{\w+\}/g) ?? [];
  const latin = value.match(/[A-Za-z0-9][\w.@/:-]*/g) ?? [];
  const cjk = (value.match(/[　-鿿＀-￯]/g) ?? []).length;
  const limit = LIMITS.find(([pattern]) => pattern.test(key))?.[1];
  const length = max ? limit : cjk ? Math.max(Math.round(cjk * 2.9), 8) : 0;
  if (!length || (max && !cjk)) return value;
  let out = "";
  let index = 0;
  while (out.length < length) out += `${out ? " " : ""}${WORDS[index++ % WORDS.length]}`;
  out = out.slice(0, length).trimEnd();
  out = out[0].toUpperCase() + out.slice(1);
  return [out, ...(max ? holes : latin.length || holes.length ? [...new Set([...latin, ...holes])] : [])].join(" ");
}

function localized<T>(value: T, path = "", transform?: (value: string, key: string) => string): T {
  if (typeof value === "string") return (transform?.(value, path) ?? value) as T;
  if (Array.isArray(value)) return value.map((entry) => localized(entry, path, transform)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, localized(entry, path ? `${path}.${key}` : key, transform)])) as T;
  }
  return value;
}

export function onboardingLocale(): OnboardingLocale {
  const query = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return query.get("lang") === "en" || (!query.has("lang") && typeof document !== "undefined" && document.documentElement.lang.startsWith("en")) ? "en" : "zh-TW";
}

export function onboardingCopy(): OnboardingCopy {
  const query = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const locale = onboardingLocale();
  const mode = query.get("pseudo");
  const copy = localized(strings[locale], "", mode ? (value, key) => pseudo(value, key, mode === "max") : undefined);
  return { ...copy, brand: "BELL Personal", listSep: mode ? ", " : copy.listSep };
}

export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}

export function joinList(items: string[], copy: OnboardingCopy): string {
  return items.join(copy.listSep);
}
