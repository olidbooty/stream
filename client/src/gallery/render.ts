import { el } from '../ui/dom.js';
import type { GalleryEntry } from './entries.js';

export type Theme = 'system' | 'light' | 'dark';

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Decision #30: data-theme on <html> forces a theme; none follows the OS.
export function setTheme(root: HTMLElement, theme: Theme): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

function themeSwitch(root: HTMLElement): HTMLElement {
  const options = THEMES.map(({ value, label }) => {
    const input = el('input', {
      attrs: { type: 'radio', name: 'theme', value },
    });
    input.checked = value === 'system';
    input.addEventListener('change', () => setTheme(root, value));
    return el('label', { className: 'gallery__theme-option' }, input, label);
  });
  return el(
    'fieldset',
    { className: 'gallery__theme' },
    el('legend', { text: 'Theme' }),
    ...options,
  );
}

function groups(entries: GalleryEntry[]): Map<string, GalleryEntry[]> {
  const byComponent = new Map<string, GalleryEntry[]>();
  for (const entry of entries) {
    const group = byComponent.get(entry.component) ?? [];
    group.push(entry);
    byComponent.set(entry.component, group);
  }
  return byComponent;
}

// Every entry in a section per component, in the order given, with a contents
// list and a theme switch. Each state has an id, so it can be linked to.
export function renderGallery(
  app: HTMLElement,
  entries: GalleryEntry[],
  root: HTMLElement = document.documentElement,
): void {
  const byComponent = groups(entries);
  const contents = el('nav', {
    className: 'gallery__contents',
    attrs: { 'aria-label': 'Components' },
  });
  const contentsList = el('ul');
  contents.append(contentsList);

  const sections: HTMLElement[] = [];
  for (const [component, group] of byComponent) {
    const id = slug(component);
    contentsList.append(
      el('li', {}, el('a', { text: component, attrs: { href: `#${id}` } })),
    );
    const section = el(
      'section',
      { className: 'gallery__section', attrs: { id } },
      el('h2', { text: component }),
    );
    for (const entry of group) {
      section.append(
        el(
          'figure',
          {
            className: 'gallery__entry',
            attrs: { id: `${id}--${slug(entry.state)}` },
          },
          el('figcaption', { className: 'gallery__state', text: entry.state }),
          el('div', { className: 'gallery__frame' }, entry.render()),
        ),
      );
    }
    sections.push(section);
  }

  app.append(
    el(
      'header',
      { className: 'gallery__header' },
      el('h1', { text: 'stream components' }),
      el('p', {
        className: 'gallery__intro',
        text: 'Every UI component in each of its states, drawn from sample data. Nothing here talks to a server.',
      }),
      themeSwitch(root),
    ),
    contents,
    ...sections,
  );
}
