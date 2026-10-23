import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button } from './button.js';
import { confirmDialog } from './confirm-dialog.js';
import { field } from './field.js';
import { progressBar, updateProgressBar } from './progress-bar.js';
import { stateBadge, updateStateBadge } from './state-badge.js';
import { statusBanner } from './status-banner.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('button', () => {
  it('renders a typed button with its variant and click handler', () => {
    const onClick = vi.fn();
    const b = button({ label: 'Remove', variant: 'danger', onClick });
    expect(b.type).toBe('button');
    expect(b.className).toBe('button button--danger');
    b.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('can submit a form', () => {
    expect(button({ label: 'Add', type: 'submit' }).type).toBe('submit');
  });
});

describe('field', () => {
  it('labels the input and wires up help and error text', () => {
    const input = document.createElement('input');
    const f = field({ label: 'Name', input, help: 'Any name' });
    document.body.append(f.element);
    const help = f.element.querySelector('.field__help')!;
    const error = f.element.querySelector('.field__error') as HTMLElement;

    expect(f.element.querySelector('label')?.htmlFor).toBe(input.id);
    expect(input.getAttribute('aria-describedby')).toBe(help.id);
    expect(error.hidden).toBe(true);

    f.setError('Too long');
    expect(error.textContent).toBe('Too long');
    expect(error.hidden).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(
      `${help.id} ${error.id}`,
    );

    f.setError(null);
    expect(error.hidden).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.getAttribute('aria-describedby')).toBe(help.id);
  });
});

describe('stateBadge', () => {
  it('shows the label and tone', () => {
    const badge = stateBadge();
    updateStateBadge(badge, { tone: 'checking', label: 'Checking files' });
    expect(badge.textContent).toBe('Checking files');
    expect(badge.dataset.tone).toBe('checking');
  });
});

describe('progressBar', () => {
  it('is a labelled native progress element', () => {
    const bar = progressBar('Download progress');
    updateProgressBar(bar, 0.255);
    expect(bar.max).toBe(1);
    expect(bar.value).toBe(0.255);
    expect(bar.getAttribute('aria-label')).toBe('Download progress');
    expect(bar.textContent).toBe('25.5%');
  });
});

describe('statusBanner', () => {
  it('starts hidden, shows a message and hides again', () => {
    const banner = statusBanner();
    expect(banner.element.getAttribute('role')).toBe('status');
    expect(banner.element.hidden).toBe(true);

    banner.show('Connection lost');
    expect(banner.element.hidden).toBe(false);
    expect(banner.element.textContent).toBe('Connection lost');

    banner.hide();
    expect(banner.element.hidden).toBe(true);
  });
});

describe('confirmDialog', () => {
  // jsdom has no showModal() or close(); stand in for the browser's.
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  });

  function buttons() {
    const dialog = document.querySelector('dialog')!;
    const [cancel, confirm] = dialog.querySelectorAll('button');
    return { dialog, cancel, confirm };
  }

  it('resolves true when confirmed and removes itself', async () => {
    const result = confirmDialog(document.body, {
      message: 'Remove Sintel?',
      confirmLabel: 'Remove',
    });
    const { dialog, cancel, confirm } = buttons();
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Remove Sintel?');
    expect(document.activeElement).toBe(cancel);
    expect(confirm.textContent).toBe('Remove');

    confirm.click();

    await expect(result).resolves.toBe(true);
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('resolves false on Cancel', async () => {
    const result = confirmDialog(document.body, {
      message: 'Remove?',
      confirmLabel: 'Remove',
    });
    buttons().cancel.click();
    await expect(result).resolves.toBe(false);
  });

  it('resolves false when the dialog is closed another way, e.g. Escape', async () => {
    const result = confirmDialog(document.body, {
      message: 'Remove?',
      confirmLabel: 'Remove',
    });
    buttons().dialog.close();
    await expect(result).resolves.toBe(false);
    expect(document.querySelector('dialog')).toBeNull();
  });
});
