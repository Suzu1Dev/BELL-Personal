import type { FeatureModule } from "../modules.js";
import { googleModule } from "./google/index.js";
import { gmailModule } from "./gmail/index.js";
import { calendarModule } from "./calendar/index.js";
import { eventsModule } from "./events/index.js";
import { lmsModule } from "./lms/index.js";
import { githubModule } from "./github/index.js";
import { projectsModule } from "./projects/index.js";
import { todosModule } from "./todos/index.js";
import { ideasModule } from "./ideas/index.js";
import { captureModule } from "./capture/index.js";
import { habitsModule } from "./habits/index.js";
import { weatherModule } from "./weather/index.js";
import { briefModule } from "./brief/index.js";

/**
 * The module registry (docs/ARCHITECTURE.md §2). Every module is already
 * listed: feature teams implement their folder's index.ts and never edit this
 * file. Order matters for today(): contributions merge in this order (the
 * first weather and brief win) and for /api/status output.
 */
export const featureModules: FeatureModule[] = [
  googleModule,
  gmailModule,
  calendarModule,
  eventsModule,
  lmsModule,
  githubModule,
  projectsModule,
  todosModule,
  ideasModule,
  captureModule,
  habitsModule,
  weatherModule,
  briefModule,
];
