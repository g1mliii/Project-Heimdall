Compact segmented toggle for 2–4 exclusive view modes (chart type, percentile window, units).

```jsx
<Segmented value={mode} onChange={setMode}
  options={[{value:'ms',label:'ms'},{value:'fps',label:'FPS'}]} />
```

Controlled via `value` + `onChange`. Options can carry an `icon`. For many/long options use `Select` instead.
