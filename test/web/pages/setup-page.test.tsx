import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { SetupPage } from "../../../src/web/pages/setup-page.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const ME = { userId: "admin1", role: "admin", mode: "server", mustChangePassword: false };

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function fill(token: string): void {
  fireEvent.change(screen.getByLabelText(/^Setup token/), { target: { value: ` ${token} ` } });
  fireEvent.change(screen.getByLabelText(/^用户名/), { target: { value: "admin" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "a-long-enough-pass" } });
  fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "a-long-enough-pass" } });
  fireEvent.click(screen.getByRole("button", { name: "创建管理员" }));
}

function errorBody(errorClass: string, code: string) {
  return { error: { class: errorClass, code, retryDisposition: "never", userMessage: "" } };
}

describe("SetupPage", () => {
  it("requests nothing on load and sends the token in its header on submit", async () => {
    const { calls } = mockApi({ "POST /api/setup": { status: 201, body: ME } });
    renderApp(
      <>
        <SetupPage />
        <Where />
      </>,
      { route: "/setup", mode: "server" },
    );
    expect(screen.getByTestId("setup-form")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    fill("tok-123");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/library"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["x-amber-setup-token"]).toBe("tok-123");
    expect(calls[0]?.headers["x-amber-request"]).toBe("1");
    expect(calls[0]?.path).toBe("/api/setup");
    expect(calls[0]?.body).toEqual({ username: "admin", password: "a-long-enough-pass" });
  });

  it("explains a rejected token and an already initialized instance", async () => {
    let status = 401;
    mockApi({
      "POST /api/setup": () => ({ status, body: status === 401 ? errorBody("unauthenticated", "unauthenticated.setup_token") : errorBody("conflict", "conflict") }),
    });
    renderApp(<SetupPage />, { route: "/setup", mode: "server" });
    fill("wrong");
    expect(await screen.findByText(/setup token 无效或已过期/)).toBeTruthy();
    // A rejected token stays on the page rather than counting as a lost session.
    expect(screen.getByTestId("setup-form")).toBeTruthy();
    status = 409;
    fireEvent.click(screen.getByRole("button", { name: "创建管理员" }));
    expect(await screen.findByText("这台服务器已经初始化过了。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "去登录" }).getAttribute("href")).toBe("/login");
  });

  it("checks the password before sending anything", async () => {
    const { calls } = mockApi({});
    renderApp(<SetupPage />, { route: "/setup", mode: "server" });
    fireEvent.change(screen.getByLabelText(/^Setup token/), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText(/^用户名/), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "创建管理员" }));
    expect(await screen.findByText("密码至少 12 个字符")).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
