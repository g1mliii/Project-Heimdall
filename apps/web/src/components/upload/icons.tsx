import type * as React from "react";

/**
 * Inline Lucide glyphs for the upload flow — stroked, currentColor, matching
 * the design system's icon rules (readme: primitives inline the few svgs they
 * need so screens ship without an icon runtime).
 */

interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  size?: number;
}

function icon(children: React.ReactNode) {
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

export const UploadCloudIcon = icon(
  <g>
    <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
    <path d="M12 12v9" />
    <path d="m16 16-4-4-4 4" />
  </g>,
);

export const FolderUpIcon = icon(
  <g>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M12 10v6" />
    <path d="m9 13 3-3 3 3" />
  </g>,
);

export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />);

export const XIcon = icon(
  <g>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </g>,
);

export const ClockIcon = icon(
  <g>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </g>,
);

export const CopyIcon = icon(
  <g>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </g>,
);

export const ArrowRightIcon = icon(
  <g>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </g>,
);
