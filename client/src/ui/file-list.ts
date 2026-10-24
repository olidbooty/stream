import type {
  TorrentDetail,
  TorrentFileInfo,
} from '../../../server/torrents-api.js';
import { formatBytes } from '../format.js';
import { el } from './dom.js';

// Set when only some files download (Decision #18); a torrent that downloads
// everything doesn't need every file marked.
type Download = 'Downloading' | 'Downloaded' | null;

function tags(
  file: TorrentFileInfo,
  isMain: boolean,
  download: Download,
): HTMLElement[] {
  const result: HTMLElement[] = [];
  if (download && file.selected) {
    result.push(
      el('span', {
        className: 'file-list__tag file-list__tag--download',
        text: download,
      }),
    );
  }
  if (isMain) {
    result.push(
      el('span', {
        className: 'file-list__tag file-list__tag--main',
        text: 'Main file',
      }),
    );
  }
  if (file.media === 'video-may-not-play') {
    result.push(
      el('span', {
        className: 'file-list__tag file-list__tag--warning',
        text: 'May not play',
      }),
    );
  } else if (file.media === 'subtitle') {
    result.push(el('span', { className: 'file-list__tag', text: 'Subtitle' }));
  }
  if (file.sample) {
    result.push(el('span', { className: 'file-list__tag', text: 'Sample' }));
  }
  return result;
}

// A torrent's files in torrent order, with the file the player will pick
// marked (3.1's mainFile), the files being downloaded marked when that isn't
// all of them, and videos the browser may refuse flagged.
export function fileList(
  detail: Pick<TorrentDetail, 'files' | 'mainFile' | 'state'>,
): HTMLUListElement {
  const list = el('ul', { className: 'file-list' });
  const files = detail.files ?? [];
  const download: Download = files.every((file) => file.selected)
    ? null
    : detail.state === 'seeding'
      ? 'Downloaded'
      : 'Downloading';
  for (const file of files) {
    list.append(
      el(
        'li',
        {
          className: 'file-list__item',
          attrs: { 'data-index': String(file.index) },
        },
        el('span', { className: 'file-list__path', text: file.path }),
        el('span', {
          className: 'file-list__size',
          text: formatBytes(file.length),
        }),
        ...tags(file, file.index === detail.mainFile, download),
      ),
    );
  }
  return list;
}
