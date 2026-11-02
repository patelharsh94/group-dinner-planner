import { useState } from "react";
import { AnswersPreview, type ManualAnswers } from "./AnswersPreview";
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
  answerSharing?: boolean;
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
  answerSharing = false,
  needsConsent = false,
  busy,
  error,
  onBack,
  onSave,
}: Props) {
  // These drafts intentionally initialize once. Polling never replaces unsaved answers.
  const [baseline] = useState(initial);
  const [shareAnswers, setShareAnswers] = useState(answerSharing);
  const [windows, setWindows] = useState(() =>
    initialWindows(initial, context.timezone),
  );
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [bulkStart, setBulkStart] = useState("19:00"),
    [bulkEnd, setBulkEnd] = useState("22:00"),
    [bulkOvernight, setBulkOvernight] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftOffsets, setDraftOffsets] = useState<
    Record<string, { start?: number; end?: number }>
  >({});
  const [editorError, setEditorError] = useState("");
  const hasDraft = selectedDates.length > 0;
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
  function windowInterval(row: WindowRow, index: number) {
    if (row.date < context.windowStart || row.date > context.windowEnd)
      throw new Error(
        `Time window ${index + 1} falls outside this dinner's date window.`,
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
        `Time window ${index + 1}: leave-by time must be later. Select “Ends next day” for an overnight window.`,
      );
    return { start, end };
  }
  function discardEditor() {
    setSelectedDates([]);
    setEditingId(null);
    setDraftOffsets({});
    setEditorError("");
    setLocalError("");
  }
  function editWindow(row: WindowRow) {
    if (hasDraft) return;
    setSelectedDates([row.date]);
    setEditingId(row.id);
    setBulkStart(row.start);
    setBulkEnd(row.end);
    setBulkOvernight(row.overnight);
    setDraftOffsets({
      [row.date]: { start: row.startOffset, end: row.endOffset },
    });
    setEditorError("");
    setLocalError("");
  }
  function changeEditorTime(boundary: "start" | "end", value: string) {
    if (boundary === "start") setBulkStart(value);
    else setBulkEnd(value);
    setDraftOffsets((offsets) =>
      Object.fromEntries(
        Object.entries(offsets).map(([date, choice]) => [
          date,
          { ...choice, [boundary]: undefined },
        ]),
      ),
    );
    setEditorError("");
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
    if (!hasDraft) return;
    setLocalError("");
    setEditorError("");
    try {
      const additions = selectedDates.map((date) => ({
        id: editingId ?? crypto.randomUUID(),
        date,
        start: bulkStart,
        end: bulkEnd,
        overnight: bulkOvernight,
        startOffset: draftOffsets[date]?.start,
        endOffset: draftOffsets[date]?.end,
      }));
      const serialized = additions.map(windowInterval);
      const existing = windows.filter((row) => row.id !== editingId);
      const unique = additions.filter(
        (_, index) =>
          !existing.some((row) => {
            const interval = windowInterval(row, 0);
            return (
              interval.start === serialized[index].start &&
              interval.end === serialized[index].end
            );
          }),
      );
      if (existing.length + unique.length > 64)
        throw new Error("You can save up to 64 available windows.");
      setWindows(
        [...existing, ...unique].sort((a, b) =>
          `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`),
        ),
      );
      discardEditor();
    } catch (failure) {
      setEditorError(
        failure instanceof Error
          ? failure.message
          : "Check these available hours.",
      );
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLocalError("");
    try {
      if (hasDraft)
        throw new Error(
          "Apply or discard your available-hour changes before saving your answers.",
        );
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
      const availability = windows.map(windowInterval);
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
        shareAnswers,
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
  const previewAnswers: ManualAnswers = {
    availability: windows.flatMap((row) => {
      try {
        return [
          {
            start: localIso(
              row.date,
              row.start,
              context.timezone,
              row.startOffset,
            ),
            end: localIso(
              row.overnight
                ? DateTime.fromISO(row.date).plus({ days: 1 }).toISODate()!
                : row.date,
              row.end,
              context.timezone,
              row.endOffset,
            ),
          },
        ];
      } catch {
        return [];
      }
    }),
    dietary: foodChoice === "none" ? [] : diets,
    preferences: preferences
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    ...(personalBudget && Number.isFinite(Number(personalBudget))
      ? {
          budget: { amount: Number(personalBudget), strength: "firm" as const },
        }
      : {}),
    ...(travelMax && Number.isFinite(Number(travelMax))
      ? {
          travel: {
            maxMinutes: Number(travelMax),
            origin: origin.trim(),
            strength: "firm" as const,
          },
        }
      : {}),
  };
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
          Your answers stay private unless you choose to share them with
          approved dinner members. Calendar busy times and private chats are
          never shared.
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
              Select the dates you are willing to come. Nothing is selected for
              you.
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
                    disabled={editingId !== null}
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
            <p className="field-hint timezone-note">
              <Icon name="clock" size={14} /> Dinner lasts{" "}
              {context.durationMinutes} minutes · All times:{" "}
              {friendlyZone(context.timezone)}
            </p>
            {hasDraft && (
              <div
                className="availability-editor"
                role="group"
                aria-label="Available hours editor"
              >
                <h3>
                  {editingId
                    ? `Edit ${dateLabel(selectedDates[0], "long")}`
                    : `Hours for ${selectedDates.length} selected ${selectedDates.length === 1 ? "date" : "dates"}`}
                </h3>
                <p className="muted small">
                  This is your available window, not the dinner time. Muse will
                  fit the {context.durationMinutes}-minute dinner within it.
                </p>
                <div className="field-pair">
                  <Field label="I'm free from">
                    <input
                      type="time"
                      value={bulkStart}
                      onChange={(event) =>
                        changeEditorTime("start", event.target.value)
                      }
                    />
                  </Field>
                  <Field label="I need to leave by">
                    <input
                      type="time"
                      value={bulkEnd}
                      onChange={(event) =>
                        changeEditorTime("end", event.target.value)
                      }
                    />
                  </Field>
                </div>
                <label className="check-label small">
                  <input
                    type="checkbox"
                    checked={bulkOvernight}
                    onChange={(event) => {
                      setBulkOvernight(event.target.checked);
                      setDraftOffsets((offsets) =>
                        Object.fromEntries(
                          Object.entries(offsets).map(([date, choice]) => [
                            date,
                            { ...choice, end: undefined },
                          ]),
                        ),
                      );
                      setEditorError("");
                    }}
                  />
                  Ends next day
                </label>
                {selectedDates.map((date) => {
                  const endDate = bulkOvernight
                    ? DateTime.fromISO(date).plus({ days: 1 }).toISODate()!
                    : date;
                  const first = localCandidates(
                      date,
                      bulkStart,
                      context.timezone,
                    ),
                    last = localCandidates(endDate, bulkEnd, context.timezone);
                  if (first.kind === "valid" && last.kind === "valid")
                    return null;
                  return (
                    <div key={date} className="form-stack">
                      <h3>{dateLabel(date, "long")}</h3>
                      <Ambiguity
                        date={date}
                        time={bulkStart}
                        zone={context.timezone}
                        offset={draftOffsets[date]?.start}
                        onChange={(start) =>
                          setDraftOffsets((offsets) => ({
                            ...offsets,
                            [date]: { ...offsets[date], start },
                          }))
                        }
                      />
                      <Ambiguity
                        date={endDate}
                        time={bulkEnd}
                        zone={context.timezone}
                        offset={draftOffsets[date]?.end}
                        onChange={(end) =>
                          setDraftOffsets((offsets) => ({
                            ...offsets,
                            [date]: { ...offsets[date], end },
                          }))
                        }
                      />
                    </div>
                  );
                })}
                {editorError && <Notice kind="error">{editorError}</Notice>}
                <div className="choice-row">
                  <Button variant="secondary" onClick={applyHours}>
                    {editingId
                      ? "Apply changes"
                      : `Apply to ${selectedDates.length} ${selectedDates.length === 1 ? "date" : "dates"}`}
                  </Button>
                  <Button variant="quiet" onClick={discardEditor}>
                    Discard changes
                  </Button>
                </div>
              </div>
            )}
            {windows.length > 0 && (
              <div
                className="saved-windows"
                role="group"
                aria-label="Saved availability"
              >
                <h3>Your available windows</h3>
                {windows.map((row, index) => (
                  <div className="availability-summary" key={row.id}>
                    <div>
                      <strong>{dateLabel(row.date, "long")}</strong>
                      <p>
                        {DateTime.fromISO(`${row.date}T${row.start}`, {
                          zone: context.timezone,
                        }).toFormat("h:mm a")}
                        –
                        {DateTime.fromISO(`${row.date}T${row.end}`, {
                          zone: context.timezone,
                        }).toFormat("h:mm a")}
                        {row.overnight ? " (next day)" : ""}
                      </p>
                    </div>
                    <div className="availability-summary-actions">
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Edit window ${index + 1}`}
                        disabled={hasDraft}
                        onClick={() => editWindow(row)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Remove window ${index + 1}`}
                        disabled={hasDraft}
                        onClick={() =>
                          setWindows((items) =>
                            items.filter((item) => item.id !== row.id),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
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
                hint="A firm maximum. Included only if you opt to share your answers."
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
                  hint="A neighborhood is fine. This starting point is included if you opt to share your answers."
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
          <section
            className="card form-card"
            aria-label="Answers sharing preview"
          >
            <h2>Your answers, your choice</h2>
            <p className="muted small">
              Only approved members of this dinner can see answers you choose to
              share. Sharing includes your availability, food requirements,
              preferences, personal budget, and travel starting point.
            </p>
            <details className="answers-preview">
              <summary>Preview the exact answers you would share</summary>
              <AnswersPreview
                answers={previewAnswers}
                timezone={context.timezone}
                currency={context.currency}
                foodAnswered={!!foodChoice}
              />
            </details>
            <label className="check-label">
              <input
                type="checkbox"
                checked={shareAnswers}
                onChange={(event) => setShareAnswers(event.target.checked)}
              />
              <span>Share these answers with approved dinner members.</span>
            </label>
            <p className="field-hint">
              Calendar busy times, private chats and staff conversations are
              never included. You can turn sharing off in settings, even after
              dinner ends.
            </p>
            {hasDraft && (
              <p className="field-hint">
                Apply your available-hour changes to update this preview before
                saving.
              </p>
            )}
          </section>
          {needsConsent && (
            <label className="check-label consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                I agree to Muse using my answers for this dinner and sending
                planning messages in Telegram. My answers are shared only if I
                choose to share them above.
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
