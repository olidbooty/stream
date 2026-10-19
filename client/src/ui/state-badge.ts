import type { StateLabel } from '../format.js';
import { el } from './dom.js';

export function stateBadge(): HTMLSpanElement {
  return el('span', { className: 'state-badge' });
}

export function updateStateBadge(
  badge: HTMLElement,
  { tone, label }: StateLabel,
): void {
  badge.dataset.tone = tone;
  badge.textContent = label;
}
