import { useTranslation } from "react-i18next";
import { TerminologyEditor } from "../../components/terminology-editor.tsx";
import { SettingsBlock } from "./settings-ui.tsx";

/** `/settings/terminology`: the global terminology set, applied to every Content. */
export function TerminologySection() {
  const { t } = useTranslation();
  return (
    <SettingsBlock intro={t("settings.terminology.intro")}>
      <TerminologyEditor scope="global" />
    </SettingsBlock>
  );
}
