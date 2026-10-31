import { createHash, randomUUID } from 'node:crypto';
import express, { type Request, type Response, Router } from 'express';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { matchSubtitles } from './media.js';
import { lanAddresses as systemLanAddresses } from './network.js';
import { mediaInputs } from './torrent-selection.js';
import {
  lanOrigins,
  streamUrl,
  tvVideos,
  withoutExtension,
} from './tv-playlist.js';

// Step 3.12: a UPnP MediaServer, so VLC's Browse > Local network lists each
// torrent as a folder of its videos (Decision #37). server/ssdp.ts announces
// it; this is the HTTP side: the device description, the two services' SCPDs
// and their SOAP control URLs. Only what VLC and other players use to browse
// is implemented: ContentDirectory's Browse and the required small actions,
// and a ConnectionManager that has no connections.

export const DEVICE_TYPE = 'urn:schemas-upnp-org:device:MediaServer:1';
export const CONTENT_DIRECTORY =
  'urn:schemas-upnp-org:service:ContentDirectory:1';
export const CONNECTION_MANAGER =
  'urn:schemas-upnp-org:service:ConnectionManager:1';
export const DESCRIPTION_PATH = '/dlna/device.xml';

export const SERVER_HEADER = `Node.js/${process.versions.node} UPnP/1.0 stream/0.1`;

// The root folder's ObjectID, fixed by the ContentDirectory spec.
const ROOT = '0';

// The SOAP request body is a few hundred bytes.
const MAX_SOAP_BODY = '64kb';

// A stable UDN for this server: VLC tells servers apart by it and drops a
// second one with the same UDN, and a player that remembers a server finds it
// again after a restart. So it is derived from the host name and port rather
// than random, and shaped like a version 5 UUID.
export function deviceUuid(hostname: string, port: number): string {
  const hex = createHash('sha1')
    .update(`stream:${hostname}:${port}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Characters XML 1.0 can't hold at all, even escaped. A torrent's file names
// come from whoever made it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

export function xmlEscape(text: string): string {
  return text.replace(NOT_XML, '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function xmlUnescape(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi,
    (entity, hex: string, dec: string, name: string) => {
      if (hex || dec) {
        const code = Number.parseInt(hex ?? dec, hex ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[
        name.toLowerCase() as 'amp'
      ];
    },
  );
}

// "stream on studio" for a Mac called studio.local.
export function deviceName(hostname: string): string {
  return `stream on ${hostname.replace(/\.local$/i, '')}`;
}

export interface DeviceInfo {
  uuid: string;
  // Shown in VLC's list of servers.
  name: string;
}

export function deviceDescription({ uuid, name }: DeviceInfo): string {
  const service = (type: string, id: string, file: string) =>
    `<service><serviceType>${type}</serviceType>` +
    `<serviceId>urn:upnp-org:serviceId:${id}</serviceId>` +
    `<SCPDURL>/dlna/${file}.xml</SCPDURL>` +
    `<controlURL>/dlna/control/${file}</controlURL>` +
    `<eventSubURL>/dlna/events/${file}</eventSubURL></service>`;
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    `<device><deviceType>${DEVICE_TYPE}</deviceType>` +
    `<friendlyName>${xmlEscape(name)}</friendlyName>` +
    '<manufacturer>stream</manufacturer>' +
    '<modelName>stream</modelName>' +
    '<dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>' +
    `<UDN>uuid:${uuid}</UDN>` +
    '<serviceList>' +
    service(CONTENT_DIRECTORY, 'ContentDirectory', 'ContentDirectory') +
    service(CONNECTION_MANAGER, 'ConnectionManager', 'ConnectionManager') +
    '</serviceList></device></root>\n'
  );
}

interface StateVariable {
  name: string;
  type: string;
  events?: boolean;
  values?: string[];
}

interface Action {
  name: string;
  // [argument, direction, related state variable]
  args: [string, 'in' | 'out', string][];
}

function scpd(actions: Action[], variables: StateVariable[]): string {
  const actionList = actions
    .map(
      ({ name, args }) =>
        `<action><name>${name}</name><argumentList>${args
          .map(
            ([arg, direction, variable]) =>
              `<argument><name>${arg}</name><direction>${direction}</direction>` +
              `<relatedStateVariable>${variable}</relatedStateVariable></argument>`,
          )
          .join('')}</argumentList></action>`,
    )
    .join('');
  const stateTable = variables
    .map(
      ({ name, type, events = false, values }) =>
        `<stateVariable sendEvents="${events ? 'yes' : 'no'}"><name>${name}</name>` +
        `<dataType>${type}</dataType>${
          values
            ? `<allowedValueList>${values.map((value) => `<allowedValue>${value}</allowedValue>`).join('')}</allowedValueList>`
            : ''
        }</stateVariable>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<scpd xmlns="urn:schemas-upnp-org:service-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    `<actionList>${actionList}</actionList>` +
    `<serviceStateTable>${stateTable}</serviceStateTable></scpd>\n`
  );
}

