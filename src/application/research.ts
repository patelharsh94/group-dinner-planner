import { z } from "zod";
export const ResearchStageSchema = z.enum([
  "queued",
  "provider",
  "output_validation",
  "source_verification",
  "planning",
  "done",
]);
export const ResearchCodeSchema = z.enum([
  "AUTH_INVALID",
  "ACCESS_DENIED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "REQUEST_REJECTED",
  "TIMEOUT",
  "NETWORK",
  "INVALID_OUTPUT",
  "INCOMPLETE_OUTPUT",
  "SEARCH_NOT_EXECUTED",
  "NO_SUITABLE_OPTIONS",
  "EVIDENCE_UNRESOLVED",
  "NO_COMMON_TIME",
  "SERVICE_UNCONFIGURED",
  "USAGE_LIMIT",
  "UNEXPECTED_ERROR",
]);
export const VerificationIssueSchema = z
  .object({
    code: z.enum([
      "missing_citation",
      "excerpt_unmatched",
      "claim_unsupported",
      "source_unavailable",
      "identity_unverified",
      "provider_unknown",
      "conflicting_sources",
    ]),
    count: z.number().int().positive(),
  })
  .strict();
export const ResearchAttemptSchema = z
  .object({
    id: z.string().min(1).max(128),
    dinnerId: z.string().min(1).max(128),
    inputVersion: z.string().max(128),
    requestedAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "needs_checks",
      "failed",
      "superseded",
      "cancelled",
    ]),
    stage: ResearchStageSchema,
    startedAt: z.iso.datetime({ offset: true }).optional(),
    finishedAt: z.iso.datetime({ offset: true }).optional(),
    code: ResearchCodeSchema.optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    providerRequestId: z
      .string()
      .max(160)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
    retryable: z.boolean().optional(),
    retryAfterSeconds: z.number().int().min(0).max(86400).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    verificationIssues: z.array(VerificationIssueSchema).max(7).optional(),
    discovery: z
      .object({
        provider: z.literal("yelp"),
        status: z.enum(["used", "empty", "unavailable"]),
        candidateIds: z
          .array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/))
          .max(5),
        code: z
          .enum([
            "unauthorized",
            "forbidden",
            "rate_limited",
            "network",
            "invalid_response",
            "invalid_request",
            "upstream",
          ])
          .optional(),
      })
      .strict()
      .optional(),
    counts: z
      .object({
        venues: z.number().int().nonnegative(),
        options: z.number().int().nonnegative(),
        verifiedClaims: z.number().int().nonnegative(),
        unresolvedClaims: z.number().int().nonnegative(),
        sourcesFailed: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .strict();
export type ResearchAttempt = z.infer<typeof ResearchAttemptSchema>;
export type ResearchCode = z.infer<typeof ResearchCodeSchema>;
export type ResearchStage = z.infer<typeof ResearchStageSchema>;
const guidance: Record<ResearchCode, string> = {
  AUTH_INVALID:
    "Muse rejected the service API key. The service owner needs to replace MODEL_API_KEY in Render and redeploy before retrying.",
  ACCESS_DENIED:
    "Muse denied this service access. The service owner should check the API key permissions and model access.",
  QUOTA_EXCEEDED:
    "Muse reports a billing or quota limit. The service owner should check the Meta account before retrying.",
  RATE_LIMITED: "Muse is temporarily rate limited. Wait before trying again.",
  REQUEST_REJECTED:
    "Muse rejected the research request. The service owner should check model and API settings.",
  PROVIDER_UNAVAILABLE:
    "Muse is temporarily unavailable. Please try again later.",
  TIMEOUT:
    "Research timed out. Please try again; your answers have been preserved.",
  NETWORK: "The service could not connect to Muse. Please try again later.",
  INVALID_OUTPUT:
    "Muse returned an answer the planner could not safely validate. Please retry; no unsupported result was accepted.",
  INCOMPLETE_OUTPUT:
    "Muse did not finish its answer. Please retry; the partial answer was not accepted.",
  SEARCH_NOT_EXECUTED:
    "Muse did not complete the required live search. Please retry; no fixture or invented result was substituted.",
  NO_SUITABLE_OPTIONS:
    "Research did not produce a usable shortlist. Retry research with your saved answers; you do not need to re-enter them.",
  EVIDENCE_UNRESOLVED:
    "Dinner options are ready to review. Some restaurant details are not yet confirmed; a reservation is tracked separately.",
  NO_COMMON_TIME:
    "There is no common available dinner time yet. Ask attendees to review their availability.",
  SERVICE_UNCONFIGURED:
    "The service has no Muse API connection configured. The service owner needs to configure MODEL_API_KEY.",
  USAGE_LIMIT:
    "This dinner reached its daily research limit. Try again tomorrow.",
  UNEXPECTED_ERROR:
    "Research could not finish because of an internal problem. Contact support with the reference below.",
};
export function researchGuidance(code?: ResearchCode): string {
  return code ? guidance[code] : "Research is in progress.";
}
export function researchMessage(attempt: ResearchAttempt): string {
  if (attempt.status === "queued") return "Research is queued.";
  if (attempt.status === "running")
    return "Muse is researching options for the group.";
  if (attempt.status === "succeeded")
    return "Research completed. Review the dinner options.";
  if (attempt.status === "cancelled")
    return "Research stopped because this dinner was cancelled.";
  if (attempt.status === "superseded")
    return "These results belong to an earlier version of the dinner.";
  if (
    attempt.code === "AUTH_INVALID" ||
    attempt.code === "ACCESS_DENIED" ||
    attempt.code === "QUOTA_EXCEEDED" ||
    attempt.code === "SERVICE_UNCONFIGURED"
  )
    return "Research could not run. The service owner needs to check the Muse connection.";
  return researchGuidance(attempt.code);
}
export function researchRetryable(code: ResearchCode): boolean {
  return [
    "RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    "TIMEOUT",
    "NETWORK",
    "INVALID_OUTPUT",
    "INCOMPLETE_OUTPUT",
    "SEARCH_NOT_EXECUTED",
    "NO_SUITABLE_OPTIONS",
    "EVIDENCE_UNRESOLVED",
    "NO_COMMON_TIME",
  ].includes(code);
}
/** Safe error metadata only: never retain provider response text, request bodies or private input. */
export class ResearchFailure extends Error {
  constructor(
    readonly code: ResearchCode,
    readonly stage: ResearchStage,
    readonly metadata: {
      httpStatus?: number;
      providerRequestId?: string;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(researchGuidance(code));
    this.name = "ResearchFailure";
  }
}
export function classifyResearchFailure(
  error: unknown,
  stage: ResearchStage = "provider",
): ResearchFailure {
  if (error instanceof ResearchFailure) return error;
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return new ResearchFailure("INVALID_OUTPUT", "output_validation");
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return new ResearchFailure("TIMEOUT", "provider");
  if (error instanceof TypeError && stage === "provider")
    return new ResearchFailure("NETWORK", "provider");
  return new ResearchFailure("UNEXPECTED_ERROR", "planning");
}
