import type { TFunction } from "i18next";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  modelPricingSchema,
  PRICE_AMOUNT_PATTERN,
  PRICE_CURRENCIES,
  PRICE_ITEMS_MAX,
  PRICE_NOTE_MAX_CHARS,
  PRICE_UNITS_BY_SCOPE,
  type ModelPricing,
  type PriceCurrency,
  type PriceUnit,
  type PricingScope,
} from "../../shared/model-pricing.ts";
import { ApiError } from "../api/client.ts";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";
import { ErrorView } from "./error-view.tsx";

const INPUT_CLASS = "h-9 rounded-md border border-line bg-surface px-2 text-sm outline-none focus:border-accent disabled:opacity-60";

/**
 * One line naming every item of a price ("<amount> <currency> / <unit>", joined by " · "),
 * with the note after it. Amounts are shown exactly as the user typed them.
 */
export function formatPricing(pricing: ModelPricing, t: TFunction): string {
  const currency = t(`settings.pricing.currencies.${pricing.currency}`);
  const price = pricing.items
    .map((item) => t("settings.pricing.item", { amount: item.amount, currency, unit: t(`settings.pricing.units.${item.unit}`) }))
    .join(" · ");
  return pricing.note === undefined ? price : t("settings.pricing.withNote", { price, note: pricing.note });
}

/**
 * A model's price summary (or "no price") with the button that edits it. Saving goes through `onSubmit`; the dialog closes once it resolves.
 */
