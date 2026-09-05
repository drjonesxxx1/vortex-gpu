import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "./helpers/harness.js";
import { get } from "./helpers/http.js";

describe("harness / health", () => {
  const srv = useServer();

  it("boots a throwaway gateway that is not the production one", async () => {
    assert.notEqual(srv.port, 3000, "must never bind the live port");
    assert.match(srv.dbPath, /vortex-test-/, "must never use data/vortex.db");
  });

  it("GET /api/health advertises config, not hardcoded copy", async () => {
    const r = await get(srv, "/api/health");
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.sessionNode, "testnode");
    assert.equal(r.json.sessionNodeOnline, false);
    assert.equal(r.json.minFreeVramMb, 2048);
    assert.equal(r.json.priceUsdPerHour, 1);
    assert.equal(typeof r.json.windowsLabel, "string");
    assert.equal(typeof r.json.linuxLabel, "string");
  });

  it("API responses are never cached", async () => {
    const r = await get(srv, "/api/health");
    assert.equal(r.headers.get("cache-control"), "no-store");
  });
});
