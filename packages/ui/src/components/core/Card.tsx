import type * as React from "react";
import { cx } from "../../utils/cx";

/**
 * Props for the surface container.
 *
 * @startingPoint section="Core" subtitle="Surface container with header/body" viewport="700x240"
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `inset` = recessed well (charts), `flat` = no shadow. Default raised. */
  variant?: "inset" | "flat";
  /** Adds hover lift + pointer for clickable cards. */
  interactive?: boolean;
}

export interface CardHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Convenience title rendered with the standard card-title style. */
  title?: React.ReactNode;
  /** Right-aligned actions (icon buttons, badges). */
  actions?: React.ReactNode;
}

/** Surface container. Compose with Card.Header / Card.Body or pass children directly. */
export function Card({ variant, interactive = false, className = "", children, ...rest }: CardProps) {
  const cls = cx("hd-card", variant && `hd-card--${variant}`, interactive && "hd-card--interactive", className);
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}

Card.Header = function CardHeader({ title, actions, className = "", children, ...rest }: CardHeaderProps) {
  return (
    <div className={cx("hd-card__head", className)} {...rest}>
      {title ? <span className="hd-card__title">{title}</span> : children}
      {actions}
    </div>
  );
};

Card.Body = function CardBody({ className = "", children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("hd-card__body", className)} {...rest}>
      {children}
    </div>
  );
};
