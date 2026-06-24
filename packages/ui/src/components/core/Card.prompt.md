Raised surface for grouping content — run panels, hardware snapshot, settings blocks.

```jsx
<Card>
  <Card.Header title="Hardware snapshot" actions={<IconButton aria-label="Copy"><i data-lucide="copy" /></IconButton>} />
  <Card.Body>…</Card.Body>
</Card>

<Card variant="inset"><Card.Body>{/* chart well */}</Card.Body></Card>
```

`variant="inset"` for recessed chart wells, `variant="flat"` to drop the shadow, `interactive` for clickable cards (hover lift).
