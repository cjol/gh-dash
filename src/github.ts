import type { Sql } from "./db";

/**
 * Minimal GitHub REST client for the sync: auth (GitHub App installation tokens, a plain token, or
 * anonymous), conditional requests backed by the mirror's ETag table, Link-header pagination and
 * rate-limit bookkeeping.
 */

export interface AuthEnv {
  GITHUB_APP_ID?: string;
  /** PEM, PKCS#1 ("BEGIN RSA PRIVATE KEY", as GitHub issues them) or PKCS#8. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Optional: skip installation discovery. */
  GITHUB_APP_INSTALLATION_ID?: string;
  /** Fallback when no App is configured (fine for local testing). */
  GITHUB_TOKEN?: string;
}

export type AuthMode = "app" | "token" | "anonymous";

export class RateLimitedError extends Error {
  constructor(public resetAt: string | undefined, message: string) {
    super(message);
  }
}

export class RequestBudgetError extends Error {
  constructor(max: number) {
    super(`per-run request budget of ${max} used up; the next run continues`);
  }
}

export class GitHubError extends Error {
  constructor(public status: number, public url: string, message: string) {
    super(`GitHub ${status} for ${url}: ${message}`);
  }
}

export interface PageResult<T> {
  /** false when the first page came back 304: nothing changed since the stored ETag. */
  changed: boolean;
  items: T[];
  /** ETag of a single-page listing (already stored unless `deferEtag` was set). */
  etag?: string;
}

const API = "https://api.github.com";

export class GitHub {
  requests = 0;
  notModified = 0;
  rateRemaining: number | undefined;
  rateLimit: number | undefined;
  rateReset: string | undefined;
  /** Stop issuing requests when the remaining budget drops to this. */
  reserve: number;
  /** Per-run cap on requests (Workers limits subrequests per invocation); the next run resumes. */
  maxRequests = Infinity;

  private installationTokens = new Map<string, { token: string; expiresAt: number }>();
  private installationIds = new Map<string, string>();

  constructor(
    private env: AuthEnv,
    private sql: Sql,
    private fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.reserve = this.authMode === "anonymous" ? 2 : 50;
  }

  get authMode(): AuthMode {
    if (this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY) return "app";
    if (this.env.GITHUB_TOKEN) return "token";
    return "anonymous";
  }

  /** True when the remaining rate budget is too low to keep going this run. */
  get exhausted(): boolean {
    return this.rateRemaining !== undefined && this.rateRemaining <= this.reserve;
  }

  /** GET one URL. With `conditional`, sends the stored ETag and returns null on 304. */
  async get<T>(pathOrUrl: string, opts: { owner: string; conditional?: boolean }): Promise<{ data: T; next?: string; etag?: string } | null> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
    if (this.requests >= this.maxRequests) throw new RequestBudgetError(this.maxRequests);
    if (this.exhausted) {
      throw new RateLimitedError(this.rateReset, `rate budget exhausted (${this.rateRemaining} left, reserve ${this.reserve})`);
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "team-activity-dashboard",
    };
    const auth = await this.authHeader(opts.owner);
    if (auth) headers.authorization = auth;
    if (opts.conditional) {
      const etag = this.sql.exec<{ etag: string }>(`SELECT etag FROM http_cache WHERE url = ?`, url)[0]?.etag;
      if (etag) headers["if-none-match"] = etag;
    }

    const res = await this.fetchImpl(url, { headers });
    this.requests++;
    this.trackRate(res.headers);

    if (res.status === 304) {
      this.notModified++;
      return null;
    }
    if (res.status === 403 || res.status === 429) {
      const body = await res.text();
      if (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after") || /rate limit/i.test(body)) {
        const retryAfter = res.headers.get("retry-after");
        const resetAt = retryAfter ? new Date(Date.now() + Number(retryAfter) * 1000).toISOString() : this.rateReset;
        throw new RateLimitedError(resetAt, `GitHub rate limited (${res.status}) on ${url}: ${body.slice(0, 200)}`);
      }
      throw new GitHubError(res.status, url, body.slice(0, 300));
    }
    if (!res.ok) throw new GitHubError(res.status, url, (await res.text()).slice(0, 300));

