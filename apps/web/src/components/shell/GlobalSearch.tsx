"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MAX_INDEXED_METADATA_TEXT_LENGTH,
  normalizeAliasName,
  SEARCH_MIN_QUERY_LENGTH,
  type SearchResponse,
} from "@heimdall/shared";
import { Badge, Input, Spinner } from "@heimdall/ui";

import { icon } from "@/components/icons";
import { loadCatalogSearch, type ApiResult } from "@/lib/api/client";
import styles from "./GlobalSearch.module.css";

const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-4-4" />
  </>,
);

const DEBOUNCE_MS = 250;
const EMPTY_RESULTS: SearchResponse = { games: [], hardware: [] };

export type SearchLoader = (
  query: string,
  signal?: AbortSignal,
) => Promise<ApiResult<SearchResponse>>;

const defaultSearchLoader: SearchLoader = (query, signal) =>
  loadCatalogSearch(query, undefined, signal);

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; results: SearchResponse }
  | { kind: "error" };

export function GlobalSearch({ search = defaultSearchLoader }: { search?: SearchLoader }) {
  const router = useRouter();
  const listboxId = React.useId();
  const [query, setQuery] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [state, setState] = React.useState<SearchState>({ kind: "idle" });
  // Gate on the same normalized form the route/repo use, so the client and
  // server agree on whether a query is long enough to search.
  const normalizedQuery = normalizeAliasName(query);
  const results = state.kind === "ready" ? state.results : EMPTY_RESULTS;
  const open = focused && normalizedQuery.length > 0;

  React.useEffect(() => {
    setActiveIndex(-1);
    if (!focused) return;
    if (normalizedQuery.length < SEARCH_MIN_QUERY_LENGTH) {
      setState((current) => (current.kind === "idle" ? current : { kind: "idle" }));
      return;
    }

    const controller = new AbortController();
    setState({ kind: "loading" });
    const timer = setTimeout(() => {
      void search(normalizedQuery, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.ok) {
            setState({ kind: "ready", results: result.data });
          } else if (result.code !== "aborted") {
            setState({ kind: "error" });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ kind: "error" });
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [focused, normalizedQuery, search]);

  function navigateToActive() {
    const game = results.games[activeIndex];
    if (!game) return;
    setFocused(false);
    router.push(`/games/${encodeURIComponent(game.slug)}`);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setFocused(false);
      setActiveIndex(-1);
      event.currentTarget.blur();
      return;
    }
    if (results.games.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.games.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) =>
        current <= 0 ? results.games.length - 1 : current - 1,
      );
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      navigateToActive();
    }
  }

  return (
    <div className={styles.root}>
      <Input
        aria-label="Search games and hardware"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listboxId}-game-${activeIndex}` : undefined
        }
        autoComplete="off"
        name="catalog-search"
        icon={<SearchIcon size={16} />}
        placeholder="Search games, GPUs…"
        maxLength={MAX_INDEXED_METADATA_TEXT_LENGTH}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        wrapClassName={styles.field}
      />

      {open && (
        <div id={listboxId} className={styles.panel} role="listbox" aria-label="Search results">
          {normalizedQuery.length < SEARCH_MIN_QUERY_LENGTH ? (
            <div className={styles.status}>Keep typing…</div>
          ) : state.kind === "loading" ? (
            <div className={styles.status}>
              <Spinner label="Searching catalog" />
            </div>
          ) : state.kind === "error" ? (
            <div className={styles.status}>Search unavailable — try again.</div>
          ) : state.kind === "ready" &&
            results.games.length === 0 &&
            results.hardware.length === 0 ? (
            <div className={styles.status}>No matches</div>
          ) : (
            <>
              {results.games.length > 0 && (
                <div role="group" aria-label="Games">
                  <span className={styles.groupLabel}>Games</span>
                  {results.games.map((game, index) => (
                    <Link
                      key={game.id}
                      id={`${listboxId}-game-${index}`}
                      className={styles.option}
                      data-active={activeIndex === index ? "" : undefined}
                      role="option"
                      aria-selected={activeIndex === index}
                      href={`/games/${encodeURIComponent(game.slug)}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => setFocused(false)}
                    >
                      <span>{game.name}</span>
                      <Badge tone="brand">Game</Badge>
                    </Link>
                  ))}
                </div>
              )}
              {results.hardware.length > 0 && (
                <div className={styles.hardwareGroup} role="group" aria-label="Hardware">
                  <span className={styles.groupLabel}>Hardware</span>
                  {results.hardware.map((hardware) => (
                    <div key={hardware.id} className={styles.hardwareRow}>
                      <span>{hardware.canonicalName}</span>
                      <Badge tone="neutral">{hardware.kind.toUpperCase()}</Badge>
                    </div>
                  ))}
                  <p className={styles.hardwareNote}>
                    Hardware pages are coming — search a game to see its runs.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
