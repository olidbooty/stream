import './styles/tokens.css';
import './styles/components.css';
import { createApi } from './api.js';
import { STATUS_MESSAGES, startLiveUpdates } from './live-updates.js';
import { createPlayer } from './player.js';
import { parsePlayRoute } from './player-route.js';
import { torrentForm } from './torrent-form.js';
import { torrentList } from './torrent-list.js';
import { tvPlaylist } from './tv-playlist.js';
import { confirmDialog } from './ui/confirm-dialog.js';
import { statusBanner } from './ui/status-banner.js';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('index.html is missing the #app element');

const api = createApi();
const banner = statusBanner();

// Pulls the list once after an add or remove, so it changes straight away
// instead of on the next event.
async function refresh(): Promise<void> {
  try {
    list.update(await api.listTorrents());
  } catch {
    // The event stream will bring the list when the server is back.
  }
}

const list = torrentList({
  api,
  confirm: (message) =>
    confirmDialog(document.body, { message, confirmLabel: 'Remove' }),
  onChanged: () => void refresh(),
});

const player = createPlayer({ api });
const form = torrentForm({ api, onAdded: () => void refresh() });
const tv = tvPlaylist({ api, clipboard: navigator.clipboard });

app.append(form, banner.element, list.element, tv.element, player.element);

// Two views: the list, or the player at #play/<infoHash>/<index>. The live
// list keeps running under the player, which shows its stats.
function route(): void {
  const play = parsePlayRoute(location.hash);
  form.hidden = play !== null;
  list.element.hidden = play !== null;
  tv.setShown(play === null);
  player.element.hidden = play === null;
  if (play) void player.open(play);
  else player.close();
}
window.addEventListener('hashchange', route);
route();

startLiveUpdates({
  createEventSource: (url) => new EventSource(url),
  document,
  onTorrents: (torrents) => {
    list.update(torrents);
    player.update(torrents);
  },
  onStatus: (status) => {
    if (status === 'live') banner.hide();
    else banner.show(STATUS_MESSAGES[status]);
    list.setStale(status !== 'live');
  },
});

// A tab opened in the background has no stream until it is shown.
void refresh();
void tv.load();
app.dataset.ready = 'true';
