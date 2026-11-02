import { useState } from "react";
import { DateTime } from "luxon";
import type {
  CreateDinnerInput,
  DinnerView,
} from "../../src/miniapp/contracts";
import { Brand, Button, Field, Icon, Notice, Sheet } from "./components";
import { friendlyZone } from "./time";

interface Props {
  onBack: () => void;
  onCreate: (input: CreateDinnerInput) => Promise<void>;
  error?: string;
  busy: boolean;
  initial?: DinnerView["setup"];
  editing?: boolean;
}
export function CreateDinner({
  onBack,
  onCreate,
  error,
  busy,
  initial,
  editing = false,
}: Props) {
  const [city, setCity] = useState(initial?.city ?? ""),
    [area, setArea] = useState(initial?.area ?? "");
  const [timezone, setTimezone] = useState(
    initial?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const [start, setStart] = useState(
      initial?.windowStart ?? DateTime.now().toISODate()!,
    ),
    [end, setEnd] = useState(
      initial?.windowEnd ?? DateTime.now().plus({ days: 14 }).toISODate()!,
    );
  const legacyTotal = initial?.budget.basis === "total";
  const [partySize, setPartySize] = useState(2),
    [amount, setAmount] = useState(
      legacyTotal ? "" : (initial?.budget.amount.toString() ?? "50"),
    );
  const [currency, setCurrency] = useState(initial?.currency ?? "USD"),
    [duration, setDuration] = useState(initial?.durationMinutes ?? 90);
  const [settings, setSettings] = useState(false),
    [consent, setConsent] = useState(false),
    [localError, setLocalError] = useState("");
  const today = DateTime.now().setZone(timezone).toISODate()!;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError("");
    if (!city.trim())
      return setLocalError("Which city are we having dinner in?");
    if (
      !start ||
      !end ||
      start < today ||
      end < start ||
      DateTime.fromISO(end).diff(DateTime.fromISO(start), "days").days > 31
    )
      return setLocalError(
        "Choose a date window starting today or later, up to 31 days.",
      );
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0)
      return setLocalError("Add a budget greater than zero.");
    if (!editing && !consent)
      return setLocalError(
        "Please agree to dinner coordination before creating your dinner.",
      );
    await onCreate({
      city: city.trim(),
      ...(area.trim() ? { area: area.trim() } : {}),
      windowStart: start,
      windowEnd: end,
      timezone,
      currency,
      durationMinutes: duration,
      partySize,
      budget: { amount: Number(amount), basis: "per-person" },
      consent: true,
    });
  }
  return (
    <>
      <Brand back={onBack} settings={() => setSettings(true)} />
      <main className="page">
        <div className="eyebrow">
          {editing ? "The shared details" : "A little less planning"}
        </div>
        <h1>
          {editing ? (
            <>
              A little change
              <br />
              of plans.
            </>
          ) : (
            <>
              Make room
              <br />
              for dinner.
            </>
          )}
        </h1>
        <p className="intro">
          {editing
            ? "Changes create a fresh plan and everyone will need to confirm again."
            : "A few details to get everyone around the same table."}
        </p>
        <form onSubmit={submit} className="form-stack">
          <section className="card form-card">
            <Field label="Where are we meeting?">
              <input
                name="city"
                autoComplete="address-level2"
                placeholder="City"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
            <Field label="Neighborhood or area" optional>
              <input
                name="area"
                placeholder={
                  city.trim()
                    ? `Anywhere in ${city.trim()}`
                    : "Anywhere in the city"
                }
                value={area}
                onChange={(e) => setArea(e.target.value)}
                maxLength={160}
              />
            </Field>
          </section>
          <section className="card form-card">
            <div className="section-icon">
              <Icon name="calendar" />
              <h2>Find a day that works</h2>
            </div>
            <p className="muted small">
              Everyone will pick their own available dates next.
            </p>
            <div className="field-pair">
              <Field label="Earliest date">
                <input
                  aria-label="Earliest date"
                  type="date"
                  min={today}
                  value={start}
                  onChange={(e) => {
                    setStart(e.target.value);
                    if (end < e.target.value) setEnd(e.target.value);
                  }}
                  required
                />
              </Field>
              <Field label="Latest date">
                <input
                  aria-label="Latest date"
                  type="date"
                  min={start || today}
                  max={
                    DateTime.fromISO(start).plus({ days: 31 }).toISODate() ??
                    undefined
                  }
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  required
                />
              </Field>
            </div>
          </section>
          <section className="card form-card">
            {!editing && (
              <>
                <div className="stepper-line">
                  <div>
                    <h2>How many at the table?</h2>
                    <p className="muted small">
                      Including you. No names needed yet.
                    </p>
                  </div>
                  <div className="stepper">
                    <button
                      type="button"
                      aria-label="Fewer people"
                      onClick={() => setPartySize((v) => v - 1)}
                      disabled={partySize <= 2}
                    >
                      −
                    </button>
                    <output aria-label="Group size" aria-live="polite">
                      {partySize}
                    </output>
                    <button
                      type="button"
                      aria-label="More people"
                      onClick={() => setPartySize((v) => v + 1)}
                      disabled={partySize >= 6}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="divider" />
              </>
            )}
            {legacyTotal && (
              <Notice>
                Your previous budget was {initial!.currency}{" "}
                {initial!.budget.amount} for the whole table. Enter an explicit
                per-person amount below. Muse will not convert it automatically.
              </Notice>
            )}
            <Field
              label="Budget per person"
              hint="The maximum estimated meal cost for each person, not the group total."
            >
              <div className="money-input">
                <span>{currency}</span>
                <input
                  aria-label="Budget per person"
                  inputMode="decimal"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
            </Field>
          </section>
          <button
            type="button"
            className="settings-link"
            onClick={() => setSettings(true)}
          >
            <Icon name="settings" size={17} />
            <span>
              {friendlyZone(timezone)} · {duration} min · {currency}
            </span>
            <Icon name="chevron" size={16} />
          </button>
          {!editing && (
            <label className="check-label consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                I agree to Muse using my answers for this dinner and sending me
                planning messages in Telegram. My answers stay private unless I
                choose to share them with approved dinner members.
              </span>
            </label>
          )}
          {(localError || error) && (
            <Notice kind="error">{localError || error}</Notice>
          )}
          <Button type="submit" busy={busy} className="full">
            {editing ? "Save shared details" : "Create dinner"}{" "}
            <Icon name="arrow" />
          </Button>
          <p className="footnote">
            {editing
              ? "Everyone will review the updated plan."
              : "Next: add your availability, then share an invitation."}
          </p>
        </form>
      </main>
      {settings && (
        <Sheet title="Dinner settings" onClose={() => setSettings(false)}>
          <div className="form-stack">
            <Field
              label="Dinner timezone"
              hint="All available times and plans use this timezone."
            >
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {[
                  ...new Set([
                    timezone,
                    "UTC",
                    ...Intl.supportedValuesOf("timeZone"),
                  ]),
                ].map((zone) => (
                  <option key={zone} value={zone}>
                    {friendlyZone(zone)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Time at the table">
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {[60, 90, 120, 150, 180].map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} minutes
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Currency">
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {["USD", "CAD", "GBP", "EUR", "AUD", "INR", "JPY", "SGD"].map(
                  (code) => (
                    <option key={code}>{code}</option>
                  ),
                )}
              </select>
            </Field>
            <p className="field-hint">
              The dinner budget is always per person.
            </p>
            <Button className="full" onClick={() => setSettings(false)}>
              Done
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}
