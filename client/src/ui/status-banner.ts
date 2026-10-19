import { el } from './dom.js';

export interface StatusBanner {
  element: HTMLElement;
  show(message: string): void;
  hide(): void;
}

// The error indicator above the torrent list. role=status, so a change is
// announced without interrupting the user.
export function statusBanner(): StatusBanner {
  const element = el('p', {
    className: 'status-banner',
    attrs: { role: 'status' },
  });
  element.hidden = true;
  return {
    element,
    show(message) {
      element.textContent = message;
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
      element.textContent = '';
    },
  };
}
