import { button } from './button.js';
import { el } from './dom.js';

export interface ConfirmOptions {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
}

// A styled replacement for window.confirm() on a native <dialog>. Resolves
// true when confirmed; Escape, Cancel and closing the dialog resolve false.
export function confirmDialog(
  parent: HTMLElement,
  { message, confirmLabel, cancelLabel = 'Cancel' }: ConfirmOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    const cancel = button({ label: cancelLabel, onClick: () => close() });
    const confirm = button({
      label: confirmLabel,
      variant: 'danger',
      onClick: () => {
        confirmed = true;
        close();
      },
    });
    const dialog = el(
      'dialog',
      { className: 'confirm-dialog' },
      el('p', { className: 'confirm-dialog__message', text: message }),
      el('div', { className: 'confirm-dialog__actions' }, cancel, confirm),
    );

    function close(): void {
      dialog.removeEventListener('close', close);
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(confirmed);
    }

    dialog.addEventListener('close', close);
    parent.append(dialog);
    dialog.showModal();
    // The safe choice has focus, so Enter doesn't delete anything.
    cancel.focus();
  });
}
