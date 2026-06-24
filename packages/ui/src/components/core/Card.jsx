import React from 'react';

/** Surface container. Compose with Card.Header / Card.Body or pass children directly. */
export function Card({ variant, interactive = false, className = '', children, ...rest }) {
  const cls = [
    'hd-card',
    variant ? `hd-card--${variant}` : '',
    interactive ? 'hd-card--interactive' : '',
    className,
  ].filter(Boolean).join(' ');
  return <div className={cls} {...rest}>{children}</div>;
}

Card.Header = function CardHeader({ title, actions, className = '', children, ...rest }) {
  return (
    <div className={['hd-card__head', className].filter(Boolean).join(' ')} {...rest}>
      {title ? <span className="hd-card__title">{title}</span> : children}
      {actions}
    </div>
  );
};

Card.Body = function CardBody({ className = '', children, ...rest }) {
  return <div className={['hd-card__body', className].filter(Boolean).join(' ')} {...rest}>{children}</div>;
};
