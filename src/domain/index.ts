import { z } from "zod";
import { DateTime } from "luxon";
import { isIP } from "node:net";
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}
const iso = z.string().datetime({
  offset: true,
});
export const ConfirmationSchema = z.object({
  dinnerId: z.string().min(1),
  participantId: z.string().min(1),
  proposalVersion: z.number().int().positive(),
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;
const zone = z.string().refine((v) => {
  try {
    new Intl.DateTimeFormat("en", {
      timeZone: v,
    });
    return v === "UTC" || v.includes("/");
  } catch {
    return false;
  }
}, "Invalid IANA timezone");
export function parseLocalDateTime(
  local: string,
  timezone: string,
  offsetMinutes?: number,
): string {
  zone.parse(timezone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(local))
    fail("LOCAL_TIME", "Local date and time without offset required");
  const normalized = local.length === 16 ? `${local}:00` : local;
  const parsed = DateTime.fromISO(normalized, {
    zone: timezone,
  });
  if (
    !parsed.isValid ||
    parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== normalized
  )
    fail("LOCAL_TIME", "Local time does not exist in this timezone");
  const candidates = parsed.getPossibleOffsets();
  if (offsetMinutes === undefined && candidates.length !== 1)
    fail(
      "AMBIGUOUS_TIME",
      "Repeated local time requires an explicit offset in minutes",
    );
  const selected =
    offsetMinutes === undefined
      ? candidates[0]
      : candidates.find((candidate) => candidate.offset === offsetMinutes);
  if (!selected)
    fail("LOCAL_TIME", "Offset does not match local time and timezone");
  return selected.toISO({
    suppressMilliseconds: true,
  })!;
}
export const PublicUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value),
      h = u.hostname.toLowerCase();
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      (u.port && u.port !== "443")
    )
      return false;
    if (
      !h.includes(".") ||
      h.endsWith(".local") ||
      h.endsWith(".localhost") ||
      h.endsWith(".internal")
    )
      return false;
    if (isIP(h.replace(/^\[|\]$/g, ""))) return false;
    return true;
  }, "Public HTTPS source URL required");
export const IntervalSchema = z
  .object({
    start: iso,
    end: iso,
  })
  .refine(
    (v) => Date.parse(v.end) > Date.parse(v.start),
    "Interval must have positive duration",
  );
