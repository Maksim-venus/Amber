import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { initI18n } from "../../../src/web/i18n.ts";
import { resetFakeShell } from "./desktop-bridge.ts";

// The web project runs without vitest globals, so Testing Library cannot register its own
// cleanup; every test starts with an empty document and real i18n resources.
initI18n();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetFakeShell();
});
