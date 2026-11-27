// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loopback TCP ports nothing listens on, for tests that publish real ports.
//
// Each port comes from binding port 0. Ports taken one at a time, each released
// before the next is taken, can come back equal, and two "free" ports that are
// one port fail a test for a reason it is not testing (a busy-port check named
// the wrong bundle in CI). So every port is held until all of them are chosen.

import { createServer } from "node:net";

/** `n` distinct ports on `host` that nothing listens on now. */
export async function freePorts(n, host = "127.0.0.1") {
  const servers = Array.from({ length: n }, () => createServer());
  try {
    await Promise.all(servers.map((s) => new Promise((resolve, reject) => {
      s.once("error", reject);
      s.listen({ host, port: 0 }, resolve);
    })));
    return servers.map((s) => s.address().port);
  } finally {
    await Promise.all(servers.map((s) => new Promise((resolve) => (s.listening ? s.close(resolve) : resolve()))));
  }
}

/** One port on `host` that nothing listens on now. */
export async function freePort(host = "127.0.0.1") {
  const [port] = await freePorts(1, host);
  return port;
}