export function ModelPricingControl(props: {
  modelId: string;
  scope: PricingScope;
  pricing: ModelPricing | undefined;
  onSubmit: (pricing: ModelPricing | null) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid="model-pricing">
      {props.pricing === undefined ? (
        <span className="text-muted" data-testid="model-pricing-summary">
          {t("settings.pricing.unset")}
        </span>
      ) : (
        <span data-testid="model-pricing-summary">{formatPricing(props.pricing, t)}</span>
      )}
      <Button size="sm" aria-label={`${t("settings.pricing.button")} · ${props.modelId}`} onClick={() => setOpen(true)}>
        {t("settings.pricing.button")}
      </Button>
      {open ? (
        <ModelPricingDialog modelId={props.modelId} scope={props.scope} pricing={props.pricing} onSubmit={props.onSubmit} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

interface ItemDraft {
  /** Local row identity, so a row keeps its inputs while others are removed. */
  key: number;
  unit: PriceUnit;
  amount: string;
}

/**
 * Edits one model's price: a currency, up to `PRICE_ITEMS_MAX` items in the units this
 * section offers (each unit once), and an optional note. "Clear" removes the price.
 */
export function ModelPricingDialog(props: {
  modelId: string;
  scope: PricingScope;
  pricing: ModelPricing | undefined;
  onSubmit: (pricing: ModelPricing | null) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const units = PRICE_UNITS_BY_SCOPE[props.scope];
  const nextKey = useRef(0);
  const newKey = (): number => (nextKey.current += 1);
  const [currency, setCurrency] = useState<PriceCurrency>(props.pricing?.currency ?? "CNY");
  const [items, setItems] = useState<ItemDraft[]>(() =>
    props.pricing === undefined
      ? [{ key: newKey(), unit: units[0] ?? "per_request", amount: "" }]
      : props.pricing.items.map((item) => ({ key: newKey(), unit: item.unit, amount: item.amount })),
  );
  const [note, setNote] = useState(props.pricing?.note ?? "");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const used = new Set(items.map((item) => item.unit));
  const free = units.filter((unit) => !used.has(unit));
  const noteTooLong = note.trim().length > PRICE_NOTE_MAX_CHARS;
  const candidate = {
    currency,
    items: items.map((item) => ({ unit: item.unit, amount: item.amount.trim() })),
    ...(note.trim() === "" ? {} : { note: note.trim() }),
  };
  const parsed = modelPricingSchema.safeParse(candidate);

  const submit = (pricing: ModelPricing | null): void => {
    setPending(true);
    setError(null);
    props
      .onSubmit(pricing)
      .then(() => props.onClose())
      .catch((failure: unknown) => setError(failure))
      .finally(() => setPending(false));
  };

  return (
    <Modal open onOpenChange={(open) => (open ? undefined : props.onClose())} title={t("settings.pricing.title", { model: props.modelId })}>
      <form
        data-testid="model-pricing-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (parsed.success) submit(parsed.data);
        }}
      >
        <p className="mb-3 text-xs text-muted">{t("settings.pricing.intro")}</p>
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-muted" htmlFor="pricing-currency">
            {t("settings.pricing.currency")}
          </label>
          <select id="pricing-currency" className={`${INPUT_CLASS} w-32`} value={currency} onChange={(event) => setCurrency(event.target.value as PriceCurrency)}>
            {PRICE_CURRENCIES.map((item) => (
              <option key={item} value={item}>
                {t(`settings.pricing.currencies.${item}`)}
              </option>
            ))}
          </select>
        </div>
        <h3 className="mb-1 text-xs font-medium text-muted">{t("settings.pricing.items")}</h3>
        <ul>
          {items.map((item, index) => {
            const amountOk = PRICE_AMOUNT_PATTERN.test(item.amount.trim());
            return (
              <li key={item.key} className="mb-2" data-testid="pricing-item">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`${t("settings.pricing.amount")} ${index + 1}`}
                    inputMode="decimal"
                    className={`${INPUT_CLASS} w-28 min-w-0 shrink-0 font-mono`}
                    value={item.amount}
                    onChange={(event) => setItems((current) => current.map((row) => (row.key === item.key ? { ...row, amount: event.target.value } : row)))}
                  />
                  <span className="shrink-0 text-sm text-muted">{`${t(`settings.pricing.currencies.${currency}`)} /`}</span>
                  <select
                    aria-label={`${t("settings.pricing.unit")} ${index + 1}`}
                    className={`${INPUT_CLASS} min-w-0 flex-1`}
                    value={item.unit}
                    onChange={(event) =>
                      setItems((current) => current.map((row) => (row.key === item.key ? { ...row, unit: event.target.value as PriceUnit } : row)))
                    }
                  >
                    {units
                      .filter((unit) => unit === item.unit || !used.has(unit))
                      .map((unit) => (
                        <option key={unit} value={unit}>
                          {t(`settings.pricing.unitOptions.${unit}`)}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={items.length <= 1}
                    aria-label={t("settings.pricing.removeItemLabel", { index: index + 1 })}
                    onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}
                  >
                    {t("settings.pricing.removeItem")}
                  </Button>
                </div>
                {touched && !amountOk ? <p className="mt-1 text-xs text-danger">{t("settings.pricing.invalidAmount")}</p> : null}
              </li>
            );
          })}
        </ul>
        <Button
          size="sm"
          disabled={items.length >= PRICE_ITEMS_MAX || free.length === 0}
          onClick={() => {
            const unit = free[0];
            if (unit !== undefined) setItems((current) => [...current, { key: newKey(), unit, amount: "" }]);
          }}
        >
          {t("settings.pricing.addItem")}
        </Button>
        <div className="mt-3">
          <label className="mb-1 block text-xs font-medium text-muted" htmlFor="pricing-note">
            {t("settings.pricing.note")}
          </label>
          <textarea
            id="pricing-note"
            rows={2}
            className="w-full rounded-md border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
            value={note}
            placeholder={t("settings.pricing.notePlaceholder")}
            onChange={(event) => setNote(event.target.value)}
          />
          {noteTooLong ? <p className="text-xs text-danger">{t("settings.pricing.noteTooLong", { max: PRICE_NOTE_MAX_CHARS })}</p> : null}
        </div>
        {error instanceof ApiError ? (
          <div className="mt-2">
            <ErrorView error={error.error} />
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-2">
          <div>
            {props.pricing === undefined ? null : (
              <Button variant="danger" disabled={pending} onClick={() => submit(null)}>
                {t("settings.pricing.clear")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={props.onClose}>{t("common.action.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {t("common.action.save")}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
