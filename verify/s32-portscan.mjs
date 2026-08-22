// Verify (background-job port detection, pure): parseListeningPorts pulls the
// LOCAL listening port off each netstat/ss line for the three OS layouts we target,
// ignores non-LISTEN lines, and newPorts() diffs a before/after snapshot. The live
// snapshotPorts() shells out and is not exercised here.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { parseListeningPorts, newPorts } = await import(pathToFileURL(path.resolve(here, "../dist/portscan.js")).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? "PASS" : "FAIL"} ${n}`); if (!c) fails++; };

// Windows `netstat -ano`: local address is column 2 (`host:port`).
const win = [
  "Active Connections",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:7777         0.0.0.0:0              LISTENING       1234",
  "  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4",
  "  TCP    127.0.0.1:52100        127.0.0.1:7777        ESTABLISHED     9999",
].join("\r\n");
const winP = parseListeningPorts(win, "win32");
ok("windows: picks up listening local ports", winP.has(7777) && winP.has(445));
ok("windows: ignores non-LISTENING (ESTABLISHED) rows", !winP.has(52100));

// Linux `ss -tln`: `LISTEN 0 128 0.0.0.0:22 0.0.0.0:*`.
const linux = [
  "State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port",
  "LISTEN  0       128            0.0.0.0:22          0.0.0.0:*",
  "LISTEN  0       511          127.0.0.1:3000       0.0.0.0:*",
].join("\n");
const linP = parseListeningPorts(linux, "linux");
ok("linux: reads first :port on LISTEN lines", linP.has(22) && linP.has(3000));

// macOS `netstat -an -p tcp`: `127.0.0.1.7777 ... LISTEN` (dot before port).
const mac = [
  "Active Internet connections",
  "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
  "tcp4       0      0  127.0.0.1.7777         *.*                    LISTEN",
  "tcp4       0      0  127.0.0.1.5000         127.0.0.1.62000        ESTABLISHED",
].join("\n");
const macP = parseListeningPorts(mac, "darwin");
ok("macos: reads dot-separated local port", macP.has(7777));
ok("macos: ignores ESTABLISHED rows", !macP.has(5000));

// newPorts diffs before/after (a job opening 3000).
const added = newPorts(new Set([22, 445]), new Set([22, 445, 3000]));
ok("newPorts returns only the newly-opened port", added.length === 1 && added[0] === 3000);
ok("newPorts is empty when nothing changed", newPorts(new Set([22]), new Set([22])).length === 0);

console.log(fails ? `\nFAILED (${fails})` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
