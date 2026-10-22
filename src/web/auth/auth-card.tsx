import type { ReactNode } from "react";

/** The centered card of the pages outside the app shell (login, setup). `centerTitle` is for the login card, whose title names the product rather than a step. */
export function AuthCard(props: { title: string; intro?: string; children: ReactNode; footer?: ReactNode; centerTitle?: boolean }) {
  return (
    <div className="flex min-h-full items-start justify-center bg-sunken px-4 py-[12vh]">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm">
        <h1 className={`mb-1 text-lg font-semibold ${props.centerTitle === true ? "text-center" : ""}`}>{props.title}</h1>
        {props.intro === undefined ? null : <p className="mb-4 text-sm text-muted">{props.intro}</p>}
        <div className={props.intro === undefined ? "mt-4" : ""}>{props.children}</div>
        {props.footer === undefined ? null : <div className="mt-4 border-t border-line pt-3 text-sm">{props.footer}</div>}
      </div>
    </div>
  );
}

export const AUTH_INPUT = "h-9 w-full rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent";
