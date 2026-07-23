/**
 * Schema-lock test for `crossdeck.contract_failed`.
 *
 * The Web SDK's reportContractFailure(...) must:
 *   1. Send a payload whose keys are exactly the allowed-fields set
 *      (required ∪ optional) from
 *      contracts/diagnostics/contract-failed-payload-schema-lock.json.
 *   2. Route to `/v1/events` (the same endpoint customer cd.track()
 *      uses) UNDER THE HARDCODED RELIABILITY PUBLISHABLE KEY — so
 *      the event lands in the Crossdeck reliability project's events
 *      warehouse, NOT in the customer's project. The hardcoded key is
 *      the structural guarantee that customer-side telemetry stays
 *      isolated from CD-side reliability telemetry.
 *   3. NEVER include any forbidden field even if the caller's input
 *      were to carry one.
 *
 * Pre-2026-05-28 the endpoint was `/v1/sdk/diagnostic` (a CD-specific
 * write into a top-level `sdkDiagnostics` collection). That collection
 * had no dashboard surface, so failures piled up invisibly. The new
 * routing reuses the customer-events pipeline — failures appear in
 * the Crossdeck project's events-explorer / event-breakdown / alerts
 * like any other custom event.
 *
 * The schema-lock contract is the structural defence behind the
 * independent-controller flow in Privacy Policy §6 — these tests
 * fail loudly the moment the wire shape drifts.
 */

import { describe, it, expect } from "vitest";
import {
  DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS,
  DIAGNOSTIC_TELEMETRY_ENDPOINT,
  DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY,
  filterDiagnosticPayload,
} from "../src/_diagnostic-telemetry";
import { BUNDLED_CONTRACTS } from "../src/_contracts-bundled";

// The schema-lock contract ships INSIDE the SDK — `_contracts-bundled.ts`
// is generated at build time from
// contracts/diagnostics/contract-failed-payload-schema-lock.json. Read
// the SHIPPED copy, not the monorepo source path: `../../../contracts/`
// exists in the monorepo but NOT in the standalone published repo (the
// mirror ships only the SDK), so the old require() broke the publish
// workflow's test gate. Reading the bundled copy keeps this test
// self-contained within the package and tests exactly what customers get.
interface SchemaLockFields {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly forbidden: readonly string[];
}
const contract = BUNDLED_CONTRACTS.find(
  (c) => c.id === "contract-failed-payload-schema-lock",
) as ((typeof BUNDLED_CONTRACTS)[number] & { allowedFields: SchemaLockFields }) | undefined;

if (!contract) {
  throw new Error(
    "bundled contract 'contract-failed-payload-schema-lock' missing — run `npm run build` to regenerate src/_contracts-bundled.ts",
  );
}

describe("contract-failed schema-lock — Web", () => {
  describe("DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS mirrors the contract", () => {
    it("matches required ∪ optional from contracts/diagnostics/contract-failed-payload-schema-lock.json", () => {
      const fromContract = new Set<string>([
        ...contract.allowedFields.required,
        ...contract.allowedFields.optional,
      ]);
      expect(new Set(DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS)).toEqual(fromContract);
    });

    it("does not contain any forbidden field", () => {
      for (const forbidden of contract.allowedFields.forbidden) {
        expect(DIAGNOSTIC_TELEMETRY_ALLOWED_KEYS.has(forbidden)).toBe(false);
      }
    });
  });

  describe("reportContractFailure payload conforms to schema-lock", () => {
    it("strips every forbidden field from the payload before send", () => {
      // filterDiagnosticPayload is what runs immediately before the
      // network IO — verifying its behaviour is what protects the
      // independent-controller legitimate-interest basis.
      const filtered = filterDiagnosticPayload({
        contract_id: "test-contract",
        sdk_version: "1.0.0",
        sdk_platform: "web",
        failure_reason: "test failure",
        run_context: "ci",
        run_id: "run_123",
        // Forbidden — must be stripped.
        anonymousId: "anon_12345",
        ip: "1.2.3.4",
        email: "user@example.com",
        stack_trace: "Error\n  at foo (bar.js:1:1)",
        user_agent: "Mozilla/5.0",
        session_id: "sess_abc",
      } as Record<string, string>);

      for (const forbidden of contract.allowedFields.forbidden) {
        expect(filtered).not.toHaveProperty(forbidden);
      }
      // And the required fields are preserved.
      for (const required of contract.allowedFields.required) {
        expect(filtered).toHaveProperty(required);
      }
    });

    it("preserves optional fields when present", () => {
      const filtered = filterDiagnosticPayload({
        contract_id: "test-contract",
        sdk_version: "1.0.0",
        sdk_platform: "web",
        failure_reason: "test failure",
        run_context: "ci",
        run_id: "run_123",
        test_file: "tests/foo.test.ts",
        test_name: "fails when X",
        device_class: "desktop",
        verification_phase: "hot_path",
      });
      expect(filtered.test_file).toBe("tests/foo.test.ts");
      expect(filtered.test_name).toBe("fails when X");
      expect(filtered.device_class).toBe("desktop");
      expect(filtered.verification_phase).toBe("hot_path");
    });

    it("verification_phase is in the schema-lock optional set", () => {
      expect(contract.allowedFields.optional).toContain("verification_phase");
    });

    it("routes to /v1/events under the hardcoded reliability key", () => {
      // Defensive: contract failures ride the customer-events pipeline
      // SHAPE (POST /v1/events with { events: [...] }) but auth under
      // the hardcoded Crossdeck reliability publishable key. The
      // backend resolves that key to the Crossdeck reliability project
      // — failures land in CD's project's warehouse, not the
      // customer's, even though they travel through the same endpoint.
      // If anyone strips the hardcoded key (or repoints to a customer-
      // bearing HTTP client), customer-side reliability data would
      // leak into the customer's warehouse — this test fails first.
      expect(DIAGNOSTIC_TELEMETRY_ENDPOINT).toBe(
        "https://api.cross-deck.com/v1/events",
      );
      expect(DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY).toMatch(/^cd_pub_live_/);
      // The reliability key is a HARDCODED LITERAL — proves auth never
      // resolves through customer configuration. The exact value is
      // pinned so a key-rotation is a visible diff.
      expect(DIAGNOSTIC_TELEMETRY_PUBLISHABLE_KEY).toBe(
        "cd_pub_live_eea2f84dbb834a45b7",
      );
    });
  });
});
