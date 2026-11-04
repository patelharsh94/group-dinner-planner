import type { DinnerView } from '../../src/miniapp/contracts';
/** Opening a restaurant's published link is independent of group agreement or automated booking authorization. */
export function BookingActions({option, prominent = false}: {option:DinnerView['options'][number]; prominent?:boolean}) {
  const direct = option.bookingLink;
  const url = direct?.url ?? option.officialWebsiteUrl ?? option.directory?.websiteUrl ?? option.directory?.profileUrl;
  const phone = option.reservationPhone ?? option.directory?.phone;
  if (!url && !phone) return null;
  return <div className="plan-actions" aria-label={`Booking links for ${option.venueName ?? 'restaurant'}`}>
    {url && <a className={`button button-${prominent ? 'primary' : 'secondary'} full`} href={url} target="_blank" rel="noopener noreferrer">{direct ? `Reserve${direct.provider ? ` · ${direct.provider}` : ''}` : option.officialWebsiteUrl || option.directory?.websiteUrl ? 'Visit website' : 'View listing'}</a>}
    {phone && /^\+?[\d ()-]{5,40}$/.test(phone) && <a className="button button-secondary full" href={`tel:${phone.replace(/[^+\d]/g,'')}`}>Call restaurant</a>}
    {!direct && option.bookingResearch?.code === "timeout" && <p className="field-hint">The booking link check timed out. You can still contact the restaurant.</p>}
    {!direct && option.bookingResearch?.outcome === "unavailable" && option.bookingResearch.code !== "timeout" && <p className="field-hint">A direct booking link could not be confirmed. Use the restaurant contact options.</p>}
    {direct && <p className="field-hint">Availability and booking terms are confirmed on the restaurant’s booking site. Opening a link does not reserve a table.</p>}
  </div>;
}
