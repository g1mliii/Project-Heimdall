import type * as React from "react";

/**
 * Shared inline-SVG icon factory (design-system readme: primitives inline the
 * few glyphs they need so screens ship without an icon runtime). Feature icon
 * sets (run/, upload/) build their glyphs from this one `icon()` so the stroked
 * <svg> boilerplate — and shared glyphs like CheckIcon — live in one place.
 */

export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

export function icon(children: React.ReactNode) {
  return function LucideIcon({ size = 18, ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        {children}
      </svg>
    );
  };
}

/** Used by both the run report and the upload flow. */
export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />);
