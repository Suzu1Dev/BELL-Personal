import type { MailMessage } from "../shared/mail.js";
import type { SeedKit } from "./seed-demo-kit.js";

/**
 * MAIL team's demo rows (SPEC-mail-assignments §13): archived conversations
 * (labels without INBOX, already read) from the last week, so the 封存 view
 * has cached rows without a Google account: the professor's answer about the
 * midterm (already replied to), a KKTIX order receipt and a department
 * notice. They join the seed's one Gmail replace, so a re-run moves them to
 * the new day.
 */
export function demoArchivedMail(kit: SeedKit): MailMessage[] {
  const { at, mail, triage } = kit;
  // Gmail's All Mail view finds a conversation that left the inbox.
  const archivedUrl = (id: string) => `https://mail.google.com/mail/u/0/#all/${id}`;
  return [
    mail("demo-archived-lin", { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, "Re: 期中考範圍", at(-3, "14:20"), {
      unread: false, labels: ["IMPORTANT", "CATEGORY_PERSONAL"], repliedAt: at(-3, "16:05"), webUrl: archivedUrl("demo-archived-lin"),
      snippet: "同學好，期中考範圍到第 6 章 Synchronization，不含 6.8…",
      excerpt: "同學好，\n\n期中考範圍到第 6 章 Synchronization，不含 6.8。考試可以帶一張 A4 手寫小抄。\n\n林志明",
      triage: triage("needs-reply", "期中考考到第 6 章，不含 6.8，可以帶一張 A4 手寫小抄。", { priority: "medium", action: "reply", context: "作業系統" }),
    }),
    mail("demo-archived-kktix", { name: "KKTIX", email: "no-reply@kktix.com" }, "訂單收據：g0v 零時政府第柒拾次大松", at(-5, "20:10"), {
      unread: false, labels: ["CATEGORY_UPDATES"], listUnsubscribe: true, webUrl: archivedUrl("demo-archived-kktix"),
      snippet: "您的訂單已完成付款，票券已放在 KKTIX 帳戶中…",
      excerpt: "您的訂單已完成付款。\n\n活動：g0v 零時政府第柒拾次大松\n票券已放在 KKTIX 帳戶中，入場時出示 QR Code 即可。",
      triage: triage("notification", "g0v 大松的訂單已付款完成，票券在 KKTIX 帳戶裡。"),
    }),
    mail("demo-archived-office", { name: "資工系辦", email: "office@cs.nycu.edu.tw" }, "[公告] 研究生獎助學金審查結果", at(-6, "10:30"), {
      unread: false, labels: ["CATEGORY_UPDATES"], webUrl: archivedUrl("demo-archived-office"),
      snippet: "本學期研究生獎助學金審查結果已公布於系網…",
      excerpt: "各位同學好：\n\n本學期研究生獎助學金審查結果已公布於系網公告區，如有疑問請於兩週內來信系辦。\n\n資工系辦",
      triage: triage("school", "獎助學金審查結果已公布在系網，有疑問兩週內寄信給系辦。", { action: "none" }),
    }),
  ];
}
