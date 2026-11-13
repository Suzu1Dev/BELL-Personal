/**
 * CaptureCard (SPEC-ux §4.6, §9): first in the side column. The card chrome
 * (`.card.capture`) around the shared capture field — the tasks team's
 * <CaptureField> with the live parse preview, Tab to switch the type and the
 * optimistic commit with its undo toast — and the two latest ideas. Local
 * first: never loading; a failed submit keeps the text in the field and in
 * localStorage.
 */
import type { ReactNode } from "react";
import type { TodayPayload } from "../../../shared/today";
import { CAPTURE } from "../../copy/today";
import { ideaWhen } from "./today-view";
import "./CaptureCard.css";

export interface CaptureCardProps {
  payload: TodayPayload | undefined;
  /** The `.cap-field` + `.cap-hint` pair (TodayPage passes <CaptureField>; tests a static stand-in). */
  field: ReactNode;
}

export function CaptureCard({ payload, field }: CaptureCardProps) {
  const ideas = payload?.ideas.slice(0, 2) ?? [];
  return (
    <section className="card capture" aria-label={CAPTURE.label}>
      {field}
      {ideas.length ? (
        <div className="recent" aria-label={CAPTURE.recentLabel}>
          {ideas.map((idea) => (
            <p className="idea" key={idea.id}>
              <span>{idea.text}</span>
              <small>{payload ? ideaWhen(idea.at, payload.now) : null}</small>
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
