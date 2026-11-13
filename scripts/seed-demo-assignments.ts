import { z } from "zod";
import { NATIVE_ASSIGNMENT_SITES, UNSORTED_COURSE, type Assignment } from "../shared/assignments.js";
import type { MailMessage } from "../shared/mail.js";
import type { AiSuggestion, AssignmentSuggestion } from "../shared/suggestions.js";
import { addDays, weekdayOf } from "../shared/time.js";
import type { Databases } from "../server/db/database.js";
import { nativeAssignmentSchema, nativeColumns } from "../server/features/lms/native.js";
import type { SeedKit } from "./seed-demo-kit.js";

/**
 * ASSIGNMENTS team's demo rows (SPEC-mail-assignments §13).
 *
 *  - demoAssignmentMail(): two teachers' announcements in the inbox, both
 *    already read: 林志明 教授's 「【作業系統】HW5 公告」 (due in 4 days) and
 *    王助教's 「Re: 計網 Lab 3 繳交方式」 (due in 6 days). They join the seed's
 *    one Gmail replace.
 *  - seedLocalAssignments(): the pending `assignment` suggestion the model
 *    made from the HW5 mail, the Lab 3 assignment already added from its mail
 *    (with its accepted suggestion), and one added by hand (專題提案書, no
 *    course, a date only). Re-running replaces them and moves them to the new day.
 */

export const DEMO_HW5_MAIL = "18c2c1d2e3f4a5b6";
export const DEMO_LAB3_MAIL = "18c29a8b7c6d5e4f";
export const DEMO_HW5_SUGGESTION = "sg-hw5-os";
const DEMO_LAB3_SUGGESTION = "sg-lab3-net";
/** Fixed uuids, so a re-run replaces the same rows (and Today's item ids stay put). */
export const DEMO_LAB3_ASSIGNMENT = "assignment:5d0c9a3e-1f2b-4c6d-8e7f-0a1b2c3d4e5f";
export const DEMO_PROPOSAL_ASSIGNMENT = "assignment:7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function demoAssignmentMail(kit: SeedKit): MailMessage[] {
  const { at, md, day, mail, triage } = kit;
  const weekday = (offset: number) => WEEKDAYS[weekdayOf(addDays(day, offset))];
  return [
    mail(DEMO_HW5_MAIL, { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, "【作業系統】HW5 公告", at(-1, "21:10"), {
      unread: false, labels: ["INBOX"],
      snippet: `HW5：系統呼叫實作，請於 ${md(4)}（${weekday(4)}）23:59 前上傳至 E3…`,
      excerpt: `各位同學好，\n\nHW5：系統呼叫實作，請於 ${md(4)}（${weekday(4)}）23:59 前上傳至 E3。\n請在 xv6 加上 trace 系統呼叫，報告一頁即可。\n\n林志明`,
      triage: triage("school", `HW5 系統呼叫實作，${md(4)} 23:59 前上傳到 E3。`, { priority: "medium", action: "none", context: "作業系統" }),
    }),
    mail(DEMO_LAB3_MAIL, { name: "王助教", email: "ta-net@cs.nycu.edu.tw" }, "Re: 計網 Lab 3 繳交方式", at(-2, "16:40"), {
      unread: false, labels: ["INBOX"],
      snippet: `Lab 3 請在 ${md(6)} 中午 12:00 前把報告寄到 ta-net@cs.nycu.edu.tw…`,
      excerpt: `同學好，\n\nLab 3 請在 ${md(6)} 中午 12:00 前把報告寄到 ta-net@cs.nycu.edu.tw，檔名用學號。\n\n王助教`,
      triage: triage("school", `Lab 3 封包分析報告 ${md(6)} 中午前寄給助教。`, { priority: "medium", action: "none", context: "計算機網路" }),
    }),
  ];
}

const loose = z.looseObject({ id: z.string() });

