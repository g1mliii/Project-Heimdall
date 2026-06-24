Underlined tab bar for run-page sections (Overview / Frame-time / Diagnostics / Hardware).

```jsx
<Tabs value={tab} onChange={setTab}
  tabs={[{value:'overview',label:'Overview'},{value:'frames',label:'Frame-time'},{value:'diag',label:'Diagnostics'}]} />
```

Controlled via `value` + `onChange`. Items can carry an `icon`.
