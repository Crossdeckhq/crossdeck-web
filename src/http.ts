/**
 * HTTP transport for the SDK. Single fetch wrapper used by every endpoint
 * call. Adds the Bearer token and SDK version header, parses responses,
 * normalises errors to CrossdeckError.
 *
 * Uses platform-native fetch (browser + Node 18+). No axios, no isomorphic-
 * fetch shim, no transitive deps.
 */

import { CrossdeckError, crossdeckErrorFromResponse } from "./errors";

export const SDK_NAME = "@cross-deck/web";
export const SDK_VERSION = "0.3.0";
export const DEFAULT_BASE_URL = "https://api.cross-deck.com/v1";

export interface HttpClientConfig {
  publicKey: string;
  baseUrl: string;
  sdkVersion: string;
}

export class HttpClient {
  constructor(private readonly config: HttpClientConfig) {}

  /**
   * Issue a request. `path` is relative to the configured baseUrl
   * ("/entitlements", "/identity/alias", etc.).
   *
   * Throws CrossdeckError on:
   *   - Network failure (`type: "network_error"`)
   *   - Non-2xx response (typed from the body envelope)
   *   - JSON parse failure on a 2xx (treated as `internal_error`)
   */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; query?: Record<string, string | undefined> } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.publicKey}`,
      "Crossdeck-Sdk-Version": `${SDK_NAME}@${this.config.sdkVersion}`,
      Accept: "application/json",
    };
    let bodyInit: BodyInit | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyInit = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: bodyInit,
      });
    } catch (err) {
      throw new CrossdeckError({
        type: "network_error",
        code: "fetch_failed",
        message: err instanceof Error ? err.message : "fetch failed",
      });
    }

    if (!response.ok) {
      throw await crossdeckErrorFromResponse(response);
    }

    // 204 No Content / OPTIONS-like — return undefined cast as T (callers
    // that don't expect a body shouldn't read it).
    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new CrossdeckError({
        type: "internal_error",
        code: "invalid_json_response",
        message: "Server returned a 2xx with an unparseable body.",
        requestId: response.headers.get("x-request-id") ?? undefined,
        status: response.status,
      });
    }
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    let url = base + cleanPath;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (typeof v === "string" && v.length > 0) params.append(k, v);
      }
      const qs = params.toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    return url;
  }
}
