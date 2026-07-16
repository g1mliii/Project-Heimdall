import type { SearchGameResult } from "@heimdall/shared";

import styles from "./GamePageClient.module.css";

export function GameHeader({ game }: { game: SearchGameResult }) {
  return (
    <header>
      <span className="heimdall-overline">Game</span>
      <h1 className={styles.title}>{game.name}</h1>
      <p className={styles.subtitle}>Individual public, validated submissions for this title.</p>
    </header>
  );
}
