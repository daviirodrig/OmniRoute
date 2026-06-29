"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import EmptyState from "@/shared/components/EmptyState";
import Input from "@/shared/components/Input";
import { CardSkeleton } from "@/shared/components/Loading";
import Toggle from "@/shared/components/Toggle";
import { useNotificationStore } from "@/store/notificationStore";
import {
  buildSimpleModeComboPayload,
  filterSimpleModeCombos,
  formatSimpleModeModel,
  getSimpleModeDisplayName,
  toSimpleModeTriggerName,
  type SimpleModeComboListItem,
  type SimpleModeModelInput,
} from "@/lib/simpleMode";

const ModelSelectModal = dynamic(() => import("@/shared/components/ModelSelectModal"), {
  ssr: false,
});

type ProviderConnection = {
  id?: string | number;
  provider: string;
  testStatus?: string;
};

type SelectedModel = SimpleModeModelInput & {
  id?: unknown;
  name?: unknown;
};

const DEFAULT_TRIGGER_INPUT = "big-models";

export default function SimpleModePage() {
  const notify = useNotificationStore();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [combos, setCombos] = useState<SimpleModeComboListItem[]>([]);
  const [allCombos, setAllCombos] = useState<any[]>([]);
  const [activeProviders, setActiveProviders] = useState<ProviderConnection[]>([]);
  const [modelAliases, setModelAliases] = useState<Record<string, string>>({});
  const [editingComboId, setEditingComboId] = useState<string | null>(null);
  const [triggerInput, setTriggerInput] = useState(DEFAULT_TRIGGER_INPUT);
  const [selectedModels, setSelectedModels] = useState<SelectedModel[]>([]);
  const [showModelSelect, setShowModelSelect] = useState(false);

  const triggerName = toSimpleModeTriggerName(triggerInput);
  const editingCombo = useMemo(
    () => combos.find((combo) => combo.id === editingComboId) || null,
    [combos, editingComboId]
  );
  const canSave = triggerName.length > "simple/".length && selectedModels.length > 0 && !saving;

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [combosRes, providersRes, aliasesRes] = await Promise.all([
        fetch("/api/combos"),
        fetch("/api/providers"),
        fetch("/api/settings/model-aliases"),
      ]);
      const [combosData, providersData, aliasesData] = await Promise.all([
        combosRes.ok ? combosRes.json() : Promise.resolve({ combos: [] }),
        providersRes.ok ? providersRes.json() : Promise.resolve({ connections: [] }),
        aliasesRes.ok ? aliasesRes.json() : Promise.resolve({ all: {} }),
      ]);
      const comboList = Array.isArray(combosData.combos) ? combosData.combos : [];
      const connections = Array.isArray(providersData.connections) ? providersData.connections : [];
      setAllCombos(comboList);
      setCombos(filterSimpleModeCombos(comboList));
      setActiveProviders(
        connections.filter(
          (connection: ProviderConnection) =>
            connection?.testStatus === "active" || connection?.testStatus === "success"
        )
      );
      setModelAliases(
        aliasesData?.all && typeof aliasesData.all === "object" ? aliasesData.all : {}
      );
    } catch {
      notify.error("Unable to load Simple Mode configuration.");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    queueMicrotask(() => {
      fetchData();
    });
  }, [fetchData]);

  const resetForm = () => {
    setEditingComboId(null);
    setTriggerInput(DEFAULT_TRIGGER_INPUT);
    setSelectedModels([]);
  };

  const handleEdit = (combo: SimpleModeComboListItem) => {
    setEditingComboId(combo.id);
    setTriggerInput(getSimpleModeDisplayName(combo.name));
    const nextModels: SelectedModel[] = [];
    for (const entry of combo.models) {
      const model = formatSimpleModeModel(entry);
      if (!model) continue;
      const providerId =
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).providerId === "string"
          ? ((entry as Record<string, unknown>).providerId as string)
          : undefined;
      nextModels.push({ model, value: model, providerId });
    }
    setSelectedModels(nextModels);
  };

  const handleSelectModel = (model: unknown) => {
    if (!model || typeof model !== "object") return;
    const candidate = model as SelectedModel;
    const modelValue = typeof candidate.value === "string" ? candidate.value : "";
    if (
      !modelValue ||
      selectedModels.some((entry) => entry.value === modelValue || entry.model === modelValue)
    ) {
      return;
    }
    setSelectedModels((current) => [...current, candidate]);
  };

  const handleDeselectModel = (model: unknown) => {
    const modelValue =
      model && typeof model === "object" && typeof (model as SelectedModel).value === "string"
        ? ((model as SelectedModel).value as string)
        : typeof model === "string"
          ? model
          : "";
    if (!modelValue) return;
    setSelectedModels((current) =>
      current.filter((entry) => entry.value !== modelValue && entry.model !== modelValue)
    );
  };

  const moveModel = (index: number, direction: -1 | 1) => {
    setSelectedModels((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const saveCombo = async () => {
    if (!canSave) return;
    const payload = buildSimpleModeComboPayload({
      triggerName: triggerInput,
      models: selectedModels,
      existingConfig: editingCombo?.config || null,
    });
    const duplicate = allCombos.find(
      (combo) => combo.name === payload.name && (!editingCombo || combo.id !== editingCombo.id)
    );
    if (duplicate) {
      notify.error(`A combo named ${payload.name} already exists.`);
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(
        editingCombo ? `/api/combos/${editingCombo.id}` : "/api/combos",
        {
          method: editingCombo ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        const message =
          typeof errorBody?.error === "string"
            ? errorBody.error
            : errorBody?.error?.message || "Failed to save Simple Mode combo.";
        notify.error(message);
        return;
      }
      notify.success(editingCombo ? "Simple Mode combo updated." : "Simple Mode combo created.");
      resetForm();
      await fetchData();
    } catch {
      notify.error("Failed to save Simple Mode combo.");
    } finally {
      setSaving(false);
    }
  };

  const deleteCombo = async (combo: SimpleModeComboListItem) => {
    if (!confirm(`Delete ${combo.name}?`)) return;
    try {
      const response = await fetch(`/api/combos/${combo.id}`, { method: "DELETE" });
      if (!response.ok) {
        notify.error("Failed to delete Simple Mode combo.");
        return;
      }
      if (editingComboId === combo.id) resetForm();
      setCombos((current) => current.filter((entry) => entry.id !== combo.id));
      setAllCombos((current) => current.filter((entry) => entry.id !== combo.id));
      notify.success("Simple Mode combo deleted.");
    } catch {
      notify.error("Failed to delete Simple Mode combo.");
    }
  };

  const toggleCombo = async (combo: SimpleModeComboListItem) => {
    const nextActive = !combo.isActive;
    setCombos((current) =>
      current.map((entry) => (entry.id === combo.id ? { ...entry, isActive: nextActive } : entry))
    );
    try {
      const response = await fetch(`/api/combos/${combo.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive }),
      });
      if (!response.ok) throw new Error("toggle failed");
    } catch {
      setCombos((current) =>
        current.map((entry) =>
          entry.id === combo.id ? { ...entry, isActive: combo.isActive } : entry
        )
      );
      notify.error("Failed to update Simple Mode combo.");
    }
  };

  if (loading) return <CardSkeleton />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <span className="material-symbols-outlined text-[22px]">linear_scale</span>
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-text-main">Simple Mode</h1>
              <p className="mt-1 text-sm text-text-muted">
                Create trigger model names that run a plain ordered fallback chain. No scoring,
                balancing, routing policy, or extra behavior is added here.
              </p>
            </div>
          </div>
        </div>
        <Button variant="secondary" onClick={resetForm} disabled={saving}>
          New combo
        </Button>
      </div>

      <Card className="p-5">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-text-main">
                {editingCombo ? "Edit fallback combo" : "Create fallback combo"}
              </h2>
              <p className="mt-1 text-sm text-text-muted">
                Pick a name and order the upstream models. Requests use the trigger as the OpenAI
                model value, for example{" "}
                <code className="font-mono text-text-main">{triggerName || "simple/name"}</code>.
              </p>
            </div>
            <Input
              label="Trigger model name"
              value={triggerInput}
              onChange={(event) => setTriggerInput(event.target.value)}
              placeholder="big-models"
              hint="Saved as simple/<name>. Use a purpose name like big-models, small-models, or fast-models."
              disabled={saving}
            />
            <div className="rounded-lg border border-border bg-surface/40 p-3 text-sm">
              <div className="text-xs font-medium text-text-muted">Invocation model</div>
              <code className="mt-1 block break-all font-mono text-text-main">
                {triggerName || "simple/name"}
              </code>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-text-main">Fallback order</h3>
                <p className="text-xs text-text-muted">
                  First model wins. Any failed attempt moves to the next.
                </p>
              </div>
              <Button size="sm" onClick={() => setShowModelSelect(true)} disabled={saving}>
                Add models
              </Button>
            </div>

            {selectedModels.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-text-muted">
                Select at least one upstream model for this trigger.
              </div>
            ) : (
              <div className="space-y-2">
                {selectedModels.map((model, index) => {
                  const modelValue =
                    typeof model.value === "string" ? model.value : String(model.model || "");
                  return (
                    <div
                      key={`${modelValue}-${index}`}
                      className="flex items-center gap-2 rounded-lg border border-border bg-surface/50 px-3 py-2"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                        {index + 1}
                      </span>
                      <code className="min-w-0 flex-1 truncate font-mono text-sm text-text-main">
                        {modelValue}
                      </code>
                      <button
                        type="button"
                        onClick={() => moveModel(index, -1)}
                        disabled={index === 0 || saving}
                        className="rounded p-1 text-text-muted transition-colors hover:bg-black/5 hover:text-text-main disabled:opacity-30 dark:hover:bg-white/5"
                        aria-label="Move model up"
                      >
                        <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => moveModel(index, 1)}
                        disabled={index === selectedModels.length - 1 || saving}
                        className="rounded p-1 text-text-muted transition-colors hover:bg-black/5 hover:text-text-main disabled:opacity-30 dark:hover:bg-white/5"
                        aria-label="Move model down"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          arrow_downward
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeselectModel(model)}
                        disabled={saving}
                        className="rounded p-1 text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-30"
                        aria-label="Remove model"
                      >
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:justify-end">
              {editingCombo && (
                <Button variant="ghost" onClick={resetForm} disabled={saving}>
                  Cancel edit
                </Button>
              )}
              <Button onClick={saveCombo} loading={saving} disabled={!canSave}>
                {editingCombo ? "Update Simple combo" : "Save Simple combo"}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-main">Simple Mode combos</h2>
            <p className="text-sm text-text-muted">
              Each row is just a priority combo marked for Simple Mode.
            </p>
          </div>
          <span className="rounded-full bg-surface px-3 py-1 text-xs text-text-muted">
            {combos.length} configured
          </span>
        </div>

        {combos.length === 0 ? (
          <EmptyState
            icon="linear_scale"
            title="No Simple Mode combos yet"
            description="Create a trigger model and choose its fallback models to get started."
            actionLabel="Select models"
            onAction={() => setShowModelSelect(true)}
          />
        ) : (
          <div className="grid gap-3">
            {combos.map((combo) => (
              <Card key={combo.id} className="p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-primary/10 px-2 py-1 font-mono text-sm text-primary">
                        {combo.name}
                      </code>
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                        fallback chain only
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {combo.models.map((entry, index) => {
                        const label = formatSimpleModeModel(entry);
                        return (
                          <span
                            key={`${combo.id}-${label}-${index}`}
                            className="inline-flex items-center gap-1 text-xs"
                          >
                            <span className="text-text-muted">{index + 1}</span>
                            <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-text-main dark:bg-white/5">
                              {label || "unknown"}
                            </code>
                            {index < combo.models.length - 1 && (
                              <span className="material-symbols-outlined text-[13px] text-text-muted">
                                arrow_forward
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t border-border pt-3 lg:border-t-0 lg:pt-0">
                    <Toggle
                      size="sm"
                      checked={combo.isActive}
                      onChange={() => toggleCombo(combo)}
                    />
                    <Button size="sm" variant="ghost" onClick={() => handleEdit(combo)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteCombo(combo)}>
                      Delete
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => setShowModelSelect(false)}
        onSelect={handleSelectModel}
        onDeselect={handleDeselectModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        title="Add upstream models"
        showCombos={false}
        addedModelValues={selectedModels
          .map((model) =>
            typeof model.value === "string" ? model.value : String(model.model || "")
          )
          .filter(Boolean)}
        keepOpenOnSelect
      />
    </div>
  );
}
