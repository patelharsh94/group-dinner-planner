import type { RestaurantBrief } from "../../src/domain/index";
const categoryLabel = { complete: "Sourced", partial: "Some details need checking", unknown: "Not found yet", conflicting: "Sources disagree" };
const assessmentLabel = { explicit: "Listed explicitly", promising: "Promising options", unsuitable: "Appears unsuitable", unknown: "Not confirmed" };
/** Display-only research. This component does not decide feasibility or authorize booking. */
export function RestaurantDetails({ brief }: { brief: RestaurantBrief }) {
  return <section className="restaurant-details" aria-label="Restaurant details">
    <dl>
      <div><dt>Address</dt><dd>{brief.address.text ?? "Address not confirmed"} <small>{categoryLabel[brief.address.status]}</small></dd></div>
      <div><dt>Posted hours</dt><dd>{brief.hours.postedHours.length ? brief.hours.postedHours.map((item, i) => <p key={i}>{item.day}: {item.hours}</p>) : <p>Posted hours not found yet</p>}<small>{categoryLabel[brief.hours.status]}</small>{brief.hours.dateSpecificUncertainty && <p>{brief.hours.dateSpecificUncertainty}</p>}<p className="field-hint">Posted hours do not confirm availability for your dinner date.</p></dd></div>
      <div><dt>Reservations</dt><dd>{brief.booking.destinationUrl ? <a href={brief.booking.destinationUrl} target="_blank" rel="noopener noreferrer">Published reservation page</a> : "Reservation destination not found yet"}{brief.booking.phone && <p>Phone: {brief.booking.phone}</p>} <small>{categoryLabel[brief.booking.status]}</small><p className="field-hint">Check availability and terms with the restaurant. Opening a page does not book a table.</p></dd></div>
      <div><dt>Dietary options</dt><dd>{brief.dietary.assessments.length ? brief.dietary.assessments.map((item, i) => <div key={i}><p><strong>{item.requirement}</strong>: {assessmentLabel[item.assessment]}</p>{item.dishes.length > 0 && <p>{item.dishes.join(", ")}</p>}{item.caveats.map((caveat, j) => <p key={j}>{caveat}</p>)}</div>) : <p>Menu suitability not confirmed yet</p>}<small>{categoryLabel[brief.dietary.status]}</small><p className="field-hint">Firm dietary needs and allergies still need their separate checks and restaurant staff confirmation.</p></dd></div>
    </dl>
    {brief.sourcedSummary && <div className="field-hint"><strong>Informational source summary</strong><p>{brief.sourcedSummary.text}</p></div>}
    {brief.sources.length > 0 && <details className="source-details"><summary>Restaurant research sources</summary><ul>{brief.sources.map((source, i) => <li key={i}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a> · Retrieved {source.retrievedAt.slice(0, 10)}</li>)}</ul></details>}
  </section>;
}
