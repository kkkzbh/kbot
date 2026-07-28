import { computed, ref } from 'vue';
import type { SettingsField } from '@contracts';
import { rawApi, rawJsonBody } from '@/api/client';
import { useRuntimeStore } from '@/stores/runtime';

type SettingsResponse = {
  fields: SettingsField[];
  restartRequired: boolean;
  reasons: string[];
};

type SettingsChange = {
  key: string;
  value?: string;
  clear?: boolean;
};

export function useManagedFeatureSettings(ownedKeys: readonly string[]) {
  const keySet = new Set(ownedKeys);
  const fields = ref<SettingsField[]>([]);
  const draft = ref<Record<string, string>>({});
  const original = ref<Record<string, string>>({});
  const clearSecrets = ref<Record<string, boolean>>({});
  const loading = ref(false);
  const runtime = useRuntimeStore();

  function hydrate(allFields: SettingsField[]): void {
    const ownedFields = allFields.filter((field) => keySet.has(field.key));
    fields.value = ownedFields;
    draft.value = Object.fromEntries(ownedFields.map((field) => [field.key, field.value ?? '']));
    original.value = { ...draft.value };
    clearSecrets.value = Object.fromEntries(ownedFields.map((field) => [field.key, false]));
  }

  const changes = computed<SettingsChange[]>(() => fields.value.reduce<SettingsChange[]>((result, field) => {
    if (field.type === 'secret') {
      if (clearSecrets.value[field.key]) result.push({ key: field.key, clear: true });
      const value = draft.value[field.key] ?? '';
      if (!clearSecrets.value[field.key] && value) result.push({ key: field.key, value });
      return result;
    }
    const value = draft.value[field.key] ?? '';
    if (value !== original.value[field.key]) result.push({ key: field.key, value });
    return result;
  }, []));

  const hasChanges = computed(() => changes.value.length > 0);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const result = await rawApi<SettingsResponse>('/settings/features');
      hydrate(result.fields);
      runtime.updateApply(result);
    } finally {
      loading.value = false;
    }
  }

  async function save(): Promise<boolean> {
    if (!hasChanges.value) return false;
    const result = await rawApi<SettingsResponse>('/settings/features', {
      method: 'PATCH',
      body: rawJsonBody({ changes: changes.value }),
    });
    hydrate(result.fields);
    runtime.updateApply(result);
    return true;
  }

  return {
    fields,
    draft,
    clearSecrets,
    loading,
    hasChanges,
    load,
    save,
  };
}
