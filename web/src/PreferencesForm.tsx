import { useState } from "react";
import { DateTime } from "luxon";
import type { PreferencesInput } from "../../src/miniapp/contracts";
import type { Constraints } from "../../src/domain/index";
import { Brand, Button, Field, Icon, Notice } from "./components";
import { dateLabel, friendlyZone, localCandidates, localIso } from "./time";

type Diet = NonNullable<Constraints["dietary"]>[number];
interface WindowRow {
  id: string;
  date: string;
  start: string;
  end: string;
  overnight: boolean;
  startOffset?: number;
  endOffset?: number;
}
export interface ResponseContext {
  city: string;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  currency: string;
  durationMinutes: number;
}
interface Props {
  context: ResponseContext;
  initial?: Constraints;
  foodConfirmed?: boolean;
  needsConsent?: boolean;
  busy: boolean;
  error?: string;
  onBack: () => void;
  onSave: (preferences: PreferencesInput) => Promise<void>;
}
const presetDiets = ["Vegetarian", "Vegan", "Gluten-free", "Halal", "Kosher"];
function initialWindows(
  initial: Constraints | undefined,
  zone: string,
): WindowRow[] {
  return (initial?.availability ?? []).map((interval) => {
    const start = DateTime.fromISO(interval.start).setZone(zone),
      end = DateTime.fromISO(interval.end).setZone(zone);
    return {
      id: crypto.randomUUID(),
      date: start.toISODate()!,
      start: start.toFormat("HH:mm"),
      end: end.toFormat("HH:mm"),
      overnight: start.toISODate() !== end.toISODate(),
      startOffset: start.offset,
      endOffset: end.offset,
    };
  });
}
function Ambiguity({
  date,
  time,
  zone,
  offset,
  onChange,
}: {
  date: string;
  time: string;
  zone: string;
  offset?: number;
  onChange: (offset: number) => void;
}) {
  const result = localCandidates(date, time, zone);
  if (result.kind === "invalid")
    return <span className="field-error">{result.message}</span>;
  if (result.kind !== "ambiguous") return null;
  return (
    <label className="field ambiguity">
      <span className="field-hint">The clocks change. Which {time}?</span>
      <select
        aria-label={`Occurrence of ${time}`}
        value={offset ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        <option value="" disabled>
          Choose first or second
        </option>
        {result.candidates.map((candidate) => (
          <option key={candidate.offset} value={candidate.offset}>
            {candidate.label}
          </option>
        ))}
      </select>
    </label>
  );
}
export function PreferencesForm({
  context,
  initial,
  foodConfirmed = false,
  needsConsent = false,
  busy,
  error,
  onBack,
  onSave,
}: Props) {
  // These drafts intentionally initialize once. Polling never replaces unsaved answers.
  const [baseline] = useState(initial);
  const [windows, setWindows] = useState(() =>
    initialWindows(initial, context.timezone),
  );
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [bulkStart, setBulkStart] = useState("19:00"),
    [bulkEnd, setBulkEnd] = useState("22:00"),
    [bulkOvernight, setBulkOvernight] = useState(false);
  const [foodChoice, setFoodChoice] = useState<"" | "none" | "requirements">(
    foodConfirmed ? (initial?.dietary?.length ? "requirements" : "none") : "",
  );
  const [diets, setDiets] = useState<Diet[]>(initial?.dietary ?? []),
    [customDiet, setCustomDiet] = useState("");
  const [preferences, setPreferences] = useState(
    initial?.preferences?.join(", ") ?? "",
  );
  const [personalBudget, setPersonalBudget] = useState(
    initial?.budget?.amount.toString() ?? "",
  );
  const [travelMax, setTravelMax] = useState(
      initial?.travel?.maxMinutes.toString() ?? "",
    ),
    [origin, setOrigin] = useState(initial?.travel?.origin ?? "");
  const [consent, setConsent] = useState(false),
    [localError, setLocalError] = useState("");
  const days: string[] = [];
  for (
    let day = DateTime.fromISO(context.windowStart);
    day.toISODate()! <= context.windowEnd && days.length < 32;
    day = day.plus({ days: 1 })
  )
    days.push(day.toISODate()!);
  function editRow(id: string, patch: Partial<WindowRow>) {
    setWindows((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }
  function addDiet(requirement: string) {
    const name = requirement.trim();
    if (
      name &&
      !diets.some((d) => d.requirement.toLowerCase() === name.toLowerCase())
    )
      setDiets((items) => [
        ...items,
        { requirement: name, strength: "firm", allergy: false },
      ]);
    setCustomDiet("");
  }
  function applyHours() {
    if (!selectedDates.length) return;
    const additions = selectedDates
      .filter(
        (date) =>
          !windows.some(
            (row) =>
              row.date === date &&
              row.start === bulkStart &&
              row.end === bulkEnd &&
              row.overnight === bulkOvernight,
          ),
      )
      .map((date) => ({
        id: crypto.randomUUID(),
        date,
        start: bulkStart,
        end: bulkEnd,
        overnight: bulkOvernight,
      }));
    setWindows((items) =>
      [...items, ...additions].sort((a, b) =>
        `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`),
      ),
    );
    setSelectedDates([]);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError("");
    try {
      if (!windows.length)
        throw new Error(
          "Add at least one time window when you are willing to come.",
        );
      if (!foodChoice)
        throw new Error("Tell us whether you have any food requirements.");
      if (foodChoice === "requirements" && !diets.length)
        throw new Error(
          "Choose or add a food requirement, or select “No requirements”.",
        );
      if (needsConsent && !consent)
        throw new Error(
          "Please agree to coordination for this dinner before saving.",
        );
      const availability = windows.map((row, i) => {
        if (row.date < context.windowStart || row.date > context.windowEnd)
          throw new Error(
            `Time window ${i + 1} falls outside this dinner's date window.`,
          );
        const start = localIso(
          row.date,
          row.start,
          context.timezone,
          row.startOffset,
        );
        const endDate = row.overnight
          ? DateTime.fromISO(row.date).plus({ days: 1 }).toISODate()!
          : row.date;
        const end = localIso(endDate, row.end, context.timezone, row.endOffset);
        if (Date.parse(end) <= Date.parse(start))
          throw new Error(
            `Time window ${i + 1}: end time must be later. Select “Ends next day” for an overnight window.`,
          );
        return { start, end };
      });
      const dietary = foodChoice === "none" ? [] : diets;
      const removeDietary = (baseline?.dietary ?? [])
        .filter(
          (old) =>
            !dietary.some(
              (diet) =>
                diet.requirement === old.requirement &&
                (!old.allergy || diet.allergy) &&
                (old.strength !== "firm" || diet.strength === "firm"),
            ),
        )
        .map((diet) => diet.requirement);
      const removeLimits: ("budget" | "travel")[] = [];
      if (!personalBudget.trim() && baseline?.budget)
        removeLimits.push("budget");
      if (!travelMax.trim() && baseline?.travel) removeLimits.push("travel");
      if (
        personalBudget &&
        (!Number.isFinite(Number(personalBudget)) ||
          Number(personalBudget) <= 0)
      )
        throw new Error("Your personal budget must be greater than zero.");
      if (
        travelMax &&
        (!origin.trim() ||
          !Number.isFinite(Number(travelMax)) ||
          Number(travelMax) <= 0)
      )
        throw new Error(
          "Add a starting point, travel method, and a travel limit greater than zero.",
        );
      const input: PreferencesInput = {
        availability,
        foodConfirmed: true,
        dietary,
        preferences: preferences
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        ...(personalBudget
          ? { budget: { amount: Number(personalBudget), strength: "firm" } }
          : {}),
        ...(travelMax
          ? {
              travel: {
                maxMinutes: Number(travelMax),
                origin: origin.trim(),
                strength: "firm",
              },
            }
          : {}),
        ...(removeDietary.length ? { removeDietary } : {}),
        ...(removeLimits.length ? { removeLimits } : {}),
      };
      await onSave(input);
    } catch (failure) {
      setLocalError(
        failure instanceof Error
          ? failure.message
          : "Please check your answers.",
      );
    }
  }
  return (
    <>
      <Brand back={onBack} />
      <main className="page">
        <div className="eyebrow">Your seat at the table</div>
        <h1>
          What works
          <br />
          for you?
        </h1>
        <p className="intro">
          Your availability and requirements stay private. Everyone sees the
          plan, not your answers.
        </p>
        <div className="context-pill">
          <Icon name="calendar" size={16} />
          {context.city} · {dateLabel(context.windowStart)}–
          {dateLabel(context.windowEnd)}
        </div>
        <form onSubmit={submit} className="form-stack">
          <section className="card form-card">
            <div className="section-icon">
              <Icon name="calendar" />
              <h2>When could you join?</h2>
            </div>
            <p className="muted small">
              Select dates, then add your available hours. Nothing is selected
              for you.
            </p>
            <div
              className="date-grid"
              role="group"
              aria-label="Available dates"
            >
              {days.map((date) => {
                const item = DateTime.fromISO(date);
                return (
                  <button
                    type="button"
                    key={date}
                    aria-label={dateLabel(date, "long")}
                    aria-pressed={selectedDates.includes(date)}
                    className={`date-cell ${selectedDates.includes(date) ? "selected" : ""} ${windows.some((row) => row.date === date) ? "has-window" : ""}`}
                    onClick={() =>
                      setSelectedDates((dates) =>
                        dates.includes(date)
                          ? dates.filter((d) => d !== date)
                          : [...dates, date],
                      )
                    }
                  >
                    <span>{item.toFormat("ccc")}</span>
                    <strong>{item.toFormat("d")}</strong>
                    <small>{item.toFormat("LLL")}</small>
                  </button>
                );
              })}
            </div>
            <div className="bulk-hours">
              <div className="field-pair">
                <Field label="From">
                  <input
                    aria-label="Available from"
                    type="time"
                    value={bulkStart}
                    onChange={(e) => setBulkStart(e.target.value)}
                  />
                </Field>
                <Field label="Until">
                  <input
                    aria-label="Available until"
                    type="time"
                    value={bulkEnd}
                    onChange={(e) => setBulkEnd(e.target.value)}
                  />
                </Field>
              </div>
              <label className="check-label small">
                <input
                  type="checkbox"
                  checked={bulkOvernight}
                  onChange={(e) => setBulkOvernight(e.target.checked)}
                />
                Ends next day
              </label>
              <Button
                variant="secondary"
                disabled={
                  !selectedDates.length ||
                  windows.length + selectedDates.length > 64
                }
                onClick={applyHours}
                className="full"
              >
                <Icon name="plus" size={17} />
                {selectedDates.length
                  ? `Add hours to ${selectedDates.length} ${selectedDates.length === 1 ? "date" : "dates"}`
                  : "Select dates above"}
              </Button>
            </div>
            <p className="field-hint timezone-note">
              <Icon name="clock" size={14} /> All times:{" "}
              {friendlyZone(context.timezone)}
            </p>
            {windows.length > 0 && (
              <div className="saved-windows">
                <h3>Your available windows</h3>
                {windows.map((row, index) => (
                  <div className="window-row" key={row.id}>
                    <div className="window-title">
                      <strong>{dateLabel(row.date, "long")}</strong>
                      <button
                        type="button"
                        aria-label={`Remove window ${index + 1}`}
                        className="icon-button small-icon"
                        onClick={() =>
                          setWindows((items) =>
                            items.filter((item) => item.id !== row.id),
                          )
                        }
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                    <div className="field-pair">
                      <Field label="From">
                        <input
                          aria-label={`Window ${index + 1} from`}
                          type="time"
                          value={row.start}
                          onChange={(e) =>
                            editRow(row.id, {
                              start: e.target.value,
                              startOffset: undefined,
                            })
                          }
                        />
                      </Field>
                      <Field label="Until">
                        <input
                          aria-label={`Window ${index + 1} until`}
                          type="time"
                          value={row.end}
                          onChange={(e) =>
                            editRow(row.id, {
                              end: e.target.value,
                              endOffset: undefined,
                            })
                          }
                        />
                      </Field>
                    </div>
                    <label className="check-label small">
                      <input
                        type="checkbox"
                        checked={row.overnight}
                        onChange={(e) =>
                          editRow(row.id, {
                            overnight: e.target.checked,
                            endOffset: undefined,
                          })
                        }
                      />
                      Ends next day
                    </label>
                    <Ambiguity
                      date={row.date}
                      time={row.start}
                      zone={context.timezone}
                      offset={row.startOffset}
                      onChange={(startOffset) =>
                        editRow(row.id, { startOffset })
                      }
                    />
                    <Ambiguity
                      date={
                        row.overnight
                          ? DateTime.fromISO(row.date)
                              .plus({ days: 1 })
                              .toISODate()!
                          : row.date
                      }
                      time={row.end}
                      zone={context.timezone}
                      offset={row.endOffset}
                      onChange={(endOffset) => editRow(row.id, { endOffset })}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="card form-card">
            <div className="section-icon">
              <Icon name="leaf" />
              <h2>Anything we should know about food?</h2>
            </div>
            <div className="choice-row">
              <button
                type="button"
                className={`choice ${foodChoice === "none" ? "selected" : ""}`}
                aria-pressed={foodChoice === "none"}
                onClick={() => setFoodChoice("none")}
              >
                <Icon name="check" size={17} />
                No requirements
              </button>
              <button
                type="button"
                className={`choice ${foodChoice === "requirements" ? "selected" : ""}`}
                aria-pressed={foodChoice === "requirements"}
                onClick={() => setFoodChoice("requirements")}
              >
                I have requirements
              </button>
            </div>
            {foodChoice === "requirements" && (
              <>
                <p className="muted small">
                  These are firm requirements. Preferences go below.
                </p>
                <div className="chips">
                  {presetDiets.map((name) => {
                    const exists = diets.some(
                      (diet) =>
                        diet.requirement.toLowerCase() === name.toLowerCase(),
                    );
                    return (
                      <button
                        type="button"
                        key={name}
                        className={`chip ${exists ? "selected" : ""}`}
                        aria-pressed={exists}
                        onClick={() =>
                          exists
                            ? setDiets((items) =>
                                items.filter(
                                  (diet) =>
                                    diet.requirement.toLowerCase() !==
                                    name.toLowerCase(),
                                ),
                              )
                            : addDiet(name)
                        }
                      >
                        {exists && <Icon name="check" size={14} />}
                        {name}
                      </button>
                    );
                  })}
                </div>
                <div className="inline-input">
                  <input
                    aria-label="Other food requirement"
                    placeholder="Another requirement, e.g. peanut allergy"
                    value={customDiet}
                    onChange={(e) => setCustomDiet(e.target.value)}
                    maxLength={120}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDiet(customDiet);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button add-button"
                    aria-label="Add food requirement"
                    disabled={!customDiet.trim() || diets.length >= 32}
                    onClick={() => addDiet(customDiet)}
                  >
                    <Icon name="plus" />
                  </button>
                </div>
                {diets.map((diet) => (
                  <div className="diet-row" key={diet.requirement}>
                    <div className="window-title">
                      <strong>{diet.requirement}</strong>
                      <button
                        type="button"
                        aria-label={`Remove ${diet.requirement}`}
                        className="icon-button small-icon"
                        onClick={() =>
                          setDiets((items) =>
                            items.filter(
                              (item) => item.requirement !== diet.requirement,
                            ),
                          )
                        }
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                    <label className="check-label small">
                      <input
                        type="checkbox"
                        checked={diet.allergy}
                        onChange={(e) =>
                          setDiets((items) =>
                            items.map((item) =>
                              item.requirement === diet.requirement
                                ? { ...item, allergy: e.target.checked }
                                : item,
                            ),
                          )
                        }
                      />
                      This is an allergy; staff safety confirmation is needed.
                    </label>
                  </div>
                ))}
              </>
            )}
            {foodChoice === "none" && baseline?.dietary?.length ? (
              <p className="field-hint">
                Saving “No requirements” explicitly removes your previous food
                requirements.
              </p>
            ) : null}
          </section>
          <details className="card advanced">
            <summary>
              More preferences <span className="optional">Optional</span>
            </summary>
            <div className="form-stack">
              <Field
                label="Foods or places you enjoy"
                optional
                hint="Preferences help Muse choose, but do not rule places out."
              >
                <input
                  placeholder="Italian, somewhere quiet, outdoor seating…"
                  value={preferences}
                  onChange={(e) => setPreferences(e.target.value)}
                  maxLength={500}
                />
              </Field>
              <Field
                label={`Your personal budget · ${context.currency} per person`}
                optional
                hint="A firm maximum, kept private."
              >
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder="Use the dinner's budget"
                  value={personalBudget}
                  onChange={(e) => setPersonalBudget(e.target.value)}
                />
              </Field>
              <Field label="Maximum travel time" optional>
                <div className="unit-input">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="240"
                    placeholder="No limit"
                    value={travelMax}
                    onChange={(e) => setTravelMax(e.target.value)}
                  />
                  <span>minutes</span>
                </div>
              </Field>
              {travelMax && (
                <Field
                  label="Starting point and travel method"
                  hint="Used privately to check travel time. A neighborhood is fine."
                >
                  <input
                    placeholder="From Lincoln Park by train"
                    value={origin}
                    onChange={(e) => setOrigin(e.target.value)}
                    maxLength={200}
                  />
                </Field>
              )}
            </div>
          </details>
          {needsConsent && (
            <label className="check-label consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                I agree to Muse using my answers for this dinner and sending
                planning messages in Telegram. Only the shared plan is shown to
                others.
              </span>
            </label>
          )}
          {(localError || error) && (
            <Notice kind="error">{localError || error}</Notice>
          )}
          <Button type="submit" className="full" busy={busy}>
            Save my answers <Icon name="arrow" />
          </Button>
          <p className="footnote">
            You can edit your answers until dinner begins.
          </p>
        </form>
      </main>
    </>
  );
}
