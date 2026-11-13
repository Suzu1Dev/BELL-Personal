import test from "node:test";
import assert from "node:assert/strict";
import { assignmentKey, cleanSubject, courseKey, detectAssignment, extractAssignment, sameAssignment, sameCourse, sameNativeAssignment, type AssignmentMailInput } from "./assignment-detect.js";

const context = { schoolDomains: ["nycu.edu.tw"], timeZone: "Asia/Taipei" };
/** SPEC-mail-assignments §5.4: received Monday 2026-10-12 09:00 in Taipei. */
const RECEIVED = "2026-10-12T01:00:00.000Z";

interface Golden {
  name: string;
  from: AssignmentMailInput["from"];
  subject: string;
  text: string;
  receivedAt?: string;
  automated?: boolean;
  labels?: string[];
  courses?: string[];
  /** undefined: detectAssignment proposes nothing. */
  draft?: { title: string; courseName?: string; dueAt: string | null; dueDay?: string; submitHint?: string; url?: string };
}

const GOLDEN: Golden[] = [
  // The §5.4 table.
  {
    name: "professor's announcement with a course tag, a date, a time and an upload",
    from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "【作業系統】HW5 公告",
    text: "HW5：系統呼叫實作，請於 10/16（五）23:59 前上傳至 E3。",
    draft: { title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z", submitHint: "上傳至 E3" },
  },
  {
    name: "TA's reply: next Wednesday at noon, sent by mail",
    from: { name: "王助教", email: "ta-net@cs.nycu.edu.tw" }, subject: "Re: 計網 Lab 3 繳交方式",
    text: "Lab 3 請在下週三中午 12:00 前把報告寄到 ta-net@cs.nycu.edu.tw",
    draft: { title: "Lab 3", dueAt: "2026-10-21T04:00:00.000Z", submitHint: "把報告寄到 ta-net@cs.nycu.edu.tw" },
  },
  {
    name: "a teacher on Gmail: a date only is due at 23:59",
    from: { name: "陳老師", email: "chen.t@gmail.com" }, subject: "期末報告繳交通知",
    text: "期末報告請在 12/20 前繳交紙本到系辦。",
    draft: { title: "期末報告", dueAt: "2026-12-20T15:59:00.000Z", dueDay: "2026-12-20", submitHint: "繳交紙本到系辦" },
  },
  {
    name: "released without a deadline: proposed with no due, the handout upload is not a hint",
    from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "HW6 已發布",
    text: "HW6 題目已上傳到 E3，截止時間另行公告。",
    draft: { title: "HW6", dueAt: null },
  },
  { name: "a newsletter about operating systems", from: { name: "iThome 電子報", email: "newsletter@ithome.com.tw" }, subject: "本週作業系統新聞", text: "本週作業系統新聞：Linux 6.12 釋出。", automated: true },
  { name: "a library notice from the school", from: { name: "NYCU 圖書館", email: "lib@nycu.edu.tw" }, subject: "[公告] 圖書館期中考週延長開放", text: "期中考週期間，浩然圖書館延長開放至 24:00，自習室同步開放。" },
  { name: "E3's own reminder (Moodle syncs it)", from: { name: "E3", email: "noreply@e3p.nycu.edu.tw" }, subject: "作業 HW3 即將截止", text: "您的作業 HW3 將在 10/12 23:59 截止。" },

  // English mail.
  {
    name: "an English homework release with a month name, 11:59 PM and a Google Form",
    from: { name: "Prof. Smith", email: "smith@cs.ucla.edu" }, subject: "[CS101] Homework 2 released",
    text: "Homework 2: Dynamic Programming is now available. It is due on Oct 20 at 11:59 PM. Submit via https://forms.gle/abc123.",
    draft: { title: "Homework 2: Dynamic Programming", courseName: "CS101", dueAt: "2026-10-20T15:59:00.000Z", submitHint: "Submit via forms.gle", url: "https://forms.gle/abc123" },
  },
  {
    name: "an English extension to next Friday 6pm",
    from: { name: "TA Kevin", email: "kevin@gmail.com" }, subject: "Lab 4 deadline extended",
    text: "The deadline for Lab 4 is extended to next Friday 6pm.",
    draft: { title: "Lab 4", dueAt: "2026-10-23T10:00:00.000Z" },
  },
  {
    name: "Assignment #1 due tomorrow at noon",
    from: { name: "Dr. Lee", email: "lee@cs.nthu.edu.tw" }, subject: "Assignment #1 reminder",
    text: "Reminder: Assignment #1 is due tomorrow at noon. Please hand in a PDF on NTU COOL https://cool.ntu.edu.tw/courses/1/assignments/2",
    draft: { title: "Assignment #1", dueAt: "2026-10-13T04:00:00.000Z", submitHint: "hand in a PDF on NTU COOL", url: "https://cool.ntu.edu.tw/courses/1/assignments/2" },
  },

  // More Chinese forms.
  {
    name: "a Chinese-numeral assignment, this Friday evening at 11, course from the known list",
    from: { name: "李老師", email: "li@mail.nycu.edu.tw" }, subject: "演算法 作業三", courses: ["演算法", "作業系統"],
    text: "作業三請於本週五晚上 11 點前上傳到 E3 作業區。",
    draft: { title: "作業三", courseName: "演算法", dueAt: "2026-10-16T15:00:00.000Z", submitHint: "上傳到 E3 作業區" },
  },
  {
    name: "a year in the date and 截止 after it",
    from: { name: "張教授", email: "chang@cs.nycu.edu.tw" }, subject: "【計算機組織】期中專題報告繳交",
    text: "期中專題報告於 2026/11/3 23:59 截止，請準時繳交。",
    draft: { title: "專題報告", courseName: "計算機組織", dueAt: "2026-11-03T15:59:00.000Z" },
  },
  {
    name: "繳交期限 with a month-day date and 中午12點",
    from: { name: "黃助教", email: "ta-db@cs.nycu.edu.tw" }, subject: "資料庫 HW2：SQL 練習",
    text: "繳交期限：11月5日 中午12點，逾期不收。繳交方式：上傳到 E3 作業區。",
    draft: { title: "HW2：SQL 練習", dueAt: "2026-11-05T04:00:00.000Z", submitHint: "上傳到 E3 作業區" },
  },
  {
    name: "明天中午前 (a period word alone is noon)",
    from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "Lab 5",
    text: "請大家明天中午前把 Lab 5 的報告上傳。",
    draft: { title: "Lab 5", dueAt: "2026-10-13T04:00:00.000Z", submitHint: "把 Lab 5 的報告上傳" },
  },
  {
    name: "a December mail about January rolls the year over",
    from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "【作業系統】HW9", receivedAt: "2026-12-28T01:00:00.000Z",
    text: "HW9 請於 1/4 前上傳。",
    draft: { title: "HW9", courseName: "作業系統", dueAt: "2027-01-04T15:59:00.000Z", dueDay: "2027-01-04" },
  },
  {
    name: "24:00 is the end of that day",
    from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "HW2 繳交",
    text: "HW2 請在 10/14 24:00 前繳交。",
    draft: { title: "HW2", dueAt: "2026-10-14T15:59:00.000Z" },
  },
  {
    name: "links on unknown hosts are never kept, E3 is",
    from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "HW7 說明",
    text: "HW7 說明在 https://example.com/hw7.pdf ，請於 10/30 前上傳 https://e3p.nycu.edu.tw/mod/assign/view.php?id=123 。",
    draft: { title: "HW7", dueAt: "2026-10-30T15:59:00.000Z", dueDay: "2026-10-30", url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=123" },
  },
  {
    name: "a hand-in verb alone counts with a deadline and a teaching sender",
    from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "期中專案繳交提醒",
    text: "請於 10/25 前上傳程式碼到 GitHub。",
    draft: { title: "期中專案繳交提醒", dueAt: "2026-10-25T15:59:00.000Z", dueDay: "2026-10-25", submitHint: "上傳程式碼到 GitHub" },
  },

  // Not assignments.
  { name: "a closed deadline with grades", from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "HW1 成績公布", text: "HW1 已於 10/5 截止，成績已公布在 E3。" },
  { name: "tuition is not homework", from: { name: "NYCU 出納組", email: "cashier@nycu.edu.tw" }, subject: "學雜費繳交通知", text: "請於 10/20 前繳交學雜費。" },
  { name: "an exam notice from the course", from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "【作業系統】期中考範圍公告", text: "期中考範圍為第 1 到 6 章，考試時間 10/28 10:10。" },
  { name: "GitHub Classroom notifications", from: { name: "GitHub Classroom", email: "classroom@github.com" }, subject: "Assignment accepted: hw5", text: "You accepted the assignment hw5. Due Oct 20." },
  { name: "a promotion", from: { name: "Udemy", email: "deals@udemy.com" }, subject: "Homework help 50% off", text: "Homework help for every course, due to popular demand.", labels: ["INBOX", "CATEGORY_PROMOTIONS"] },
  { name: "a hand-in verb without a teaching sender", from: { name: "小明", email: "ming@gmail.com" }, subject: "照片上傳", text: "請在明天前上傳社團照片。" },
  { name: "加退選作業 is an office procedure", from: { name: "NYCU 註冊組", email: "reg@nycu.edu.tw" }, subject: "加退選作業時程公告", text: "加退選作業將於 10/20 截止。" },
  { name: "a classmate asking about HW5", from: { name: "同學", email: "classmate@gmail.com" }, subject: "HW5 有人寫完了嗎", text: "想問 HW5 第二題怎麼做。" },
  { name: "the owner's own sent mail", from: { name: "Suzu", email: "suzu@nycu.edu.tw" }, subject: "Re: HW5 繳交", text: "老師好，HW5 已經上傳到 E3。", labels: ["SENT"] },
];

for (const golden of GOLDEN) {
  test(`detectAssignment: ${golden.name}`, () => {
    const input: AssignmentMailInput = {
      subject: golden.subject, from: golden.from, text: golden.text, receivedAt: golden.receivedAt ?? RECEIVED,
      ...(golden.automated ? { automated: true } : {}), ...(golden.labels ? { labels: golden.labels } : {}),
    };
    const draft = detectAssignment(input, { ...context, ...(golden.courses ? { courses: golden.courses } : {}) });
    if (!golden.draft) {
      assert.equal(draft, undefined);
      return;
    }
    assert.ok(draft, "proposed");
    assert.deepEqual(draft, { ...golden.draft, detectedBy: "rule" });
  });
}

test("cleanSubject drops reply and notice prefixes and reads a leading course tag", () => {
  assert.deepEqual(cleanSubject("Re: [公告] 【作業系統】HW5 公告"), { title: "HW5 公告", course: "作業系統" });
  assert.deepEqual(cleanSubject("FW: Re: 期末報告繳交通知"), { title: "期末報告繳交通知" });
  assert.deepEqual(cleanSubject("【計算機網路】"), { title: "【計算機網路】", course: "計算機網路" });
  assert.deepEqual(cleanSubject("【提醒】【作業系統】HW5"), { title: "HW5", course: "作業系統" });
  assert.deepEqual(cleanSubject("[HW5] 繳交方式"), { title: "繳交方式" }, "a code is not a course");
});

test("extractAssignment always returns a draft for 轉成作業", () => {
  const draft = extractAssignment({
    subject: "【作業系統】HW5 公告", from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" },
    text: "HW5：系統呼叫實作，請於 10/16（五）23:59 前上傳至 E3。", receivedAt: RECEIVED,
  }, context);
  assert.equal(draft.detectedBy, "rule");
  assert.equal(draft.courseName, "作業系統");
  assert.equal(draft.title, "HW5：系統呼叫實作");
  assert.equal(extractAssignment({ subject: "Lab 3", from: { email: "ta@cs.nycu.edu.tw" }, text: "", receivedAt: RECEIVED, context: "計算機網路" }, context).courseName, "計算機網路");
  // Nothing recognisable: the subject is the title, no deadline.
  assert.deepEqual(extractAssignment({ subject: "Re: 下週的進度", from: { email: "friend@gmail.com" }, text: "我們再約時間。", receivedAt: RECEIVED }, context),
    { title: "下週的進度", dueAt: null, detectedBy: "rule" });
  // A date before the received day is never the deadline.
  assert.equal(extractAssignment({ subject: "HW1", from: { email: "ta@cs.nycu.edu.tw" }, text: "HW1 已於 10/5 截止。", receivedAt: RECEIVED }, context).dueAt, null);
});

test("long and hostile text stays linear and cut", () => {
  const text = `${"作業".repeat(50_000)} 10/16 前上傳 ${"a".repeat(100_000)}`;
  const started = Date.now();
  const draft = extractAssignment({ subject: "HW1", from: { email: "ta@cs.nycu.edu.tw" }, text, receivedAt: RECEIVED }, context);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(draft.dueAt, null, "the deadline sits past the 4,000-character cut");
});

test("assignment matching across origins: code, course and deadline", () => {
  assert.equal(assignmentKey("HW5：系統呼叫實作"), "hw5");
  assert.equal(assignmentKey("Homework 5"), "hw5");
  assert.equal(assignmentKey("作業五"), "hw5");
  assert.equal(assignmentKey("Lab 3：Socket"), "lab3");
  assert.equal(assignmentKey("期末報告"), "期末報告");
  assert.equal(courseKey("【113上】作業系統"), "作業系統");
  assert.equal(courseKey("未分類"), "");
  const e3 = { title: "HW5：System Calls", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z" };
  assert.ok(sameAssignment({ title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z" }, e3));
  assert.ok(sameAssignment({ title: "HW5", courseName: "作業系統 (OS)", dueAt: null }, e3), "no deadline in the mail: course and code decide");
  assert.ok(!sameAssignment({ title: "HW5", courseName: "計算機網路", dueAt: "2026-10-16T15:59:00.000Z" }, e3), "another course");
  assert.ok(!sameAssignment({ title: "HW5", courseName: "作業系統", dueAt: "2026-10-30T15:59:00.000Z" }, e3), "another deadline");
  assert.ok(!sameAssignment({ title: "HW5", dueAt: "2026-10-16T14:00:00.000Z" }, e3), "no course: HW5 repeats in every course, never merged");
  assert.ok(!sameAssignment({ title: "HW5", dueAt: null }, e3), "no course and no deadline: never merged");
  assert.ok(sameAssignment({ title: "HW5", courseName: "作業系統", dueAt: null }, { ...e3, courseName: "作業系統 Operating Systems" }), "E3's bilingual name");
});

test("a mail assignment is never taken for another course's LMS row (it would hide the record the user just made)", () => {
  // The spec's own golden mail has no course; E3 lists another course's Lab 3 the same day.
  const draft = extractAssignment({ subject: "Re: 計網 Lab 3 繳交方式", from: { name: "王助教", email: "ta-net@cs.nycu.edu.tw" }, text: "Lab 3 請在下週三中午 12:00 前把報告寄到 ta-net@cs.nycu.edu.tw", receivedAt: RECEIVED }, context);
  assert.equal(draft.courseName, undefined);
  assert.ok(!sameAssignment(draft, { title: "Lab 3: Flip-flops", courseName: "數位電路實驗", dueAt: "2026-10-21T15:59:00.000Z" }));
  assert.ok(!sameAssignment({ title: "HW2", courseName: "DS", dueAt: "2026-10-20T15:59:00.000Z" }, { title: "HW2", courseName: "Numerical Methods", dueAt: "2026-10-20T15:59:00.000Z" }), "DS is not inside Numerical Methods");
  assert.ok(sameCourse("ML", "機器學習 (ML)"));
  assert.ok(sameCourse("作業系統", "作業系統概論"));
  assert.ok(!sameCourse("計網", "計算機網路"), "an abbreviation is not guessed");
  assert.ok(!sameCourse("作業系統", "計算機網路"));
  assert.ok(!sameCourse("AI", "Data Visualization"));
});

test("two mails about one assignment (an announcement and its reminder) are one; another course's HW5 is not", () => {
  const announcement = { title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z" };
  assert.ok(sameNativeAssignment(announcement, { title: "HW5", dueAt: "2026-10-16T15:59:00.000Z" }), "a reminder without a course, same deadline");
  assert.ok(sameNativeAssignment(announcement, { title: "HW5", courseName: "作業系統", dueAt: null }), "the TA's follow-up without a deadline");
  assert.ok(!sameNativeAssignment(announcement, { title: "HW5", courseName: "計算機網路", dueAt: "2026-10-16T15:59:00.000Z" }));
  assert.ok(!sameNativeAssignment(announcement, { title: "HW5", dueAt: null }), "no course and no deadline: could be any course");
  assert.ok(!sameNativeAssignment(announcement, { title: "HW6", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z" }));
});

const due = (text: string, subject = "作業公告") => extractAssignment({ subject, from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, text, receivedAt: RECEIVED }, context);

test("a comma never separates a date from its time; with several dates the deadline's clause decides", () => {
  const cases: Array<[string, string, string | undefined]> = [
    ["Lab 4 is due Oct 20, 9:00 AM.", "2026-10-20T01:00:00.000Z", undefined],
    ["HW5 截止：10/16（五），上午 9:00 前上傳。", "2026-10-16T01:00:00.000Z", undefined],
    ["Homework 2 is due at 11:59 PM, Oct 20.", "2026-10-20T15:59:00.000Z", undefined],
    ["Deadline: 23:59, Friday.", "2026-10-16T15:59:00.000Z", undefined],
    ["HW5 請於 10/16（五），早上 10 點上課前繳交紙本。", "2026-10-16T02:00:00.000Z", undefined],
    ["HW2 is due Friday, October 23.", "2026-10-23T15:59:00.000Z", "2026-10-23"],
    ["The deadline is Friday, Oct 23.", "2026-10-23T15:59:00.000Z", "2026-10-23"],
    ["HW3 is due Friday, Oct 16, 5:00 PM.", "2026-10-16T09:00:00.000Z", undefined],
    ["HW1 已於 10/5 截止，HW2 請於 10/20 前上傳。", "2026-10-20T15:59:00.000Z", "2026-10-20"],
    ["上傳區 10/20 18:00 開放，23:59 截止。", "2026-10-20T15:59:00.000Z", undefined],
  ];
  for (const [text, dueAt, dueDay] of cases) {
    const draft = due(text);
    assert.deepEqual([draft.dueAt, draft.dueDay], [dueAt, dueDay], text);
  }
});

test("only whole month names are months: 「10 marks」, 「separate」 and 「Market」 are not March or September", () => {
  const friday = "2026-10-16T15:59:00.000Z";
  assert.equal(due("Homework 2 (10 marks) is due Friday.").dueAt, friday);
  assert.equal(due("Homework 2 is worth 20 marks and due Oct 20.").dueAt, "2026-10-20T15:59:00.000Z");
  assert.equal(due("Upload Homework 2 as 2 separate files by Friday.").dueAt, friday);
  assert.equal(due("Homework 2 (Market 5 analysis) is due Friday.").dueAt, friday);
  assert.equal(due("Homework 2 is due 3 decimal places later, by Friday.").dueAt, friday);
  assert.equal(due("Homework 2 is due 30 November.").dueAt, "2026-11-30T15:59:00.000Z");
});

test("procedures, offices and banks are not homework: 作業 as a procedure, a hand-in verb without a teacher by name, bills", () => {
  const notices: Array<{ from: AssignmentMailInput["from"]; subject: string; text: string; category?: string }> = [
    { from: { name: "國泰世華銀行", email: "service@cathaybk.com.tw" }, subject: "網路銀行憑證更新作業通知", text: "親愛的客戶您好，請於 10/20 前完成憑證更新作業，以免影響交易。" },
    { from: { name: "財政部", email: "service@mof.gov.tw" }, subject: "綜所稅結算申報作業提醒", text: "115 年度綜合所得稅結算申報作業將於 10/31 截止，請儘早完成申報。" },
    { from: { name: "人資部", email: "hr@example-corp.com.tw" }, subject: "年終考核作業", text: "各位同仁好，年終考核作業請於 10/25 前完成填寫。" },
    { from: { name: "NYCU 總務處", email: "general@nycu.edu.tw" }, subject: "年度財產盤點作業", text: "年度財產盤點作業將於 10/22 前完成，請各單位配合。" },
    { from: { name: "住服組", email: "housing@nycu.edu.tw" }, subject: "宿舍申請資料繳交", text: "請於 10/20 前繳交宿舍申請資料。" },
    { from: { name: "生輔組", email: "life@nycu.edu.tw" }, subject: "役男兵役資料上傳", text: "請役男於 10/23 前上傳兵役資料。" },
    { from: { name: "某系統公司", email: "it@example.com" }, subject: "系統升級作業", text: "系統升級作業請於 10/20 前配合完成。" },
    { from: { name: "中華電信", email: "bill@cht.com.tw" }, subject: "9 月電子帳單", text: "本期作業費用請於 10/23 前繳交。", category: "bill" },
  ];
  for (const notice of notices) {
    assert.equal(detectAssignment({ ...notice, receivedAt: RECEIVED }, context), undefined, notice.subject);
  }
  // A course's bare 作業 still counts when the mail is about a course.
  assert.ok(detectAssignment({ from: { email: "cmlin@cs.nycu.edu.tw" }, subject: "本週作業", text: "本週作業：閱讀課本第三章並寫心得，10/19 前上傳到 E3。", receivedAt: RECEIVED }, context));
});

test("a classmate's reply from a school address is not a teacher; the TA's reply still is", () => {
  const classmate = { from: { name: "同學", email: "student@nycu.edu.tw" }, subject: "Re: 【作業系統】HW5 公告", text: "請問 HW5 可以用 C++ 寫嗎？", receivedAt: RECEIVED };
  assert.equal(detectAssignment(classmate, context), undefined);
  assert.ok(detectAssignment({ ...classmate, from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, text: "可以，HW5 不限語言。" }, context));
});

test("a short known course name matches whole words only, and the triage's course beats a guess", () => {
  const input = { subject: "HW5 details", from: { email: "cmlin@cs.nycu.edu.tw" }, text: "HW5 is due Friday.", receivedAt: RECEIVED };
  assert.equal(extractAssignment({ ...input, context: "作業系統" }, { ...context, courses: ["AI", "作業系統"] }).courseName, "作業系統", "「details」 does not name 「AI」");
  assert.equal(extractAssignment(input, { ...context, courses: ["AI"] }).courseName, undefined);
  assert.equal(extractAssignment({ ...input, subject: "Machine Learning HW5" }, { ...context, courses: ["Machine Learning"] }).courseName, "Machine Learning");
  assert.equal(extractAssignment({ ...input, subject: "演算法 HW5", context: "作業系統" }, { ...context, courses: ["演算法"] }).courseName, "作業系統", "the triage read the mail; a known name in the text is only a guess");
});
