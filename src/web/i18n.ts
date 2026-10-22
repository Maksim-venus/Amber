import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { UI_LANGUAGE_DEFAULT } from "../shared/defaults.ts";
import { zhCN } from "../shared/i18n/zh-CN/index.ts";

// i18next bootstrap: every user-visible string comes from src/shared/i18n; components look
// keys up with `t("<namespace>.<path>")`. Only zh-CN ships, so other languages fall back.

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof zhCN };
  }
}

export const RESOURCES = { [UI_LANGUAGE_DEFAULT]: { translation: zhCN } } as const;

export function initI18n(language: string = UI_LANGUAGE_DEFAULT): typeof i18next {
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      resources: RESOURCES,
      lng: language,
      fallbackLng: UI_LANGUAGE_DEFAULT,
      // React escapes rendered text already.
      interpolation: { escapeValue: false },
      returnNull: false,
      initAsync: false,
    });
  } else if (i18next.language !== language) {
    void i18next.changeLanguage(language);
  }
  return i18next;
}
