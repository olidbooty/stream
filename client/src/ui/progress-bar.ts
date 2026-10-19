import { formatPercent } from '../format.js';
import { el } from './dom.js';

// A native <progress>, so screen readers announce it without extra ARIA.
export function progressBar(label: string): HTMLProgressElement {
  return el('progress', {
    className: 'progress',
    attrs: { max: '1', value: '0', 'aria-label': label },
  });
}

export function updateProgressBar(
  bar: HTMLProgressElement,
  fraction: number,
): void {
  bar.value = fraction;
  bar.textContent = formatPercent(fraction);
}
