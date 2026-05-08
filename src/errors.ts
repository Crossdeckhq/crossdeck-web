/**
 * Stripe-style error wrapper for @cross-deck/web.
 *
 * Mirrors the wire shape returned by the v1 backend (see
 * backend/src/api/v1-errors.ts) so SDK consumers can `catch`
 * with consistent fields:
 *
 *   try {
 *     await crossdeck.identify("user_847");
 *   } catch (err) {
 *     if (err instanceof CrossdeckError && err.code === "invalid_api_key") {
 *       // ...
 *     }
 *   }
 */

export type CrossdeckErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "rate_limit_error"
  | "internal_error"
  | "network_error"
  | "configuration_error";

export interface CrossdeckErrorPayload {
  type: CrossdeckErrorType;
  code: string;
  message: string;
  /** Server-issued request ID. Echoed in support tickets. */
  requestId?: string;
  /** HTTP status code if the error came from an API response. */
  status?: number;
}

export class CrossdeckError extends Error {
  public readonly type: CrossdeckErrorType;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly status?: number;

  constructor(payload: CrossdeckErrorPayload) {
    super(payload.message);
    this.name = "CrossdeckError";
    this.type = payload.type;
    this.code = payload.code;
    this.requestId = payload.requestId;
    this.status = payload.status;
    // Restore prototype chain — needed when targeting ES5.
    Object.setPrototypeOf(this, CrossdeckError.prototype);
  }
}

/**
 * Build a CrossdeckError from a non-OK fetch Response. Reads the
 * Stripe-style envelope { error: { type, code, message, request_id } }.
 * Falls back to a generic shape if the body isn't valid JSON.
 */
export async function crossdeckErrorFromResponse(res: Response): Promise<CrossdeckError> {
  const requestId = res.headers.get("x-request-id") ?? undefined;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const envelope = (body as { error?: Partial<CrossdeckErrorPayload> & { request_id?: string } })?.error;
  if (envelope && typeof envelope.type === "string" && typeof envelope.code === "string") {
    return new CrossdeckError({
      type: envelope.type as CrossdeckErrorType,
      code: envelope.code,
      message: envelope.message ?? `HTTP ${res.status}`,
      requestId: envelope.request_id ?? requestId,
      status: res.status,
    });
  }
  return new CrossdeckError({
    type: typeMapForStatus(res.status),
    code: `http_${res.status}`,
    message: `HTTP ${res.status} ${res.statusText || ""}`.trim(),
    requestId,
    status: res.status,
  });
}

function typeMapForStatus(status: number): CrossdeckErrorType {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "internal_error";
}
