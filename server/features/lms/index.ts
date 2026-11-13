import type { Assignment } from "../../../shared/assignments.js";
import { AppError } from "../../errors.js";
import type { ActionHandler, FeatureModule, ModuleContext } from "../../modules.js";
import { defaultLabel } from "../../today/actions.js";
import { CanvasSync } from "./canvas.js";
import { acceptAssignmentSuggestion, convertMailHandler, nativeActionHandler, suggestionAssignmentHandler } from "./from-mail.js";
import { assignmentFingerprint } from "./lms.js";
import { MoodleSync } from "./moodle.js";
import { localAssignments } from "./native.js";
import { createLmsRouter } from "./router.js";
import { lmsToday } from "./today.js";

/** Actions an assignment row offers; anything else is refused before the core records it. */
const ASSIGNMENT_ACTIONS = new Set(["open", "submitted", "snooze", "dismiss"]);

/**
 * 標為已交, 開啟 and 延後 are generic (the core writes the state); this handler
 * only refuses actions an assignment does not have and, when #/work acts on
 * an assignment Today did not serve (due in 10 days), describes it so the
 * core keeps its fingerprint: the row returns when the LMS changes the due
 * date or the submission state (SPEC-ux §6.4).
 */
export function assignmentActionHandler(ctx: Pick<ModuleContext, "sourceItems">): ActionHandler {
  return (request) => {
    if (!ASSIGNMENT_ACTIONS.has(request.action)) throw new AppError(400, "作業不能這樣處理。");
    const label = defaultLabel(request.action);
    if (request.item) return { label };
    const source = request.source === "canvas" ? "canvas" : "moodle";
    const assignment = ctx.sourceItems.get<Assignment>(source, request.sourceId)?.value;
    if (!assignment) throw new AppError(404, "找不到這份作業，可能已經從學校系統移除。");
    if (request.action === "submitted" && (assignment.submission === "submitted" || assignment.submission === "graded"))
      throw new AppError(409, "學校系統已經顯示這份作業繳交了。");
    return {
      label,
      target: { kind: "assignment", title: `${assignment.courseName} ${assignment.title}`.slice(0, 280), fingerprint: assignmentFingerprint(assignment) },
    };
  };
}

/**
 * 學校作業 (work team; assignments from mail: assignments team): NYCU E3 /
 * any Moodle and Canvas, normalised to `Assignment` in source_items (kind
 * `assignment`), plus native assignments in personal.sqlite
 * `local_assignments` (announced in a teacher's mail or added on #/work,
 * SPEC-mail-assignments §5; native.ts).
 *
 * Sources: `moodle` (vault `moodle.token`) and `canvas` (vault `canvas.token`),
 *   every 30 min; a dead token → 需要重新連線.
 * Routes (/api/lms): see router.ts. today(): see today.ts.
 * actions.moodle / actions.canvas: see assignmentActionHandler.
 * actions.assignment, anySourceActions.assignment (轉成作業),
 * suggestionActions.assignment and acceptSuggestion.assignment (加入作業): see from-mail.ts.
 */
export const lmsModule: FeatureModule = {
  name: "lms",
  label: "學校作業",
  setup(ctx) {
    const moodle = new MoodleSync(ctx);
    const canvas = new CanvasSync(ctx);
    const handler = assignmentActionHandler(ctx);
    // Registers the local_assignments trash restorer once, at boot (刪除作業 → 復原).
    localAssignments(ctx);
    return {
      router: createLmsRouter(ctx, { moodle, canvas }),
      sources: [moodle, canvas],
      today: (context, input) => lmsToday(context, input),
      actions: { moodle: handler, canvas: handler, assignment: nativeActionHandler() },
      anySourceActions: { assignment: convertMailHandler() },
      suggestionActions: { assignment: suggestionAssignmentHandler() },
      acceptSuggestion: { assignment: acceptAssignmentSuggestion() },
      // Hidden without 學生: assignments and their actions refuse; the E3 / Canvas connection stays manageable.
      writableWhenHidden: ["/moodle", "/canvas"],
      status: async () => ({
        moodle: { connected: await moodle.configured().catch(() => false) },
        canvas: { connected: await canvas.configured().catch(() => false) },
      }),
    };
  },
};
