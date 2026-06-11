// Phase 6.2 contract tests — backend-emitted codes are present in
// the SDK error-codes catalogue.
//
// Pre-v1.4.0 a developer hitting `invalid_api_key` on the wire
// looked up the code via getErrorCode("invalid_api_key") and got
// undefined — no remediation guidance, just a freeform message
// string they had to grep through. The catalogue documented codes
// the SDK throws ITSELF but ZERO of the codes the BACKEND emits.

import { describe, it, expect } from "vitest";
import { CROSSDECK_ERROR_CODES, getErrorCode } from "../src/error-codes";

describe("error-codes catalogue backfill (Phase 6.2)", () => {
  // Backend-emitted codes the SDK MUST document.
  // Source of truth: backend/src/api/v1-errors.ts ApiErrorCode.
  const backendCodes = [
    "missing_api_key",
    "invalid_api_key",
    "key_revoked",
    "identity_token_invalid",
    "origin_not_allowed",
    "bundle_id_not_allowed",
    "package_name_not_allowed",
    "env_mismatch",
    "idempotency_key_in_use",
    "rate_limited",
    "internal_error",
    "google_not_supported",
    "stripe_not_supported",
    "missing_required_param",
    "invalid_param_value",
    "sdk_version_unsupported",
  ];

  it.each(backendCodes)("includes backend code %s with remediation", (code) => {
    const entry = getErrorCode(code);
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(code);
    expect(entry!.description.length).toBeGreaterThan(20);
    expect(entry!.resolution.length).toBeGreaterThan(20);
  });

  it("invalid_api_key resolution points at the dashboard", () => {
    const entry = getErrorCode("invalid_api_key");
    expect(entry?.resolution.toLowerCase()).toMatch(/dashboard|api keys/);
  });

  it("idempotency_key_in_use resolution mentions Stripe-grade contract", () => {
    const entry = getErrorCode("idempotency_key_in_use");
    expect(entry?.resolution.toLowerCase()).toMatch(/v1\.4\.0|deterministic|body/);
  });

  it("rate_limited is marked retryable: true", () => {
    expect(getErrorCode("rate_limited")?.retryable).toBe(true);
  });

  it("key_revoked is NOT retryable (operator action required)", () => {
    expect(getErrorCode("key_revoked")?.retryable).toBe(false);
  });

  it("identity-lock codes carry permission_error type", () => {
    expect(getErrorCode("origin_not_allowed")?.type).toBe("permission_error");
    expect(getErrorCode("bundle_id_not_allowed")?.type).toBe("permission_error");
    expect(getErrorCode("package_name_not_allowed")?.type).toBe("permission_error");
    expect(getErrorCode("env_mismatch")?.type).toBe("permission_error");
  });

  it("no entry has an empty description or resolution", () => {
    for (const entry of CROSSDECK_ERROR_CODES) {
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.resolution.trim().length).toBeGreaterThan(0);
    }
  });
});
