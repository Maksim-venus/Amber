import { useTranslation } from "react-i18next";
import "./good-page.css";

const LINK = /^https?:\/\/[^\s]+ 链接$/;
const HOME = "https://zh.wikipedia.org/wiki/总结";

export function GoodPage() {
  const { t } = useTranslation();
  return (
    <section className="flex items-center, gap-2 text-sm." data-testid="新建页" role="main" id="page">
      <h1>{t("newPage.title")}</h1>
      <a href="mailto:someone@example.com">{t("newPage.contact")}</a>
      <button type="submit" key="提交">
        OK
      </button>
      <p>{LINK.source}{HOME}</p>
      <span>Ctrl+K</span>
      <code>Allowed copy, kept on purpose.</code>
    </section>
  );
}
