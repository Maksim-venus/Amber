import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../../src/web/i18n.ts";
import { pageSizeStorageKey, Pagination, parsePositiveInt, usePagination, type PaginationScope } from "../../../src/web/ui/pagination.tsx";

initI18n();

let locations: string[] = [];
let navigationKinds: string[] = [];

function Probe(props: { scope: PaginationScope; total: number | undefined; totalStale?: boolean; onPageShown?: () => void }) {
  const pager = usePagination(props);
  const location = useLocation();
  locations.push(`${location.pathname}${location.search}`);
  return (
    <div>
      <output data-testid="state">{`${pager.page}|${pager.pageSize}|${pager.offset}`}</output>
      <output data-testid="slice">{pager.slice(Array.from({ length: props.total ?? 0 }, (_, i) => i + 1)).join(",")}</output>
      <Pagination pager={pager} />
    </div>
  );
}

function Harness(props: { route: string; scope?: PaginationScope; total: number | undefined; totalStale?: boolean; onPageShown?: () => void }) {
  return (
    <MemoryRouter initialEntries={[props.route]}>
      <Routes>
        <Route path="*" element={<Probe scope={props.scope ?? "library"} total={props.total} {...(props.totalStale === undefined ? {} : { totalStale: props.totalStale })} {...(props.onPageShown === undefined ? {} : { onPageShown: props.onPageShown })} />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Lets a test change the total after mount, as a list answering does. */
function Changing(props: { route: string; initial: number | undefined }) {
  const [total, setTotal] = useState(props.initial);
  return (
    <>
      <button type="button" onClick={() => setTotal((value) => (value ?? 0) + 100)}>
        grow
      </button>
      <Harness route={props.route} total={total} />
    </>
  );
}

const lastLocation = (): string => locations.at(-1) ?? "";
const state = (): string => screen.getByTestId("state").textContent ?? "";

beforeEach(() => {
  locations = [];
  navigationKinds = [];
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsePositiveInt", () => {
  it("accepts positive safe integers only", () => {
    expect(parsePositiveInt("3")).toBe(3);
    for (const raw of [null, "", "0", "-1", "1.5", "abc", "1e3", "99999999999999999999"]) expect(parsePositiveInt(raw)).toBeUndefined();
  });
});

describe("Pagination", () => {
  it("shows total, size, previous, current box, next and jump", () => {
    render(<Harness route="/library" total={136} />);
    expect(screen.getByText("共 136 条")).toBeTruthy();
    expect((screen.getByLabelText("每页条数") as HTMLSelectElement).value).toBe("10");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["每页 10 条", "每页 15 条", "每页 20 条", "每页 50 条"]);
    const current = screen.getByText("第 1 / 14 页");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByLabelText("跳转到页码")).toBeTruthy();
    expect(screen.getByText("1,2,3,4,5,6,7,8,9,10", { exact: false })).toBeTruthy();
  });

  it("is hidden while the total is unknown or the list is empty", () => {
    const { unmount } = render(<Harness route="/library" total={undefined} />);
    expect(screen.queryByRole("navigation")).toBeNull();
    unmount();
    render(<Harness route="/library" total={0} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("shows every control for a single row", () => {
    render(<Harness route="/library" total={1} />);
    expect(screen.getByText("共 1 条")).toBeTruthy();
    expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
    expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("跳转到页码")).toBeTruthy();
    expect(screen.getByRole("button", { name: "跳转" })).toBeTruthy();
  });

  it("moves to the next and previous page, writing page and pageSize", () => {
    render(<Harness route="/library?status=failed" total={136} />);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(lastLocation()).toBe("/library?status=failed&page=2&pageSize=10");
    expect(screen.getByText("第 2 / 14 页")).toBeTruthy();
    expect(state()).toBe("2|10|10");
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(lastLocation()).toBe("/library?status=failed&pageSize=10");
    expect(state()).toBe("1|10|0");
  });

  it("disables next on the last page", () => {
    render(<Harness route="/library?page=14&pageSize=10" total={136} />);
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("slice").textContent).toBe("131,132,133,134,135,136");
  });

  it("changing the size goes back to page 1 and remembers it for this page only", () => {
    render(<Harness route="/library?page=3&pageSize=10" total={136} />);
    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "50" } });
    expect(lastLocation()).toBe("/library?pageSize=50");
    expect(screen.getByText("第 1 / 3 页")).toBeTruthy();
    expect(localStorage.getItem(pageSizeStorageKey("library"))).toBe("50");
    expect(localStorage.getItem(pageSizeStorageKey("trash"))).toBeNull();
  });

  it("uses the remembered size when the URL has none, and the URL's size over it", () => {
    localStorage.setItem(pageSizeStorageKey("trash"), "20");
    const { unmount } = render(<Harness route="/trash" scope="trash" total={136} />);
    expect(state()).toBe("1|20|0");
    unmount();
    render(<Harness route="/trash?pageSize=15" scope="trash" total={136} />);
    expect(state()).toBe("1|15|0");
  });

  it("jumps to a typed page, clamping out-of-range integers", () => {
    render(<Harness route="/library" total={136} />);
    const input = screen.getByLabelText("跳转到页码") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(lastLocation()).toBe("/library?page=6&pageSize=10");
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.click(screen.getByRole("button", { name: "跳转" }));
    expect(lastLocation()).toBe("/library?page=14&pageSize=10");
  });

  it("ignores empty and non-integer jumps", () => {
    render(<Harness route="/library" total={136} />);
    const input = screen.getByLabelText("跳转到页码") as HTMLInputElement;
    const before = locations.length;
    for (const value of ["", "2.5"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    }
    expect(lastLocation()).toBe("/library");
    expect(locations.length).toBe(before);
  });

  it("clears the jump input when the total changes", () => {
    render(<Changing route="/library" initial={136} />);
    const input = screen.getByLabelText("跳转到页码") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "grow" }));
    expect((screen.getByLabelText("跳转到页码") as HTMLInputElement).value).toBe("");
  });

  it("keeps the jump box when everything fits one page, clamping to it", () => {
    render(<Harness route="/library?pageSize=50" total={30} />);
    expect(screen.getByText("第 1 / 1 页")).toBeTruthy();
    const input = screen.getByLabelText("跳转到页码") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(lastLocation()).toBe("/library?pageSize=50");
    expect(state()).toBe("1|50|0");
  });
});