export const CONTENT_DIRECTORY_SCPD = scpd(
  [
    {
      name: 'Browse',
      args: [
        ['ObjectID', 'in', 'A_ARG_TYPE_ObjectID'],
        ['BrowseFlag', 'in', 'A_ARG_TYPE_BrowseFlag'],
        ['Filter', 'in', 'A_ARG_TYPE_Filter'],
        ['StartingIndex', 'in', 'A_ARG_TYPE_Index'],
        ['RequestedCount', 'in', 'A_ARG_TYPE_Count'],
        ['SortCriteria', 'in', 'A_ARG_TYPE_SortCriteria'],
        ['Result', 'out', 'A_ARG_TYPE_Result'],
        ['NumberReturned', 'out', 'A_ARG_TYPE_Count'],
        ['TotalMatches', 'out', 'A_ARG_TYPE_Count'],
        ['UpdateID', 'out', 'A_ARG_TYPE_UpdateID'],
      ],
    },
    {
      name: 'GetSearchCapabilities',
      args: [['SearchCaps', 'out', 'SearchCapabilities']],
    },
    {
      name: 'GetSortCapabilities',
      args: [['SortCaps', 'out', 'SortCapabilities']],
    },
    {
      name: 'GetSystemUpdateID',
      args: [['Id', 'out', 'SystemUpdateID']],
    },
  ],
  [
    { name: 'A_ARG_TYPE_ObjectID', type: 'string' },
    {
      name: 'A_ARG_TYPE_BrowseFlag',
      type: 'string',
      values: ['BrowseMetadata', 'BrowseDirectChildren'],
    },
    { name: 'A_ARG_TYPE_Filter', type: 'string' },
    { name: 'A_ARG_TYPE_Index', type: 'ui4' },
    { name: 'A_ARG_TYPE_Count', type: 'ui4' },
    { name: 'A_ARG_TYPE_SortCriteria', type: 'string' },
    { name: 'A_ARG_TYPE_Result', type: 'string' },
    { name: 'A_ARG_TYPE_UpdateID', type: 'ui4' },
    { name: 'SearchCapabilities', type: 'string' },
    { name: 'SortCapabilities', type: 'string' },
    { name: 'SystemUpdateID', type: 'ui4', events: true },
  ],
);

export const CONNECTION_MANAGER_SCPD = scpd(
  [
    {
      name: 'GetProtocolInfo',
      args: [
        ['Source', 'out', 'SourceProtocolInfo'],
        ['Sink', 'out', 'SinkProtocolInfo'],
      ],
    },
    {
      name: 'GetCurrentConnectionIDs',
      args: [['ConnectionIDs', 'out', 'CurrentConnectionIDs']],
    },
    {
      name: 'GetCurrentConnectionInfo',
      args: [
        ['ConnectionID', 'in', 'A_ARG_TYPE_ConnectionID'],
        ['RcsID', 'out', 'A_ARG_TYPE_RcsID'],
        ['AVTransportID', 'out', 'A_ARG_TYPE_AVTransportID'],
        ['ProtocolInfo', 'out', 'A_ARG_TYPE_ProtocolInfo'],
        ['PeerConnectionManager', 'out', 'A_ARG_TYPE_ConnectionManager'],
        ['PeerConnectionID', 'out', 'A_ARG_TYPE_ConnectionID'],
        ['Direction', 'out', 'A_ARG_TYPE_Direction'],
        ['Status', 'out', 'A_ARG_TYPE_ConnectionStatus'],
      ],
    },
  ],
  [
    { name: 'SourceProtocolInfo', type: 'string', events: true },
    { name: 'SinkProtocolInfo', type: 'string', events: true },
    { name: 'CurrentConnectionIDs', type: 'string', events: true },
    {
      name: 'A_ARG_TYPE_ConnectionStatus',
      type: 'string',
      values: ['OK', 'ContentFormatMismatch', 'InsufficientBandwidth'],
    },
    { name: 'A_ARG_TYPE_ConnectionManager', type: 'string' },
    {
      name: 'A_ARG_TYPE_Direction',
      type: 'string',
      values: ['Input', 'Output'],
    },
    { name: 'A_ARG_TYPE_ProtocolInfo', type: 'string' },
    { name: 'A_ARG_TYPE_ConnectionID', type: 'i4' },
    { name: 'A_ARG_TYPE_AVTransportID', type: 'i4' },
    { name: 'A_ARG_TYPE_RcsID', type: 'i4' },
  ],
);

