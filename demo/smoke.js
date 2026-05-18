/**
 * Smoke-test driver for sdks/web/demo/index.html.
 *
 * Wires every button to the BUILT SDK loaded from
 * ../dist/crossdeck.umd.min.js. Intercepts window.fetch to render the
 * Network pane (so you can verify Idempotency-Key, retry behaviour,
 * consent gating without leaving the page).
 *
 * Pure DOM + vanilla JS — zero framework dep. The page IS the test.
 *
 * Pulls the SDK from the same artefact the npm package would ship,
 * so a green run here is a green run for real consumers. Nothing in
 * this file is published; the dist is built by `npm run build`
 * before opening this page.
 */

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ============================================================
  // Global Crossdeck instance — exported by the UMD bundle.
  // ============================================================
  const Crossdeck = window.Crossdeck && window.Crossdeck.Crossdeck;
  if (!Crossdeck) {
    document.body.innerHTML =
      '<div style="padding:40px;color:#ef4444;font-family:monospace;">' +
      'Crossdeck failed to load. Run <code>npm run build</code> in sdks/web/ first, ' +
      'then reload this page.</div>';
    return;
  }

  // ============================================================
  // Logging — append-only console in the right sidebar.
  // ============================================================
  const logEl = $("#log-pane");
  let logEmpty = true;
  function log(level, msg) {
    if (logEmpty) {
      logEl.innerHTML = "";
      logEmpty = false;
    }
    const time = new Date().toLocaleTimeString();
    const row = document.createElement("div");
    row.className = `log-line log-${level}`;
    row.innerHTML = `<span class="log-time">${time}</span><span class="log-msg"></span>`;
    row.querySelector(".log-msg").textContent = msg;
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ============================================================
  // Network interceptor — every fetch() shows up in the pane.
  // ============================================================
  const netEl = $("#network-pane");
  let netEmpty = true;
  const origFetch = window.fetch.bind(window);
  // The SDK is going to issue cross-origin fetch() to api.cross-deck.com.
  // We wrap globally so requests show up regardless of which layer made them.
  window.fetch = async function wrappedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = (init?.method || "GET").toUpperCase();
    const idem = init?.headers?.["Idempotency-Key"] || init?.headers?.["idempotency-key"];
    let response;
    let status = "?";
    let ok = false;
    try {
      response = await origFetch(input, init);
      status = String(response.status);
      ok = response.ok;
    } catch (err) {
      status = "ERR";
      ok = false;
      renderNet({ method, url, status, ok, idem });
      throw err;
    }
    renderNet({ method, url, status, ok, idem });
    return response;
  };

  function renderNet({ method, url, status, ok, idem }) {
    if (netEmpty) {
      netEl.innerHTML = "";
      netEmpty = false;
    }
    // Trim URL to the path for readability.
    let displayUrl = url;
    try {
      const u = new URL(url, window.location.href);
      displayUrl = u.pathname + (u.search || "");
    } catch (_) {
      // keep raw
    }
    const idemBadge = idem
      ? ` <span style="color:#a3a3a3;font-size:10.5px;">idem=${idem.slice(0, 18)}…</span>`
      : "";
    const row = document.createElement("div");
    row.className = `net-row ${ok ? "net-ok" : "net-err"}`;
    row.innerHTML = `
      <span class="net-method">${method}</span>
      <span class="net-path">${escapeHtml(displayUrl)}${idemBadge}</span>
      <span class="net-status">${status}</span>
    `;
    netEl.appendChild(row);
    netEl.scrollTop = netEl.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // ============================================================
  // Sidebar tab switching.
  // ============================================================
  $$(".sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".sidebar-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      $$(".sidebar-pane").forEach((p) => {
        p.hidden = p.id !== tab.dataset.pane;
      });
    });
  });

  // ============================================================
  // Diagnostics tick — refresh the right panel every 1s once init().
  // ============================================================
  const diagOut = $("#diag-output");
  const sdkStatusEl = $("#sdk-status");
  const sdkDotEl = $("#sdk-status-dot");
  let initialized = false;

  setInterval(() => {
    if (!initialized) return;
    try {
      const d = Crossdeck.diagnostics();
      diagOut.textContent = JSON.stringify(d, null, 2);
      if (d.started) {
        sdkStatusEl.textContent = `started · ${d.events.buffered} buffered · ${d.events.consecutiveFailures} retries`;
        sdkDotEl.className = d.events.lastError ? "status-dot is-warn" : "status-dot is-ok";
      }
    } catch (err) {
      diagOut.textContent = `diagnostics() threw: ${err.message}`;
    }
  }, 1000);

  // ============================================================
  // Wire actions.
  // ============================================================
  function tryRun(label, fn) {
    try {
      const r = fn();
      log("ok", `${label} OK`);
      return r;
    } catch (err) {
      log("err", `${label} FAILED: ${err.message}`);
      return null;
    }
  }

  async function tryRunAsync(label, fn) {
    try {
      const r = await fn();
      log("ok", `${label} OK`);
      return r;
    } catch (err) {
      log("err", `${label} FAILED: ${err.message}`);
      return null;
    }
  }

  // -------- 1. init ----------
  $("#btn-init").addEventListener("click", () => {
    const appId = $("#cfg-appId").value.trim();
    const key = $("#cfg-key").value.trim();
    const env = $("#cfg-env").value;
    const baseUrl = $("#cfg-base").value;
    if (!appId || !key) {
      log("err", "App ID + publishable key are required to init.");
      return;
    }
    tryRun("init()", () => {
      Crossdeck.init({ appId, publicKey: key, environment: env, baseUrl, debug: true });
      initialized = true;
      sdkDotEl.className = "status-dot is-ok";
      sdkStatusEl.textContent = "started";
    });
  });

  $("#btn-warm").addEventListener("click", () => {
    tryRunAsync("getEntitlements()", () => Crossdeck.getEntitlements());
  });

  // -------- 2. identity ----------
  $("#btn-identify").addEventListener("click", () => {
    const userId = $("#id-userId").value.trim();
    if (!userId) {
      log("err", "User ID required for identify().");
      return;
    }
    let traits;
    try {
      traits = JSON.parse($("#id-traits").value || "{}");
    } catch (err) {
      log("err", `Invalid traits JSON: ${err.message}`);
      return;
    }
    tryRunAsync("identify()", () => Crossdeck.identify(userId, { traits }));
  });

  $("#btn-reset").addEventListener("click", () => {
    tryRun("reset()", () => Crossdeck.reset());
  });

  $("#btn-register").addEventListener("click", () => {
    let props;
    try {
      props = JSON.parse($("#id-super").value || "{}");
    } catch (err) {
      log("err", `Invalid super-properties JSON: ${err.message}`);
      return;
    }
    tryRun("register()", () => Crossdeck.register(props));
  });

  $("#btn-unregister").addEventListener("click", () => {
    tryRun('unregister("releaseChannel")', () => Crossdeck.unregister("releaseChannel"));
  });

  $("#btn-group").addEventListener("click", () => {
    const type = $("#grp-type").value.trim();
    const id = $("#grp-id").value.trim();
    if (!type || !id) {
      log("err", "Group type and id required.");
      return;
    }
    tryRun(`group("${type}", "${id}")`, () => Crossdeck.group(type, id));
  });

  $("#btn-ungroup").addEventListener("click", () => {
    const type = $("#grp-type").value.trim();
    tryRun(`group("${type}", null)`, () => Crossdeck.group(type, null));
  });

  // -------- 3. track ----------
  $("#btn-track-simple").addEventListener("click", () => {
    tryRun("track('paywall_viewed')", () =>
      Crossdeck.track("paywall_viewed", { variant: "v3" }),
    );
  });

  $("#btn-track-poison").addEventListener("click", () => {
    const circular = { name: "ring" };
    circular.self = circular;
    tryRun("track('poison')", () =>
      Crossdeck.track("poison_test", {
        fn: () => 0,
        sym: Symbol("x"),
        big: 9007199254740993n,
        when: new Date(),
        err: new Error("test err"),
        huge: "x".repeat(5000),
        nan: NaN,
        circular,
      }),
    );
    log("info", "Inspect Network tab — payload should have all values sanitised, no JSON.stringify crash.");
  });

  $("#btn-track-burst").addEventListener("click", () => {
    for (let i = 0; i < 25; i++) {
      Crossdeck.track("burst_event", { i });
    }
    log("ok", "Queued 25 events. Watch Network for immediate flush.");
  });

  $("#btn-flush").addEventListener("click", () => {
    tryRunAsync("flush()", () => Crossdeck.flush());
  });

  $("#btn-track-pii").addEventListener("click", () => {
    tryRun("track('pii')", () =>
      Crossdeck.track("pii_test", {
        url: "/users/wes@pinet.co.za/profile",
        creditCard: "4242 4242 4242 4242",
      }),
    );
    log("info", "Inspect Network tab — values should show '[email]' and '[card]' in the request body.");
  });

  // -------- 4. consent / forget ----------
  $("#btn-consent-deny").addEventListener("click", () => {
    tryRun("consent({analytics:false})", () => Crossdeck.consent({ analytics: false }));
  });
  $("#btn-consent-allow").addEventListener("click", () => {
    tryRun("consent({analytics:true})", () => Crossdeck.consent({ analytics: true }));
  });
  $("#btn-consent-marketing-off").addEventListener("click", () => {
    tryRun("consent({marketing:false})", () => Crossdeck.consent({ marketing: false }));
  });

  $("#btn-forget").addEventListener("click", () => {
    tryRunAsync("forget()", () => Crossdeck.forget());
  });

  // -------- 5. durability ----------
  $("#btn-stuff-queue").addEventListener("click", () => {
    for (let i = 0; i < 5; i++) {
      Crossdeck.track("durable_test", { i });
    }
    log("ok", "Queued 5 events without flushing. Close + reopen the tab to verify rehydration.");
  });

  $("#btn-inspect-storage").addEventListener("click", () => {
    try {
      const blob = localStorage.getItem("crossdeck:queue.v1");
      if (!blob) {
        log("info", "No queue persisted yet. Queue events first.");
      } else {
        const parsed = JSON.parse(blob);
        log("ok", `Persisted: version=${parsed.version}, events=${parsed.events.length}`);
        console.log("[smoke] persisted queue:", parsed);
      }
    } catch (err) {
      log("err", `localStorage read failed: ${err.message}`);
    }
  });

  let offlineRestoreTimer = null;
  $("#btn-simulate-offline").addEventListener("click", () => {
    // Monkey-patch fetch to fail for 10s, then restore.
    const realFetch = window.fetch;
    let offline = true;
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      // Only fail Crossdeck API calls, not other arbitrary requests
      // a developer might be making from the same page.
      if (offline && url.includes("cross-deck.com")) {
        renderNet({ method: init?.method || "GET", url, status: "SIM-OFFLINE", ok: false });
        throw new TypeError("Failed to fetch (simulated offline)");
      }
      return realFetch(input, init);
    };
    log("warn", "Network simulated offline for Crossdeck API for 10s.");
    for (let i = 0; i < 3; i++) {
      Crossdeck.track("offline_test", { i });
    }
    if (offlineRestoreTimer) clearTimeout(offlineRestoreTimer);
    offlineRestoreTimer = setTimeout(() => {
      offline = false;
      window.fetch = realFetch;
      log("ok", "Network restored. Watch retry kick in within the backoff window.");
    }, 10_000);
  });

  // -------- 6. entitlements ----------
  $("#btn-is-entitled").addEventListener("click", () => {
    const key = $("#ent-key").value.trim();
    const result = tryRun(`isEntitled("${key}")`, () => Crossdeck.isEntitled(key));
    if (result !== null) {
      log("info", `Result: ${result}`);
    }
  });
  $("#btn-list-ents").addEventListener("click", () => {
    const result = tryRun("listEntitlements()", () => Crossdeck.listEntitlements());
    if (result !== null) {
      log("info", `Returned ${result.length} entitlements: ${JSON.stringify(result.map((e) => e.key))}`);
    }
  });

  // ============================================================
  // 7. Full checklist — automated end-to-end.
  // ============================================================
  $("#btn-run-checklist").addEventListener("click", async () => {
    const appId = $("#cfg-appId").value.trim();
    const key = $("#cfg-key").value.trim();
    if (!appId || !key) {
      log("err", "Fill in App ID + publishable key first.");
      return;
    }
    const set = (step, state) => {
      const el = document.querySelector(`.checklist .check[data-step="${step}"]`);
      if (!el) return;
      el.className = `check ${state}`;
      el.textContent = state === "is-done" ? "✓" : state === "is-fail" ? "✗" : "·";
    };
    const reset = () => {
      $$(".checklist .check").forEach((el) => {
        el.className = "check";
        el.textContent = "·";
      });
    };
    reset();

    // 1. Boot.
    try {
      const env = $("#cfg-env").value;
      const baseUrl = $("#cfg-base").value;
      Crossdeck.init({ appId, publicKey: key, environment: env, baseUrl, debug: true });
      initialized = true;
      await Crossdeck.heartbeat();
      set("boot", "is-done");
    } catch (err) {
      set("boot", "is-fail");
      log("err", `boot failed: ${err.message}`);
      return;
    }

    // 2. identify with traits.
    try {
      await Crossdeck.identify("dogfood_user_001", {
        traits: { name: "Dogfood", plan: "pro" },
      });
      set("identify", "is-done");
    } catch (err) {
      set("identify", "is-fail");
      log("err", `identify failed: ${err.message}`);
    }

    // 3. register.
    try {
      Crossdeck.register({ releaseChannel: "beta" });
      const supers = Crossdeck.getSuperProperties();
      if (supers.releaseChannel === "beta") set("register", "is-done");
      else set("register", "is-fail");
    } catch (err) {
      set("register", "is-fail");
    }

    // 4. group.
    try {
      Crossdeck.group("org", "acme_smoke");
      const groups = Crossdeck.getGroups();
      if (groups.org?.id === "acme_smoke") set("group", "is-done");
      else set("group", "is-fail");
    } catch (err) {
      set("group", "is-fail");
    }

    // 5. track + flush.
    const beforeNet = netEl.querySelectorAll(".net-row").length;
    try {
      Crossdeck.track("smoke_test_event", { ts: Date.now() });
      await Crossdeck.flush();
      const afterNet = netEl.querySelectorAll(".net-row").length;
      if (afterNet > beforeNet) set("track", "is-done");
      else set("track", "is-fail");
    } catch (err) {
      set("track", "is-fail");
    }

    // 6. idempotency-key on most recent /events call.
    try {
      const eventsRow = Array.from(netEl.querySelectorAll(".net-row"))
        .reverse()
        .find((row) => row.textContent.includes("/events"));
      if (eventsRow && eventsRow.textContent.includes("idem=batch_")) {
        set("idem", "is-done");
      } else {
        set("idem", "is-fail");
      }
    } catch (err) {
      set("idem", "is-fail");
    }

    // 7. durable queue.
    try {
      Crossdeck.track("durability_smoke", { ts: Date.now() });
      const persisted = localStorage.getItem("crossdeck:queue.v1");
      // Persisted writes are debounced via microtask. Wait two ticks.
      await Promise.resolve();
      await Promise.resolve();
      const after = localStorage.getItem("crossdeck:queue.v1");
      if (after || persisted) set("durable", "is-done");
      else set("durable", "is-fail");
    } catch (err) {
      set("durable", "is-fail");
    }

    // 8. consent gate.
    try {
      Crossdeck.consent({ analytics: false });
      const beforeBlock = netEl.querySelectorAll(".net-row").length;
      Crossdeck.track("blocked_event", {});
      await Crossdeck.flush();
      const afterBlock = netEl.querySelectorAll(".net-row").length;
      if (afterBlock === beforeBlock) set("consent", "is-done");
      else set("consent", "is-fail");
      Crossdeck.consent({ analytics: true });
    } catch (err) {
      set("consent", "is-fail");
    }

    // 9. PII scrub. Track an event, intercept the next /events POST body.
    try {
      let scrubbed = false;
      const realFetch = window.fetch;
      const intercept = async (input, init) => {
        const url = typeof input === "string" ? input : input?.url || "";
        if (url.includes("/events") && init?.body) {
          if (init.body.includes("[email]") && !init.body.includes("wes@pinet.co.za")) {
            scrubbed = true;
          }
        }
        return realFetch(input, init);
      };
      window.fetch = intercept;
      Crossdeck.track("pii_smoke", { url: "/users/wes@pinet.co.za/profile" });
      await Crossdeck.flush();
      window.fetch = realFetch;
      set("scrub", scrubbed ? "is-done" : "is-fail");
    } catch (err) {
      set("scrub", "is-fail");
    }

    // 10. diagnostics shape.
    try {
      const d = Crossdeck.diagnostics();
      const expected = ["started", "clock", "entitlements", "events"];
      const ok = expected.every((k) => k in d) &&
                 "skewMs" in d.clock &&
                 "consecutiveFailures" in d.events &&
                 "listenerErrors" in d.entitlements;
      set("diag", ok ? "is-done" : "is-fail");
    } catch (err) {
      set("diag", "is-fail");
    }

    log("ok", "Smoke checklist complete. Review the checklist above + the Network tab.");
  });

  // ============================================================
  // Stash config across reloads so the dogfood test doesn't lose
  // the API key every time we test the durable queue feature.
  // ============================================================
  for (const id of ["cfg-appId", "cfg-key", "cfg-env", "cfg-base"]) {
    const el = $("#" + id);
    if (!el) continue;
    const stored = localStorage.getItem(`smoke:${id}`);
    if (stored) el.value = stored;
    el.addEventListener("change", () => {
      localStorage.setItem(`smoke:${id}`, el.value);
    });
  }

  log("info", "Smoke driver ready. Fill in App ID + key and click init().");
})();
