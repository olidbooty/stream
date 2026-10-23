import type {
  TorrentDetail,
  TorrentFileInfo,
} from '../../../server/torrents-api.js';
import { formatBytes } from '../format.js';
import { el } from './dom.js';

function tags(file: TorrentFileInfo, isMain: boolean): HTMLElement[] {
  const result: HTMLElement[] = [];
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
// marked (3.1's mainFile) and videos the browser may refuse flagged.
export function fileList(
  detail: Pick<TorrentDetail, 'files' | 'mainFile'>,
): HTMLUListElement {
  const list = el('ul', { className: 'file-list' });
  for (const file of detail.files ?? []) {
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
        ...tags(file, file.index === detail.mainFile),
      ),
    );
  }
  return list;
}
