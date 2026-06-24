Big-number metric tile for run summaries (Avg FPS, 1% low, frame-time percentiles). Value renders in tabular mono.

```jsx
<Stat label="Avg FPS" value="144.7" accent="var(--tier-avg)" />
<Stat label="1% Low" value="98" unit="fps" delta="+14%" deltaDir="up" accent="var(--tier-p1)" />
<Stat label="p99 frame-time" value="14.1" unit="ms" delta="-3%" deltaDir="down" />
```

`accent` paints a top bar — use `--tier-avg/--tier-p1/--tier-p01` for smoothness tiles. `deltaDir` controls arrow + color (`up`=good green, `down`=bad red); flip it for "lower is better" metrics.
