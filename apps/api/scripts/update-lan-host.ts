/**
 * Rewrites `.env`'s `HOST` and `LOCAL_DEV_ALLOWED_ORIGINS` to this machine's
 * current LAN IPv4 address.
 *
 * `AUTH_MODE=custom-local` requires `HOST` to be a real, currently-owned
 * private address (see `assertLocalDevServerHost` — it deliberately refuses
 * `0.0.0.0`, so the server can't be made to silently accept traffic on
 * every interface). A laptop's address changes every time it joins a new
 * Wi-Fi network, so the old one just stops being reachable — the server
 * keeps listening on an address it no longer owns. Run this after
 * switching networks, then restart the API server and worker.
 *
 *   npx tsx scripts/update-lan-host.ts
 */
import { networkInterfaces } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

function currentLanIPv4(): string {
  const candidates = Object.entries(networkInterfaces())
    // Virtual/tunnel interfaces (Docker, VPNs, `utun*`) are not what a phone
    // on the same Wi-Fi would use to reach this machine.
    .filter(([name]) => !/^(docker|utun|awdl|llw|bridge|anpi)/.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal);
  const chosen = candidates[0];
  if (!chosen) {
    throw new Error("No non-internal IPv4 network interface found — is this machine connected to a network?");
  }
  return chosen.address;
}

async function main() {
  const ip = currentLanIPv4();
  const env = await readFile(envPath, "utf8");

  const withHost = env.replace(/^HOST=.*$/m, `HOST=${ip}`);
  if (withHost === env) throw new Error("No HOST= line found in .env — expected one to already exist");

  const withOrigins = withHost.replace(
    /^LOCAL_DEV_ALLOWED_ORIGINS=.*$/m,
    `LOCAL_DEV_ALLOWED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001,http://${ip}:3001`,
  );
  if (withOrigins === withHost) throw new Error("No LOCAL_DEV_ALLOWED_ORIGINS= line found in .env — expected one to already exist");

  await writeFile(envPath, withOrigins);
  console.log(`[update-lan-host] .env now points at ${ip}`);
  console.log(`[update-lan-host] restart the API server and worker, then open http://${ip}:3001 on any device on this network`);
}

main().catch((err) => {
  console.error("[update-lan-host] failed:", err.message);
  process.exit(1);
});
