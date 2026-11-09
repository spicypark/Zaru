import type { Announcement } from "./useSeeSession";

const PRIORITY_LABEL: Record<string, string> = {
  hazard: "Hazard",
  people: "People",
  text: "Text",
  scene: "Scene",
};

const SOURCE_LABEL: Record<Announcement["source"], string> = {
  auto: "Noticed automatically",
  describe: "You asked: describe",
  ask: "You asked",
  approach: "Approaching",
};

/**
 * Visual record of the latest thing Zaru said, with the exact camera frame it was based on, so
 * sighted companions (and judges) can see what the model was looking at. Hidden from screen
 * readers: Zaru already spoke it.
 */
export function AnnouncementCard({ entry }: { entry: Announcement }) {
  const priority = entry.source === "approach" ? "approach" : entry.priority;
  return (
    <div className={`see-card priority-${priority}`} aria-hidden="true">
      <img className="see-card-frame" src={entry.image} alt="" />
      <div className="see-card-body">
        <div className="see-card-meta">
          <span className="see-card-badge">
            {entry.source === "approach" ? "Approaching" : (PRIORITY_LABEL[entry.priority] ?? "Info")}
          </span>
          <span>
            {entry.source === "ask" && entry.question
              ? `You asked: “${entry.question}”`
              : SOURCE_LABEL[entry.source]}
          </span>
          <span className="see-card-time">
            {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}
          </span>
        </div>
        <p className="see-card-text">{entry.text}</p>
      </div>
    </div>
  );
}
