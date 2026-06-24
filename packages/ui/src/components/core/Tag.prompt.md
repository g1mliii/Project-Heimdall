Dismissible chip for active filters (GPU, resolution, settings) on the aggregate game page.

```jsx
<Tag onRemove={() => clearFilter('gpu')}>RTX 4070</Tag>
<Tag>DX12</Tag>
```

Omit `onRemove` for a static, non-dismissible chip.
