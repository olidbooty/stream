import { ProbeError, runFfprobe, summarizeProbe } from '../server/probe.js';

// Step 4.1: what a file holds, as the codec rules see it.
//
//   npm run probe -- <file or URL>...        one summary per input
//   npm run probe -- --json <file or URL>... ffprobe's full JSON instead
//
// A URL can be a torrent file's stream route, such as
// http://localhost:1234/api/torrents/<infoHash>/files/<index>/stream, which
// fetches only the pieces ffprobe reads.

async function main(argv: string[]): Promise<void> {
  const raw = argv.includes('--json');
  const inputs = argv.filter((arg) => arg !== '--json');
  if (inputs.length === 0) {
    console.error('Usage: npm run probe -- [--json] <file or URL>...');
    process.exitCode = 2;
    return;
  }
  for (const input of inputs) {
    try {
      const json = await runFfprobe(input);
      const output = raw ? json : { input, ...summarizeProbe(json) };
      console.log(JSON.stringify(output, null, 2));
    } catch (error) {
      if (!(error instanceof ProbeError)) throw error;
      console.error(`${input}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
