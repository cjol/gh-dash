import type { Env } from "./mirror";

export { GitHubMirror } from "./mirror";

function mirror(env: Env) {
  return env.MIRROR.get(env.MIRROR.idFromName("mirror"));
}

function authorized(request: Request, env: Env): boolean {
  if (!env.DASHBOARD_PASSWORD) return true;
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = atob(header.slice(6));
  const password = decoded.slice(decoded.indexOf(":") + 1);
  // Constant-time-ish comparison; the password is short and this is a personal dashboard.
  if (password.length !== env.DASHBOARD_PASSWORD.length) return false;
  let diff = 0;
  for (let i = 0; i < password.length; i++) diff |= password.charCodeAt(i) ^ env.DASHBOARD_PASSWORD.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!authorized(request, env)) {
      return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="team dashboard"' } });
    }
    const url = new URL(request.url);
    // Wiping the mirror is only exposed when the site is password-protected.
    if (url.pathname === "/api/reset" && !env.DASHBOARD_PASSWORD) return new Response("reset needs DASHBOARD_PASSWORD set", { status: 403 });
    if (url.pathname.startsWith("/api/")) return mirror(env).fetch(request);
    return env.ASSETS.fetch(request);
  },

  // Belt and braces: the mirror runs on its own alarm, this just makes sure the alarm exists
  // (e.g. right after a fresh deploy, before anyone has opened the page).
  async scheduled(_event, env): Promise<void> {
    await mirror(env).fetch("https://mirror/api/ensure-alarm", { method: "POST" });
  },
} satisfies ExportedHandler<Env>;
