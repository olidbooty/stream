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

export interface LinkButtonOptions {
  label: string;
  href: string;
  variant?: ButtonVariant;
}

// A link that looks like a button, for actions that are navigation, such as
// opening the player. Being a link, it can be opened in a new tab or copied.
export function linkButton({
  label,
  href,
  variant = 'secondary',
}: LinkButtonOptions): HTMLAnchorElement {
  return el('a', {
    className: `button button--${variant}`,
    text: label,
    attrs: { href },
  });
}
