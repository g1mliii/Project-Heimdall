import type * as React from "react";
import { cx } from "../../utils/cx";

export interface NavTabItem {
  href: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface NavTabsProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  /** Destinations rendered as real links, preserving browser navigation affordances. */
  tabs: readonly NavTabItem[];
  /** The href that represents the current page. */
  currentHref?: string;
  /** Framework link component, for example Next.js `Link`. */
  as?: React.ElementType;
}

/**
 * Underlined navigation links styled like tabs. Unlike `Tabs`, these are
 * document navigation rather than an in-place tab panel switch.
 */
export function NavTabs({
  tabs,
  currentHref,
  as: LinkComponent = "a",
  className = "",
  ...rest
}: NavTabsProps) {
  return (
    <nav className={cx("hd-tabs", className)} {...rest}>
      {tabs.map(({ href, label, icon }) => {
        const active = href === currentHref;
        return (
          <LinkComponent
            key={href}
            href={href}
            className={`hd-tab${active ? " hd-tab--active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {icon}
            {label}
          </LinkComponent>
        );
      })}
    </nav>
  );
}
