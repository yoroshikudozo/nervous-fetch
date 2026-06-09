import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

// Browser worker for the dev demo. Imported dynamically (see MswProvider) so
// it never ends up in the production bundle.
export const worker = setupWorker(...handlers);
