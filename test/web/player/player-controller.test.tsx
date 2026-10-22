import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES } from "../../../src/web/player/capabilities.ts";
import { PlayerController } from "../../../src/web/player/player-controller.tsx";

describe("PlayerController", () => {
  it("applies a seek requested before any player attached", () => {
    const controller = new PlayerController();
    controller.seek(5_000);
    const seek = vi.fn();
    controller.attach({ capabilities: CAPABILITIES.youtube, seek });
    expect(seek).toHaveBeenCalledWith(5_000);
  });

  it("exposes time only for players that track it", () => {
    const controller = new PlayerController();
    const detach = controller.attach({ capabilities: CAPABILITIES.bilibili, seek: vi.fn() });
    controller.reportTime(1_000);
    expect(controller.currentTimeMs()).toBeUndefined();
    detach();
    controller.attach({ capabilities: CAPABILITIES.local, seek: vi.fn() });
    controller.reportTime(1_000);
    expect(controller.currentTimeMs()).toBe(1_000);
  });

  it("falls back to no capabilities after detaching", () => {
    const controller = new PlayerController();
    const detach = controller.attach({ capabilities: CAPABILITIES.youtube, seek: vi.fn() });
    detach();
    expect(controller.capabilities).toEqual(CAPABILITIES.none);
  });
});
