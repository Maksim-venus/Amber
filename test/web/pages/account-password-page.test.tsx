import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { AccountPasswordPage } from "../../../src/web/pages/account-password-page.tsx";
import { mockApi, renderApp } from "../../fixtures/web/render.tsx";

const ME = { userId: "u1", username: "admin", role: "admin", mode: "server", mustChangePassword: false };

describe("AccountPasswordPage", () => {
  it("names the account and changes the password", async () => {
    const { calls } = mockApi({ "GET /api/auth/me": { body: ME }, "POST /api/auth/change-password": { body: ME } });
    renderApp(<AccountPasswordPage />, { route: "/account/password", path: "/account/password", mode: "server" });
    expect((await screen.findByTestId("password-page-account")).textContent).toBe("当前账号admin管理员");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("修改密码");
    expect(screen.queryByRole("button", { name: "登出" })).toBeNull();
    fireEvent.change(screen.getByLabelText("当前密码"), { target: { value: "old-password-123" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password-123" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "new-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(await screen.findByText("密码已修改，其它设备上的登录已退出")).toBeTruthy();
    expect(calls.find((call) => call.path === "/api/auth/change-password")?.body).toEqual({ currentPassword: "old-password-123", newPassword: "new-password-123" });
  });

  it("says plainly that the current password is wrong", async () => {
    mockApi({
      "GET /api/auth/me": { body: ME },
      "POST /api/auth/change-password": {
        status: 400,
        body: { error: { class: "invalid_request", code: "invalid_request", retryDisposition: "never", userMessage: "请求参数有误：currentPassword" } },
      },
    });
    renderApp(<AccountPasswordPage />, { route: "/account/password", path: "/account/password", mode: "server" });
    fireEvent.change(await screen.findByLabelText("当前密码"), { target: { value: "not-the-password" } });
    fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password-123" } });
    fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "new-password-123" } });
    fireEvent.click(screen.getByRole("button", { name: "修改密码" }));
    expect(await screen.findByText("当前密码不正确")).toBeTruthy();
    expect(screen.queryByText(/currentPassword/u)).toBeNull();
  });

  it("sends local mode, which has no login credentials, to the settings", async () => {
    mockApi({ "GET /api/auth/me": { body: { userId: "local", role: "admin", mode: "local", mustChangePassword: false } } });
    renderApp(
      <>
        <AccountPasswordPage />
        <Where />
      </>,
      { route: "/account/password" },
    );
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/settings/models"));
  });
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}
