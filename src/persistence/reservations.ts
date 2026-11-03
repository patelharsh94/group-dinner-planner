import type { DinnerTx } from "./store.js";
import type {
  ReservationAttempt,
  ReservationReview,
  ReservationProjection,
} from "../application/reservations.js";
export async function getReservation(
  tx: DinnerTx,
  dinnerId: string,
  currentVersion?: number,
): Promise<ReservationProjection> {
  const a = await tx.client.query(
    "SELECT attempt FROM reservation_attempts WHERE dinner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [dinnerId],
  );
  const r = await tx.client.query(
    "SELECT review FROM reservation_reviews WHERE dinner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [dinnerId],
  );
  const attempt = a.rows[0]?.attempt as ReservationAttempt | undefined,
    review = r.rows[0]?.review as ReservationReview | undefined;
  return {
    attempt,
    review,
    mismatch:
      !!attempt &&
      currentVersion !== undefined &&
      attempt.version !== currentVersion,
  };
}
export async function deleteReservationContactsForUser(
  tx: DinnerTx,
  userId: string,
): Promise<void> {
  await tx.client.query(
    "UPDATE reservation_attempts SET encrypted_contact=NULL,user_id=NULL WHERE user_id=$1",
    [userId],
  );
}
export async function reconcileReservationAttempts(
  tx: DinnerTx,
): Promise<void> {
  await tx.client.query(
    `UPDATE reservation_attempts a SET attempt=a.attempt || jsonb_build_object('status','unknown','message','Booking outcome is unknown. Check directly before booking again.'),encrypted_contact=NULL FROM outbox o WHERE o.id=a.id AND o.kind='reservation' AND o.status IN ('failed','ambiguous','suppressed','sent') AND a.attempt->>'status' IN ('queued','submitting')`,
  );
}
