import type { MailMessage } from "../../../shared/mail.js";
import type { SourceItemStore } from "../../stores/source-items.js";
import { gmailThreadUrl, withLabels } from "./parse.js";

/** A label change applied locally before Gmail confirmed it (a deferred 封存 or 標為已讀). */
export interface LabelEdit {
  add: string[];
  remove: string[];
}

/**
 * The cached Gmail messages (sources.sqlite source_items, source `gmail`, kind
 * `mail`, external id = Gmail message id). Local label edits made by actions
 * that have not reached Gmail yet are kept in memory and re-applied whenever a
 * sync rewrites the same message, so a full resync during the 6.5 s undo
 * window cannot bring an archived mail back.
 */
export class MailStore {
  private readonly edits = new Map<string, LabelEdit[]>();

  constructor(private readonly items: SourceItemStore) {}

  all(): MailMessage[] {
    return this.items.list<MailMessage>({ source: "gmail", kind: "mail" }).map((item) => item.value);
  }

  /** Messages carrying the INBOX label. */
  inbox(): MailMessage[] {
    return this.all().filter((message) => message.labels.includes("INBOX"));
  }

  get(id: string): MailMessage | undefined {
    return this.items.get<MailMessage>("gmail", id)?.value;
  }

  thread(threadId: string): MailMessage[] {
    return this.all().filter((message) => message.threadId === threadId).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  count(): number {
    return this.items.count("gmail", "mail");
  }

  /** Writes messages as fetched, with any pending local label edits re-applied. */
  put(messages: MailMessage[]): void {
    if (!messages.length) return;
    this.items.upsert("gmail", messages.map((message) => {
      const value = this.overlay(message);
      return { kind: "mail" as const, externalId: value.id, value, updatedAt: value.receivedAt };
    }));
  }

  remove(ids: string[]): number {
    for (const id of ids) this.edits.delete(id);
    return ids.length ? this.items.remove("gmail", ids) : 0;
  }

  /** Every cached message (POST /api/gmail/purge); pending edits are forgotten too. */
  clear(): number {
    this.edits.clear();
    return this.items.clear("gmail");
  }

  /**
   * Applies a label edit locally now and remembers it until `settle` (the
   * remote write finished) or `revert` (undo, or the remote write failed).
   * Returns the ids that actually changed.
   */
  edit(ids: string[], edit: LabelEdit): { changed: string[]; settle: () => void; revert: () => void } {
    const changed: string[] = [];
    const touched: MailMessage[] = [];
    for (const id of ids) {
      const message = this.get(id);
      if (!message) continue;
      const next = applyEdit(message, edit);
      if (next.labels.join() !== message.labels.join()) changed.push(id);
      touched.push(next);
      this.edits.set(id, [...(this.edits.get(id) ?? []), edit]);
    }
    if (touched.length) this.items.upsert("gmail", touched.map((value) => ({ kind: "mail" as const, externalId: value.id, value, updatedAt: value.receivedAt })));
    const forget = () => {
      for (const id of ids) {
        const list = (this.edits.get(id) ?? []).filter((item) => item !== edit);
        if (list.length) this.edits.set(id, list);
        else this.edits.delete(id);
      }
    };
    return {
      changed,
      settle: forget,
      revert: () => {
        forget();
        const inverse: LabelEdit = { add: edit.remove, remove: edit.add };
        const restored = changed.map((id) => this.get(id)).filter((message): message is MailMessage => !!message).map((message) => applyEdit(message, inverse));
        if (restored.length) this.items.upsert("gmail", restored.map((value) => ({ kind: "mail" as const, externalId: value.id, value, updatedAt: value.receivedAt })));
      },
    };
  }

  /**
   * Points every cached message's Gmail link at `account` (links stored before
   * the account was known, or for another account, used u/0). Returns how many changed.
   */
  relink(account: string | undefined): number {
    const stale = this.all().filter((message) => message.webUrl !== gmailThreadUrl(message.threadId, account));
    if (stale.length) this.items.upsert("gmail", stale.map((message) => ({
      kind: "mail" as const, externalId: message.id, value: { ...message, webUrl: gmailThreadUrl(message.threadId, account) }, updatedAt: message.receivedAt,
    })));
    return stale.length;
  }

  /** Pending edits currently held (tests). */
  get pendingEdits(): number {
    return this.edits.size;
  }

  private overlay(message: MailMessage): MailMessage {
    const edits = this.edits.get(message.id);
    return edits ? edits.reduce(applyEdit, message) : message;
  }
}

export function applyEdit(message: MailMessage, edit: LabelEdit): MailMessage {
  const labels = message.labels.filter((label) => !edit.remove.includes(label));
  for (const label of edit.add) if (!labels.includes(label)) labels.push(label);
  return withLabels(message, labels);
}
