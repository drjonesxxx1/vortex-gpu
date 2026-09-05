// A local stand-in for BTCPay.
//
// The gateway talks to BTCPay with https.request() and rejectUnauthorized:false
// (the real one is a self-signed box on the LAN), so the stub must speak TLS —
// a plain-HTTP stub would be rejected by https.request before a byte was sent.
// The cert is generated on the fly with openssl into the test's temp dir.

import https from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cachedCert = null;

function selfSignedCert() {
  if (cachedCert) return cachedCert;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  cachedCert = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return cachedCert;
}

/**
 * Start a fake BTCPay. `handler(body, req)` returns { status, json }.
 * Records every request it received on `.requests`.
 */
export async function startBtcpayStub(handler) {
  const { key, cert } = selfSignedCert();
  const requests = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(buf || "{}"); } catch { body = {}; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = handler ? handler(body, req) : { status: 200, json: {} };
      res.writeHead(out.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    port,
    url: `https://127.0.0.1:${port}`,
    requests,
    stop: () => new Promise((r) => server.close(r)),
  };
}
