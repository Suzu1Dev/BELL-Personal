import { MAIL_SEARCH_LIMITS, type MailView } from "../../../shared/mail.js";

/**
 * The Gmail `q` for each #/inbox view and a user's search (SPEC-mail-assignments
 * §3.6). `users.messages.list` / `users.threads.list` take `q` in the Gmail
 * search-box syntax and leave Spam and Trash out unless the query names them
 * (`includeSpamTrash` defaults to false); the suffix keeps them out even when the
 * user types `in:anywhere`. The 封存 query names only system labels (`in:inbox`,
 * `in:sent`, `in:drafts`, as the sync already uses, plus `in:snoozed` from the
 * Gmail search-operator list); `in:archive` from the same list describes this
 * set but leaves the Sent and Drafts exclusions implicit. Not verified against a
 * live account from this host.
 */
export const GMAIL_VIEW_QUERIES: Record<MailView, string> = {
  inbox: "in:inbox",
  archive: "-in:inbox -in:snoozed -in:sent -in:drafts",
  all: "-in:drafts",
};

/** Appended to every query: never list spam or trash. */
export const GMAIL_QUERY_SUFFIX = "-in:spam -in:trash";

/**
 * The user's search text as it goes into `q`: control characters removed,
 * whitespace collapsed, at most MAIL_SEARCH_LIMITS.query characters, and
 * parentheses dropped when they do not pair up (an open group would swallow
 * the spam/trash suffix).
 */
export function cleanSearchText(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const cut = Array.from(flat).slice(0, MAIL_SEARCH_LIMITS.query).join("").trim();
  return balanced(cut) ? cut : cut.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The full `q` for a view and an optional search: view query, the user's text
 * unchanged in between (Gmail's OR binds tighter than the implicit AND, so
 * `from:a OR from:b` stays inside the view), then the spam/trash suffix.
 */
export function gmailViewQuery(view: MailView, text = ""): string {
  const search = cleanSearchText(text);
  return [GMAIL_VIEW_QUERIES[view], search, GMAIL_QUERY_SUFFIX].filter(Boolean).join(" ");
}
