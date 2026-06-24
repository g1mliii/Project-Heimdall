Text field with label + hint/error + optional leading icon. Used for search, run titles, game names.

```jsx
<Input label="Run title" placeholder="e.g. Cyberpunk — Ultra, RT on" />
<Input icon={<i data-lucide="search" />} placeholder="Search games…" />
<Input label="Management token" mono error="That token doesn't match this run." />
```

`mono` switches to tabular monospace (IDs/tokens). `error` overrides `hint` and applies the red error border.
