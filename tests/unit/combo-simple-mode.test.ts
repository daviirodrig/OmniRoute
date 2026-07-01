import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Integration coverage for the simple-mode combo contract:
// - any error from one provider instantly falls through to the next
// - the last model's failure is surfaced
// - circuit-breaker / cooldown / lockout pre-skip checks are bypassed
// - body-specific 400 errors no longer short-circuit the chain
// - the combo's own retry / fallback / hedging config is overridden
//
// Module loading uses a top-level dynamic import on purpose: `combo.ts` reads
// `process.env.DATA_DIR` and the local SQLite wiring at evaluation time, and
// the env var must be set before the module graph is materialised. The same
// pattern is used by sibling tests (e.g. combo-strategy-fallbacks.test.ts).

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-simple-mode-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { resetAllComboMetrics } = await import("../../open-sse/services/comboMetrics.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { resetAll: resetAllSemaphores } =
  await import("../../open-sse/services/rateLimitSemaphore.ts");
const { _resetAllDecks } = await import("../../src/shared/utils/shuffleDeck.ts");
const { clearSessions } = await import("../../open-sse/services/sessionManager.ts");
const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");

function createLog() {
  const entries: Array<{ level: string; tag: unknown; msg: unknown }> = [];
  return {
    info: (tag: unknown, msg: unknown) => entries.push({ level: "info", tag, msg }),
    warn: (tag: unknown, msg: unknown) => entries.push({ level: "warn", tag, msg }),
    error: (tag: unknown, msg: unknown) => entries.push({ level: "error", tag, msg }),
    debug: (tag: unknown, msg: unknown) => entries.push({ level: "debug", tag, msg }),
    entries,
  };
}

function okResponse(body: Record<string, unknown> = { choices: [{ message: { content: "ok" } }] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, message: string = `Error ${status}`) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function cleanupTestDataDir() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      core.resetDbInstance();
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError) throw lastError;
}

test.beforeEach(async () => {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  _resetAllDecks();
  clearSessions();
  await cleanupTestDataDir();
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settingsDb.resetAllPricing();
  settingsDb.clearAllLKGP();
});

test.after(async () => {
  resetAllComboMetrics();
  resetAllCircuitBreakers();
  resetAllSemaphores();
  _resetAllDecks();
  clearSessions();
  settingsDb.clearAllLKGP();
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
  await cleanupTestDataDir();
});

test("simple mode falls through to the next model on any error and returns the last failure", async () => {
  const calls: string[] = [];
  const result = await handleComboChat({
    body: {},
    combo: {
      name: "simple/cascade",
      strategy: "priority",
      models: ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
      config: {
        simpleMode: true,
        // Even when the operator asks for 5 retries and a 3-second fallback
        // wait, simple mode overrides these to zero — the only knob that
        // matters in simple mode is the model list itself.
        maxRetries: 5,
        retryDelayMs: 3000,
        fallbackDelayMs: 3000,
        hedging: true,
      },
    },
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "google/gemini-2.5-pro") return errorResponse(502, "boom");
      return errorResponse(503, "downstream");
    },
    isModelAvailable: async () => true,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(calls.length, 3, "every model in the chain must be attempted exactly once");
  assert.deepEqual(calls, [
    "openai/gpt-4.1",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-pro",
  ]);
  assert.equal(result.ok, false, "all models failed — the last error must be surfaced");
  assert.equal(result.status, 502, "the LAST model's status is what the chain reports");
});

test("simple mode returns the first successful response and stops iterating", async () => {
  const calls: string[] = [];
  const result = await handleComboChat({
    body: {},
    combo: {
      name: "simple/first-success",
      strategy: "priority",
      models: ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5"],
      config: { simpleMode: true },
    },
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "openai/gpt-4.1") return errorResponse(500, "transient");
      return okResponse({ marker: "second" });
    },
    isModelAvailable: async () => true,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5"]);
});

test("simple mode ignores the circuit breaker for the first target and still tries it", async () => {
  const { getCircuitBreaker } = await import("../../src/shared/utils/circuitBreaker.ts");
  const breaker = getCircuitBreaker("openai", { failureThreshold: 1, resetTimeout: 60_000 });
  // Trip the breaker by recording a synthetic failure.
  await breaker
    .execute(async () => {
      throw new Error("synthetic");
    })
    .catch(() => undefined);
  assert.equal(breaker.getStatus().state, "OPEN", "breaker is OPEN before the combo runs");

  const calls: string[] = [];
  const result = await handleComboChat({
    body: {},
    combo: {
      name: "simple/breaker-override",
      strategy: "priority",
      models: ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5"],
      config: { simpleMode: true },
    },
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      // First model fails — the combo MUST still have called it despite OPEN.
      if (modelStr === "openai/gpt-4.1") return errorResponse(503, "openai down");
      return okResponse();
    },
    isModelAvailable: async () => false, // also gate-closed: simple mode must bypass
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls,
    ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5"],
    "simple mode must call the OPEN-breaker model and fall through to the next on error"
  );
});

test("simple mode falls through a body-specific 400 instead of stopping the chain", async () => {
  const calls: string[] = [];
  const result = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    combo: {
      name: "simple/body-400-fallthrough",
      strategy: "priority",
      models: ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5"],
      config: { simpleMode: true },
    },
    handleSingleModel: async (_body: unknown, modelStr: string) => {
      calls.push(modelStr);
      // Body-rejecting 400 with a 'context' cue — in normal mode this would
      // short-circuit the combo (#2101/#4279 guard). Simple mode overrides it.
      if (modelStr === "openai/gpt-4.1") {
        return errorResponse(400, "Bad Request: context length exceeded for input");
      }
      return okResponse();
    },
    isModelAvailable: async () => true,
    log: createLog(),
    settings: null,
    allCombos: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5"]);
});
