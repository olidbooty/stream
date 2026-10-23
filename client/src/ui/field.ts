import { el, uniqueId } from './dom.js';

export interface FieldOptions {
  label: string;
  input: HTMLInputElement;
  help?: string;
}

export interface Field {
  element: HTMLElement;
  input: HTMLInputElement;
  // Shows an error under the input, or clears it with null.
  setError(message: string | null): void;
}

export function field({ label, input, help }: FieldOptions): Field {
  input.id ||= uniqueId('field');
  input.classList.add('field__input');
  const helpText = help
    ? el('p', {
        className: 'field__help',
        text: help,
        attrs: { id: uniqueId('help') },
      })
    : null;
  const error = el('p', {
    className: 'field__error',
    attrs: { id: uniqueId('error'), role: 'alert' },
  });
  error.hidden = true;

  const describedBy = () =>
    [helpText?.id, error.hidden ? null : error.id].filter(Boolean).join(' ');
  if (helpText) input.setAttribute('aria-describedby', describedBy());

  const element = el(
    'div',
    { className: 'field' },
    el('label', {
      className: 'field__label',
      text: label,
      attrs: { for: input.id },
    }),
    input,
    ...(helpText ? [helpText] : []),
    error,
  );

  return {
    element,
    input,
    setError(message) {
      error.textContent = message ?? '';
      error.hidden = message === null;
      input.setAttribute('aria-invalid', String(message !== null));
      const ids = describedBy();
      if (ids) input.setAttribute('aria-describedby', ids);
      else input.removeAttribute('aria-describedby');
    },
  };
}
