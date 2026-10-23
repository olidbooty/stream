import { el } from './dom.js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonOptions {
  label: string;
  variant?: ButtonVariant;
  type?: 'button' | 'submit';
  onClick?: () => void;
}

export function button({
  label,
  variant = 'secondary',
  type = 'button',
  onClick,
}: ButtonOptions): HTMLButtonElement {
  const element = el('button', {
    className: `button button--${variant}`,
    text: label,
    attrs: { type },
  });
  if (onClick) element.addEventListener('click', onClick);
  return element;
}
