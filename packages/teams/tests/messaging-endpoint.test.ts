import { describe, expect, it } from "vitest";
import {
  buildMessagingEndpointUrl,
  describeMessagingEndpoint,
  isNonRoutableHost,
  messagingWebhookPath,
  PLUGIN_WEBHOOK_PATH_PREFIX,
} from "../src/messaging-endpoint.js";

const PLUGIN = "dexwox.teams-chatos";
const KEY = "bot-messages";

describe("messagingWebhookPath", () => {
  it("builds the fixed host route", () => {
    expect(messagingWebhookPath(PLUGIN, KEY)).toBe(`${PLUGIN_WEBHOOK_PATH_PREFIX}/${PLUGIN}/webhooks/${KEY}`);
  });
  it("percent-encodes unusual segments (defensive; no-op for normal ids)", () => {
    expect(messagingWebhookPath("a b", "c/d")).toBe("/api/plugins/a%20b/webhooks/c%2Fd");
  });
});

describe("isNonRoutableHost", () => {
  it("flags loopback / private / link-local / internal names", () => {
    for (const h of [
      "localhost",
      "app.localhost",
      "teams-bot.local",
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "192.168.1.10",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.1.1",
      "::1",
      "[::1]",
      "fd00::1",
      "fc00::abcd",
      "",
    ]) {
      expect(isNonRoutableHost(h), h).toBe(true);
    }
  });
  it("treats public hosts/IPs as routable", () => {
    for (const h of ["teams-bot.example.com", "203.0.113.7", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
      expect(isNonRoutableHost(h), h).toBe(false);
    }
  });
});

describe("buildMessagingEndpointUrl", () => {
  it("builds the full public URL from an https origin", () => {
    const r = buildMessagingEndpointUrl("https://teams-bot.example.com", PLUGIN, KEY);
    expect(r).toEqual({ ok: true, url: `https://teams-bot.example.com/api/plugins/${PLUGIN}/webhooks/${KEY}`, path: `/api/plugins/${PLUGIN}/webhooks/${KEY}` });
  });
  it("preserves a base-path prefix and port, collapsing trailing slashes", () => {
    const r = buildMessagingEndpointUrl("https://host.example.com:8443/paperclip/", PLUGIN, KEY);
    expect(r).toEqual({ ok: true, url: `https://host.example.com:8443/paperclip/api/plugins/${PLUGIN}/webhooks/${KEY}`, path: `/api/plugins/${PLUGIN}/webhooks/${KEY}` });
  });
  it("rejects empty, invalid, non-HTTPS, and non-routable origins with a reason", () => {
    expect(buildMessagingEndpointUrl("", PLUGIN, KEY)).toMatchObject({ ok: false });
    expect(buildMessagingEndpointUrl("   ", PLUGIN, KEY)).toMatchObject({ ok: false });
    expect(buildMessagingEndpointUrl("not a url", PLUGIN, KEY)).toMatchObject({ ok: false });
    expect(buildMessagingEndpointUrl("http://teams-bot.example.com", PLUGIN, KEY).ok).toBe(false); // must be HTTPS
    expect(buildMessagingEndpointUrl("https://localhost:3100", PLUGIN, KEY).ok).toBe(false);
    expect(buildMessagingEndpointUrl("https://127.0.0.1", PLUGIN, KEY).ok).toBe(false);
  });
  it("HTTPS rejection reason names the TLS/self-signed requirement", () => {
    const r = buildMessagingEndpointUrl("http://teams-bot.example.com", PLUGIN, KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTPS/);
  });
});

describe("describeMessagingEndpoint", () => {
  it("configured:false + path present when no origin is set", () => {
    const info = describeMessagingEndpoint("", PLUGIN, KEY);
    expect(info).toMatchObject({ configured: false, ok: false, path: `/api/plugins/${PLUGIN}/webhooks/${KEY}` });
    expect(info.url).toBeUndefined();
    expect(info.reason).toBeTruthy();
  });
  it("configured:true + ok:false when an origin is set but invalid", () => {
    const info = describeMessagingEndpoint("https://localhost", PLUGIN, KEY);
    expect(info).toMatchObject({ configured: true, ok: false });
    expect(info.reason).toMatch(/routable/);
  });
  it("ok:true with the full URL for a valid public origin", () => {
    const info = describeMessagingEndpoint("https://teams-bot.example.com", PLUGIN, KEY);
    expect(info).toMatchObject({ configured: true, ok: true, url: `https://teams-bot.example.com/api/plugins/${PLUGIN}/webhooks/${KEY}` });
  });
});
