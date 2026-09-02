/**
 * Rewrites `.env`'s `LOCAL_DEV_ALLOWED_ORIGINS` to include this machine's
 * current LAN IPv4 address, so another device on the same network can load
 * the web app and have its API calls pass the CORS allow-list.
 *
 * `HOST` is left alone: it should stay `0.0.0.0` so the API serves loopback
 * and the LAN address at once. Binding a single LAN address instead left
 * `localhost` with nothing listening, and every localhost URL failed at the
 * network layer with "Failed to fetch" while the LAN URL worked.
 *
 * The allow-list still needs the current address because CORS matches an
 * exact origin, and a laptop's address changes on every new Wi-Fi network.
 * Run this after switching networks, then restart the API server.
 *
 *   npm run update-lan-host
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

  const withOrigins = env.replace(
    /^LOCAL_DEV_ALLOWED_ORIGINS=.*$/m,
    `LOCAL_DEV_ALLOWED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001,http://${ip}:3001`,
  );
  if (withOrigins === env) throw new Error("No LOCAL_DEV_ALLOWED_ORIGINS= line found in .env — expected one to already exist");

  await writeFile(envPath, withOrigins);
  console.log(`[update-lan-host] allowed browser origins now include ${ip}`);
  console.log(`[update-lan-host] restart the API server, then open http://${ip}:3001 from another device on this network`);
  console.log("[update-lan-host] http://localhost:3001 keeps working on this machine either way");
}

main().catch((err) => {
  console.error("[update-lan-host] failed:", err.message);
  process.exit(1);
});