    const data = (await res.json()) as T;
    return { data, next: parseNextLink(res.headers.get("link")), etag: res.headers.get("etag") ?? undefined };
  }

  /**
   * GET every page of a listing. With `conditional`, the first page is sent with the stored ETag; a
   * 304 short-circuits to `{ changed: false }`. The ETag is only kept when the whole listing fit on
   * one page, since a 304 on page 1 says nothing about later pages.
   */
  async paginate<T>(path: string, opts: { owner: string; conditional?: boolean; maxPages?: number; stop?: (page: T[]) => boolean; deferEtag?: boolean }): Promise<PageResult<T>> {
    const firstUrl = path.startsWith("http") ? path : API + path;
    const items: T[] = [];
    let url: string | undefined = firstUrl;
    let pages = 0;
    let singlePageEtag: string | undefined;
    while (url) {
      const res: { data: T[]; next?: string; etag?: string } | null = await this.get<T[]>(url, {
        owner: opts.owner,
        conditional: opts.conditional && pages === 0,
      });
      if (res === null) return { changed: false, items: [] };
      items.push(...res.data);
      pages++;
      if (pages === 1 && !res.next) singlePageEtag = res.etag;
      if (opts.stop?.(res.data)) break;
      if (opts.maxPages && pages >= opts.maxPages) break;
      url = res.next;
    }
    if (opts.conditional) {
      // Always forget a stale ETag now; with deferEtag the caller stores the new one once it has
      // finished acting on the response, so an interrupted run doesn't 304 its way past the work.
      this.sql.exec(`DELETE FROM http_cache WHERE url = ?`, firstUrl);
      if (singlePageEtag && !opts.deferEtag) this.storeEtag(firstUrl, singlePageEtag);
    }
    return { changed: true, items, etag: singlePageEtag };
  }

  storeEtag(pathOrUrl: string, etag: string | undefined): void {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
    if (!etag) return;
    this.sql.exec(
      `INSERT INTO http_cache (url, etag, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (url) DO UPDATE SET etag = excluded.etag, updated_at = excluded.updated_at`,
      url, etag, new Date().toISOString(),
    );
  }

  private trackRate(h: Headers): void {
    const remaining = h.get("x-ratelimit-remaining");
    // 304s carry the headers too; only the core resource matters here.
    if (remaining !== null && (h.get("x-ratelimit-resource") ?? "core") === "core") {
      this.rateRemaining = Number(remaining);
      this.rateLimit = Number(h.get("x-ratelimit-limit") ?? NaN);
      const reset = h.get("x-ratelimit-reset");
      if (reset) this.rateReset = new Date(Number(reset) * 1000).toISOString();
    }
  }

  private async authHeader(owner: string): Promise<string | undefined> {
    switch (this.authMode) {
      case "app":
        return `token ${await this.installationToken(owner)}`;
      case "token":
        return `Bearer ${this.env.GITHUB_TOKEN}`;
      default:
        return undefined;
    }
  }

  private async installationToken(owner: string): Promise<string> {
    const installationId = this.env.GITHUB_APP_INSTALLATION_ID || (await this.findInstallation(owner));
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const res = await this.fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: await this.appHeaders(),
    });
    if (!res.ok) throw new GitHubError(res.status, "installation token", (await res.text()).slice(0, 300));
    const body = (await res.json()) as { token: string; expires_at: string };
    this.installationTokens.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  private async findInstallation(owner: string): Promise<string> {
    const known = this.installationIds.get(owner);
    if (known) return known;
    const headers = await this.appHeaders();
    // An owner's installation covers all of its repos the App is granted; try org then user.
    for (const path of [`/orgs/${owner}/installation`, `/users/${owner}/installation`]) {
      const res = await this.fetchImpl(API + path, { headers });
      if (res.ok) {
        const id = String(((await res.json()) as { id: number }).id);
        this.installationIds.set(owner, id);
        return id;
      }
    }
    throw new Error(`GitHub App ${this.env.GITHUB_APP_ID} is not installed for ${owner}`);
  }

  private async appHeaders(): Promise<Record<string, string>> {
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "team-activity-dashboard",
      authorization: `Bearer ${await appJwt(this.env.GITHUB_APP_ID!, this.env.GITHUB_APP_PRIVATE_KEY!)}`,
    };
  }
}

export function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return undefined;
}

// --- GitHub App JWT (RS256 via WebCrypto) ---

let keyCache: { pem: string; key: CryptoKey } | undefined;

export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  if (keyCache?.pem !== pem) {
    const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    keyCache = { pem, key };
  }
  const iat = Math.floor(now / 1000) - 60; // allow for clock drift
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat, exp: iat + 540, iss: appId })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyCache.key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** GitHub hands out PKCS#1 keys; WebCrypto only imports PKCS#8, so wrap PKCS#1 in a PKCS#8 envelope. */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n");
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const b64 = normalized.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (!isPkcs1) return der.buffer;
  // PrivateKeyInfo ::= SEQUENCE { INTEGER 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(der.length), ...der];
  const body = [...version, ...algId, ...octet];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]).buffer;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}
