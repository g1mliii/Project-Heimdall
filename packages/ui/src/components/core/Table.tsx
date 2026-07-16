import type * as React from "react";

import { cx } from "../../utils/cx";

export interface TableColumn<Row> {
  /** Stable column identity and controlled-sort key. */
  key: string;
  header: React.ReactNode;
  /** @default "left" */
  align?: "left" | "center" | "right";
  /** Apply the data-mono contract and tabular figures to every body cell. */
  numeric?: boolean;
  /** Render a real header button when controlled sorting is wired. */
  sortable?: boolean;
  /** Token-backed CSS width, e.g. `var(--space-24)`. */
  width?: string;
  cell(row: Row): React.ReactNode;
}

export interface TableSort {
  key: string;
  direction: "asc" | "desc";
}

export interface TableProps<Row> {
  /** Required accessible name; visually hidden inside a native caption. */
  caption: string;
  columns: readonly TableColumn<Row>[];
  /** Already ordered rows. This primitive never reorders a keyset page. */
  rows: readonly Row[];
  rowKey(row: Row): React.Key;
  /** Visual highlight only; consumers must also render a textual cue. */
  rowHighlighted?(row: Row): boolean;
  sort?: TableSort;
  onSortChange?(sort: TableSort): void;
  /** Rendered across all columns when `rows` is empty. */
  empty?: React.ReactNode;
  className?: string;
}

function columnClassName(column: Pick<TableColumn<never>, "align" | "numeric">) {
  return cx(
    `hd-table__cell--${column.align ?? "left"}`,
    column.numeric && "hd-table__cell--numeric",
  );
}

function SortIcon({ direction }: { direction: TableSort["direction"] | null }) {
  return (
    <svg
      className="hd-table__sort-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {direction === "asc" ? (
        <path d="m4.5 9.5 3.5-3 3.5 3" />
      ) : direction === "desc" ? (
        <path d="m4.5 6.5 3.5 3 3.5-3" />
      ) : (
        <>
          <path d="m5 6 3-2.5L11 6" />
          <path d="m5 10 3 2.5 3-2.5" />
        </>
      )}
    </svg>
  );
}

/**
 * Dense, accessible data table. Sorting is controlled by the consumer because
 * reordering only the currently loaded keyset page would misrepresent the full
 * result set.
 */
export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowHighlighted,
  sort,
  onSortChange,
  empty = "No rows to show.",
  className = "",
}: TableProps<Row>) {
  return (
    <div className={cx("hd-table__scroll", className)}>
      <table className="hd-table">
        <caption className="hd-table__caption">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const activeDirection = sort?.key === column.key ? sort.direction : null;
              const canSort = Boolean(column.sortable && onSortChange);
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={columnClassName(column)}
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={
                    activeDirection === "asc"
                      ? "ascending"
                      : activeDirection === "desc"
                        ? "descending"
                        : undefined
                  }
                >
                  {canSort ? (
                    <button
                      type="button"
                      className="hd-table__sort"
                      onClick={() =>
                        onSortChange?.({
                          key: column.key,
                          direction: activeDirection === "asc" ? "desc" : "asc",
                        })
                      }
                    >
                      <span>{column.header}</span>
                      <SortIcon direction={activeDirection} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="hd-table__empty" colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={rowHighlighted?.(row) ? "hd-table__row--highlighted" : undefined}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={columnClassName(column)}
                    {...(column.numeric ? { "data-mono": "" } : {})}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
