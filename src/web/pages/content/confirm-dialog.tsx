import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button.tsx";
import { Modal } from "../../ui/modal.tsx";

/** A plain confirm / cancel question for an action that cannot be undone, such as clearing a conversation. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open={props.open} onOpenChange={(open) => (open ? undefined : props.onCancel())} title={props.title}>
      <p className="text-sm">{props.message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={props.onCancel}>{t("common.action.cancel")}</Button>
        <Button variant="primary" disabled={props.busy === true} onClick={props.onConfirm} data-testid="confirm-dialog-ok">
          {props.confirmLabel ?? t("common.action.confirm")}
        </Button>
      </div>
    </Modal>
  );
}
