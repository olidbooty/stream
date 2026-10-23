import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import { sampleSummary } from './sample-data.js';
import { torrentForm } from './torrent-form.js';

function setup() {
  const api = {
    addMagnet: vi.fn().mockResolvedValue(sampleSummary()),
    addTorrentFile: vi.fn().mockResolvedValue(sampleSummary()),
  };
  const onAdded = vi.fn();
  const root = torrentForm({ api, onAdded });
  document.body.append(root);
  const [magnetForm, fileForm] = root.querySelectorAll('form');
  const magnetInput = root.querySelector<HTMLInputElement>(
    'input[name="magnet"]',
  )!;
  const fileInput = root.querySelector<HTMLInputElement>(
    'input[name="torrent"]',
  )!;
  return { api, onAdded, root, magnetForm, fileForm, magnetInput, fileInput };
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

function chooseFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [file],
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('torrentForm', () => {
  it('labels both inputs', () => {
    const { magnetInput, fileInput, root } = setup();
    const label = (input: HTMLInputElement) =>
      root.querySelector(`label[for="${input.id}"]`)?.textContent;
    expect(label(magnetInput)).toBe('Magnet link');
    expect(label(fileInput)).toBe('.torrent file');
    expect(fileInput.accept).toBe('.torrent,application/x-bittorrent');
  });

  it('adds a magnet link and reports it', async () => {
    const { api, onAdded, magnetForm, magnetInput, root } = setup();
    magnetInput.value = '  magnet:?xt=urn:btih:abc  ';
    submit(magnetForm);

    await vi.waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(api.addMagnet).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc');
    expect(magnetInput.value).toBe('');
    expect(root.querySelector('[role="status"]')?.textContent).toBe(
      'Added Sintel',
    );
  });

  it("shows the server's error under the input", async () => {
    const { api, onAdded, magnetForm, magnetInput } = setup();
    api.addMagnet.mockRejectedValue(
      new ApiError(409, 'This torrent has already been added'),
    );
    magnetInput.value = 'magnet:?xt=urn:btih:abc';
    submit(magnetForm);

    const error = magnetForm.querySelector('[role="alert"]')!;
    await vi.waitFor(() =>
      expect(error.textContent).toBe('This torrent has already been added'),
    );
    expect(error.hasAttribute('hidden')).toBe(false);
    expect(magnetInput.getAttribute('aria-invalid')).toBe('true');
    expect(magnetInput.getAttribute('aria-describedby')).toBe(error.id);
    expect(magnetInput.value).toBe('magnet:?xt=urn:btih:abc');
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('asks for a magnet link before sending anything', () => {
    const { api, magnetForm } = setup();
    submit(magnetForm);
    expect(api.addMagnet).not.toHaveBeenCalled();
    expect(magnetForm.querySelector('[role="alert"]')?.textContent).toBe(
      'Paste a magnet link first',
    );
  });

  it('disables the button while the request is in flight', async () => {
    const { api, magnetForm, magnetInput } = setup();
    let finish!: (value: unknown) => void;
    api.addMagnet.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const button = magnetForm.querySelector('button')!;
    magnetInput.value = 'magnet:?xt=urn:btih:abc';
    submit(magnetForm);

    expect(button.disabled).toBe(true);
    finish(sampleSummary());
    await vi.waitFor(() => expect(button.disabled).toBe(false));
  });

  it('uploads the chosen .torrent file', async () => {
    const { api, onAdded, fileForm, fileInput } = setup();
    const file = new File([new Uint8Array([1])], 'sintel.torrent');
    chooseFile(fileInput, file);
    submit(fileForm);

    await vi.waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(api.addTorrentFile).toHaveBeenCalledWith(file);
  });

  it('shows a 413 for a file that is too large', async () => {
    const { api, fileForm, fileInput } = setup();
    api.addTorrentFile.mockRejectedValue(
      new ApiError(413, 'The .torrent file is larger than 10485760 bytes'),
    );
    chooseFile(fileInput, new File([new Uint8Array([1])], 'big.torrent'));
    submit(fileForm);

    await vi.waitFor(() =>
      expect(fileForm.querySelector('[role="alert"]')?.textContent).toBe(
        'The .torrent file is larger than 10485760 bytes',
      ),
    );
  });

  it('asks for a file before sending anything', () => {
    const { api, fileForm } = setup();
    submit(fileForm);
    expect(api.addTorrentFile).not.toHaveBeenCalled();
    expect(fileForm.querySelector('[role="alert"]')?.textContent).toBe(
      'Choose a .torrent file first',
    );
  });
});
