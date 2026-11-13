/**
 * BacklogNote: one quiet line directly under the queue card when open todos
 * with no due day were captured before today (`payload.backlog`, sent by the
 * todos module): 「還有 3 件待辦沒排日期 · 去排一下」. Not an alert and not part
 * of the queue: the headline count, progress and badges never include it.
 * 去排一下 opens #/tasks on the 沒有期限 group. Nothing renders before the
 * first payload, after a failed first load, or at 0.
 */
import type { TodayPayload } from "../../../shared/today";
import { BACKLOG } from "../../copy/today";
import { TextLink } from "../../components/Link";
import "./BacklogNote.css";

export function BacklogNote({ payload }: { payload: TodayPayload | undefined }) {
  const count = payload?.backlog?.undatedTodos ?? 0;
  if (count <= 0) return null;
  return (
    <p className="backlog">
      <span>{BACKLOG.line(count)}</span>
      <TextLink href="#/tasks?group=someday">{BACKLOG.action}</TextLink>
    </p>
  );
}
