import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TaskDetailDto } from "../../../shared/dto/task.ts";
import { useTask } from "../../api/context.tsx";
import { TaskFlow } from "../../components/task-flow.tsx";
import { Button } from "../../ui/button.tsx";

/**
 * The stage flow of a Task the user just started from this page, shown until it succeeds
 * (then `onSucceeded` runs once with the final snapshot) or the user closes it; failures stay visible with their
 * AppError and the rerun action.
 */
export function TrackedTask(props: { taskId: string; onSucceeded?: (detail: TaskDetailDto) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const view = useTask(props.taskId);
  const detail = view.detail;
  const status = detail?.statusProjection;
  const fired = useRef(false);
  const { onSucceeded } = props;
  useEffect(() => {
    if (detail !== undefined && status === "succeeded" && !fired.current) {
      fired.current = true;
      onSucceeded?.(detail);
    }
  }, [detail, status, onSucceeded]);
  if (status === "succeeded") return null;
  return (
    <div className="rounded-md border border-line p-3" data-testid="tracked-task">
      <TaskFlow taskId={props.taskId} />
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          {t("common.action.close")}
        </Button>
      </div>
    </div>
  );
}
