import React from 'react';

/**
 * Props for the surface container.
 *
 * @startingPoint section="Core" subtitle="Surface container with header/body" viewport="700x240"
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `inset` = recessed well (charts), `flat` = no shadow. Default raised. */
  variant?: 'inset' | 'flat';
  /** Adds hover lift + pointer for clickable cards. */
  interactive?: boolean;
}

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Convenience title rendered with the standard card-title style. */
  title?: React.ReactNode;
  /** Right-aligned actions (icon buttons, badges). */
  actions?: React.ReactNode;
}

/**
 * Raised surface container. Use `Card.Header` and `Card.Body` for structure.
 */
export function Card(props: CardProps): JSX.Element;
export namespace Card {
  function Header(props: CardHeaderProps): JSX.Element;
  function Body(props: React.HTMLAttributes<HTMLDivElement>): JSX.Element;
}
