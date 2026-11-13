/**
 * EndMark (SPEC-ux §4.9): the page reads as finite. Always last, in every
 * state: 「今天的版面到這裡。」 then when the next brief arrives (or that AI
 * briefs are off).
 */
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings";
import type { TodayPayload } from "../../../shared/today";
import { ENDMARK } from "../../copy/today";

export function EndMark({ brief }: { brief: TodayPayload["brief"] | undefined }) {
  const note = brief?.state === "off" ? ENDMARK.off : ENDMARK.next(brief?.next ?? DEFAULT_APP_SETTINGS["brief.autoTime"]);
  return (
    <footer className="endmark">
      <i aria-hidden="true" />
      <p className="kp"><b>{ENDMARK.title}</b>{brief ? note : null}</p>
    </footer>
  );
}