describe("usePagination normalization", () => {
  it("leaves a deep link alone while the total is unknown", () => {
    render(<Harness route="/library?page=99&pageSize=13" total={undefined} />);
    expect(lastLocation()).toBe("/library?page=99&pageSize=13");
    expect(state()).toBe("99|10|980");
  });

  it("leaves it alone while the total is stale", () => {
    render(<Harness route="/library?page=99&pageSize=10" total={20} totalStale />);
    expect(lastLocation()).toBe("/library?page=99&pageSize=10");
  });

  it("rewrites an out-of-range page to the last one once the total is known", () => {
    render(<Harness route="/library?page=99&pageSize=10" total={63} />);
    expect(lastLocation()).toBe("/library?page=7&pageSize=10");
    expect(state()).toBe("7|10|60");
  });

  it("rewrites to page 1 when the list is empty", () => {
    render(<Harness route="/library?page=99&pageSize=20" total={0} />);
    expect(lastLocation()).toBe("/library?pageSize=20");
  });

  it("rewrites a malformed page and page size", () => {
    render(<Harness route="/library?status=failed&page=abc&pageSize=13" total={63} />);
    expect(lastLocation()).toBe("/library?status=failed&pageSize=10");
  });

  it("adds the page size a hand-written page lacks", () => {
    render(<Harness route="/library?page=2" total={63} />);
    expect(lastLocation()).toBe("/library?page=2&pageSize=10");
  });

  it("does not write a URL that is already right", () => {
    render(<Harness route="/library?page=2&pageSize=10" total={63} />);
    expect(locations.every((location) => location === "/library?page=2&pageSize=10")).toBe(true);
  });

  it("rewrites in place rather than adding history", () => {
    // MemoryRouter keeps one entry when every write replaces; navigating back would otherwise land on page 99.
    function Back() {
      const location = useLocation();
      navigationKinds.push(location.key);
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/library?page=99&pageSize=10"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Probe scope="library" total={63} />
                <Back />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(lastLocation()).toBe("/library?page=7&pageSize=10");
    expect(new Set(navigationKinds).size).toBe(2);
  });

  it("calls onPageShown after a page change but not on first render", () => {
    const shown = vi.fn();
    render(<Harness route="/library" total={136} onPageShown={shown} />);
    expect(shown).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    });
    expect(shown).toHaveBeenCalledTimes(1);
  });
});
