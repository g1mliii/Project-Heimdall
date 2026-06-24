Horizontal meter for utilization (GPU load, VRAM) and upload/processing progress.

```jsx
<Meter label="VRAM" value={11.4} max={12} display="11.4 / 12 GB" color="var(--bad)" />
<Meter label="GPU load" value={97} display="97%" />
<Meter value={42} display="Uploading…" />
```

Color the fill with a semantic token when it carries a verdict (red near saturation).