export type Interval = z.infer<typeof IntervalSchema>;
const strength = z.enum(["firm", "flexible"]);
export const ConstraintSchema = z
  .object({
    availability: z.array(IntervalSchema).max(64).optional(),
    busy: z.array(IntervalSchema).max(64).optional(),
    calendarStatus: z
      .enum(["not-connected", "connected", "unavailable"])
      .optional(),
    calendarCheckedAt: iso.optional(),
    calendarWindow: IntervalSchema.optional(),
    budget: z
      .object({
        amount: z.number().nonnegative(),
        strength,
      })
      .strict()
      .optional(),
    dietary: z
      .array(
        z
          .object({
            requirement: z.string().min(1),
            strength,
            allergy: z.boolean().default(false),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    travel: z
      .object({
        maxMinutes: z.number().nonnegative(),
        strength,
        origin: z.string().optional(),
      })
      .strict()
      .optional(),
    preferences: z.array(z.string()).max(64).optional(),
  })
  .strict();
export type Constraints = z.infer<typeof ConstraintSchema>;
export const DinnerSetupSchema = z
  .object({
    city: z.string().min(1),
    area: z.string().min(1),
    windowStart: z.string().date(),
    windowEnd: z.string().date(),
    timezone: zone,
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezoneConfirmed: z.literal(true),
    currencyConfirmed: z.literal(true),
    durationMinutes: z.number().int().positive().max(480),
    budget: z.object({
      amount: z.number().positive(),
      basis: z.enum(["per-person", "total"]),
    }),
    intendedAttendees: z.array(z.string().min(1)).min(2).max(6),
  })
  .refine((v) => v.windowEnd >= v.windowStart, "Invalid date window")
  .refine(
    (v) => Date.parse(v.windowEnd) - Date.parse(v.windowStart) <= 31 * 86400000,
    "Date window cannot exceed 31 days",
  )
  .refine(
    (v) => new Set(v.intendedAttendees).size === v.intendedAttendees.length,
    "Duplicate attendee",
  );
export type DinnerSetup = z.infer<typeof DinnerSetupSchema>;
const evidenceBase = {
  status: z.enum(["known", "unknown", "contradictory"]),
  url: PublicUrlSchema,
  retrievedAt: iso,
  excerpt: z.string().min(1),
  relatedSources: z
    .array(
      z
        .object({
          url: PublicUrlSchema,
          excerpt: z.string().min(1),
          retrievedAt: iso,
        })
        .strict(),
    )
    .optional(),
};
export const ClaimSchema = z.object(evidenceBase);
export const BookingLinkSchema = z.object({
  url: PublicUrlSchema,
  sourceUrl: PublicUrlSchema,
  retrievedAt: iso,
  provider: z.string().min(1).max(80),
  provenance: z.enum(["official_link", "matched_provider"]),
}).strict();
export type BookingLink = z.infer<typeof BookingLinkSchema>;
export const VenueSchema = z.object({
  bookingLink: BookingLinkSchema.optional(),
  officialWebsiteUrl: PublicUrlSchema.optional(),
  directoryBusinessId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  area: z.string().min(1),
  evidence: z.object({
    location: ClaimSchema,
    price: z.object({
      ...evidenceBase,
      amount: z.number().nonnegative().optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional(),
      basis: z.enum(["per-person", "total"]).optional(),
    }),
    opening: z.object({
      ...evidenceBase,
      intervals: z.array(IntervalSchema).max(64).optional(),
    }),
    reservation: z
      .object({
        ...evidenceBase,
        state: z
          .enum(["unknown", "not-booked", "handoff", "unavailable"])
          .optional(),
        phone: z.string().max(40).optional(),
        providerRestaurantId: z.string().regex(/^\d+$/).optional(),
      })
      .strict(),
    dietary: z.record(
      z.string(),
      z
        .object({
          ...evidenceBase,
          supported: z.boolean().optional(),
        })
        .strict(),
    ),
    travel: z.record(
      z.string(),
      z.object({
        ...evidenceBase,
        minutes: z.number().nonnegative().optional(),
      }),
    ),
  }),
});
export type Venue = z.infer<typeof VenueSchema>;
export const VenueListSchema = z
  .array(VenueSchema)
  .refine(
    (venues) => new Set(venues.map((venue) => venue.id)).size === venues.length,
    "Venue IDs must be unique",
  );
export const PlanOptionSchema = z.object({
  venueId: z.string(),
  start: iso,
  end: iso,
  pricePerPerson: z.number().nonnegative(),
  priceEstimateKnown: z.boolean().optional(),
  priceBasis: z.enum(["per-person", "total"]),
  durationMinutes: z.number().int().positive().max(480),
});
export type PlanOption = z.infer<typeof PlanOptionSchema>;
export const MemberSchema = z.object({
  id: z.string(),
  required: z.boolean(),
  consent: z.literal(true),
  startedBot: z.literal(true),
  remindersOptIn: z.boolean(),
});
export type Member = z.infer<typeof MemberSchema>;
export const ProposalSchema = z.object({
  version: z.number().int().positive(),
  createdAt: iso,
  options: z.array(PlanOptionSchema).min(1).max(3),
  selectedIndex: z.number().int().min(0).max(2),
  revision: z.number().int(),
  setup: DinnerSetupSchema,
  memberIds: z.array(z.string()),
  constraints: z.record(z.string(), ConstraintSchema),
  venues: VenueListSchema,
});
export type Proposal = z.infer<typeof ProposalSchema>;
const DisputeSchema = z.object({
  memberId: z.string(),
  reason: z.string(),
  version: z.number().nullable(),
  createdAt: iso,
  open: z.boolean(),
  revisionAttempts: z.number().int().nonnegative(),
});
const StaffReportSchema = z.object({
  memberId: z.string(),
  venueId: z.string(),
  requirement: z.string(),
  report: z.string().min(1),
  accommodationConfirmed: z.literal(true),
  reportedAt: iso,
});
export const DinnerSchema = z.object({
  id: z.string(),
  organizerId: z.string(),
  revision: z.number().int().nonnegative(),
  setup: DinnerSetupSchema,
  members: z.array(MemberSchema),
  constraints: z.record(z.string(), ConstraintSchema),
  venues: VenueListSchema,
  proposals: z.array(ProposalSchema),
  activeVersion: z.number().int().nullable(),
  confirmations: z.record(z.string(), z.number().int()),
  disputes: z.array(DisputeSchema),
  staffReports: z.array(StaffReportSchema),
  status: z.enum([
    "collecting",
    "proposed",
    "agreed",
    "escalated",
    "cancelled",
  ]),
  cancellation: z.object({ at: iso, by: z.string().min(1) }).optional(),
  createdAt: iso,
});
export type Dinner = z.infer<typeof DinnerSchema>;
export type Feasibility = {
  status: "feasible" | "unresolved" | "infeasible";
  reasons: string[];
};
export function createDinner(
  id: string,
  organizerId: string,
  input: DinnerSetup,
  now: string,
): Dinner {
  const setup = DinnerSetupSchema.parse(input);
  iso.parse(now);
  if (!setup.intendedAttendees.includes(organizerId))
    fail("SETUP", "Organizer must be included");
  return {
    id,
    organizerId,
    revision: 0,
    setup,
    members: [
      {
        id: organizerId,
        required: true,
        consent: true,
        startedBot: true,
        remindersOptIn: false,
      },
    ],
    constraints: {},
    venues: [],
    proposals: [],
    activeVersion: null,
    confirmations: {},
    disputes: [],
    staffReports: [],
    status: "collecting",
    createdAt: now,
  };
}
function active(d: Dinner): Proposal {
  const p = d.proposals.find((p) => p.version === d.activeVersion);
  return p ?? fail("STALE", "No active proposal");
}
function member(d: Dinner, id: string): Member {
  return (
    d.members.find((m) => m.id === id) ??
    fail("MEMBERSHIP", "Approved membership required")
  );
}
function organizer(d: Dinner, id: string) {
  if (id !== d.organizerId) fail("AUTHORIZATION", "Organizer required");
}
function editable(d: Dinner, now: string) {
  iso.parse(now);
  if (d.status === "cancelled") fail("CANCELLED", "This dinner was cancelled");
  const p = d.activeVersion !== null ? active(d) : d.proposals.at(-1);
  if (p && Date.parse(now) >= Date.parse(p.options[p.selectedIndex]!.start))
    fail("STARTED", "Dinner has begun");
}
function invalidate(d: Dinner): Dinner {
  return {
    ...d,
    revision: d.revision + 1,
    activeVersion: null,
    confirmations: {},
    status: "collecting",
  };
}
export function cancelDinner(d: Dinner, actor: string, now: string): Dinner {
  organizer(d, actor);
  iso.parse(now);
  if (d.status === "cancelled") return d;
  editable(d, now);
  return {
    ...d,
    status: "cancelled",
    cancellation: { at: now, by: actor },
    activeVersion: null,
    confirmations: {},
    revision: d.revision + 1,
  };
}
export function approveMember(
  d: Dinner,
  actor: string,
  input: {
    id: string;
    consent: boolean;
    startedBot: boolean;
    remindersOptIn?: boolean;
  },
  now: string,
): Dinner {
  organizer(d, actor);
  editable(d, now);
  if (!input.consent || !input.startedBot)
    fail("CONSENT", "Explicit consent and bot start required");
  if (!d.setup.intendedAttendees.includes(input.id))
    fail("MEMBERSHIP", "Not an intended attendee");
  if (d.members.some((m) => m.id === input.id)) return d;
  return {
    ...invalidate(d),
    members: [
      ...d.members,
      {
        id: input.id,
        consent: true,
        startedBot: true,
        required: true,
        remindersOptIn: input.remindersOptIn ?? false,
      },
    ],
  };
}
export function updateConstraints(
  d: Dinner,
  id: string,
  patch: Partial<Constraints>,
  now: string,
): Dinner {
  member(d, id);
  editable(d, now);
  const parsedPatch = Object.fromEntries(
    Object.entries(ConstraintSchema.parse(patch)).filter(
      ([, value]) => value !== undefined,
    ),
  ) as Constraints;
  if (
    d.constraints[id]?.budget?.strength === "firm" &&
    parsedPatch.budget?.strength === "flexible"
  )
    fail(
      "CONSTRAINT_RELAXATION",
      "Explicit removal is required before relaxing a firm budget",
    );
  if (
    d.constraints[id]?.travel?.strength === "firm" &&
    parsedPatch.travel?.strength === "flexible"
  )
    fail(
      "CONSTRAINT_RELAXATION",
      "Explicit removal is required before relaxing a firm travel limit",
    );
  const dietary = new Map(
    (d.constraints[id]?.dietary ?? []).map((item) => [item.requirement, item]),
  );
  for (const item of parsedPatch.dietary ?? []) {
    const previous = dietary.get(item.requirement);
    if (
      previous &&
      ((previous.allergy && !item.allergy) ||
        (previous.strength === "firm" && item.strength === "flexible"))
    )
      fail(
        "DIETARY_RELAXATION",
        "Explicit removal is required before relaxing an existing requirement",
      );
    dietary.set(item.requirement, item);
  }
  const next = ConstraintSchema.parse({
    ...d.constraints[id],
    ...parsedPatch,
    ...(parsedPatch.dietary
      ? {
          dietary: [...dietary.values()],
        }
      : {}),
  });
  return {
    ...invalidate(d),
    constraints: {
      ...d.constraints,
      [id]: next,
    },
  };
}
export function removeDietary(
  d: Dinner,
  id: string,
  requirement: string,
  now: string,
): Dinner {
  member(d, id);
  editable(d, now);
  const existing = d.constraints[id];
  if (!existing?.dietary?.some((item) => item.requirement === requirement))
    fail("DIETARY", "Unknown dietary requirement");
  return {
    ...invalidate(d),
    constraints: {
      ...d.constraints,
      [id]: {
        ...existing,
        dietary: existing.dietary.filter(
          (item) => item.requirement !== requirement,
        ),
      },
    },
    staffReports: d.staffReports.filter(
      (report) => report.memberId !== id || report.requirement !== requirement,
    ),
  };
}
export function removeFirmLimit(
  d: Dinner,
  id: string,
  kind: "budget" | "travel",
  now: string,
): Dinner {
  member(d, id);
  editable(d, now);
  z.enum(["budget", "travel"]).parse(kind);
  const constraints = {
    ...d.constraints[id],
  };
  if (!constraints[kind]) fail("CONSTRAINT", "Unknown limit");
  delete constraints[kind];
  return {
    ...invalidate(d),
    constraints: {
      ...d.constraints,
      [id]: constraints,
    },
  };
}
export function updateSetup(
  d: Dinner,
  actor: string,
  patch: Partial<DinnerSetup>,
  now: string,
): Dinner {
  organizer(d, actor);
  editable(d, now);
  const setup = DinnerSetupSchema.parse({
    ...d.setup,
    ...patch,
  });
  if (!setup.intendedAttendees.includes(d.organizerId))
    fail("MEMBERSHIP", "Organizer must remain intended");
  if (
    d.members.some((m) => m.required && !setup.intendedAttendees.includes(m.id))
  )
    fail(
      "MEMBERSHIP",
      "Explicit requirement decision needed before removing attendee",
    );
  return {
    ...invalidate(d),
    setup,
  };
}
export function setMemberRequired(
  d: Dinner,
  actor: string,
  id: string,
  required: boolean,
  now: string,
): Dinner {
  organizer(d, actor);
  editable(d, now);
  member(d, id);
  if (id === d.organizerId && !required)
    fail("MEMBERSHIP", "Organizer is required");
  return {
    ...invalidate(d),
    disputes: required
      ? d.disputes
      : d.disputes.map((dispute) =>
          dispute.memberId === id
            ? {
                ...dispute,
                open: false,
              }
            : dispute,
        ),
    members: d.members.map((m) =>
      m.id === id
        ? {
            ...m,
            required,
          }
        : m,
    ),
  };
}
export function setReminderConsent(
  d: Dinner,
  id: string,
  optIn: boolean,
): Dinner {
  member(d, id);
  if (d.status === "cancelled") fail("CANCELLED", "This dinner was cancelled");
  return {
    ...d,
    revision: d.revision + 1,
    members: d.members.map((m) =>
      m.id === id
        ? {
            ...m,
            remindersOptIn: optIn,
          }
        : m,
    ),
  };
}
export function setVenues(
  d: Dinner,
  actor: string,
  venues: Venue[],
  now: string,
): Dinner {
  organizer(d, actor);
  editable(d, now);
  return {
    ...invalidate(d),
    venues: VenueListSchema.parse(venues),
    staffReports: [],
  };
}
const contains = (interval: Interval, p: PlanOption) =>
  Date.parse(interval.start) <= Date.parse(p.start) &&
  Date.parse(interval.end) >= Date.parse(p.end);
const overlaps = (interval: Interval, p: PlanOption) =>
  Date.parse(interval.start) < Date.parse(p.end) &&
  Date.parse(interval.end) > Date.parse(p.start);
export function evaluateFeasibility(
  d: Dinner,
  input: PlanOption,
  now: string,
): Feasibility {
  iso.parse(now);
  const current = (claim: z.infer<typeof ClaimSchema> | undefined) =>
    !!claim &&
    claim.status === "known" &&
    Date.parse(claim.retrievedAt) <= Date.parse(now) &&
    Date.parse(now) - Date.parse(claim.retrievedAt) <= 48 * 3600000;
  const p = PlanOptionSchema.parse(input),
    bad: string[] = [],
    unknown: string[] = [];
  const start = DateTime.fromISO(p.start).setZone(d.setup.timezone),
    end = DateTime.fromISO(p.end).setZone(d.setup.timezone);
  if (
    start.toISODate()! < d.setup.windowStart ||
    end.toISODate()! > d.setup.windowEnd
  )
    bad.push("Outside date window");
  if (
    Date.parse(p.end) - Date.parse(p.start) !== p.durationMinutes * 60000 ||
    p.durationMinutes !== d.setup.durationMinutes
  )
    bad.push("Duration mismatch");
  if (p.priceEstimateKnown === false)
    unknown.push("Price estimate unavailable");
  if (p.priceBasis !== "per-person")
    unknown.push("Per-person price basis unresolved");
  const venue = d.venues.find((v) => v.id === p.venueId);
  if (!venue) unknown.push("Venue evidence missing");
  if (
    d.setup.intendedAttendees.some((id) => !d.members.some((m) => m.id === id))
  )
    unknown.push("Intended membership incomplete");
  const required = d.members.filter((m) => m.required);
  const limit =
    d.setup.budget.basis === "total"
      ? d.setup.budget.amount / required.length
      : d.setup.budget.amount;
  if (p.pricePerPerson > limit) bad.push("Group budget exceeded");
  if (venue) {
    const e = venue.evidence;
    if (!current(e.location)) unknown.push("Location evidence unresolved");
    if (
      venue.city.toLocaleLowerCase() !== d.setup.city.toLocaleLowerCase() ||
      venue.area.toLocaleLowerCase() !== d.setup.area.toLocaleLowerCase()
    )
      bad.push("Venue outside agreed city or area");
    if (
      !current(e.price) ||
      e.price.amount === undefined ||
      !e.price.basis ||
      e.price.currency !== d.setup.currency
    )
      unknown.push("Price evidence unresolved");
    else {
      const price =
        e.price.basis === "total"
          ? e.price.amount / required.length
          : e.price.amount;
      if (price !== p.pricePerPerson)
        unknown.push("Price estimate does not match evidence");
    }
    if (!current(e.opening) || !e.opening.intervals)
      unknown.push("Opening hours unresolved");
    else if (!e.opening.intervals.some((i) => contains(i, p)))
      bad.push("Venue closed");
    if (e.reservation.state === "unavailable")
      bad.push("Reservation unavailable");
  }
  for (const m of required) {
    const c = d.constraints[m.id];
    if (c?.calendarStatus === "connected") {
      const checkedAt = c.calendarCheckedAt
        ? Date.parse(c.calendarCheckedAt)
        : NaN;
      const age = Date.parse(now) - checkedAt;
      if (
        !Number.isFinite(checkedAt) ||
        age < 0 ||
        age > 24 * 3600000 ||
        !c.calendarWindow ||
        !contains(c.calendarWindow, p)
      )
        unknown.push(`Calendar sync unresolved: ${m.id}`);
    }
    if (c?.calendarStatus === "unavailable")
      unknown.push(`Calendar unavailable: ${m.id}`);
    if (!c?.availability?.length)
      unknown.push(`Availability unresolved: ${m.id}`);
    else if (!c.availability.some((i) => contains(i, p)))
      bad.push(`Unavailable: ${m.id}`);
    if (c?.busy?.some((i) => overlaps(i, p))) bad.push(`Busy: ${m.id}`);
    if (c?.budget?.strength === "firm" && p.pricePerPerson > c.budget.amount)
      bad.push(`Budget exceeded: ${m.id}`);
    for (const diet of c?.dietary ?? []) {
      if (diet.strength !== "firm" && !diet.allergy) continue;
      const e = venue?.evidence.dietary[diet.requirement];
      const staffConfirmed =
        diet.allergy &&
        d.staffReports.some(
          (r) =>
            r.memberId === m.id &&
            r.venueId === p.venueId &&
            r.requirement === diet.requirement &&
            r.accommodationConfirmed === true,
        );
      // An authenticated participant's affirmative staff report is direct,
      // private venue evidence. It cannot overrule contradictory public evidence.
      if (e?.status === "contradictory")
        unknown.push(`Dietary evidence contradictory: ${m.id}`);
      else if (
        (!e || !current(e) || e.supported === undefined) &&
        !staffConfirmed
      )
        unknown.push(`Dietary evidence unresolved: ${m.id}`);
      else if (e && current(e) && e.supported === false)
        bad.push(`Dietary requirement unsupported: ${m.id}`);
      if (diet.allergy && !staffConfirmed)
        unknown.push(`Participant staff allergy report required: ${m.id}`);
    }
    if (c?.travel?.strength === "firm") {
      if (!c.travel.origin?.trim())
        unknown.push(`Travel origin unresolved: ${m.id}`);
      const e = venue?.evidence.travel[m.id];
      if (!e || !current(e) || e.minutes === undefined)
        unknown.push(`Travel evidence unresolved: ${m.id}`);
      else if (e.minutes > c.travel.maxMinutes)
        bad.push(`Travel limit exceeded: ${m.id}`);
    }
  }
  return {
    status: bad.length
      ? "infeasible"
      : unknown.length
        ? "unresolved"
        : "feasible",
    reasons: [...bad, ...unknown],
  };
}
export function proposeOptions(
  d: Dinner,
  actor: string,
  inputs: PlanOption[],
  now: string,
): Dinner {
  organizer(d, actor);
  editable(d, now);
  const options = z.array(PlanOptionSchema).min(1).max(3).parse(inputs);
  const version = (d.proposals.at(-1)?.version ?? 0) + 1;
  if (options.some((o) => Date.parse(o.start) <= Date.parse(now)))
    fail("STARTED", "Proposal must begin in the future");
  const proposal: Proposal = {
    version,
    createdAt: now,
    options: structuredClone(options),
    selectedIndex: 0,
    revision: d.revision,
    setup: structuredClone(d.setup),
    memberIds: d.members.filter((m) => m.required).map((m) => m.id),
    constraints: structuredClone(d.constraints),
    venues: structuredClone(d.venues),
  };
  const disputes = d.disputes.map((x) =>
    x.open
      ? {
          ...x,
          revisionAttempts: x.revisionAttempts + 1,
        }
      : x,
  );
  const escalated =
    d.status === "escalated" ||
    disputes.some((x) => x.open && x.revisionAttempts > 2);
  return {
    ...d,
    revision: d.revision + 1,
    proposals: [...d.proposals, proposal],
    activeVersion: version,
    confirmations: {},
    disputes,
    status: escalated ? "escalated" : "proposed",
  };
}
export function selectAlternative(
  d: Dinner,
  actor: string,
  index: number,
  now: string,
): Dinner {
  organizer(d, actor);
  const p = active(d);
  const selected = p.options[index];
  if (!selected) fail("OPTION", "Unknown option");
  return proposeOptions(
    d,
    actor,
    [selected, ...p.options.filter((_, i) => i !== index)],
    now,
  );
}
/** Group choice is separate from public evidence readiness; known conflicts still block it. */
export function canConfirmChoice(
  d: Dinner,
  option: PlanOption,
  now: string,
): boolean {
  const feasibility = evaluateFeasibility(d, option, now);
  return (
    d.status !== "cancelled" &&
    d.status !== "escalated" &&
    !d.disputes.some((x) => x.open) &&
    Date.parse(option.start) > Date.parse(now) &&
    feasibility.status !== "infeasible" &&
    !feasibility.reasons.some(
      (reason) =>
        reason === "Intended membership incomplete" ||
        reason.startsWith("Availability unresolved"),
    )
  );
}
export function confirmVersion(
  d: Dinner,
  id: string,
  version: number,
  now: string,
): Dinner {
  member(d, id);
  editable(d, now);
  if (d.status === "escalated")
    fail("ESCALATED", "Organizer must resolve escalation");
  if (d.disputes.some((x) => x.open))
    fail("DISPUTE", "An open objection must be resolved by its author");
  if (version !== d.activeVersion)
    fail("STALE", "Confirmation is not for current proposal");
  const p = active(d);
  if (!canConfirmChoice(d, p.options[p.selectedIndex]!, now))
    fail(
      "FEASIBILITY",
      "This choice conflicts with current willingness, membership or a known firm requirement",
    );
  const confirmations = {
    ...d.confirmations,
    [id]: version,
  };
  const agreed = d.members
    .filter((m) => m.required)
    .every((m) => confirmations[m.id] === version);
  return {
    ...d,
    revision: d.revision + 1,
    confirmations,
    status: agreed ? "agreed" : "proposed",
  };
}
export function raiseDispute(
  d: Dinner,
  id: string,
  reason: string,
  now: string,
): Dinner {
  member(d, id);
  editable(d, now);
  if (!reason.trim()) fail("DISPUTE", "Reason required");
  const existing = d.disputes.find((x) => x.memberId === id && x.open);
  const disputes = existing
    ? d.disputes.map((x) =>
        x === existing
          ? {
              ...x,
              reason,
            }
          : x,
      )
    : [
        ...d.disputes,
        {
          memberId: id,
          reason,
          version: d.activeVersion,
          createdAt: now,
          open: true,
          revisionAttempts: 0,
        },
      ];
  return {
    ...d,
    revision: d.revision + 1,
    disputes,
    activeVersion: null,
    confirmations: {},
    status:
      d.status === "escalated" || (existing?.revisionAttempts ?? 0) >= 2
        ? "escalated"
        : "collecting",
  };
}
export function resolveDispute(d: Dinner, id: string, now: string): Dinner {
  member(d, id);
  editable(d, now);
  return {
    ...d,
    revision: d.revision + 1,
    disputes: d.disputes.map((x) =>
      x.memberId === id
        ? {
            ...x,
            open: false,
          }
        : x,
    ),
  };
}
export function reportAllergySafety(
  d: Dinner,
  id: string,
  input: {
    venueId: string;
    requirement: string;
    report: string;
    accommodationConfirmed: true;
  },
  now: string,
): Dinner {
  member(d, id);
  editable(d, now);
  if (
    !d.constraints[id]?.dietary?.some(
      (x) => x.allergy && x.requirement === input.requirement,
    )
  )
    fail("ALLERGY", "Only affected participant can report");
  if (!d.venues.some((v) => v.id === input.venueId))
    fail("VENUE", "Unknown venue");
  const report = StaffReportSchema.parse({
    ...input,
    memberId: id,
    reportedAt: now,
  });
  return {
    ...invalidate(d),
    staffReports: [
      ...d.staffReports.filter(
        (r) =>
          !(
            r.memberId === id &&
            r.venueId === input.venueId &&
            r.requirement === input.requirement
          ),
      ),
      report,
    ],
  };
}
export function reminderEligibility(
  d: Dinner,
  id: string,
  now: string,
  sentAt: string[],
): {
  allowed: boolean;
  reason: string;
} {
  if (d.status === "cancelled")
    return { allowed: false, reason: "Dinner cancelled" };
  const m = member(d, id);
  const local = DateTime.fromISO(iso.parse(now)).setZone(d.setup.timezone);
  const latest = d.activeVersion !== null ? active(d) : d.proposals.at(-1);
  if (
    latest &&
    Date.parse(now) >= Date.parse(latest.options[latest.selectedIndex]!.start)
  )
    return {
      allowed: false,
      reason: "Dinner has begun",
    };
  if (!m.remindersOptIn)
    return {
      allowed: false,
      reason: "Not opted in",
    };
  if (local.hour >= 21 || local.hour < 9)
    return {
      allowed: false,
      reason: "Quiet hours",
    };
  if (
    sentAt.some(
      (t) =>
        DateTime.fromISO(t).setZone(d.setup.timezone).toISODate() ===
        local.toISODate(),
    )
  )
    return {
      allowed: false,
      reason: "Daily limit",
    };
  if (d.status === "agreed")
    return {
      allowed: false,
      reason: "Already agreed",
    };
  return {
    allowed: true,
    reason: "Eligible",
  };
}
const escapeIcs = (s: string) =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
const utc = (s: string) =>
  DateTime.fromISO(s).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
export function exportIcs(d: Dinner, now: string): string {
  if (d.status !== "agreed")
    fail("AGREEMENT", "Calendar export requires agreement");
  const p = active(d),
    o = p.options[p.selectedIndex]!,
    v = p.venues.find((v) => v.id === o.venueId)!;
  const verification = evaluateFeasibility(d, o, now).status;
  const reservation =
    v.evidence.reservation.status === "known"
      ? (v.evidence.reservation.state ?? "unknown")
      : "unknown";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dinner Planner//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeIcs(d.id)}@dinner-planner`,
    `DTSTAMP:${utc(now)}`,
    `SEQUENCE:${p.version}`,
    `DTSTART:${utc(o.start)}`,
    `DTEND:${utc(o.end)}`,
    `SUMMARY:${escapeIcs(`Dinner at ${v.name}`)}`,
    `LOCATION:${escapeIcs(v.address)}`,
    `DESCRIPTION:${escapeIcs(`${o.priceEstimateKnown === false ? "Meal cost not confirmed" : `Estimated cost: ${o.pricePerPerson} ${d.setup.currency} per person`}. Reservation: ${reservation}; no booking implied by group agreement. Restaurant verification: ${verification}. Attendees: ${p.memberIds.join(", ")}. Local timezone: ${d.setup.timezone}`)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return (
    lines
      .map((line) => {
        let folded = "",
          bytes = 0;
        for (const char of line) {
          const size = new TextEncoder().encode(char).length;
          if (bytes + size > 75) {
            folded += "\r\n ";
            bytes = 1;
          }
          folded += char;
          bytes += size;
        }
        return folded;
      })
      .join("\r\n") + "\r\n"
  );
}
