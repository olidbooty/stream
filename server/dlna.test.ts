import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebTorrent from 'webtorrent';
import { FakeWebTorrent } from '../test/mocks/webtorrent.js';
import { createApp } from './app.js';
import {
  CONTENT_DIRECTORY,
  deviceName,
  deviceUuid,
  didl,
  soapArgs,
  videoMimeType,
  xmlEscape,
} from './dlna.js';
import { NO_SETTINGS, SettingsStore } from './settings.js';

const FILM = '08ada5a7a6183aae1e09d831df6748d566095a10';
const SHOW = 'c9e15763f722f23e98a29decdfae341b98d53056';
const PENDING = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';
const MB = 1024 * 1024;
const DEVICE = {
  uuid: '4f7ad604-67ef-5958-a706-c60b14eadd08',
  name: 'stream on studio',
};

describe('xmlEscape', () => {
  it('escapes markup and drops characters XML cannot hold', () => {
    expect(xmlEscape(`Tom & Jerry <"1"> 'x'\u0001\u0007\ttab`)).toBe(
      'Tom &amp; Jerry &lt;&quot;1&quot;&gt; &apos;x&apos;\ttab',
    );
  });
});

describe('deviceUuid', () => {
  it('is the same for the same host and port, and shaped like a UUID', () => {
    const uuid = deviceUuid('studio', 1234);

    expect(uuid).toBe(deviceUuid('studio', 1234));
    expect(uuid).not.toBe(deviceUuid('studio', 1235));
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('deviceName', () => {
  it('names the server after the computer, without .local', () => {
    expect(deviceName('studio.local')).toBe('stream on studio');
    expect(deviceName('nas')).toBe('stream on nas');
  });
});

describe('videoMimeType', () => {
  it('keeps a video type and makes one up for anything else', () => {
    expect(videoMimeType('video/x-matroska', 'a.mkv')).toBe('video/x-matroska');
    expect(videoMimeType('application/octet-stream', 'a.RMVB')).toBe(
      'video/x-rmvb',
    );
    expect(videoMimeType(undefined, 'noextension')).toBe('video/x-unknown');
  });
});

describe('soapArgs', () => {
  it('reads each argument, namespaced or not, unescaping its text', () => {
    const args = soapArgs(
      '<?xml version="1.0"?><s:Envelope xmlns:s="x"><s:Body>' +
        '<u:Browse xmlns:u="y"><ObjectID>a&amp;b&#x2F;&#49;</ObjectID>' +
        '<BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter/>' +
        '<u:StartingIndex>5</u:StartingIndex><SortCriteria></SortCriteria>' +
        '</u:Browse></s:Body></s:Envelope>',
    );

    expect(args.get('ObjectID')).toBe('a&b/1');
    expect(args.get('BrowseFlag')).toBe('BrowseDirectChildren');
    expect(args.get('Filter')).toBe('');
    expect(args.get('StartingIndex')).toBe('5');
    expect(args.get('SortCriteria')).toBe('');
    expect(args.has('Body')).toBe(false);
  });
});

describe('didl', () => {
  it('writes folders and videos with their resources and subtitles', () => {
    expect(
      didl([
        {
          kind: 'container',
          id: FILM,
          parentId: '0',
          title: 'Tom & Jerry',
          childCount: 2,
        },
        {
          kind: 'item',
          id: `${FILM}/0`,
          parentId: FILM,
          title: 'E01',
          url: 'http://h/v?play&x',
          mimeType: 'video/mp4',
          size: 42,
          subtitles: [
            { url: 'http://h/s1.vtt', language: 'en' },
            { url: 'http://h/s2.vtt', language: null },
          ],
        },
      ]),
    ).toBe(
      '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:sec="http://www.sec.co.kr/">' +
        `<container id="${FILM}" parentID="0" restricted="1" searchable="0" childCount="2"><dc:title>Tom &amp; Jerry</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>` +
        `<item id="${FILM}/0" parentID="${FILM}" restricted="1"><dc:title>E01</dc:title><upnp:class>object.item.videoItem</upnp:class>` +
        '<res protocolInfo="http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0" size="42">http://h/v?play&amp;x</res>' +
        '<res protocolInfo="http-get:*:text/vtt:*">http://h/s1.vtt</res>' +
        '<res protocolInfo="http-get:*:text/vtt:*">http://h/s2.vtt</res>' +
        '<sec:CaptionInfoEx sec:type="vtt">http://h/s1.vtt</sec:CaptionInfoEx></item>' +
        '</DIDL-Lite>',
    );
  });
});

describe('DLNA routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  let client: FakeWebTorrent;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    client = new FakeWebTorrent();
    app = createApp({
      client: client as unknown as WebTorrent,
      downloadDir: join(tmpdir(), 'stream-dlna-test'),
      lanAddresses: () => ['192.168.1.20'],
      dlna: DEVICE,
    });
  });

  function addTorrents(): void {
    // The same three as the 3.11 playlist tests: a film with a sample and
    // subtitles, a season, and a magnet still fetching its metadata.
    client.add(`magnet:?xt=urn:btih:${FILM}`).simulateMetadata({
      name: 'Sintel <Director’s Cut> & More',
      files: [
        { name: 'Sintel.mkv', path: 'Sintel/Sintel.mkv', length: 700 * MB },
        { name: 'Sintel.en.srt', path: 'Sintel/Sintel.en.srt', length: 50 },
        {
          name: 'sample.mkv',
          path: 'Sintel/Sample/sample.mkv',
          length: 10 * MB,
        },
      ],
    });
    client.add(`magnet:?xt=urn:btih:${SHOW}`).simulateMetadata({
      name: 'Show S01',
      files: [
        { name: 'Show.E02.mp4', path: 'Show S01/Show.E02.mp4', length: MB },
        { name: 'Show.E01.mp4', path: 'Show S01/Show.E01.mp4', length: MB },
      ],
    });
    client.add(`magnet:?xt=urn:btih:${PENDING}`);
  }

  // supertest only buffers text/* bodies as text by itself.
  const text = (res: request.Response) => res.text as string;

  function soap(
    action: string,
    args: Record<string, string>,
    service = CONTENT_DIRECTORY,
    path = '/dlna/control/ContentDirectory',
  ) {
    const body = Object.entries(args)
      .map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`)
      .join('');
    return request(app)
      .post(path)
      .set('Host', '192.168.1.20:1234')
      .set('SOAPACTION', `"${service}#${action}"`)
      .set('Content-Type', 'text/xml; charset="utf-8"')
      .send(
        '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
          `<u:${action} xmlns:u="${service}">${body}</u:${action}></s:Body></s:Envelope>`,
      );
  }

  function browse(
    objectId: string,
    flag = 'BrowseDirectChildren',
    start = '0',
    count = '0',
  ) {
    return soap('Browse', {
      ObjectID: objectId,
      BrowseFlag: flag,
      Filter: '*',
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: '',
    });
  }

  // The DIDL-Lite in a Browse answer, unescaped once, and the counts.
  function result(res: request.Response) {
    const args = soapArgs(text(res));
    return {
      didl: args.get('Result') ?? '',
      returned: Number(args.get('NumberReturned')),
      total: Number(args.get('TotalMatches')),
      updateId: Number(args.get('UpdateID')),
    };
  }

  it('describes a MediaServer with its name and UDN', async () => {
    const res = await request(app).get('/dlna/device.xml');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/xml/);
    expect(text(res)).toContain(
      '<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>',
    );
    expect(text(res)).toContain(
      '<friendlyName>stream on studio</friendlyName>',
    );
    expect(text(res)).toContain(`<UDN>uuid:${DEVICE.uuid}</UDN>`);
    expect(text(res)).toContain(
      '<controlURL>/dlna/control/ContentDirectory</controlURL>',
    );
  });

  it('serves both service descriptions', async () => {
    const cd = await request(app).get('/dlna/ContentDirectory.xml');
    const cm = await request(app).get('/dlna/ConnectionManager.xml');

    expect(text(cd)).toContain('<name>Browse</name>');
    expect(text(cm)).toContain('<name>GetProtocolInfo</name>');
  });

  it('lists a folder per torrent with a video', async () => {
    addTorrents();

    const res = await browse('0');

    expect(res.status).toBe(200);
    const { didl, returned, total } = result(res);
    expect(returned).toBe(2);
    expect(total).toBe(2);
    expect(didl).toContain(
      `<container id="${FILM}" parentID="0" restricted="1" searchable="0" childCount="1"><dc:title>Sintel &lt;Director’s Cut&gt; &amp; More</dc:title>`,
    );
    expect(didl).toContain(
      `<container id="${SHOW}" parentID="0" restricted="1" searchable="0" childCount="2">`,
    );
    expect(didl.indexOf(FILM)).toBeLessThan(didl.indexOf(SHOW));
    expect(didl).not.toContain(PENDING);
  });

  it('lists a folder’s videos with LAN stream URLs and subtitles', async () => {
    addTorrents();

    const film = result(await browse(FILM)).didl;
    const show = result(await browse(SHOW)).didl;

    expect(film).toContain(
      `<item id="${FILM}/0" parentID="${FILM}" restricted="1"><dc:title>Sintel</dc:title><upnp:class>object.item.videoItem</upnp:class>` +
        `<res protocolInfo="http-get:*:video/x-matroska:DLNA.ORG_OP=01;DLNA.ORG_CI=0" size="${700 * MB}">http://192.168.1.20:1234/api/torrents/${FILM}/files/0/stream?play</res>` +
        `<res protocolInfo="http-get:*:text/vtt:*">http://192.168.1.20:1234/api/torrents/${FILM}/files/1/subtitles.vtt</res>`,
    );
    // The sample is left out, as in the playlist.
    expect(film).not.toContain(`${FILM}/2`);
    expect(show.indexOf(`${SHOW}/1`)).toBeLessThan(show.indexOf(`${SHOW}/0`));
    expect(show).toContain('<dc:title>Show.E01</dc:title>');
    expect(show).toContain('video/mp4:DLNA.ORG_OP=01');
  });

  it('answers BrowseMetadata for the root, a folder and a video', async () => {
    addTorrents();

    const root = result(await browse('0', 'BrowseMetadata'));
    const folder = result(await browse(SHOW, 'BrowseMetadata'));
    const video = result(await browse(`${SHOW}/1`, 'BrowseMetadata'));

    expect(root.didl).toContain(
      '<container id="0" parentID="-1" restricted="1" searchable="0" childCount="2"><dc:title>stream on studio</dc:title>',
    );
    expect(folder.didl).toContain(`<container id="${SHOW}" parentID="0"`);
    expect(video.didl).toContain(`<item id="${SHOW}/1" parentID="${SHOW}"`);
    expect([root.total, folder.total, video.total]).toEqual([1, 1, 1]);
  });

  it('pages through children with StartingIndex and RequestedCount', async () => {
    addTorrents();

    const page = result(await browse(SHOW, 'BrowseDirectChildren', '1', '5'));

    expect(page.returned).toBe(1);
    expect(page.total).toBe(2);
    expect(page.didl).toContain(`${SHOW}/0`);
    expect(page.didl).not.toContain(`${SHOW}/1`);
  });

  it('answers 701 for an object that is not there', async () => {
    addTorrents();

    for (const id of [PENDING, `${FILM}/2`, `${FILM}/9`, `${FILM}/x`, 'nope']) {
      const res = await browse(id);
      expect(res.status).toBe(500);
      expect(text(res)).toContain('<errorCode>701</errorCode>');
    }
  });

  it('answers 402 for bad arguments and 401 for an unknown action', async () => {
    const flag = await browse('0', 'BrowseEverything');
    const count = await browse('0', 'BrowseDirectChildren', '-1');
    const action = await soap('DestroyObject', { ObjectID: '0' });
    const wrongService = await soap(
      'Browse',
      { ObjectID: '0' },
      'urn:schemas-upnp-org:service:AVTransport:1',
    );

    expect(text(flag)).toContain('<errorCode>402</errorCode>');
    expect(text(count)).toContain('<errorCode>402</errorCode>');
    expect(text(action)).toContain('<errorCode>401</errorCode>');
    expect(text(wrongService)).toContain('<errorCode>401</errorCode>');
  });

  it('raises SystemUpdateID when the folders change', async () => {
    const before = result(await browse('0')).updateId;
    const same = Number(
      soapArgs(text(await soap('GetSystemUpdateID', {}))).get('Id'),
    );
    addTorrents();
    const after = result(await browse('0')).updateId;

    expect(same).toBe(before);
    expect(after).toBeGreaterThan(before);
  });

  it('answers the small ContentDirectory and ConnectionManager actions', async () => {
    const sort = await soap('GetSortCapabilities', {});
    const protocols = await soap(
      'GetProtocolInfo',
      {},
      'urn:schemas-upnp-org:service:ConnectionManager:1',
      '/dlna/control/ConnectionManager',
    );
    const ids = await soap(
      'GetCurrentConnectionIDs',
      {},
      'urn:schemas-upnp-org:service:ConnectionManager:1',
      '/dlna/control/ConnectionManager',
    );

    expect(text(sort)).toContain('<SortCaps></SortCaps>');
    expect(soapArgs(text(protocols)).get('Source')).toContain(
      'http-get:*:video/*:*',
    );
    expect(soapArgs(text(ids)).get('ConnectionIDs')).toBe('0');
  });

  it('accepts event subscriptions without sending events', async () => {
    const res = await request(app)
      .subscribe('/dlna/events/ContentDirectory')
      .set('CALLBACK', '<http://192.168.1.30:4000/>')
      .set('NT', 'upnp:event');

    expect(res.status).toBe(200);
    expect(res.headers.sid).toMatch(/^uuid:/);
  });

  it('answers 404 while the DLNA setting is off, and again once it is on', async () => {
    const settings = new SettingsStore(
      join(tmpdir(), 'stream-dlna-test-settings'),
      { ...NO_SETTINGS, dlnaOn: false },
    );
    const gated = createApp({
      client: client as unknown as WebTorrent,
      downloadDir: join(tmpdir(), 'stream-dlna-test'),
      lanAddresses: () => ['192.168.1.20'],
      dlna: DEVICE,
      settings,
    });

    expect((await request(gated).get('/dlna/device.xml')).status).toBe(404);
    // Only the in-memory value matters here; the save may fail.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    void settings.set({ ...settings.get(), dlnaOn: true });
    expect((await request(gated).get('/dlna/device.xml')).status).toBe(200);
  });

  it('is off without a device', async () => {
    const off = createApp({
      client: client as unknown as WebTorrent,
      downloadDir: join(tmpdir(), 'stream-dlna-test'),
    });

    const res = await request(off).get('/dlna/device.xml');

    expect(res.status).toBe(404);
  });
});
