import type { RestaurantBrief } from "../../src/domain/index";
const categoryLabel = { complete: "Sourced", partial: "Some details need checking", unknown: "Not found yet", conflicting: "Sources disagree" };
const assessmentLabel = { explicit: "Listed explicitly", promising: "Promising options", unsuitable: "Appears unsuitable", unknown: "Not confirmed" };
/** Display-only research. This component does not decide feasibility or authorize booking. */
export function RestaurantDetails({ brief }: { brief: RestaurantBrief }) {
  return <section className="restaurant-details" aria-label="Restaurant details">
    <dl>
      <div><dt>Address</dt><dd>{brief.address.text ?? "Not confirmed yet"} <small>{categoryLabel[brief.address.status]}</small></dd></div>
      <div><dt>Hours</dt><dd>{brief.hours.postedHours.length ? <p>{brief.hours.postedHours.map((item) => `${item.day}: ${item.hours}`).join(" · ")}</p> : <p>Not found yet</p>}<small>{categoryLabel[brief.hours.status]}</small>{brief.hours.dateSpecificUncertainty && <p>{brief.hours.dateSpecificUncertainty}</p>}</dd></div>
      <div><dt>Booking</dt><dd>{brief.booking.destinationUrl ? <a href={brief.booking.destinationUrl} target="_blank" rel="noopener noreferrer">Reservation page</a> : "Not found yet"}{brief.booking.phone && <p>{brief.booking.phone}</p>} <small>{categoryLabel[brief.booking.status]}</small></dd></div>
      <div><dt>Dietary</dt><dd>{brief.dietary.assessments.length ? brief.dietary.assessments.map((item, i) => <div key={i}><p><strong>{item.requirement}</strong> · {assessmentLabel[item.assessment]}{item.dishes.length > 0 && `: ${item.dishes.join(", ")}`}</p>{item.caveats.map((caveat, j) => <p key={j}>{caveat}</p>)}</div>) : <p>Not confirmed yet</p>}<small>{categoryLabel[brief.dietary.status]}</small></dd></div>
    </dl>
    <p className="field-hint">Posted hours don't confirm your date, links don't book a table, and firm needs still need staff confirmation.</p>
    {brief.sourcedSummary && <details className="source-details"><summary>What the sources say</summary><p>{brief.sourcedSummary.text}</p></details>}
    {brief.sources.length > 0 && <details className="source-details"><summary>Sources</summary><ul>{brief.sources.map((source, i) => <li key={i}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a> · Retrieved {source.retrievedAt.slice(0, 10)}</li>)}</ul></details>}
  </section>;
}
