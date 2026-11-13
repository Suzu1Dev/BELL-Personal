/** Limits shared by the server's validation and the UI's hints. */
export const REQUEST_BODY_LIMIT = "160kb";
export const REQUEST_BODY_BYTES = 160 * 1024;
/** Undo toasts call POST /api/trash/restore; trash files are kept far longer (30 days). */
export const UNDO_WINDOW_MS = 6_000;
/** Largest model answer accepted, in bytes. */
export const MAX_MODEL_OUTPUT_BYTES = 120_000;
/** Largest prompt (instructions + data) sent to a model, in characters. */
export const MAX_MODEL_INPUT_CHARS = 100_000;
/** Remote writes of a queue action (Gmail modify, Calendar insert…) commit this long after the request unless undone. */
export const ACTION_COMMIT_MS = 6_500;
/** Local-only actions stay undoable from the queue footer this long. */
export const ACTION_LOCAL_UNDO_MS = 24 * 60 * 60_000;
/** Each module's today() must answer within this; a late or failing module degrades to its sources[] state. */
export const TODAY_MODULE_TIMEOUT_MS = 3_000;
