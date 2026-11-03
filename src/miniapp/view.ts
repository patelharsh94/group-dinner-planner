import { coordinationView } from "../application/coordination.js";
import { getReservation } from "../application/reservations.js";
import { researchMessage } from "../application/research.js";
import { stableHash } from "./hash.js";
import {
  evaluateFeasibility,
  confirmVersion,
  type Constraints,
} from "../domain/index.js";
import {
  authorized,
  availabilityShared,
  organizer,
  canPlan,
  sharedPlan,
  type AppDinner,
} from "../application/model.js";
import type { DinnerRecord, DinnerTx } from "../persistence/store.js";
import type { DinnerSummary, DinnerView, InvitationView } from "./contracts.js";
import { MiniAppFault } from "./auth.js";
export function publicSetup(s: AppDinner) {
  const {
    city,
    area,
    windowStart,
    windowEnd,
    timezone,
    currency,
    durationMinutes,
    budget,
  } = s.dinner.setup;
  return {
    city,
    area,
    windowStart,
    windowEnd,
    timezone,
    currency,
    durationMinutes,
    budget,
  };
}
export function formVersion(s: AppDinner, user: string): string {
  return stableHash({
    title: s.title,
    setup: publicSetup(s),
    own: s.joinRequests[user]?.preferences ?? s.dinner.constraints[user] ?? {},
    membership: s.dinner.members.find((m) => m.id === user) ?? null,
    consent: s.consents[user]?.active ?? false,
    answerSharing: s.answerSharing?.[user],
    availabilitySharing: s.availabilitySharing?.[user],
  });
}
export function summary(
  record: DinnerRecord<AppDinner>,
  user: string,
): DinnerSummary {
  const s = record.state,
    d = s.dinner;
  return {
    id: record.id,
    ...(s.title ? { title: s.title } : {}),
    city: d.setup.city,
    windowStart: d.setup.windowStart,
    windowEnd: d.setup.windowEnd,
    status: d.status,
    role:
      d.organizerId === user
        ? "organizer"
        : authorized(s, user)
          ? "member"
          : s.joinRequests[user]
            ? "pending"
            : "withdrawn",
    ended: !!record.endedAt,
    ...(d.cancellation ? { cancellation: d.cancellation } : {}),
  };
}
export function invitation(
  record: DinnerRecord<AppDinner>,
  user: string,
): InvitationView {
  const s = record.state,
    d = s.dinner;
  return {
    formVersion: formVersion(s, user),
    dinnerId: record.id,
    ...(s.title ? { title: s.title } : {}),
    city: d.setup.city,
    windowStart: d.setup.windowStart,
    windowEnd: d.setup.windowEnd,
    partySize: s.roster.length,
    availablePlaces: s.roster.filter(
      (r) =>
        !d.members.some((m) => m.id === r.id) ||
        (r.id === user && !authorized(s, user)),
    ).length,
    alreadyJoined: authorized(s, user),
    pending: !!s.joinRequests[user],
    timezone: d.setup.timezone,
    currency: d.setup.currency,
    durationMinutes: d.setup.durationMinutes,
    area: d.setup.area,
    budget: d.setup.budget,
  };
}
/** Explicit projection: no raw dinner, historical proposals, others' private input or evidence maps. */
export async function project(
  tx: DinnerTx,
  record: DinnerRecord<AppDinner>,
  user: string,
  now: string,
): Promise<DinnerView> {
  const s = record.state,
    d = s.dinner,
    isMember = authorized(s, user),
    pending = s.joinRequests[user];
  if (!isMember && !pending && d.organizerId !== user)
    throw new MiniAppFault("MEMBERSHIP", 403, "This dinner is unavailable.");
  const own = pending?.preferences ?? d.constraints[user] ?? {};
  // Google busy times are deliberately excluded even from this user's web response.
  const constraints: Constraints = {};
  for (const key of [
    "availability",
    "dietary",
    "preferences",
    "budget",
    "travel",
  ] as const)
    if (own[key] !== undefined) Object.assign(constraints, { [key]: own[key] });
  const proposal = d.proposals.find((p) => p.version === d.activeVersion),
    stored = await tx.getCalendarConnection(record.id, user);
  const full = isMember;
  const required = d.members.filter((m) => m.required),
    confirmed = required.filter(
      (m) =>
        d.activeVersion !== null && d.confirmations[m.id] === d.activeVersion,
    ).length;
  const selected = proposal?.options[proposal.selectedIndex],
    feasibility = selected
      ? evaluateFeasibility(d, selected, now).status
      : null;
  let canConfirm = false;
  if (
    full &&
    d.activeVersion !== null &&
    canPlan(s) &&
    required.some((m) => m.id === user)
  ) {
    try {
      confirmVersion(d, user, d.activeVersion, now);
      canConfirm = true;
    } catch {}
  }
  const verificationStatus =
    feasibility === "feasible"
      ? "ready"
      : feasibility === "infeasible"
        ? "action_needed"
        : "pending";
  const nextAction = record.endedAt
    ? undefined
    : !full
      ? {
          label: "Join dinner",
          message: "Complete your invitation to join this dinner.",
          action: "join" as const,
        }
      : !own.availability?.length
        ? {
            label: "Add your response",
            message: "Choose when you are available and any requirements.",
            action: "savePreferences" as const,
          }
        : d.disputes.some((x) => x.memberId === user && x.open)
          ? {
              label: "Resolve your change request",
              message: "Close your objection once it has been addressed.",
              action: "resolve" as const,
            }
          : canConfirm && d.confirmations[user] !== d.activeVersion
            ? {
                label: "This works for me",
                message: "Agree to this exact dinner option.",
                action: "confirm" as const,
              }
            : d.status === "agreed"
              ? {
                  label: "Review the reservation",
                  message:
                    "Everyone has agreed. A reservation still needs its own confirmation.",
                }
              : !proposal && organizer(s, user)
                ? {
                    label: "Find dinner options",
                    message:
                      "Collect responses, then find an option for the group.",
                    action: "research" as const,
                  }
                : undefined;

  const reservation = full
    ? await getReservation(tx, record.id, d.activeVersion ?? undefined)
    : undefined;
  const research = full ? await tx.getLatestResearchAttempt(record.id) : null;
  const work = await tx.client.query(
    "SELECT EXISTS(SELECT 1 FROM outbox WHERE dinner_id=$1 AND kind='research' AND status IN ('pending','sending')) AS pending",
    [record.id],
  );
  return {
    ...summary(record, user),
    ...(reservation ? { reservation } : {}),
    ...(full ? { coordination: coordinationView(s, user) } : {}),
    agreement: {
      version: full ? d.activeVersion : null,
      confirmed: full ? confirmed : 0,
      required: full ? required.length : 0,
      agreed: full && d.status === "agreed",
    },
    verification: {
      status: verificationStatus,
      checks: [
        {
          kind: "requirements",
          status: verificationStatus,
          message: !selected
            ? "Dinner option checks will appear after an option is proposed."
            : feasibility === "feasible"
              ? "The current checks support this option."
              : feasibility === "infeasible"
                ? "A known requirement conflicts with this option."
                : "Some venue details still need verification. Agreement does not confirm a reservation.",
        },
      ],
    },
    ...(nextAction ? { nextAction } : {}),
    canConfirm,
    sharedAvailability: full
      ? d.members
          .filter((m) => authorized(s, m.id))
          .map((m) => {
            const availability = d.constraints[m.id]?.availability,
              shared = availabilityShared(s, m.id);
            return {
              userId: m.id,
              name: s.roster.find((r) => r.id === m.id)?.name ?? "Attendee",
              status: !availability?.length
                ? "not-submitted"
                : shared
                  ? "shared"
                  : "private",
              ...(availability?.length && shared
                ? { availability: structuredClone(availability) }
                : {}),
            };
          })
      : [],
    formVersion: formVersion(s, user),
    researchPending: full && work.rows[0].pending,
    ...(research
      ? {
          research: {
            id: research.id,
            status: research.status,
            requestedAt: research.requestedAt,
            updatedAt: research.updatedAt,
            message: researchMessage(research),
          },
          ...(organizer(s, user) ? { researchDetails: research } : {}),
        }
      : {}),
    setup: structuredClone(publicSetup(s)),
    sharedPlan:
      d.status === "cancelled"
        ? "This dinner was cancelled by its organizer. Existing reservations are unchanged."
        : full
          ? sharedPlan(s, now)
          : "Your response is waiting for organizer approval.",
    activeVersion: full ? d.activeVersion : null,
    members: full
      ? d.members.map((m) => ({
          id: m.id,
          name: s.roster.find((r) => r.id === m.id)?.name ?? "Attendee",
          required: m.required,
          confirmed:
            d.confirmations[m.id] === d.activeVersion &&
            d.activeVersion !== null,
        }))
      : [],
    sharedResponses: full
      ? d.members
          .filter((m) => authorized(s, m.id))
          .map((m) => {
            const input = d.constraints[m.id],
              submitted =
                !!input?.availability?.length && input.dietary !== undefined,
              enabled = s.answerSharing?.[m.id]?.enabled === true;
            const shared: Constraints = {};
            if (submitted && enabled)
              for (const key of [
                "availability",
                "dietary",
                "preferences",
                "budget",
                "travel",
              ] as const)
                if (input[key] !== undefined)
                  Object.assign(shared, { [key]: structuredClone(input[key]) });
            return {
              userId: m.id,
              name: s.roster.find((r) => r.id === m.id)?.name ?? "Attendee",
              status: !submitted
                ? "not-submitted"
                : enabled
                  ? "shared"
                  : "private",
              ...(submitted && enabled ? { constraints: shared } : {}),
            };
          })
      : [],
    own: {
      answerSharing: s.answerSharing?.[user]?.enabled === true,
      availabilitySharing: availabilityShared(s, user),
      constraints,
      reminders: d.members.find((m) => m.id === user)?.remindersOptIn ?? false,
      consent: s.consents[user]?.active ?? false,
      calendar: stored
        ? own.calendarStatus === "connected"
          ? "connected"
          : own.calendarStatus === "unavailable"
            ? "unavailable"
            : "staged"
        : "not-connected",
      foodConfirmed: own.dietary !== undefined,
      disputeOpen: d.disputes.some((x) => x.memberId === user && x.open),
    },
    ...(organizer(s, user)
      ? {
          pendingRequests: Object.entries(s.joinRequests).map(
            ([userId, r]) => ({ userId, name: r.name }),
          ),
        }
      : {}),
    progress: {
      approved: d.members.length,
      expected: s.roster.length,
      complete: d.members.filter(
        (m) =>
          d.constraints[m.id]?.availability?.length &&
          d.constraints[m.id]?.dietary !== undefined,
      ).length,
      confirmed: d.members.filter(
        (m) =>
          d.activeVersion !== null && d.confirmations[m.id] === d.activeVersion,
      ).length,
    },
    options: full
      ? (proposal?.options ?? []).map((option, index) => {
          const venue =
            d.venues.find((v) => v.id === option.venueId) ??
            proposal!.venues.find((v) => v.id === option.venueId);
          const feasibility = evaluateFeasibility(d, option, now);
          const reasons = feasibility.reasons
            .filter(
              (reason) =>
                !reason.includes(": ") || reason.endsWith(`: ${user}`),
            )
            .map((reason) => reason.replace(new RegExp(`: ${user}$`), ""));
          return {
            index,
            venueId: option.venueId,
            venueName: venue?.name ?? "Venue",
            address: venue?.address ?? "",
            start: option.start,
            end: option.end,
            pricePerPerson: option.pricePerPerson,
            currency: d.setup.currency,
            reservationUrl: venue?.evidence.reservation.url ?? "",
            reservationState: venue?.evidence.reservation.state ?? "unknown",
            ownChecks: { status: feasibility.status, reasons },
            sources: venue
              ? (["location", "price", "opening", "reservation"] as const).map(
                  (key) => ({
                    label: key,
                    url: venue.evidence[key].url,
                    retrievedAt: venue.evidence[key].retrievedAt,
                    status: venue.evidence[key].status,
                  }),
                )
              : [],
          };
        })
      : [],
  };
}
