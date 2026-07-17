# Table

Config-driven table for dense benchmark data. A required native caption names
the table for assistive technology; numeric columns use the shared mono/tabular
contract automatically.

```tsx
<Table
  caption="Cyberpunk 2077 submissions"
  columns={[
    { key: "gpu", header: "GPU", cell: (row) => row.gpu },
    { key: "avg", header: "Avg", numeric: true, align: "right", cell: (row) => row.avg },
  ]}
  rows={rows}
  rowKey={(row) => row.id}
/>
```

Sorting is controlled: mark a column `sortable`, pass `sort`, and handle
`onSortChange`. The primitive deliberately preserves `rows` verbatim. Sorting
inside the component would reorder only the currently loaded keyset page and
misrepresent the full result set.

`rowHighlighted` is visual only. Always render a text or badge cue in the row so
color is not the only signal. Use design tokens for `width`.
