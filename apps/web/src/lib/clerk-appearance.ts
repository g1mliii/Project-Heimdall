/**
 * Clerk `appearance.variables` themed to the `@heimdall/ui` dark
 * instrument-panel tokens (§20.1a). `@clerk/nextjs` does not ship a dark
 * base theme at this entrypoint (`@clerk/ui/themes` exports one, but pulling
 * in that whole package for one preset isn't worth a new pinned dependency),
 * so every color/radius/font is overridden directly instead.
 *
 * Variable names are this Clerk major version's ("Core 3") API — `colorInput`
 * / `colorInputForeground` / `colorForeground` / `colorMutedForeground`, not
 * the older `colorInputBackground` / `colorInputText` / `colorText` /
 * `colorTextSecondary` names from earlier Clerk versions. Verified by
 * rendering the sign-in modal; a version bump that renames these again will
 * silently fall back to Clerk's light-theme defaults, not error.
 *
 * `var(--token)` resolves at render time, so this stays correct if the token
 * values in `packages/ui/src/tokens/colors.css` ever change.
 */
// No explicit `Appearance`/`Theme` type import: @clerk/nextjs does not
// re-export one from its top-level entrypoint, and pulling in the separate
// `@clerk/types` package for one type isn't worth a new pinned dependency.
// `<ClerkProvider appearance={clerkAppearance}>` structurally checks this
// object instead.
export const clerkAppearance = {
  variables: {
    colorPrimary: "var(--brand-teal)",
    colorPrimaryForeground: "var(--fg-on-accent)",
    colorBackground: "var(--bg-card)",
    colorForeground: "var(--fg-1)",
    colorMuted: "var(--bg-raised)",
    colorMutedForeground: "var(--fg-2)",
    colorInput: "var(--bg-inset)",
    colorInputForeground: "var(--fg-1)",
    colorDanger: "var(--bad)",
    colorSuccess: "var(--good)",
    colorWarning: "var(--warn)",
    colorNeutral: "var(--fg-2)",
    colorBorder: "var(--line-1)",
    colorRing: "var(--brand-teal-ring)",
    borderRadius: "var(--radius-md)",
    fontFamily: "var(--font-sans)",
    fontFamilyButtons: "var(--font-sans)",
    fontFamilyMono: "var(--font-mono)",
  },
  elements: {
    card: { boxShadow: "none", border: "var(--border-thin) solid var(--line-1)" },
    footerActionLink: { color: "var(--brand-teal)" },
    // The generic status badge ("Primary" email, "This device" session) reads
    // near-black-on-dark by default — none of the `variables` above reach it.
    // Matches `.hd-badge--neutral` in packages/ui/src/components/components.css.
    badge: {
      color: "var(--fg-3)",
      backgroundColor: "transparent",
      borderColor: "var(--line-2)",
    },
  },
};
