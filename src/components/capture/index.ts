/**
 * Quick capture for every surface (SPEC-ux §6.6): Today's capture card wraps
 * <CaptureField>, the palette's 快速新增 and the mobile ＋捕捉 sheet use the
 * same hooks (useCaptureState / useCaptureCommit / useAiParse) and <ParseRow>,
 * #/ideas has the <Composer>. docs/FRONTEND.md §5 has the contract.
 */
export { CaptureField, CAPTURE_FIELD_DRAFT_KEY, type CaptureFieldProps } from "./CaptureField";
export { Composer, composerDraftKey } from "./Composer";
export { ParseRow, type ParseRowProps } from "./ParseRow";
export { CAPTURED_EVENT, captureApi, notifyCaptured } from "./client";
export { captureToast, chipLabel, optionMeta, whenLabel } from "./describe";
export { useAiParse, useCaptureCommit, useCaptureEnv, useCaptureState, type CaptureEnv, type CaptureState } from "./useCapture";