export function seedLocalAssignments(databases: Databases, kit: SeedKit): { assignments: number; suggestions: number } {
  const { at, ago, gmailUrl } = kit;
  const assignments = databases.personal.docs<Assignment>({ table: "local_assignments", label: "作業", schema: nativeAssignmentSchema, columns: nativeColumns });
  const lab3: Assignment = {
    id: DEMO_LAB3_ASSIGNMENT, origin: "mail", externalId: DEMO_LAB3_ASSIGNMENT.slice("assignment:".length),
    courseName: "計算機網路", title: "Lab 3：封包分析報告", dueAt: at(6, "12:00"), submission: "not-submitted",
    site: NATIVE_ASSIGNMENT_SITES.mail, submitHint: "把報告寄到 ta-net@cs.nycu.edu.tw",
    mailRef: { messageId: DEMO_LAB3_MAIL, threadId: DEMO_LAB3_MAIL, url: gmailUrl(DEMO_LAB3_MAIL) },
    createdAt: at(-2, "17:02"), updatedAt: at(-2, "17:02"),
  };
  const proposal: Assignment = {
    id: DEMO_PROPOSAL_ASSIGNMENT, origin: "manual", externalId: DEMO_PROPOSAL_ASSIGNMENT.slice("assignment:".length),
    courseName: UNSORTED_COURSE, title: "專題提案書", dueAt: at(10, "23:59"), dueDateOnly: true, submission: "not-submitted",
    site: NATIVE_ASSIGNMENT_SITES.manual, submitHint: "紙本交到系辦", notes: "一頁 A4，附上 eBPF 量測方法。",
    createdAt: ago(60 * 26), updatedAt: ago(60 * 26),
  };
  databases.personal.transaction(() => {
    // Also what the app made from the demo mails since the last seed (加入作業 on HW5): the suggestion is pending again.
    databases.personal.db.prepare("DELETE FROM local_assignments WHERE id IN (?, ?) OR source_message_id IN (?, ?)").run(lab3.id, proposal.id, DEMO_HW5_MAIL, DEMO_LAB3_MAIL);
    // Queue state left by acting on these rows before (加入作業, 標為已交) would hide them on the new day.
    databases.personal.db.prepare("DELETE FROM item_state WHERE item_id IN (?, ?, ?, ?)").run(`ai:${DEMO_HW5_SUGGESTION}`, `ai:${DEMO_LAB3_SUGGESTION}`, lab3.id, proposal.id);
    assignments.putMany([lab3, proposal]);
  });

  const suggestions = databases.sources.docs<AiSuggestion<AssignmentSuggestion>>({
    table: "ai_suggestions", label: "建議", schema: loose as unknown as z.ZodType<AiSuggestion<AssignmentSuggestion>>,
    columns: (suggestion) => ({ kind: suggestion.kind, status: suggestion.status, created_at: suggestion.createdAt }),
  });
  const hw5: AiSuggestion<AssignmentSuggestion> = {
    id: DEMO_HW5_SUGGESTION, kind: "assignment", status: "pending", title: "HW5：系統呼叫實作", origin: "林志明 教授 信件", createdAt: at(-1, "21:15"),
    payload: { title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: at(4, "23:59"), submitHint: "上傳到 E3", detectedBy: "ai" },
    sourceRef: { source: "gmail", externalId: DEMO_HW5_MAIL, url: gmailUrl(DEMO_HW5_MAIL) },
  };
  const lab3Suggestion: AiSuggestion<AssignmentSuggestion> = {
    id: DEMO_LAB3_SUGGESTION, kind: "assignment", status: "accepted", title: "Lab 3：封包分析報告", origin: "王助教 信件",
    createdAt: at(-2, "16:45"), decidedAt: at(-2, "17:02"), resultId: lab3.id,
    payload: { title: "Lab 3：封包分析報告", courseName: "計算機網路", dueAt: lab3.dueAt, submitHint: lab3.submitHint, detectedBy: "ai" },
    sourceRef: { source: "gmail", externalId: DEMO_LAB3_MAIL, url: gmailUrl(DEMO_LAB3_MAIL) },
  };
  databases.sources.transaction(() => {
    // A suggestion the app itself made from these mails since the last seed holds the same dedupe key.
    databases.sources.db.prepare("DELETE FROM ai_suggestions WHERE dedupe_key IN (?, ?) AND id NOT IN (?, ?)")
      .run(`mail-assignment:${DEMO_HW5_MAIL}`, `mail-assignment:${DEMO_LAB3_MAIL}`, hw5.id, lab3Suggestion.id);
    suggestions.putMany([hw5, lab3Suggestion]);
    const dedupe = databases.sources.db.prepare("UPDATE ai_suggestions SET dedupe_key = ? WHERE id = ?");
    dedupe.run(`mail-assignment:${DEMO_HW5_MAIL}`, hw5.id);
    dedupe.run(`mail-assignment:${DEMO_LAB3_MAIL}`, lab3Suggestion.id);
  });
  return { assignments: 2, suggestions: 2 };
}
