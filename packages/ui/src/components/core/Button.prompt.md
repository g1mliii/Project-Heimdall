Primary action button — use for any clickable command; one `primary` per view, `secondary`/`ghost` for the rest.

```jsx
<Button variant="primary" iconLeft={<i data-lucide="upload" />}>Upload run</Button>
<Button variant="secondary" size="sm">Cancel</Button>
<Button variant="ghost">Skip</Button>
<Button variant="danger" loading>Deleting…</Button>
```

Variants: `primary` (teal), `secondary` (outlined surface), `ghost` (transparent), `subtle` (teal tint), `danger` (red). Sizes `sm | md | lg`. Pass `block` to fill width, `loading` to show a spinner and disable. Icons go in `iconLeft` / `iconRight` (render Lucide `<i data-lucide>` or inline SVG; call `lucide.createIcons()` after mount).