// One entry of a Browse result: a folder (a torrent) or a video in it.
export type DidlObject =
  | {
      kind: 'container';
      id: string;
      parentId: string;
      title: string;
      childCount: number;
    }
  | {
      kind: 'item';
      id: string;
      parentId: string;
      title: string;
      url: string;
      mimeType: string;
      size: number;
      subtitles: { url: string; language: string | null }[];
    };

// OP=01: the server answers byte Range requests, so players can seek. Some
// TVs refuse to seek without it.
const VIDEO_DLNA_FLAGS = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0';

function didlObject(object: DidlObject): string {
  const head = `id="${xmlEscape(object.id)}" parentID="${xmlEscape(object.parentId)}" restricted="1"`;
  const title = `<dc:title>${xmlEscape(object.title)}</dc:title>`;
  if (object.kind === 'container') {
    return (
      `<container ${head} searchable="0" childCount="${object.childCount}">${title}` +
      '<upnp:class>object.container.storageFolder</upnp:class></container>'
    );
  }
  // VLC adds every text/ resource as a subtitle track. Samsung TVs read
  // sec:CaptionInfoEx instead, which holds one.
  const [first] = object.subtitles;
  return (
    `<item ${head}>${title}<upnp:class>object.item.videoItem</upnp:class>` +
    `<res protocolInfo="http-get:*:${xmlEscape(object.mimeType)}:${VIDEO_DLNA_FLAGS}" size="${object.size}">${xmlEscape(object.url)}</res>` +
    object.subtitles
      .map(
        ({ url }) =>
          `<res protocolInfo="http-get:*:text/vtt:*">${xmlEscape(url)}</res>`,
      )
      .join('') +
    (first
      ? `<sec:CaptionInfoEx sec:type="vtt">${xmlEscape(first.url)}</sec:CaptionInfoEx>`
      : '') +
    '</item>'
  );
}

// DIDL-Lite, the XML a Browse returns, as a string; the SOAP answer escapes it
// once more.
export function didl(objects: readonly DidlObject[]): string {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:sec="http://www.sec.co.kr/">' +
    objects.map(didlObject).join('') +
    '</DIDL-Lite>'
  );
}

// VLC only lists a video whose resource is a video/ type, so a container the
// MIME table doesn't know, such as .rmvb, still gets one.
export function videoMimeType(type: string | undefined, name: string): string {
  if (type?.startsWith('video/')) return type;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : 'unknown';
  return `video/x-${extension.replace(/[^a-z0-9]/g, '')}`;
}

function torrentFolder(torrent: Torrent): DidlObject {
  return {
    kind: 'container',
    id: torrent.infoHash,
    parentId: ROOT,
    title: torrent.name,
    childCount: tvVideos(torrent).length,
  };
}

function videoItem(
  torrent: Torrent,
  index: number,
  origin: string,
): DidlObject {
  const file = torrent.files[index];
  const base = `${origin}/api/torrents/${torrent.infoHash}/files`;
  return {
    kind: 'item',
    id: `${torrent.infoHash}/${index}`,
    parentId: torrent.infoHash,
    title: withoutExtension(file.name),
    url: streamUrl(origin, torrent, index),
    mimeType: videoMimeType(file.type, file.name),
    size: file.length,
    subtitles: matchSubtitles(mediaInputs(torrent), index).map(
      ({ index: subtitle, language }) => ({
        url: `${base}/${subtitle}/subtitles.vtt`,
        language,
      }),
    ),
  };
}

// The folders shown at the top: one per torrent with a video to list, in the
// order they were added, like the 3.11 playlist.
function folders(torrents: readonly Torrent[]): Torrent[] {
  return torrents.filter((torrent) => tvVideos(torrent).length > 0);
}

