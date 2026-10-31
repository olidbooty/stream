import './styles/tokens.css';
import './styles/components.css';
import { createApi } from './api.js';
import { STATUS_MESSAGES, startLiveUpdates } from './live-updates.js';
import { createPlayer } from './player.js';
import {
  isSettingsRoute,
  parsePlayRoute,
  SETTINGS_HREF,
} from './player-route.js';
import { diskFullMessage, settingsPanel } from './settings-panel.js';
import { torrentForm } from './torrent-form.js';
import { torrentList } from './torrent-list.js';
import { tvPlaylist } from './tv-playlist.js';
import { linkButton } from './ui/button.js';
import { confirmDialog } from './ui/confirm-dialog.js';
import { el } from './ui/dom.js';
import { statusBanner } from './ui/status-banner.js';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('index.html is missing the #app element');

const api = createApi();
const banner = statusBanner();
// Decision #36: the list says when the disk limit holds downloads back.
const diskBanner = statusBanner();
diskBanner.element.dataset.tone = 'warning';

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
const settings = settingsPanel({
  api,
  confirm: (message) =>
    confirmDialog(document.body, { message, confirmLabel: 'Delete' }),
});

// The page title with a link to the settings page beside it.
const settingsLink = linkButton({ label: 'Settings', href: SETTINGS_HREF });
const title = app.querySelector('h1');
const header = el('header', { className: 'page-header' });
if (title) header.append(title);
header.append(settingsLink);

// Things set once and rarely changed: the TV address and the disk space.
const settingsPage = el(
  'div',
  { className: 'settings-page' },
  el('div', {}, linkButton({ label: 'Back to torrents', href: '#' })),
  tv.element,
  settings.element,
);

app.prepend(header);
app.append(
  form,
  banner.element,
  diskBanner.element,
  list.element,
  settingsPage,
  player.element,
);

// Three views: the list, the player at #play/<infoHash>/<index>, or the
// settings page at #settings. The live list keeps running under the other
// two; the player shows its stats.
let listShown = true;
function route(): void {
  const play = parsePlayRoute(location.hash);
  const settingsShown = !play && isSettingsRoute(location.hash);
  listShown = !play && !settingsShown;
  form.hidden = !listShown;
  list.element.hidden = !listShown;
  diskBanner.element.hidden = !listShown || !diskBanner.element.textContent;
  settingsLink.hidden = !listShown;
  settingsPage.hidden = !settingsShown;
  tv.setShown(settingsShown);
  settings.setShown(settingsShown);
  if (settingsShown) {
    void tv.load();
    void settings.load();
  }
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
    const message = diskFullMessage(torrents);
    if (message) diskBanner.show(message);
    else diskBanner.hide();
    if (!listShown) diskBanner.element.hidden = true;
    // Usage changes as torrents download.
    settings.refresh();
  },
  onStatus: (status) => {
    if (status === 'live') banner.hide();
    else banner.show(STATUS_MESSAGES[status]);
    list.setStale(status !== 'live');
  },
});

// A tab opened in the background has no stream until it is shown.
void refresh();
app.dataset.ready = 'true';
