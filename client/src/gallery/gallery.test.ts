import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entries } from './entries.js';
import { renderGallery, setTheme } from './render.js';

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

afterEach(() => {
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

describe('gallery entries', () => {
  it.each(
    entries.map((entry) => [`${entry.component}: ${entry.state}`, entry]),
  )('%s renders', (_name, entry) => {
    const element = entry.render();
    document.body.append(element);
    expect(element.isConnected).toBe(true);
    expect(
      element.textContent?.trim() || element.childElementCount,
    ).toBeTruthy();
  });

  it('names each state once per component', () => {
    const keys = entries.map((e) => `${e.component}\u0000${e.state}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shows a badge for every state tone', () => {
    for (const entry of entries.filter((e) => e.component === 'State badge')) {
      document.body.append(entry.render());
    }
    const tones = Array.from(
      document.querySelectorAll<HTMLElement>('.state-badge'),
      (badge) => badge.dataset.tone,
    );
    expect(tones.sort()).toEqual([
      'checking',
      'connecting',
      'diskFull',
      'downloading',
      'error',
      'noPeers',
      'paused',
      'seeding',
    ]);
  });

  it('opens the confirm dialog from its button', () => {
    const entry = entries.find((e) => e.component === 'Confirm dialog')!;
    const open = entry.render() as HTMLButtonElement;
    document.body.append(open);
    open.click();
    expect(document.querySelector('dialog')?.open).toBe(true);
  });

  it('shows the files of an expanded row', () => {
    const entry = entries.find((e) => e.state === 'expanded with files')!;
    const element = entry.render();
    expect(
      element.querySelector('.torrent__toggle')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(element.querySelectorAll('.file-list__item').length).toBe(4);
  });
});

describe('renderGallery', () => {
  it('renders a section per component and a figure per entry', () => {
    const app = document.createElement('main');
    document.body.append(app);
    renderGallery(app, entries);

    const components = new Set(entries.map((e) => e.component));
    expect(app.querySelectorAll(':scope > section').length).toBe(
      components.size,
    );
    expect(app.querySelectorAll('section > figure').length).toBe(
      entries.length,
    );
    expect(app.querySelectorAll('nav a').length).toBe(components.size);
    expect(
      app.querySelector('#torrent-row--expanded-with-files'),
    ).not.toBeNull();
  });

  it('forces a theme from the switch and goes back to the OS setting', () => {
    const app = document.createElement('main');
    document.body.append(app);
    renderGallery(app, entries);
    const root = document.documentElement;
    const option = (value: string) =>
      app.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;

    option('dark').click();
    expect(root.dataset.theme).toBe('dark');
    option('light').click();
    expect(root.dataset.theme).toBe('light');
    option('system').click();
    expect(root.dataset.theme).toBeUndefined();
  });

  it('setTheme only sets data-theme for a forced theme', () => {
    const root = document.createElement('html');
    setTheme(root, 'dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    setTheme(root, 'system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});
