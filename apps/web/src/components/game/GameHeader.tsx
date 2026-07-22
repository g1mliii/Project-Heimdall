import type { SearchGameResult } from "@heimdall/shared";
import { ReportButton } from "@/components/moderation/ReportButton";

import styles from "./GamePageClient.module.css";

export function GameHeader({ game }: { game: SearchGameResult }) {
  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: "var(--space-4)",
        flexWrap: "wrap",
      }}
    >
      <div>
        <span className="heimdall-overline">Game</span>
        <h1 className={styles.title}>{game.name}</h1>
        <p className={styles.subtitle}>Individual public, validated submissions for this title.</p>
      </div>
      <ReportButton subject={{ type: "game", id: game.id }} />
    </header>
  );
}
