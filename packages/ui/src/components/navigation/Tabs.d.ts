import React from 'react';

export interface TabItem { value: string; label: React.ReactNode; icon?: React.ReactNode; }

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Tabs as strings or {value,label,icon}. */
  tabs: (string | TabItem)[];
  /** Active tab value. */
  value: string;
  /** Called with the new active value. */
  onChange?: (value: string) => void;
}

/** Underlined tab bar for run-page sections and dashboard views. */
export function Tabs(props: TabsProps): JSX.Element;
