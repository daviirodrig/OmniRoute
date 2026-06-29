import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSimpleModeComboPayload,
  filterSimpleModeCombos,
  getSimpleModeDisplayName,
  toSimpleModeTriggerName,
} from "../../src/lib/simpleMode.ts";

test("Simple Mode builds a priority combo trigger with ordered upstream models", () => {
  const payload = buildSimpleModeComboPayload({
    triggerName: " Big Models ",
    models: [
      { value: "openai/gpt-4.1", providerId: "openai" },
      { value: "anthropic/claude-sonnet-4.5", providerId: "anthropic" },
      { value: "openai/gpt-4.1", providerId: "openai" },
    ],
  });

  assert.equal(payload.name, "simple/big-models");
  assert.equal(payload.strategy, "priority");
  assert.deepEqual(payload.models, [
    { model: "openai/gpt-4.1", providerId: "openai", weight: 0 },
    { model: "anthropic/claude-sonnet-4.5", providerId: "anthropic", weight: 0 },
  ]);
  assert.deepEqual(payload.config, {
    simpleMode: true,
    simpleModeDescription: "Model fallback chaining only",
  });
});

test("Simple Mode keeps only combos explicitly marked as fallback-only priority chains", () => {
  const combos = filterSimpleModeCombos([
    {
      id: "simple-big",
      name: "simple/big",
      strategy: "priority",
      isActive: true,
      models: [{ model: "openai/gpt-4.1" }],
      config: { simpleMode: true },
    },
    {
      id: "weighted",
      name: "simple/weighted",
      strategy: "weighted",
      models: [{ model: "openai/gpt-4.1" }],
      config: { simpleMode: true },
    },
    {
      id: "ordinary",
      name: "ordinary-priority",
      strategy: "priority",
      models: [{ model: "openai/gpt-4.1" }],
      config: {},
    },
  ]);

  assert.deepEqual(
    combos.map((combo) => combo.name),
    ["simple/big"]
  );
});

test("Simple Mode trigger helpers use a stable simple slash namespace", () => {
  assert.equal(toSimpleModeTriggerName("fast models"), "simple/fast-models");
  assert.equal(toSimpleModeTriggerName("simple/small"), "simple/small");
  assert.equal(getSimpleModeDisplayName("simple/big-models"), "big-models");
});
