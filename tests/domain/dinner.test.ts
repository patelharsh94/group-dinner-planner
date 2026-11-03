import { describe, expect, it } from "vitest";
import {
  createDinner,
  cancelDinner,
  approveMember,
  updateConstraints,
  updateSetup,
  proposeOptions,
  confirmVersion,
  evaluateFeasibility,
  exportIcs,
  raiseDispute,
  reminderEligibility,
  selectAlternative,
  setMemberRequired,
  reportAllergySafety,
  resolveDispute,
  VenueSchema,
  DinnerSchema,
  setVenues,
  parseLocalDateTime,
  removeDietary,
  removeFirmLimit,
  type DinnerSetup,
  type Venue,
} from "../../src/domain/index.js";
const setup: DinnerSetup = {
  city: "Chicago",
  area: "Loop",
  windowStart: "2026-11-01",
  windowEnd: "2026-11-14",
  timezone: "America/Chicago",
  currency: "USD",
  timezoneConfirmed: true,
  currencyConfirmed: true,
  durationMinutes: 90,
  budget: {
    amount: 60,
    basis: "per-person",
  },
  intendedAttendees: ["a", "b", "c"],
};
const now = "2026-10-28T15:00:00Z";
const claim = {
  status: "known" as const,
  url: "https://venue.example/menu",
  retrievedAt: now,
  excerpt: "Example fixture evidence supporting this individual claim",
};
const option = {
  venueId: "v",
  start: "2026-11-03T19:00:00-06:00",
  end: "2026-11-03T20:30:00-06:00",
  pricePerPerson: 40,
  priceBasis: "per-person" as const,
  durationMinutes: 90,
};
function ready() {
  let d = createDinner("d", "a", setup, now);
  for (const id of ["b", "c"])
    d = approveMember(
      d,
      "a",
      {
        id,
        consent: true,
        startedBot: true,
        remindersOptIn: true,
      },
      now,
    );
  for (const id of ["a", "b", "c"])
    d = updateConstraints(
      d,
      id,
      {
        availability: [
          {
            start: "2026-11-03T18:00:00-06:00",
            end: "2026-11-03T22:00:00-06:00",
          },
        ],
      },
      now,
    );
  return d;
}
const venue: Venue = {
  id: "v",
  name: "Example",
  address: "1 Main St",
  city: "Chicago",
  area: "Loop",
  evidence: {
    location: claim,
    price: {
      ...claim,
      amount: 40,
      currency: "USD",
      basis: "per-person",
    },
    opening: {
      ...claim,
      intervals: [
        {
          start: "2026-11-03T18:00:00-06:00",
          end: "2026-11-03T23:00:00-06:00",
        },
      ],
    },
    reservation: {
      ...claim,
      status: "unknown",
    },
    dietary: {},
    travel: {},
  },
};
describe("dinner aggregate requirements", () => {
  it("cancels only by organizer before start, preserving history and remaining terminal", () => {
    let agreed = proposeOptions(
      { ...ready(), venues: [venue] },
      "a",
      [option],
      now,
    );
    for (const user of ["a", "b", "c"])
      agreed = confirmVersion(agreed, user, agreed.activeVersion!, now);
    const cancelled = cancelDinner(agreed, "a", now);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancellation).toEqual({ at: now, by: "a" });
    expect(cancelled.activeVersion).toBeNull();
    expect(cancelled.confirmations).toEqual({});
    expect(cancelled.proposals).toEqual(agreed.proposals);
    expect(cancelDinner(cancelled, "a", "2026-11-20T15:00:00Z")).toBe(
      cancelled,
    );
    expect(() => cancelDinner(agreed, "b", now)).toThrow();
    expect(() =>
      cancelDinner(agreed, "a", "2026-11-03T20:00:00-06:00"),
    ).toThrow();
    expect(() =>
      updateConstraints(cancelled, "a", { preferences: ["late edit"] }, now),
    ).toThrow();
    expect(() => exportIcs(cancelled, now)).toThrow();
  });

  it("DIET-01 a participant staff affirmation resolves their own allergy gap while contradictory evidence still blocks", () => {
    let d = { ...ready(), venues: [structuredClone(venue)] };
    d = updateConstraints(
      d,
      "b",
      {
        dietary: [
          { requirement: "peanut allergy", strength: "firm", allergy: true },
        ],
      },
      now,
    );
    expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
    d = reportAllergySafety(
      d,
      "b",
      {
        venueId: "v",
        requirement: "peanut allergy",
        report:
          "Restaurant staff explicitly confirmed they can accommodate this allergy",
        accommodationConfirmed: true,
      },
      now,
    );
    expect(evaluateFeasibility(d, option, now).status).toBe("feasible");
    d.venues[0].evidence.dietary["peanut allergy"] = {
      ...claim,
      status: "contradictory",
      supported: true,
    };
    expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
  });
  it("SETUP-01 requires confirmed timezone and two to six attendees", () => {
    expect(() =>
      createDinner(
        "d",
        "a",
        {
          ...setup,
          timezoneConfirmed: false,
        } as unknown as DinnerSetup,
        now,
      ),
    ).toThrow();
    expect(() =>
      createDinner(
        "d",
        "a",
        {
          ...setup,
          intendedAttendees: ["a"],
        },
        now,
      ),
    ).toThrow();
    expect(
      createDinner("two", "a", { ...setup, intendedAttendees: ["a", "b"] }, now)
        .setup.intendedAttendees,
    ).toHaveLength(2);
    expect(() =>
      createDinner(
        "seven",
        "a",
        { ...setup, intendedAttendees: ["a", "b", "c", "d", "e", "f", "g"] },
        now,
      ),
    ).toThrow();
  });
  it("JOIN-01 requires organizer approval, prior bot start and consent", () => {
    const d = createDinner("d", "a", setup, now);
    expect(() =>
      approveMember(
        d,
        "b",
        {
          id: "b",
          consent: true,
          startedBot: true,
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      approveMember(
        d,
        "a",
        {
          id: "b",
          consent: false,
          startedBot: true,
        },
        now,
      ),
    ).toThrow();
  });
  it("CONSTRAINT-01 patches preserve existing private constraints", () => {
    let d = ready();
    d = updateConstraints(
      d,
      "b",
      {
        budget: {
          amount: 45,
          strength: "firm",
        },
      },
      now,
    );
    d = updateConstraints(
      d,
      "b",
      {
        dietary: [
          {
            requirement: "vegan",
            strength: "firm",
            allergy: false,
          },
        ],
      },
      now,
    );
    expect(d.constraints.b?.budget?.amount).toBe(45);
  });
  it("FEASIBILITY-01 keeps unknown hard dietary and travel claims provisional", () => {
    let d = ready();
    d = updateConstraints(
      d,
      "b",
      {
        dietary: [
          {
            requirement: "vegan",
            strength: "firm",
            allergy: false,
          },
        ],
        travel: {
          maxMinutes: 30,
          strength: "firm",
        },
      },
      now,
    );
    d = {
      ...d,
      venues: [venue],
    };
    const r = evaluateFeasibility(d, option, now);
    expect(r.status).toBe("unresolved");
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
  it("AGREEMENT-01 requires all current-version explicit confirmations and invalidates changes", () => {
    let d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [option],
      now,
    );
    for (const id of ["a", "b", "c"])
      d = confirmVersion(d, id, d.activeVersion!, now);
    expect(d.status).toBe("agreed");
    const version = d.activeVersion!;
    d = updateSetup(
      d,
      "a",
      {
        durationMinutes: 100,
      },
      now,
    );
    expect(d.confirmations).toEqual({});
    expect(d.status).not.toBe("agreed");
    expect(() => confirmVersion(d, "a", version, now)).toThrow();
  });
  it("FEASIBILITY-02 rejects busy overlap and unknown prices", () => {
    let d = ready();
    d = updateConstraints(
      d,
      "b",
      {
        busy: [
          {
            start: option.start,
            end: option.end,
          },
        ],
      },
      now,
    );
    d = {
      ...d,
      venues: [venue],
    };
    expect(evaluateFeasibility(d, option, now).status).toBe("infeasible");
    expect(
      evaluateFeasibility(
        {
          ...ready(),
          venues: [
            {
              ...venue,
              evidence: {
                ...venue.evidence,
                price: {
                  ...claim,
                  status: "unknown",
                },
              },
            },
          ],
        },
        option,
        now,
      ).status,
    ).toBe("unresolved");
  });
  it("PROPOSAL-01 caps choices and does not mutate history", () => {
    const d = {
      ...ready(),
      venues: [venue],
    };
    expect(() =>
      proposeOptions(d, "a", [option, option, option], now),
    ).toThrow();
    const p = proposeOptions(d, "a", [option], now);
    expect(d.proposals).toHaveLength(0);
    expect(p.proposals).toHaveLength(1);
  });
  it("DISPUTE-01 escalates after two revision attempts", () => {
    let d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [option],
      now,
    );
    d = raiseDispute(d, "b", "too late", now);
    d = proposeOptions(d, "a", [option], now);
    d = raiseDispute(d, "b", "still late", now);
    d = proposeOptions(d, "a", [option], now);
    d = raiseDispute(d, "b", "unresolved", now);
    expect(d.status).toBe("escalated");
  });
  it("REMINDER-01 enforces opt-in, quiet hours and local daily cap", () => {
    const d = ready();
    expect(
      reminderEligibility(d, "b", "2026-11-03T03:00:00Z", []).allowed,
    ).toBe(false);
    expect(
      reminderEligibility(d, "b", "2026-11-03T17:00:00Z", [
        "2026-11-03T16:00:00Z",
      ]).allowed,
    ).toBe(false);
    expect(
      reminderEligibility(d, "b", "2026-11-03T17:00:00Z", []).allowed,
    ).toBe(true);
  });
  it("ICS-01 exports UTC times and truthful reservation status", () => {
    let d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [option],
      now,
    );
    for (const id of ["a", "b", "c"])
      d = confirmVersion(d, id, d.activeVersion!, now);
    const ics = exportIcs(d, now);
    expect(ics).toContain("DTSTART:20261104T010000Z");
    expect(ics).toContain("Reservation: unknown");
    expect(ics).toContain("VERSION:2.0");
  });
  it("FEASIBILITY-03 allergy accommodation requires each affected participant staff report", () => {
    let d = updateConstraints(
      ready(),
      "b",
      {
        dietary: [
          {
            requirement: "peanut",
            strength: "firm",
            allergy: true,
          },
        ],
      },
      now,
    );
    d = updateConstraints(
      d,
      "c",
      {
        dietary: [
          {
            requirement: "peanut",
            strength: "firm",
            allergy: true,
          },
        ],
      },
      now,
    );
    d = {
      ...d,
      venues: [
        {
          ...venue,
          evidence: {
            ...venue.evidence,
            dietary: {
              peanut: {
                ...claim,
                supported: true,
              },
            },
          },
        },
      ],
    };
    expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
    d = reportAllergySafety(
      d,
      "b",
      {
        venueId: "v",
        requirement: "peanut",
        report: "I spoke to staff about cross contact",
        accommodationConfirmed: true,
      },
      now,
    );
    expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
    d = reportAllergySafety(
      d,
      "c",
      {
        venueId: "v",
        requirement: "peanut",
        report: "I spoke to staff about cross contact",
        accommodationConfirmed: true,
      },
      now,
    );
    expect(evaluateFeasibility(d, option, now).status).toBe("feasible");
  });
  it("PROPOSAL-02 selecting an alternative creates a fresh version and preserves snapshots", () => {
    let d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [
        option,
        {
          ...option,
          pricePerPerson: 41,
        },
      ],
      now,
    );
    const old = structuredClone(d.proposals[0]);
    d = confirmVersion(d, "a", 1, now);
    d = selectAlternative(d, "a", 1, now);
    expect(d.activeVersion).toBe(2);
    expect(d.proposals[0]).toEqual(old);
    expect(d.confirmations).toEqual({});
    expect(d.proposals[1]?.options[0]?.pricePerPerson).toBe(41);
  });
  it("MEMBER-01 required membership cannot be silently removed", () => {
    const d = ready();
    expect(() =>
      updateSetup(
        d,
        "a",
        {
          intendedAttendees: ["a", "c", "x"],
        },
        now,
      ),
    ).toThrow();
    expect(
      setMemberRequired(d, "a", "b", false, now).members.find(
        (m) => m.id === "b",
      )?.required,
    ).toBe(false);
  });
  it("TIME-01 rejects invalid offset intervals and changes after dinner begins", () => {
    expect(() =>
      updateConstraints(
        ready(),
        "a",
        {
          availability: [
            {
              start: "2026-11-03T19:00:00",
              end: option.end,
            },
          ],
        },
        now,
      ),
    ).toThrow();
    const d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [option],
      now,
    );
    expect(() =>
      updateSetup(
        d,
        "a",
        {
          area: "River North",
        },
        "2026-11-04T01:00:00Z",
      ),
    ).toThrow();
  });
  it("DISPUTE-02 cannot reconfirm an unresolved disputed version", () => {
    const d = raiseDispute(
      proposeOptions(
        {
          ...ready(),
          venues: [venue],
        },
        "a",
        [option],
        now,
      ),
      "b",
      "change please",
      now,
    );
    expect(() => confirmVersion(d, "a", 1, now)).toThrow();
  });
  it("REMINDER-02 converts quiet hours through DST and allows 09:00 exactly", () => {
    const d = ready();
    expect(
      reminderEligibility(d, "b", "2026-11-03T14:59:00Z", []).allowed,
    ).toBe(false);
    expect(
      reminderEligibility(d, "b", "2026-11-03T15:00:00Z", []).allowed,
    ).toBe(true);
    expect(
      reminderEligibility(d, "b", "2026-11-04T03:00:00Z", []).allowed,
    ).toBe(false);
  });
  it("EVIDENCE-01 requires public HTTPS URLs, excerpts and IANA zones", () => {
    for (const url of [
      "http://example.com",
      "https://localhost/a",
      "https://u:p@example.com",
      "https://127.0.0.1/a",
      "https://10.1.1.1",
    ])
      expect(() =>
        VenueSchema.parse({
          ...venue,
          evidence: {
            ...venue.evidence,
            price: {
              ...claim,
              url,
            },
          },
        }),
      ).toThrow();
    expect(() =>
      VenueSchema.parse({
        ...venue,
        evidence: {
          ...venue.evidence,
          price: {
            ...claim,
            excerpt: "",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      createDinner(
        "d",
        "a",
        {
          ...setup,
          timezone: "UTC+3",
        },
        now,
      ),
    ).toThrow();
  });
  it("EVIDENCE-02 unresolved stale evidence and rejects venues outside area", () => {
    const d = {
      ...ready(),
      venues: [venue],
    };
    expect(evaluateFeasibility(d, option, "2026-10-31T15:00:00Z").status).toBe(
      "unresolved",
    );
    expect(
      evaluateFeasibility(
        {
          ...d,
          venues: [
            {
              ...venue,
              area: "Hyde Park",
            },
          ],
        },
        option,
        now,
      ).status,
    ).toBe("infeasible");
  });
  it("CONSTRAINT-02 rejects unknown keys instead of silently losing them", () => {
    expect(() =>
      updateConstraints(
        ready(),
        "b",
        {
          availability: [],
          invented: true,
        } as never,
        now,
      ),
    ).toThrow();
  });
  it("DISPUTE-03 open objections need explicit resolution by their author", () => {
    let d = raiseDispute(
      proposeOptions(
        {
          ...ready(),
          venues: [venue],
        },
        "a",
        [option],
        now,
      ),
      "b",
      "earlier please",
      now,
    );
    d = proposeOptions(d, "a", [option], now);
    expect(() => confirmVersion(d, "a", d.activeVersion!, now)).toThrow();
    d = resolveDispute(d, "a", now);
    expect(() => confirmVersion(d, "a", d.activeVersion!, now)).toThrow();
    d = resolveDispute(d, "b", now);
    expect(() => confirmVersion(d, "a", d.activeVersion!, now)).not.toThrow();
  });
  it("EVIDENCE-03 research cannot assert booking or participant allergy reports", () => {
    expect(() =>
      VenueSchema.parse({
        ...venue,
        evidence: {
          ...venue.evidence,
          reservation: {
            ...claim,
            state: "booked",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      VenueSchema.parse({
        ...venue,
        evidence: {
          ...venue.evidence,
          dietary: {
            peanut: {
              ...claim,
              supported: true,
              staffReportBy: "b",
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      reportAllergySafety(
        {
          ...ready(),
          venues: [venue],
        },
        "a",
        {
          venueId: "v",
          requirement: "peanut",
          report: "Checked",
          accommodationConfirmed: true,
        },
        now,
      ),
    ).toThrow();
  });
  it("REVISION-01 independently advances persistence revision on each confirmation", () => {
    let d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [option],
      now,
    );
    const previous = d.revision;
    d = confirmVersion(d, "a", d.activeVersion!, now);
    expect(d.revision).toBe(previous + 1);
    d = confirmVersion(d, "b", d.activeVersion!, now);
    expect(d.revision).toBe(previous + 2);
  });
  it("REMINDER-03 does not remind after the proposed dinner has begun", () => {
    const d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [option],
      now,
    );
    expect(
      reminderEligibility(d, "b", "2026-11-04T17:00:00Z", []).allowed,
    ).toBe(false);
  });
  it("PRICE-01 cannot confirm price evidence in missing or different currency", () => {
    for (const currency of [undefined, "EUR"]) {
      const d = {
        ...ready(),
        venues: [
          {
            ...venue,
            evidence: {
              ...venue.evidence,
              price: {
                ...venue.evidence.price,
                currency,
              },
            },
          },
        ],
      };
      expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
    }
  });
  it("EVIDENCE-04 preserves contradictory related sources", () => {
    const relatedSources = [
      {
        url: "https://venue.example/other-menu",
        excerpt: "Another published menu contradicts the price",
        retrievedAt: now,
      },
    ];
    const parsed = VenueSchema.parse({
      ...venue,
      evidence: {
        ...venue.evidence,
        price: {
          ...venue.evidence.price,
          status: "contradictory",
          relatedSources,
        },
      },
    });
    expect(parsed.evidence.price.relatedSources).toEqual(relatedSources);
  });
  it("TIME-02 rejects nonexistent local times and demands an offset for DST ambiguity", () => {
    expect(() =>
      parseLocalDateTime("2026-03-08T02:30", "America/Chicago"),
    ).toThrow();
    expect(() =>
      parseLocalDateTime("2026-11-01T01:30", "America/Chicago"),
    ).toThrow();
    expect(
      parseLocalDateTime("2026-11-01T01:30", "America/Chicago", -300),
    ).toBe("2026-11-01T01:30:00-05:00");
    expect(
      parseLocalDateTime("2026-11-01T01:30", "America/Chicago", -360),
    ).toBe("2026-11-01T01:30:00-06:00");
    expect(() =>
      parseLocalDateTime("2026-11-01T01:30", "America/Chicago", 60),
    ).toThrow();
    expect(parseLocalDateTime("2026-11-03T19:00", "America/Chicago")).toBe(
      "2026-11-03T19:00:00-06:00",
    );
    expect(() =>
      parseLocalDateTime("2026-11-03T19:00-06:00", "America/Chicago"),
    ).toThrow();
  });
  it("ICS-02 unknown reservation evidence cannot assert a handoff", () => {
    const unknownVenue = {
      ...venue,
      evidence: {
        ...venue.evidence,
        reservation: {
          ...claim,
          status: "unknown" as const,
          state: "handoff" as const,
        },
      },
    };
    let d = proposeOptions(
      {
        ...ready(),
        venues: [unknownVenue],
      },
      "a",
      [option],
      now,
    );
    for (const id of ["a", "b", "c"])
      d = confirmVersion(d, id, d.activeVersion!, now);
    expect(exportIcs(d, now)).toContain("Reservation: unknown");
  });
  it("ALLERGY-01 report text cannot establish affirmative accommodation", () => {
    let d = updateConstraints(
      ready(),
      "b",
      {
        dietary: [
          {
            requirement: "peanut",
            strength: "firm",
            allergy: true,
          },
        ],
      },
      now,
    );
    d = {
      ...d,
      venues: [venue],
    };
    for (const accommodationConfirmed of [undefined, false]) {
      expect(() =>
        reportAllergySafety(
          d,
          "b",
          {
            venueId: "v",
            requirement: "peanut",
            report: "Staff said unsafe",
            accommodationConfirmed,
          } as never,
          now,
        ),
      ).toThrow();
    }
  });
  it("DIETARY-01 additive patches retain existing allergies and require explicit relaxation", () => {
    let d = updateConstraints(
      ready(),
      "b",
      {
        dietary: [
          {
            requirement: "peanut",
            strength: "firm",
            allergy: true,
          },
        ],
      },
      now,
    );
    d = updateConstraints(
      d,
      "b",
      {
        dietary: [
          {
            requirement: "vegan",
            strength: "firm",
            allergy: false,
          },
        ],
      },
      now,
    );
    expect(d.constraints.b?.dietary).toHaveLength(2);
    expect(() =>
      updateConstraints(
        d,
        "b",
        {
          dietary: [
            {
              requirement: "peanut",
              strength: "flexible",
              allergy: false,
            },
          ],
        },
        now,
      ),
    ).toThrow();
    d = removeDietary(d, "b", "peanut", now);
    expect(d.constraints.b?.dietary?.map((x) => x.requirement)).toEqual([
      "vegan",
    ]);
    expect(d.confirmations).toEqual({});
  });
  it("VENUE-01 rejects duplicate venue identities at research and persistence boundaries", () => {
    const duplicates = [
      venue,
      {
        ...venue,
        name: "Other venue",
      },
    ];
    expect(() => setVenues(ready(), "a", duplicates, now)).toThrow();
    expect(() =>
      DinnerSchema.parse({
        ...ready(),
        venues: duplicates,
      }),
    ).toThrow();
  });
  it("CONSTRAINT-03 preserves undefined fields and refuses implicit firm relaxation", () => {
    let d = updateConstraints(
      ready(),
      "b",
      {
        budget: {
          amount: 40,
          strength: "firm",
        },
        travel: {
          maxMinutes: 20,
          strength: "firm",
        },
        dietary: [
          {
            requirement: "peanut",
            strength: "firm",
            allergy: true,
          },
        ],
      },
      now,
    );
    expect(() =>
      updateConstraints(
        d,
        "b",
        {
          budget: {
            amount: 40,
            strength: "flexible",
          },
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      updateConstraints(
        d,
        "b",
        {
          travel: {
            maxMinutes: 20,
            strength: "flexible",
          },
        },
        now,
      ),
    ).toThrow();
    d = updateConstraints(
      d,
      "b",
      {
        budget: undefined,
        travel: undefined,
        dietary: undefined,
      },
      now,
    );
    expect(d.constraints.b?.budget?.strength).toBe("firm");
    expect(d.constraints.b?.travel?.strength).toBe("firm");
    expect(d.constraints.b?.dietary?.[0]?.allergy).toBe(true);
  });
  it("MEMBER-02 explicit optional decision closes withdrawn member objections", () => {
    let d = proposeOptions(
      {
        ...ready(),
        venues: [venue],
      },
      "a",
      [option],
      now,
    );
    d = raiseDispute(d, "b", "I cannot attend", now);
    d = setMemberRequired(d, "a", "b", false, now);
    expect(d.disputes[0]?.open).toBe(false);
    expect(d.disputes[0]?.reason).toBe("I cannot attend");
    d = proposeOptions(d, "a", [option], now);
    d = confirmVersion(d, "a", d.activeVersion!, now);
    d = confirmVersion(d, "c", d.activeVersion!, now);
    expect(d.status).toBe("agreed");
  });
  it("CONSTRAINT-04 explicit own limit removal permits a newly flexible preference", () => {
    let d = updateConstraints(
      ready(),
      "b",
      {
        budget: {
          amount: 40,
          strength: "firm",
        },
        travel: {
          maxMinutes: 20,
          strength: "firm",
        },
      },
      now,
    );
    d = removeFirmLimit(d, "b", "budget", now);
    expect(d.constraints.b?.budget).toBeUndefined();
    expect(d.constraints.b?.travel?.strength).toBe("firm");
    d = updateConstraints(
      d,
      "b",
      {
        budget: {
          amount: 50,
          strength: "flexible",
        },
      },
      now,
    );
    d = removeFirmLimit(d, "b", "travel", now);
    expect(d.constraints.b?.travel).toBeUndefined();
    expect(d.constraints.b?.budget?.strength).toBe("flexible");
    expect(() => removeFirmLimit(d, "unapproved", "budget", now)).toThrow();
    expect(() => removeFirmLimit(d, "b", "dietary" as never, now)).toThrow();
  });
  it("CALENDAR-01 connected calendar requires fresh sync covering the proposal", () => {
    for (const patch of [
      {
        calendarStatus: "connected" as const,
      },
      {
        calendarStatus: "connected" as const,
        calendarCheckedAt: "2026-10-26T15:00:00Z",
        calendarWindow: {
          start: option.start,
          end: option.end,
        },
      },
      {
        calendarStatus: "connected" as const,
        calendarCheckedAt: now,
        calendarWindow: {
          start: option.start,
          end: "2026-11-03T19:30:00-06:00",
        },
      },
    ]) {
      const d = {
        ...updateConstraints(ready(), "b", patch, now),
        venues: [venue],
      };
      expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
    }
    const d = {
      ...updateConstraints(
        ready(),
        "b",
        {
          calendarStatus: "connected",
          calendarCheckedAt: now,
          calendarWindow: {
            start: option.start,
            end: option.end,
          },
        },
        now,
      ),
      venues: [venue],
    };
    expect(evaluateFeasibility(d, option, now).status).toBe("feasible");
  });
  it("TRAVEL-01 firm travel needs an explicit origin even with known minutes", () => {
    let d = updateConstraints(
      ready(),
      "b",
      {
        travel: {
          maxMinutes: 30,
          strength: "firm",
        },
      },
      now,
    );
    d = {
      ...d,
      venues: [
        {
          ...venue,
          evidence: {
            ...venue.evidence,
            travel: {
              b: {
                ...claim,
                minutes: 15,
              },
            },
          },
        },
      ],
    };
    expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
    d = updateConstraints(
      d,
      "b",
      {
        travel: {
          maxMinutes: 30,
          strength: "firm",
          origin: "From home by car",
        },
      },
      now,
    );
    expect(evaluateFeasibility(d, option, now).status).toBe("feasible");
  });
  it("BOUNDS-01 caps date windows, duration and input arrays", () => {
    expect(() =>
      createDinner(
        "d",
        "a",
        {
          ...setup,
          windowEnd: "2027-01-01",
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      createDinner(
        "d",
        "a",
        {
          ...setup,
          durationMinutes: 481,
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      updateConstraints(
        ready(),
        "b",
        {
          availability: Array.from(
            {
              length: 65,
            },
            () => ({
              start: option.start,
              end: option.end,
            }),
          ),
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      updateConstraints(
        ready(),
        "b",
        {
          dietary: Array.from(
            {
              length: 33,
            },
            (_, i) => ({
              requirement: `diet-${i}`,
              strength: "firm" as const,
              allergy: false,
            }),
          ),
        },
        now,
      ),
    ).toThrow();
  });
});

it("AGR-02 records unanimous group choice while restaurant checks remain pending, without claiming a booking", () => {
  const pending = structuredClone(venue);
  pending.evidence.price.status = "unknown";
  pending.evidence.location.status = "unknown";
  let d = proposeOptions({ ...ready(), venues: [pending] }, "a", [option], now);
  for (const user of ["a", "b", "c"])
    d = confirmVersion(d, user, d.activeVersion!, now);
  expect(d.status).toBe("agreed");
  expect(evaluateFeasibility(d, option, now).status).toBe("unresolved");
  expect(exportIcs(d, now)).toContain("Reservation: unknown");
  d.constraints.b.availability = [];
  expect(() => confirmVersion(d, "a", d.activeVersion!, now)).toThrow();
});
