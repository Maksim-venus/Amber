import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES } from "../../../src/web/player/capabilities.ts";
import { PlayerController, PlayerControllerProvider } from "../../../src/web/player/player-controller.tsx";
import { highlightTone, HighlightsBelowPlayer, Timeline } from "../../../src/web/player/timeline.tsx";

const highlight = (segmentId: string, score: number, startMs: number) => ({ segmentId, score, text: segmentId, segmentText: segmentId, startMs, endMs: startMs + 5_000 });

describe("Timeline", () => {
  it("draws the given AI highlights as a band whose marks seek", () => {
    const controller = new PlayerController();
    const seek = vi.fn();
    controller.attach({ capabilities: CAPABILITIES.youtube, seek });
    render(
      <PlayerControllerProvider controller={controller}>
        <Timeline durationMs={100_000} chapters={[]} highlights={[highlight("a", 95, 10_000), highlight("b", 82, 50_000)]} />
      </PlayerControllerProvider>,
    );
    const marks = screen.getByTestId("timeline-highlights").querySelectorAll<HTMLElement>("[data-highlight]");
    expect([...marks].map((mark) => mark.style.left)).toEqual(["10%", "50%"]);
    fireEvent.click(marks[1] as HTMLElement);
    expect(seek).toHaveBeenCalledWith(50_000);
  });

  it("has no band without highlights and colours by score", () => {
    render(
      <PlayerControllerProvider controller={new PlayerController()}>
        <Timeline durationMs={100_000} chapters={[]} highlights={[]} />
      </PlayerControllerProvider>,
    );
    expect(screen.queryByTestId("timeline-highlights")).toBeNull();
    expect([highlightTone(95), highlightTone(85), highlightTone(40)]).toEqual(["bg-danger", "bg-accent", "bg-muted"]);
  });

  it("leaves only the highlight band under the local player, whose chapters are in its seek bar", () => {
    const controller = new PlayerController();
    const seek = vi.fn();
    controller.attach({ capabilities: CAPABILITIES.local, seek });
    const chapters = [{ startMs: 0, endMs: 100_000, title: "全部" }];
    const { rerender } = render(
      <PlayerControllerProvider controller={controller}>
        <HighlightsBelowPlayer durationMs={undefined} chapters={chapters} highlights={[highlight("a", 95, 25_000)]} />
      </PlayerControllerProvider>,
    );
    expect(screen.queryByTestId("timeline")).toBeNull();
    expect(screen.queryByTestId("timeline-cursor")).toBeNull();
    // Without a duration the chapters still give the span.
    const mark = screen.getByTestId("timeline-highlights").querySelector<HTMLElement>("[data-highlight]") as HTMLElement;
    expect(mark.style.left).toBe("25%");
    fireEvent.click(mark);
    expect(seek).toHaveBeenCalledWith(25_000);
    rerender(
      <PlayerControllerProvider controller={controller}>
        <HighlightsBelowPlayer durationMs={100_000} chapters={chapters} highlights={[]} />
      </PlayerControllerProvider>,
    );
    expect(screen.queryByTestId("timeline-highlights")).toBeNull();
  });
});