export class NoSuchObject extends Error {}

export interface BrowseRequest {
  objectId: string;
  metadata: boolean;
  start: number;
  // 0 means all.
  count: number;
}

export interface BrowseResult {
  objects: DidlObject[];
  totalMatches: number;
}

// ObjectIDs: "0" for the root, the info hash for a torrent's folder and
// "<infoHash>/<index>" for a video, so an ID stays valid while the torrent is
// there.
export function browse(
  torrents: readonly Torrent[],
  { objectId, metadata, start, count }: BrowseRequest,
  origin: string,
  name: string,
): BrowseResult {
  const [infoHash, index, ...rest] = objectId.split('/');
  let self: DidlObject;
  let children: () => DidlObject[];
  if (objectId === ROOT) {
    self = {
      kind: 'container',
      id: ROOT,
      parentId: '-1',
      title: name,
      childCount: folders(torrents).length,
    };
    children = () => folders(torrents).map(torrentFolder);
  } else {
    const torrent = torrents.find((t) => t.infoHash === infoHash);
    const videos = torrent ? tvVideos(torrent) : [];
    if (!torrent || videos.length === 0 || rest.length > 0) {
      throw new NoSuchObject(objectId);
    }
    if (index === undefined) {
      self = torrentFolder(torrent);
      children = () => videos.map((video) => videoItem(torrent, video, origin));
    } else {
      const video = Number(index);
      if (!/^\d+$/.test(index) || !videos.includes(video)) {
        throw new NoSuchObject(objectId);
      }
      self = videoItem(torrent, video, origin);
      children = () => [];
    }
  }
  if (metadata) return { objects: [self], totalMatches: 1 };
  const all = children();
  const end = count > 0 ? start + count : undefined;
  return { objects: all.slice(start, end), totalMatches: all.length };
}

// The text of each argument in a SOAP action, by its unqualified name.
// Arguments are flat elements holding text, so this doesn't need an XML
// parser.
export function soapArgs(body: string): Map<string, string> {
  const args = new Map<string, string>();
  const element =
    /<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?(?:\/>|>([^<]*)<\/(?:[\w.-]+:)?\1\s*>)/g;
  for (const [, name, text = ''] of body.matchAll(element)) {
    if (!args.has(name)) args.set(name, xmlUnescape(text));
  }
  return args;
}

export function soapResponse(
  service: string,
  action: string,
  values: Record<string, string | number>,
): string {
  const body = Object.entries(values)
    .map(([key, value]) => `<${key}>${xmlEscape(String(value))}</${key}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action}Response xmlns:u="${service}">${body}</u:${action}Response></s:Body></s:Envelope>\n`
  );
}

// UPnP error codes: 401 Invalid Action, 402 Invalid Args, 701 No such object.
export function soapFault(code: number, description: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>' +
    '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">' +
    `<errorCode>${code}</errorCode><errorDescription>${xmlEscape(description)}</errorDescription>` +
    '</UPnPError></detail></s:Fault></s:Body></s:Envelope>\n'
  );
}

class SoapError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function parseCount(args: Map<string, string>, name: string): number {
  const value = args.get(name) ?? '0';
  if (!/^\d+$/.test(value)) throw new SoapError(402, `Invalid ${name}`);
  return Number(value);
}

export interface DlnaRouterOptions {
  client: WebTorrent;
  device: DeviceInfo;
  // The DLNA setting: while it is off the routes answer 404.
  enabled?: () => boolean;
  lanAddresses?: () => string[];
}

