const SIMPLE_MODE_TRIGGER_PREFIX = "simple/";

export type SimpleModeModelInput = {
  model?: unknown;
  value?: unknown;
  providerId?: unknown;
};

export type SimpleModeComboInput = {
  id?: unknown;
  name?: unknown;
  models?: unknown;
  isActive?: unknown;
  config?: unknown;
  strategy?: unknown;
};

export type SimpleModeComboListItem = {
  id: string;
  name: string;
  models: unknown[];
  isActive: boolean;
  config: Record<string, unknown>;
  strategy?: unknown;
};

export function normalizeSimpleModeName(value: string): string {
  return value.trim().replace(/\s+/g, "-").toLowerCase();
}

export function toSimpleModeTriggerName(value: string): string {
  const normalized = normalizeSimpleModeName(value);
  if (!normalized) return "";
  return normalized.startsWith(SIMPLE_MODE_TRIGGER_PREFIX)
    ? normalized
    : `${SIMPLE_MODE_TRIGGER_PREFIX}${normalized}`;
}

export function getSimpleModeDisplayName(comboName: string): string {
  const normalized = String(comboName || "").trim();
  return normalized.startsWith(SIMPLE_MODE_TRIGGER_PREFIX)
    ? normalized.slice(SIMPLE_MODE_TRIGGER_PREFIX.length)
    : normalized;
}

export function isSimpleModeCombo(combo: SimpleModeComboInput): boolean {
  const config = combo.config;
  return Boolean(
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    (config as Record<string, unknown>).simpleMode === true &&
    combo.strategy === "priority"
  );
}

export function filterSimpleModeCombos(combos: SimpleModeComboInput[]): SimpleModeComboListItem[] {
  return combos.filter(isSimpleModeCombo).map((combo) => ({
    id: String(combo.id || combo.name || ""),
    name: String(combo.name || ""),
    models: Array.isArray(combo.models) ? combo.models : [],
    isActive: combo.isActive !== false,
    config:
      combo.config && typeof combo.config === "object" && !Array.isArray(combo.config)
        ? (combo.config as Record<string, unknown>)
        : {},
    strategy: combo.strategy,
  }));
}

function getModelValue(model: SimpleModeModelInput): string {
  const value = typeof model.value === "string" ? model.value : model.model;
  return typeof value === "string" ? value.trim() : "";
}

export function buildSimpleModeModels(models: SimpleModeModelInput[]) {
  const seen = new Set<string>();
  const result: Array<{ model: string; providerId?: string; weight: number }> = [];

  for (const input of models) {
    const model = getModelValue(input);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const providerId = typeof input.providerId === "string" ? input.providerId.trim() : "";
    result.push({
      model,
      ...(providerId ? { providerId } : {}),
      weight: 0,
    });
  }

  return result;
}

export function buildSimpleModeComboPayload({
  triggerName,
  models,
  existingConfig,
}: {
  triggerName: string;
  models: SimpleModeModelInput[];
  existingConfig?: Record<string, unknown> | null;
}) {
  const name = toSimpleModeTriggerName(triggerName);
  const comboModels = buildSimpleModeModels(models);

  return {
    name,
    strategy: "priority" as const,
    models: comboModels,
    config: {
      ...(existingConfig || {}),
      simpleMode: true,
      simpleModeDescription: "Model fallback chaining only",
    },
  };
}

export function formatSimpleModeModel(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  const record = entry as Record<string, unknown>;
  const model = typeof record.model === "string" ? record.model : "";
  return model;
}
