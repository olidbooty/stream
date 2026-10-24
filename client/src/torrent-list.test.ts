import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TorrentSummary } from '../../server/torrents-api.js';
import { ApiError } from './api.js';
import { sampleDetail, sampleSummary } from './sample-data.js';
import { torrentList } from './torrent-list.js';

const OTHER = 'ffffffffffffffffffffffffffffffffffffffff';

function setup() {
  const api = {
    getTorrent: vi.fn().mockResolvedValue(sampleDetail()),
    removeTorrent: vi.fn().mockResolvedValue(undefined),
    addMagnet: vi.fn().mockResolvedValue(sampleSummary()),
  };
  const confirm = vi.fn().mockResolvedValue(true);
  const onChanged = vi.fn();
  const list = torrentList({ api, confirm, onChanged });
  document.body.append(list.element);
  return { api, confirm, onChanged, list };
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.torrent')];
}

function row(index = 0) {
  const element = rows()[index];
  const button = (label: string) =>
    [...element.querySelectorAll('button')].find(
      (b) => b.textContent === label,
    )!;
  return {
    element,
    toggle: element.querySelector<HTMLButtonElement>('.torrent__toggle')!,
    files: element.querySelector<HTMLElement>('.torrent__files')!,
    badge: element.querySelector('.state-badge')!,
    button,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('torrentList', () => {
  it('shows a hint while there are no torrents', () => {
    const { list } = setup();
    list.update([]);
    expect(
      document.querySelector('.torrent-list__empty')?.hasAttribute('hidden'),
    ).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('shows each torrent with its state, progress and stats', () => {
    const { list } = setup();
    list.update([sampleSummary()]);

    const { element, badge } = row();
    expect(element.querySelector('.torrent__name')?.textContent).toBe('Sintel');
    expect(badge.textContent).toBe('Downloading');
    expect(badge.getAttribute('data-tone')).toBe('downloading');
    expect(element.querySelector('progress')?.value).toBe(0.42);
    expect(element.querySelector('.torrent__stats')?.textContent).toBe(
      '129 MB of 231 MB selected · 7 peers · ↓ 1.3 MB/s · ↑ 64 kB/s',
    );
    expect(
      document.querySelector('.torrent-list__empty')?.hasAttribute('hidden'),
    ).toBe(true);
  });

  it('shows one size when every file downloads', () => {
    const { list } = setup();
    list.update([sampleSummary({ length: 1000, selectedLength: 1000 })]);

    expect(row().element.querySelector('.torrent__stats')?.textContent).toBe(
      '1.0 kB · 7 peers · ↓ 1.3 MB/s · ↑ 64 kB/s',
    );
  });

  it('shows the info hash and unknown size while metadata is pending', () => {
    const { list } = setup();
    list.update([
      sampleSummary({
        name: null,
        hasMetadata: false,
        ready: false,
        length: null,
        numPeers: 1,
        state: 'connecting',
      }),
    ]);
    const { element } = row();
    expect(element.querySelector('.torrent__name')?.textContent).toBe(
      sampleSummary().infoHash,
    );
    expect(element.querySelector('.torrent__stats')?.textContent).toMatch(
      /^Size not known yet · 1 peer ·/,
    );
  });

  it('updates rows in place and keeps their order', () => {
    const { list } = setup();
    const second = sampleSummary({ infoHash: OTHER, name: 'Other' });
    list.update([sampleSummary(), second]);
    const [first] = rows();
    first.querySelector('button')?.focus();

    list.update([sampleSummary({ progress: 0.5, state: 'seeding' }), second]);

    expect(rows()[0]).toBe(first);
    expect(document.activeElement).toBe(first.querySelector('button'));
    expect(row().badge.textContent).toBe('Seeding');
  });

  it('removes rows that leave the list', () => {
    const { list } = setup();
    list.update([sampleSummary(), sampleSummary({ infoHash: OTHER })]);
    list.update([sampleSummary({ infoHash: OTHER })]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].dataset.infoHash).toBe(OTHER);
  });

  it('follows the order the server sends', () => {
    const { list } = setup();
    list.update([sampleSummary(), sampleSummary({ infoHash: OTHER })]);
    list.update([sampleSummary({ infoHash: OTHER }), sampleSummary()]);
    expect(rows().map((r) => r.dataset.infoHash)).toEqual([
      OTHER,
      sampleSummary().infoHash,
    ]);
  });

  describe('expanding a row', () => {
    it('loads and shows the files once', async () => {
      const { api, list } = setup();
      list.update([sampleSummary()]);
      const { toggle, files } = row();
      expect(files.hidden).toBe(true);
      expect(toggle.getAttribute('aria-controls')).toBe(files.id);

      toggle.click();

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(files.hidden).toBe(false);
      await vi.waitFor(() =>
        expect(files.querySelectorAll('.file-list__item')).toHaveLength(4),
      );
      expect(api.getTorrent).toHaveBeenCalledWith(sampleSummary().infoHash);
      const main = files.querySelector('[data-index="1"]')!;
      expect(main.textContent).toContain('Main file');
      expect(files.querySelector('[data-index="2"]')?.textContent).toContain(
        'May not play',
      );
      expect(files.querySelector('[data-index="3"]')?.textContent).toContain(
        'Sample',
      );
      const downloading = [...files.querySelectorAll('.file-list__item')]
        .filter((item) => item.textContent?.includes('Downloading'))
        .map((item) => item.getAttribute('data-index'));
      expect(downloading).toEqual(['0', '1']);

      list.update([sampleSummary({ progress: 0.6 })]);
      expect(api.getTorrent).toHaveBeenCalledTimes(1);
    });

    it('reloads the files once the selection has downloaded', async () => {
      const { api, list } = setup();
      list.update([sampleSummary()]);
      const { toggle, files } = row();
      toggle.click();
      await vi.waitFor(() =>
        expect(files.textContent).toContain('Downloading'),
      );

      api.getTorrent.mockResolvedValueOnce(
        sampleDetail({ state: 'seeding', progress: 1 }),
      );
      list.update([sampleSummary({ state: 'seeding', progress: 1 })]);

      await vi.waitFor(() => expect(files.textContent).toContain('Downloaded'));
      expect(files.textContent).not.toContain('Downloading');
      list.update([sampleSummary({ state: 'seeding', progress: 1 })]);
      expect(api.getTorrent).toHaveBeenCalledTimes(2);
    });

    it("doesn't fetch anything for a collapsed row", () => {
      const { api, list } = setup();
      list.update([sampleSummary()]);
      list.update([sampleSummary({ progress: 0.9 })]);
      expect(api.getTorrent).not.toHaveBeenCalled();
    });

    it('waits for pending metadata, then loads the files', async () => {
      const { api, list } = setup();
      const pending: Partial<TorrentSummary> = {
        name: null,
        hasMetadata: false,
        ready: false,
        length: null,
        state: 'connecting',
      };
      api.getTorrent.mockResolvedValueOnce(
        sampleDetail({ ...pending, files: null, mainFile: null, videos: null }),
      );
      list.update([sampleSummary(pending)]);
      const { toggle, files } = row();
      toggle.click();
      await vi.waitFor(() =>
        expect(files.textContent).toBe(
          'File list not known yet: it is still coming from peers.',
        ),
      );

      list.update([sampleSummary({ ...pending, numPeers: 2 })]);
      expect(api.getTorrent).toHaveBeenCalledTimes(1);

      list.update([sampleSummary()]);
      await vi.waitFor(() =>
        expect(files.querySelectorAll('.file-list__item')).toHaveLength(4),
      );
      expect(api.getTorrent).toHaveBeenCalledTimes(2);
    });

    it('says why the files could not be loaded', async () => {
      const { api, list } = setup();
      api.getTorrent.mockRejectedValue(
        new ApiError(404, 'No torrent with that info hash'),
      );
      list.update([sampleSummary()]);
      const { toggle, files } = row();
      toggle.click();
      await vi.waitFor(() =>
        expect(files.textContent).toBe(
          "Couldn't load the files: No torrent with that info hash",
        ),
      );
    });

    it('collapses again', () => {
      const { list } = setup();
      list.update([sampleSummary()]);
      const { toggle, files } = row();
      toggle.click();
      toggle.click();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(files.hidden).toBe(true);
    });
  });

  describe('Remove', () => {
    it('asks first, then removes and refreshes', async () => {
      const { api, confirm, onChanged, list } = setup();
      list.update([sampleSummary()]);
      row().button('Remove').click();

      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(confirm).toHaveBeenCalledWith(
        'Remove Sintel? Its downloaded files will be deleted.',
      );
      expect(api.removeTorrent).toHaveBeenCalledWith(sampleSummary().infoHash);
    });

    it('does nothing when cancelled', async () => {
      const { api, confirm, list } = setup();
      confirm.mockResolvedValue(false);
      list.update([sampleSummary()]);
      row().button('Remove').click();

      await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
      await Promise.resolve();
      expect(api.removeTorrent).not.toHaveBeenCalled();
    });

    it('shows an error if the remove fails', async () => {
      const { api, list } = setup();
      api.removeTorrent.mockRejectedValue(new ApiError(500, 'Internal error'));
      list.update([sampleSummary()]);
      row().button('Remove').click();

      const alert = row().element.querySelector('[role="alert"]')!;
      await vi.waitFor(() =>
        expect(alert.textContent).toBe("Couldn't remove it: Internal error"),
      );
    });
  });

  describe('a failed torrent', () => {
    const failed = sampleSummary({
      state: 'error',
      errorMessage: 'Invalid torrent metadata',
      numPeers: 0,
      progress: 0,
    });

    it('shows why it failed and offers Retry', () => {
      const { list } = setup();
      list.update([failed]);
      const { element, badge, button } = row();
      expect(badge.textContent).toBe('Failed');
      expect(element.querySelector('.torrent__error')?.textContent).toBe(
        'Invalid torrent metadata',
      );
      expect(button('Retry').hidden).toBe(false);
    });

    it('hides Retry for a healthy torrent', () => {
      const { list } = setup();
      list.update([sampleSummary()]);
      expect(row().button('Retry').hidden).toBe(true);
    });

    it('retries by adding its magnet link again', async () => {
      const { api, onChanged, list } = setup();
      list.update([failed]);
      row().button('Retry').click();

      await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(api.addMagnet).toHaveBeenCalledWith(failed.magnetURI);
    });

    it('says it has no files when expanded', async () => {
      const { api, list } = setup();
      api.getTorrent.mockResolvedValue(
        sampleDetail({ ...failed, files: null, mainFile: null, videos: null }),
      );
      list.update([failed]);
      const { toggle, files } = row();
      toggle.click();
      await vi.waitFor(() =>
        expect(files.textContent).toBe(
          'This torrent failed, so it has no files.',
        ),
      );
    });
  });

  it('marks the list stale', () => {
    const { list } = setup();
    list.setStale(true);
    expect(list.element.dataset.stale).toBe('true');
    list.setStale(false);
    expect(list.element.dataset.stale).toBe('false');
  });
});
