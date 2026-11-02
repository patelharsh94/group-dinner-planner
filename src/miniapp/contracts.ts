import type { Constraints, DinnerSetup } from "../domain/index.js";
export type PreferencesInput = Pick<
  Constraints,
  "availability" | "dietary" | "preferences" | "budget" | "travel"
> & {
  availability: NonNullable<Constraints["availability"]>;
  foodConfirmed: true;
  removeDietary?: string[];
  removeLimits?: ("budget" | "travel")[];
};
export interface CreateDinnerInput {
  city: string;
  area?: string;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  currency: string;
  durationMinutes: number;
  partySize: number;
  budget: { amount: number; basis?: "per-person" };
  consent: true;
}
export type MiniAppActionName =
  | "cancelDinner"
  | "create"
  | "join"
  | "approve"
  | "reject"
  | "savePreferences"
  | "updateDinner"
  | "research"
  | "select"
  | "confirm"
  | "change"
  | "resolve"
  | "staffReport"
  | "invite"
  | "calendarConnect"
  | "calendarActivate"
  | "calendarSync"
  | "calendarDisconnect"
  | "reminders"
  | "stop"
  | "delete"
  | "resume";
export interface MutationEnvelope {
  requestId: string;
  action: MiniAppActionName;
  dinnerId?: string;
  formVersion?: string;
  payload?: unknown;
}
export interface DinnerSummary {
  id: string;
  city: string;
  windowStart: string;
  windowEnd: string;
  status: string;
  role: "organizer" | "member" | "pending" | "withdrawn";
  ended: boolean;
  cancellation?: { at: string; by: string };
}
export interface InvitationView {
  formVersion: string;
  dinnerId: string;
  city: string;
  windowStart: string;
  windowEnd: string;
  partySize: number;
  availablePlaces: number;
  alreadyJoined: boolean;
  pending: boolean;
  timezone: string;
  currency: string;
  durationMinutes: number;
  area: string;
  budget: DinnerSetup["budget"];
}
export interface DinnerView extends DinnerSummary {
  formVersion: string;
  researchPending: boolean;
  setup: Pick<
    DinnerSetup,
    | "city"
    | "area"
    | "windowStart"
    | "windowEnd"
    | "timezone"
    | "currency"
    | "durationMinutes"
    | "budget"
  >;
  sharedPlan: string;
  activeVersion: number | null;
  members: {
    id: string;
    name: string;
    required: boolean;
    confirmed: boolean;
  }[];
  own: {
    constraints: Constraints;
    reminders: boolean;
    consent: boolean;
    calendar: "not-connected" | "staged" | "connected" | "unavailable";
    foodConfirmed: boolean;
    disputeOpen: boolean;
  };
  pendingRequests?: { userId: string; name: string }[];
  progress: {
    approved: number;
    expected: number;
    complete: number;
    confirmed: number;
  };
  options: {
    index: number;
    venueId: string;
    venueName: string;
    address: string;
    start: string;
    end: string;
    pricePerPerson: number;
    currency: string;
    reservationUrl: string;
    reservationState: string;
    ownChecks: {
      status: "feasible" | "unresolved" | "infeasible";
      reasons: string[];
    };
    sources: {
      label: string;
      url: string;
      retrievedAt: string;
      status: "known" | "unknown" | "contradictory";
    }[];
  }[];
}
export interface BootstrapResponse {
  actor: { id: string; name: string };
  dinners: DinnerSummary[];
  currentDinnerId: string | null;
  invitation?: InvitationView;
  supportContact: string;
  privacyUrl: string;
  botUsername: string;
}
export interface MutationResponse {
  ok: true;
  dinner?: DinnerView;
  invitationUrl?: string;
  calendarUrl?: string;
  message?: string;
  deleted?: boolean;
}
export interface MiniAppError {
  error: { code: string; message: string };
}
