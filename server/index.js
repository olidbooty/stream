import { createApp } from './app.js';
import { lanAddresses } from './network.js';

const port = Number(process.env.PORT) || 3000;
// 0.0.0.0 exposes the server to other devices on the LAN; set HOST=127.0.0.1 to keep it local.
const host = process.env.HOST || '0.0.0.0';

createApp().listen(port, host, () => {
  console.log(`stream listening on http://localhost:${port}`);
  if (host === '0.0.0.0') {
    for (const address of lanAddresses()) {
      console.log(`  on your network: http://${address}:${port}`);
    }
  }
});
