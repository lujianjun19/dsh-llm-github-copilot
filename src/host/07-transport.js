//#region transport
/**
 * Copilot request transport. GitHub serves the full Copilot model catalog
 * (Claude included) only to connections that arrive through the environment's
 * proxy egress. The undici `ProxyAgent` routes each request through
 * `https_proxy`/`HTTPS_PROXY`/`http_proxy`/`HTTP_PROXY` (+ `NO_PROXY`) at
 * runtime — no launch flag needed — and falls back to the global fetch when
 * no proxy applies. A hand-rolled CONNECT tunnel is deliberately NOT used:
 * on mixed-mode proxies it bypasses the proxy egress and GitHub then serves
 * a reduced catalog.
 */
import undici from "undici";
const ProxyAgent = undici.ProxyAgent;
let proxyDispatcherCache;
function resolveHttpProxy() {
  const order = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];
  for (const key of order) {
    const value = process.env[key];
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return value;
    } catch {}
  }
  return void 0;
}
function isProxyBypassed(hostname) {
  const raw = process.env.no_proxy ?? process.env.NO_PROXY;
  if (!raw) return false;
  const host = hostname.toLowerCase();
  return raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.includes("/")) return false; // CIDR ranges are not supported
    const base = pattern.startsWith(".") ? pattern.slice(1) : pattern;
    return host === base || host.endsWith("." + base);
  });
}
/** A cached undici ProxyAgent for the current proxy URL, or undefined when no proxy applies. */
function proxyDispatcher() {
  const url = resolveHttpProxy();
  if (url === void 0) return void 0;
  if (proxyDispatcherCache !== void 0 && proxyDispatcherCache.url === url) return proxyDispatcherCache.agent;
  const agent = new ProxyAgent(url);
  proxyDispatcherCache = { url, agent };
  return agent;
}
async function copilotFetch(url, init = {}) {
  const target = new URL(url);
  const dispatcher = target.protocol === "https:" && !isProxyBypassed(target.hostname) ? proxyDispatcher() : void 0;
  if (dispatcher === void 0) return fetch(url, init);
  return fetch(url, { ...init, dispatcher });
}
//#endregion

