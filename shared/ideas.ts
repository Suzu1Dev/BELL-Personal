import type { Todo } from "./todos.js";

export const IDEA_ORIGINS = ["manual", "quick-capture"] as const;
export type IdeaOrigin = (typeof IDEA_ORIGINS)[number];

/** 靈感: a captured creative idea. Tags may come from a confirmed AI suggestion. */
export interface Idea {
  id: string;
  text: string;
  title?: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  origin: IdeaOrigin;
  createdAt: string;
  updatedAt: string;
}

export const IDEA_LIMITS = { text: 8000, title: 120, tags: 8, tag: 30 } as const;

/** One AI tag proposal (an `idea-tags` suggestion with a single tag): tap to confirm, × to dismiss. */
export interface IdeaTagProposal {
  suggestionId: string;
  tag: string;
}

/** An idea as the 靈感 page lists it. */
export interface IdeaView extends Idea {
  /** Local day of createdAt, for the by-day list. */
  day: string;
  /** Pending AI tag proposals (dashed chips). */
  proposals: IdeaTagProposal[];
}

/** GET /api/ideas?q=&tag=&archived=1&limit= */
export interface IdeaListResponse {
  /** Today in BELLPERSONAL_TZ (the list's 今天 / 昨天 headings). */
  today: string;
  ideas: IdeaView[];
  /** Every tag in use on non-archived ideas with its count, most used first. */
  tags: Array<{ tag: string; count: number }>;
  /** Non-archived ideas in total (unfiltered). */
  total: number;
  /** Whether AI tag proposals are on (ai.enabled && ai.ideaTags). */
  aiTags: boolean;
}

/** POST /api/ideas → 201 Idea. */
export interface IdeaCreateRequest {
  text: string;
  title?: string;
  tags?: string[];
  pinned?: boolean;
}

/** PATCH /api/ideas/:id → Idea. */
export interface IdeaUpdateRequest {
  text?: string;
  title?: string | null;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
}

/** DELETE /api/ideas/:id → 200; 復原 = POST /api/trash/restore. */
export interface IdeaDeleteResponse {
  deleted: true;
  undoToken?: string;
}

/**
 * POST /api/ideas/:id/todo {} → 201. One transaction makes an open `manual` todo from the idea (title = its first
 * non-empty line, the rest in the notes) and archives the idea. 復原 = POST /api/trash/restore { token: undoToken },
 * which removes that todo and moves the idea back. 404 when the idea is gone, 409 when it is already archived.
 */
export interface IdeaToTodoResponse {
  todo: Todo;
  undoToken: string;
}
