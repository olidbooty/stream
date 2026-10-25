// The player has its own address on the page, #play/<infoHash>/<index>, so
// the browser's Back button closes it and a link to a film can be opened on
// another device. No router library: the page has two views.

export interface PlayRoute {
  infoHash: string;
  index: number;
}

const PLAY = /^#play\/([0-9a-f]{40})\/(0|[1-9][0-9]{0,8})$/i;

export function parsePlayRoute(hash: string): PlayRoute | null {
  const match = PLAY.exec(hash);
  if (!match) return null;
  return { infoHash: match[1].toLowerCase(), index: Number(match[2]) };
}

export function playHref(infoHash: string, index: number): string {
  return `#play/${infoHash}/${index}`;
}
