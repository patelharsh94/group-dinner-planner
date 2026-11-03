import { DateTime } from "luxon";
import type { Constraints } from "../../src/domain/index";

export type ManualAnswers = Pick<
  Constraints,
  "availability" | "dietary" | "preferences" | "budget" | "travel"
>;
export function AnswersPreview({
  answers,
  timezone,
  currency,
  foodAnswered = true,
  includeAvailability = true,
}: {
  answers: ManualAnswers;
  timezone: string;
  currency: string;
  foodAnswered?: boolean;
  includeAvailability?: boolean;
}) {
  return (
    <dl className="answers-list">
      {includeAvailability && (
        <div>
          <dt>Availability</dt>
          <dd>
            {answers.availability?.length ? (
              <ul>
                {answers.availability.map((range, index) => {
                  const start = DateTime.fromISO(range.start).setZone(timezone),
                    end = DateTime.fromISO(range.end).setZone(timezone);
                  return (
                    <li key={index}>
                      {start.toFormat("ccc, LLL d · h:mm a")}–
                      {end.toFormat(
                        start.toISODate() === end.toISODate()
                          ? "h:mm a"
                          : "ccc, LLL d · h:mm a",
                      )}{" "}
                      ({timezone.replaceAll("_", " ")})
                    </li>
                  );
                })}
              </ul>
            ) : (
              "No available windows saved yet."
            )}
          </dd>
        </div>
      )}
      <div>
        <dt>Food requirements</dt>
        <dd>
          {!foodAnswered ? (
            "Not answered yet."
          ) : answers.dietary?.length ? (
            <ul>
              {answers.dietary.map((item) => (
                <li key={item.requirement}>
                  {item.requirement} · {item.strength}
                  {item.allergy ? " · allergy" : ""}
                </li>
              ))}
            </ul>
          ) : (
            "No food requirements."
          )}
        </dd>
      </div>
      <div>
        <dt>Preferences</dt>
        <dd>
          {answers.preferences?.length
            ? answers.preferences.join(", ")
            : "No additional preferences."}
        </dd>
      </div>
      <div>
        <dt>Personal budget</dt>
        <dd>
          {answers.budget
            ? `${currency} ${answers.budget.amount} per person · ${answers.budget.strength === "firm" ? "firm maximum" : "flexible preference"}`
            : "No personal budget limit."}
        </dd>
      </div>
      <div>
        <dt>Travel</dt>
        <dd>
          {answers.travel ? (
            <>
              {answers.travel.maxMinutes} minutes maximum ·{" "}
              {answers.travel.strength}
              <br />
              Starting point and method:{" "}
              {answers.travel.origin || "Not provided."}
            </>
          ) : (
            "No travel limit or starting point."
          )}
        </dd>
      </div>
    </dl>
  );
}
