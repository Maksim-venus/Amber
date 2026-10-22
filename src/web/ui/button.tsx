import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent-glow text-accent-ink hover:brightness-105",
  secondary: "border border-line bg-surface hover:bg-sunken",
  ghost: "hover:bg-sunken",
  danger: "border border-line text-danger hover:bg-sunken",
};

/** Never shrinks or wraps: a squeezed flex row would otherwise break short CJK labels one character per line. */
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  const sizing = size === "sm" ? "h-7 px-2 text-xs" : "h-9 px-3 text-sm";
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
