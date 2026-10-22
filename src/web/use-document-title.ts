import { useEffect } from "react";
import { useTranslation } from "react-i18next";

/** Names the browser tab after what is open (`<title> - Amber`); leaving the page restores the app name. */
export function useDocumentTitle(title: string | undefined): void {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = title === undefined || title === "" ? t("common.appName") : t("common.documentTitle", { title });
    return () => {
      document.title = t("common.appName");
    };
  }, [title, t]);
}
