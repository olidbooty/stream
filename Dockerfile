# Step 5.1: the server as an image for an always-on box (Raspberry Pi, NAS).
# Two stages: the first has the build tools for the native modules and builds
# the page; the second only carries what the server runs.

# The full node image already has the C++ toolchain and Python that node-gyp
# needs: utp-native has no prebuilt binary for Linux on ARM, so npm builds it
# here (Decision #10). node-datachannel downloads its prebuilt binary, which
# exists for amd64 and arm64. Same Debian release as the runtime stage, so
# the compiled modules find the same glibc.
FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
  DOWNLOAD_DIR=/downloads
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
# The torrents, their saved list (.torrents) and the settings live here, so a
# new image keeps them. Owned by the image's node user (uid 1000).
RUN mkdir /downloads && chown node:node /downloads
VOLUME /downloads
USER node
# HTTP, peers (TCP and uTP), DHT, and SSDP for DLNA. With host networking
# (compose.yaml) these are only documentation.
EXPOSE 1234 6881/tcp 6881/udp 6882/udp 1900/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 1234}/api/client`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Node itself is PID 1 and handles SIGTERM from docker stop, so the client
# stops announcing and the torrent list is saved. tsx runs the TypeScript.
CMD ["node", "--import", "tsx", "server/index.ts"]
