import type { Assignment } from "../../../shared/assignments.js";
import type { ModuleContext } from "../../modules.js";
import { itemIdOf } from "./lms.js";

/**
 * 「標為已交」 is local until the LMS agrees (SPEC-ux §6.4). Once a sync sees
 * the assignment submitted or graded, the local mark has done its job: forget
 * it, so a later reopened submission (status back to not submitted) returns
 * to the queue instead of matching the old fingerprint. Returns how many
 * marks were cleared.
 */
export function reconcileLocalSubmissions(ctx: Pick<ModuleContext, "itemState">, assignments: Assignment[]): number {
  let cleared = 0;
  for (const assignment of assignments) {
    if (assignment.submission !== "submitted" && assignment.submission !== "graded") continue;
    const itemId = itemIdOf(assignment);
    const state = ctx.itemState.get(itemId);
    if (state?.state === "dismissed" && state.action === "submitted") {
      ctx.itemState.clear(itemId);
      cleared++;
    }
  }
  return cleared;
}
