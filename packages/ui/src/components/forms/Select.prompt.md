Styled native dropdown for filters (GPU, CPU, resolution, settings preset).

```jsx
<Select label="Resolution" options={['1080p', '1440p', '2160p']} />
<Select label="GPU" options={[{value:'4070',label:'RTX 4070'}]} />
```

Pass `options` as strings or `{value,label}`, or supply `<option>` children directly.
