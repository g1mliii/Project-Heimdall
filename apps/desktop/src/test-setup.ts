import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs with `globals: false`, so Testing Library's automatic cleanup
// (which registers itself on the global afterEach) never fires. Without this
// every render stacks onto the previous test's DOM and queries start matching
// multiple elements.
afterEach(cleanup);