export function dlnaRouter({
  client,
  device,
  enabled = () => true,
  lanAddresses = systemLanAddresses,
}: DlnaRouterOptions): Router {
  const router = Router();
  router.use((_req, _res, next) => next(enabled() ? undefined : 'router'));

  // SystemUpdateID tells a player the content changed. It goes up whenever
  // the folders or their videos do, worked out when asked.
  let updateId = 1;
  let lastContents: string | undefined;
  function systemUpdateId(): number {
    const contents = folders(client.torrents)
      .map((torrent) => `${torrent.infoHash}:${tvVideos(torrent).join(',')}`)
      .join(';');
    if (lastContents !== undefined && contents !== lastContents) updateId++;
    lastContents = contents;
    return updateId;
  }

  const sendXml = (res: Response, xml: string) =>
    res
      .type('text/xml; charset="utf-8"')
      .set('Server', SERVER_HEADER)
      .send(xml);

  router.get(DESCRIPTION_PATH, (_req, res) => {
    sendXml(res, deviceDescription(device));
  });
  router.get('/dlna/ContentDirectory.xml', (_req, res) => {
    sendXml(res, CONTENT_DIRECTORY_SCPD);
  });
  router.get('/dlna/ConnectionManager.xml', (_req, res) => {
    sendXml(res, CONNECTION_MANAGER_SCPD);
  });

  type Handler = (
    args: Map<string, string>,
    req: Request,
  ) => Record<string, string | number>;

  const contentDirectory: Record<string, Handler> = {
    Browse(args, req) {
      const flag = args.get('BrowseFlag');
      if (flag !== 'BrowseMetadata' && flag !== 'BrowseDirectChildren') {
        throw new SoapError(402, 'Invalid BrowseFlag');
      }
      const [origin] = lanOrigins(req, lanAddresses());
      if (!origin) throw new SoapError(402, 'Unrecognised Host header');
      try {
        const { objects, totalMatches } = browse(
          client.torrents,
          {
            objectId: args.get('ObjectID') ?? ROOT,
            metadata: flag === 'BrowseMetadata',
            start: parseCount(args, 'StartingIndex'),
            count: parseCount(args, 'RequestedCount'),
          },
          origin,
          device.name,
        );
        return {
          Result: didl(objects),
          NumberReturned: objects.length,
          TotalMatches: totalMatches,
          UpdateID: systemUpdateId(),
        };
      } catch (err) {
        if (err instanceof NoSuchObject) {
          throw new SoapError(701, 'No such object');
        }
        throw err;
      }
    },
    GetSearchCapabilities: () => ({ SearchCaps: '' }),
    GetSortCapabilities: () => ({ SortCaps: '' }),
    GetSystemUpdateID: () => ({ Id: systemUpdateId() }),
  };

  const connectionManager: Record<string, Handler> = {
    GetProtocolInfo: () => ({
      Source: 'http-get:*:video/*:*,http-get:*:text/vtt:*',
      Sink: '',
    }),
    GetCurrentConnectionIDs: () => ({ ConnectionIDs: '0' }),
    GetCurrentConnectionInfo: (args) => {
      if (args.get('ConnectionID') !== '0') {
        throw new SoapError(706, 'Invalid connection reference');
      }
      return {
        RcsID: -1,
        AVTransportID: -1,
        ProtocolInfo: '',
        PeerConnectionManager: '',
        PeerConnectionID: -1,
        Direction: 'Output',
        Status: 'OK',
      };
    },
  };

  const control = (service: string, handlers: Record<string, Handler>) => [
    express.text({ type: () => true, limit: MAX_SOAP_BODY }),
    (req: Request, res: Response) => {
      // SOAPACTION: "urn:schemas-upnp-org:service:ContentDirectory:1#Browse"
      const header = (req.get('soapaction') ?? '').replace(/^"|"$/g, '');
      const hash = header.lastIndexOf('#');
      const action = header.slice(hash + 1);
      const handler =
        header.slice(0, hash) === service && Object.hasOwn(handlers, action)
          ? handlers[action]
          : undefined;
      try {
        if (!handler) throw new SoapError(401, 'Invalid Action');
        const body = typeof req.body === 'string' ? req.body : '';
        sendXml(
          res,
          soapResponse(service, action, handler(soapArgs(body), req)),
        );
      } catch (err) {
        if (!(err instanceof SoapError)) throw err;
        res.status(500);
        sendXml(res, soapFault(err.code, err.message));
      }
    },
  ];

  router.post(
    '/dlna/control/ContentDirectory',
    ...control(CONTENT_DIRECTORY, contentDirectory),
  );
  router.post(
    '/dlna/control/ConnectionManager',
    ...control(CONNECTION_MANAGER, connectionManager),
  );

  // Eventing: accepted so a player that subscribes carries on, but no events
  // are sent. Players browse again when they open a folder, and VLC doesn't
  // subscribe at all.
  router.subscribe('/dlna/events/:service', (_req, res) => {
    res
      .set({
        SID: `uuid:${randomUUID()}`,
        TIMEOUT: 'Second-1800',
        Server: SERVER_HEADER,
      })
      .end();
  });
  router.unsubscribe('/dlna/events/:service', (_req, res) => {
    res.end();
  });

  return router;
}
