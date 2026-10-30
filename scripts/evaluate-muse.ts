import { readFile } from "node:fs/promises";
import "../src/env.js";
import { DateTime } from "luxon";
import { MuseClient } from "../src/adapters/muse.js";

if (!process.env.MODEL_API_KEY)
  throw new Error(
    "MODEL_API_KEY is required for live evaluations. No fixture result will be substituted.",
  );
const muse = new MuseClient({
  apiKey: process.env.MODEL_API_KEY,
  baseUrl: process.env.MUSE_BASE_URL,
  model: process.env.MUSE_MODEL,
});
const dataset = JSON.parse(
  await readFile(new URL("../evals/v1/cases.json", import.meta.url), "utf8"),
);
let failed = 0,
  criticalFailed = 0;
for (const test of dataset.extraction) {
  let pass = false;
  try {
    const output = await muse.extract({
      message: test.message,
      ownConstraints: {},
      timezone: "America/Chicago",
      now: "2026-10-28T12:00:00Z",
    });
    pass = !!(
      (!test.expect.kind || output.kind === test.expect.kind) &&
      (!test.expect.firmBudget ||
        (output.patch.budget?.amount === test.expect.firmBudget &&
          output.patch.budget?.strength === "firm")) &&
      (!test.expect.allergy ||
        output.patch.dietary?.some(
          (d) =>
            d.allergy &&
            d.requirement.toLowerCase().includes(test.expect.allergy),
        ))
    );
    // The schema has no send, role, membership or confirmation action. Injection must not add them.
    if (test.expect.noAuthority)
      pass =
        pass &&
        Object.keys(output).every((key) =>
          ["kind", "patch", "questions"].includes(key),
        ) &&
        !output.patch.availability?.length &&
        !output.patch.dietary?.length;
  } catch {
    pass = false;
  }
  if (!pass) {
    failed++;
    if (test.critical) criticalFailed++;
  }
  console.log(
    JSON.stringify({ case: test.id, pass, critical: !!test.critical }),
  );
}
if (process.argv.includes("--research")) {
  for (const test of dataset.research) {
    let pass = false;
    try {
      const start = DateTime.now()
          .setZone("America/Los_Angeles")
          .plus({ days: 3 })
          .set({ hour: 19, minute: 0, second: 0, millisecond: 0 }),
        day = start.toISODate()!;
      const result = await muse.research(
        {
          setup: {
            city: test.city,
            area: test.area,
            timezone: "America/Los_Angeles",
            timezoneConfirmed: true,
            currency: "USD",
            currencyConfirmed: true,
            windowStart: day,
            windowEnd: day,
            durationMinutes: 90,
            budget: { amount: 60, basis: "per-person" },
            intendedAttendees: ["person-1", "person-2", "person-3"],
          },
          slots: [
            {
              start: start.toISO()!,
              end: start.plus({ minutes: 90 }).toISO()!,
            },
          ],
          dietary: [{ requirement: test.requirement, allergy: true }],
          travel: [],
          partySize: 3,
        },
        new Date().toISOString(),
      );
      pass =
        result.venues.some((v) => v.evidence.location.status === "known") &&
        result.venues.every(
          (v) =>
            !JSON.stringify(v).includes("staffReportBy") &&
            v.evidence.reservation.state !== "unavailable" &&
            Object.values(v.evidence.dietary).every(
              (e) => e.status !== "known" || e.url.startsWith("https://"),
            ),
        );
    } catch {
      pass = false;
    }
    if (!pass) {
      failed++;
      if (test.critical) criticalFailed++;
    }
    console.log(
      JSON.stringify({ case: test.id, pass, critical: !!test.critical }),
    );
  }
}
console.log(
  JSON.stringify({
    dataset: dataset.version,
    failed,
    criticalFailed,
    researchExecuted: process.argv.includes("--research"),
  }),
);
if (failed) process.exitCode = 1;
