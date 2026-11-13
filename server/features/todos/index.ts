import type { FeatureModule } from "../../modules.js";
import { acceptTodoSuggestion, convertToTodoHandler, nativeActionHandler, suggestionTodoHandler } from "./actions.js";
import { projectNames } from "./projects.js";
import { createTodosRouter } from "./router.js";
import { todoStore } from "./store.js";
import { todosToday } from "./today.js";

/**
 * 待辦 module (tasks team). Table: todos (Todo, shared/todos.ts).
 *
 *  - Routes /api/todos: list (open + finished today), get, create, PATCH,
 *    complete / uncomplete, DELETE through the trash (復原 = POST /api/trash/restore).
 *  - today(): `todo` queue rows (`native:<id>`; hints.dueAt = due time or 23:59,
 *    hardDeadline when priority high), a `due` agenda row for a timed high-priority
 *    todo today, free-slot candidates due within 48 h, nav.tasks = open todos,
 *    backlog.undatedTodos = open todos with no due day created before today
 *    (Today's quiet 還有 N 件待辦沒排日期 line; never part of the counts).
 *  - actions.native: 完成 (apply sets completedAt; undo reopens).
 *  - anySourceActions.todo: 轉待辦 from any row (a Todo with a sourceRef; undo deletes it).
 *  - suggestionActions.todo + acceptSuggestion.todo: 加入待辦 for AI todo suggestions.
 */
export const todosModule: FeatureModule = {
  name: "todos",
  label: "待辦",
  setup(ctx) {
    const store = todoStore(ctx);
    return {
      router: createTodosRouter(store, ctx),
      today: (context, input) => todosToday(store, () => projectNames(context), input),
      actions: { native: nativeActionHandler(store) },
      anySourceActions: { todo: convertToTodoHandler(store) },
      suggestionActions: { todo: suggestionTodoHandler(store) },
      acceptSuggestion: { todo: acceptTodoSuggestion(store) },
    };
  },
};
