import { setupServer } from "msw/node";
import { handlers } from "./handlers";

// Node integration (vitest). Kept separate from browser.ts so tests never
// pull in `msw/browser` (which references service-worker globals).
export const server = setupServer(...handlers);
