The signature Heimdall component: an auto-generated optimization warning on the run page.

```jsx
<Diagnostic severity="warn" title="RAM below rated speed">
  Your RAM is running at 4800 MHz instead of its rated 6000 — enable EXPO/XMP in BIOS.
</Diagnostic>
<Diagnostic severity="bad" title="VRAM saturation stutters">
  Frame-time spikes correlate with 100% VRAM use. Lower texture quality.
</Diagnostic>
<Diagnostic severity="good" title="No issues detected">This run looks clean.</Diagnostic>
```

`severity`: `warn` (amber), `bad` (red), `good` (green), `info` (blue). Keep messages plain-English and actionable.
