Icon-only button for toolbars, card headers, and dense rows. Always give an `aria-label`.

```jsx
<IconButton aria-label="Share run"><i data-lucide="share-2" /></IconButton>
<IconButton solid aria-label="More"><i data-lucide="ellipsis" /></IconButton>
```

`solid` adds a surface + border (use on busy backgrounds); default is transparent ghost. Sizes `sm | md | lg`.
