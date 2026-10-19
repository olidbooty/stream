import type { TorrentSummary } from '../../server/torrents-api.js';
import type { Api } from './api.js';
import { button } from './ui/button.js';
import { el } from './ui/dom.js';
import { type Field, field } from './ui/field.js';

export interface TorrentFormOptions {
  api: Pick<Api, 'addMagnet' | 'addTorrentFile'>;
  // Called after a torrent is added, e.g. to refresh the list at once.
  onAdded(torrent: TorrentSummary): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

// One add form: an input, a submit button and a confirmation line. The
// server validates the input and its error message is shown as is.
function addForm(
  input: Field,
  submitLabel: string,
  submit: () => Promise<TorrentSummary> | null,
  onAdded: (torrent: TorrentSummary) => void,
): HTMLFormElement {
  const submitButton = button({
    label: submitLabel,
    variant: 'primary',
    type: 'submit',
  });
  const done = el('p', {
    className: 'add-torrent__done',
    attrs: { role: 'status' },
  });
  const form = el(
    'form',
    { className: 'add-torrent__form' },
    el('div', { className: 'add-torrent__row' }, input.element, submitButton),
    done,
  );
  form.noValidate = true;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    done.textContent = '';
    input.setError(null);
    const pending = submit();
    if (!pending) return;
    submitButton.disabled = true;
    try {
      const torrent = await pending;
      form.reset();
      done.textContent = `Added ${torrent.name ?? torrent.infoHash}`;
      onAdded(torrent);
    } catch (err) {
      input.setError(errorMessage(err));
    } finally {
      submitButton.disabled = false;
    }
  });
  return form;
}

export function torrentForm({ api, onAdded }: TorrentFormOptions): HTMLElement {
  const magnet = field({
    label: 'Magnet link',
    input: el('input', {
      attrs: {
        type: 'text',
        name: 'magnet',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'magnet:?xt=urn:btih:…',
      },
    }),
  });
  const file = field({
    label: '.torrent file',
    input: el('input', {
      attrs: {
        type: 'file',
        name: 'torrent',
        accept: '.torrent,application/x-bittorrent',
      },
    }),
    help: 'Up to 10 MB.',
  });

  return el(
    'section',
    { className: 'add-torrent', attrs: { 'aria-labelledby': 'add-heading' } },
    el('h2', { text: 'Add a torrent', attrs: { id: 'add-heading' } }),
    addForm(
      magnet,
      'Add magnet',
      () => {
        const value = magnet.input.value.trim();
        if (!value) {
          magnet.setError('Paste a magnet link first');
          return null;
        }
        return api.addMagnet(value);
      },
      onAdded,
    ),
    addForm(
      file,
      'Upload',
      () => {
        const chosen = file.input.files?.[0];
        if (!chosen) {
          file.setError('Choose a .torrent file first');
          return null;
        }
        return api.addTorrentFile(chosen);
      },
      onAdded,
    ),
  );
}
