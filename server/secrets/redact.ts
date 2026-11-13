/**
 * Single source of secret shapes.
 *
 * redact() masks every shape so logs, Agent answers, draft bodies and PR
 * bodies never carry a credential. secretInPatch() only reports the shapes
 * that are unambiguous enough to block a patch or drop an imported source:
 * assignments such as `password = "example"` and URL credentials are masked
 * but never block, because fixtures and docs legitimately contain them.
 */
interface SecretPattern {
  pattern: RegExp;
  replacement: string;
  /** When true the shape also makes secretInPatch() return true. */
  blocks: boolean;
}

export const secretPatterns: readonly SecretPattern[] = [
  {
    // Provider tokens share one minimum length of 16 characters after the prefix.
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g,
    replacement: "[REDACTED]",
    blocks: true,
  },
  {
    // BELL Personal addition: Google OAuth access tokens and OAuth client secrets.
    pattern: /\b(?:ya29\.[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]{20,})/g,
    replacement: "[REDACTED]",
    blocks: true,
  },
  {
    // PEM private keys; a block cut off before its END marker is masked to the end of the text.
    pattern:
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
    replacement: "[REDACTED]",
    blocks: true,
  },
  {
    pattern: /(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,
    replacement: "$1[REDACTED]@",
    blocks: false,
  },
  {
    pattern:
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    replacement: "$1[REDACTED]",
    blocks: false,
  },
];

export function redact(text: string): string {
  return secretPatterns.reduce(
    (result, { pattern, replacement }) =>
      result.replace(pattern, replacement),
    text,
  );
}

export function secretInPatch(patch: string): boolean {
  // String#search ignores the global flag's lastIndex, so the shared patterns stay stateless.
  return secretPatterns.some(
    ({ pattern, blocks }) => blocks && patch.search(pattern) !== -1,
  );
}

/** A run of characters a key, or a CLI's shortened echo of it, is printed with; a dot only inside the run. */
const KEY_RUN = /(?:[A-Za-z0-9_*…-]|\.(?=[A-Za-z0-9_*…-]))+/g;
/**
 * Key shapes no caller needs to know the key for: anything that starts with
 * `sk-` (`sk-proj-***`, `sk-ant-…`), a provider prefix glued to other text
 * (`Bearersk-proj-…`, `OPENAI_API_KEY_sk-…`), and a long piece that starts
 * with the part after `sk-` (`proj-…`, `api03-…`).
 */
const KEY_SHAPE = /^sk-.{3}|sk-(?:proj|ant|svcacct|admin)-|^(?:proj|svcacct|admin|api\d\d)-[A-Za-z0-9_-]{12,}/;
/** Shortening marks: `sk-proj-****abcd`, `sk-proj-rIgE…lFaKe0`, `sk-abc...wxyz`. */
const SHORTENED = /[*…]|\.\./;
const FRAGMENT = 8;
const MASK = "[REDACTED]";

/**
 * For text a model CLI printed (its error output, a notice, a status line):
 * redact() plus the key echoes it misses. With the run's own `secrets`
 * (the key a job was spawned with) a whole run of key characters is masked
 * when it holds any 8-character piece of a secret, or a 4-character piece next
 * to a shortening mark: the key itself, its prefix (`sk-proj-rIgElFaKe0…`),
 * its tail, or `proj-…`/`api03-…` with the `sk-` cut off.
 */
export function redactCliOutput(text: string, secrets: readonly string[] = []): string {
  const keys = secrets.filter((secret) => secret.length >= FRAGMENT);
  let result = text;
  for (const key of keys) result = result.split(key).join(MASK);
  const pieces = keys.map((key) => {
    const set = new Set<string>();
    for (let i = 0; i + FRAGMENT <= key.length; i++) set.add(key.slice(i, i + FRAGMENT));
    return { key, set };
  });
  const echoes = (run: string) =>
    pieces.some(({ key, set }) => {
      for (let i = 0; i + FRAGMENT <= run.length; i++) if (set.has(run.slice(i, i + FRAGMENT))) return true;
      return SHORTENED.test(run) && run.split(/[*….]+/).some((piece) => piece.length >= 4 && key.includes(piece));
    });
  return redact(result).replace(KEY_RUN, (run) => (KEY_SHAPE.test(run) || echoes(run) ? MASK : run));
}
