Binary toggle for settings and the "Verified vs All submissions" aggregate filter.

```jsx
<Switch checked={verifiedOnly} onChange={e => setVerifiedOnly(e.target.checked)} label="Verified only" />
```

Controlled — pass `checked` + `onChange`.
