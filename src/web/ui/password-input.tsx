import { Eye, EyeOff } from "lucide-react";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * A password input with a show / hide toggle. Label it with `htmlFor` (or use
 * `PasswordField`): a `<label>` wrapping it would take the toggle's name into the field's
 * accessible name. Spell checking stays off because enhanced spell checkers send the text of
 * visible fields to their servers. Submitting the form hides the text again, and Edge's own
 * reveal button is suppressed so there is one toggle.
 */
export function PasswordInput({ className = "", ...rest }: PasswordInputProps) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = input.current?.form;
    if (form === null || form === undefined) {
      return;
    }
    const hide = (): void => setShown(false);
    form.addEventListener("submit", hide);
    return () => form.removeEventListener("submit", hide);
  }, []);
  return (
    <span className="relative block">
      <input
        {...rest}
        ref={input}
        type={shown ? "text" : "password"}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={`${className} pr-9 [&::-ms-reveal]:hidden`}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted hover:text-ink"
        aria-label={t("auth.passwordInput.show")}
        aria-pressed={shown}
        onClick={() => setShown((value) => !value)}
      >
        {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
      </button>
    </span>
  );
}

/** A labelled `PasswordInput` stacked under its label, as on the login, setup and password forms. */
export function PasswordField({ label, ...rest }: PasswordInputProps & { label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      <PasswordInput {...rest} id={id} />
    </div>
  );
}
