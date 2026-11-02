import type { DinnerSummary } from "../../src/miniapp/contracts";
import { Icon } from "./components";
import { chronological, dinnerName } from "./dinners";
import { dateLabel } from "./time";

export function DinnerList({
  dinners,
  openingId,
  onChoose,
}: {
  dinners: DinnerSummary[];
  openingId?: string;
  onChoose: (id: string) => void;
}) {
  const groups = [
    {
      label: "Organizing",
      dinners: dinners
        .filter((d) => !d.ended && d.role === "organizer")
        .sort(chronological),
    },
    {
      label: "Joining",
      dinners: dinners
        .filter((d) => !d.ended && d.role !== "organizer")
        .sort(chronological),
    },
    {
      label: "Past or cancelled",
      dinners: dinners
        .filter((d) => d.ended)
        .sort((a, b) => chronological(b, a)),
    },
  ];
  return (
    <div className="dinner-groups">
      {groups
        .filter((group) => group.dinners.length)
        .map((group) => (
          <section
            className="dinner-list"
            key={group.label}
            aria-label={group.label}
          >
            <h2>{group.label}</h2>
            {group.dinners.map((item) => (
              <button
                key={item.id}
                className="card dinner-list-item"
                aria-busy={openingId === item.id || undefined}
                onClick={() => onChoose(item.id)}
              >
                <div className="date-tile">
                  <Icon name="calendar" size={22} />
                </div>
                <div>
                  <h3>{dinnerName(item)}</h3>
                  <p>
                    {item.city} · {dateLabel(item.windowStart)}–
                    {dateLabel(item.windowEnd)}
                  </p>
                  <span className="small muted">
                    {openingId === item.id
                      ? "Opening…"
                      : item.status === "cancelled"
                        ? "Cancelled"
                        : item.ended
                          ? "Past dinner"
                          : item.role === "withdrawn"
                            ? "Coordination stopped for you"
                            : item.role === "pending"
                              ? "Waiting for approval"
                              : item.status === "agreed"
                                ? "Agreed plan"
                                : "Planning together"}
                  </span>
                </div>
                <Icon name="chevron" />
              </button>
            ))}
          </section>
        ))}
    </div>
  );
}
