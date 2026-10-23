import './styles/tokens.css';
import './styles/components.css';
import { createApi } from './api.js';
import { type LiveStatus, startLiveUpdates } from './live-updates.js';
import { torrentForm } from './torrent-form.js';
import { torrentList } from './torrent-list.js';
import { confirmDialog } from './ui/confirm-dialog.js';
import { statusBanner } from './ui/status-banner.js';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('index.html is missing the #app element');

const STATUS_MESSAGES: Record<Exclude<LiveStatus, 'live'>, string> = {
  reconnecting:
    'Connection to the server lost. Reconnecting; the list may be out of date.',
  unavailable:
    'Live updates are unavailable right now. Retrying in 10 seconds; the list may be out of date.',
};

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

app.append(
  torrentForm({ api, onAdded: () => void refresh() }),
  banner.element,
  list.element,
);

startLiveUpdates({
  createEventSource: (url) => new EventSource(url),
  document,
  onTorrents: (torrents) => list.update(torrents),
  onStatus: (status) => {
    if (status === 'live') banner.hide();
    else banner.show(STATUS_MESSAGES[status]);
    list.setStale(status !== 'live');
  },
});

// A tab opened in the background has no stream until it is shown.
void refresh();
app.dataset.ready = 'true';
