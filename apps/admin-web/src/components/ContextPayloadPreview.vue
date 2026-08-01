<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

type JsonTokenKind = 'plain' | 'key' | 'string' | 'number' | 'boolean' | 'null';

interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

const props = withDefaults(defineProps<{
  value: unknown;
  meta?: string;
  roles?: readonly string[];
  compact?: boolean;
  copyable?: boolean;
}>(), {
  meta: '',
  roles: () => [],
  compact: false,
  copyable: true,
});

const copied = ref(false);
let copiedTimer: number | undefined;

const json = computed(() => JSON.stringify(props.value, null, 2)!);
const tokens = computed<JsonToken[]>(() => {
  const result: JsonToken[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  let cursor = 0;

  for (const match of json.value.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) result.push({ kind: 'plain', text: json.value.slice(cursor, index) });

    const text = match[0];
    let kind: JsonTokenKind = 'number';
    if (text.startsWith('"')) {
      kind = /^\s*:/.test(json.value.slice(index + text.length)) ? 'key' : 'string';
    } else if (text === 'true' || text === 'false') {
      kind = 'boolean';
    } else if (text === 'null') {
      kind = 'null';
    }
    result.push({ kind, text });
    cursor = index + text.length;
  }

  if (cursor < json.value.length) result.push({ kind: 'plain', text: json.value.slice(cursor) });
  return result;
});

function roleClass(role: string): string {
  if (role === 'system') return 'is-system';
  if (role === 'human' || role === 'user' || role === 'native') return 'is-human';
  if (role === 'ai' || role === 'assistant' || role === 'mcp') return 'is-ai';
  if (role === 'tool' || role === 'option') return 'is-tool';
  if (role === 'file') return 'is-system';
  return 'is-data';
}

async function copyJson(): Promise<void> {
  await navigator.clipboard.writeText(json.value);
  copied.value = true;
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copied.value = false;
    copiedTimer = undefined;
  }, 1200);
}

onBeforeUnmount(() => {
  if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="payload-preview" :class="{ compact }">
    <div v-if="meta || roles.length || copyable" class="payload-toolbar">
      <div>
        <code v-if="meta">{{ meta }}</code>
        <span v-for="role in roles" :key="role" class="payload-role" :class="roleClass(role)">
          {{ role }}
        </span>
      </div>
      <button v-if="copyable" type="button" @click="copyJson">
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>
    <pre><code><span v-for="(token, index) in tokens" :key="index" :class="`token-${token.kind}`">{{ token.text }}</span></code></pre>
  </div>
</template>

<style scoped>
.payload-preview {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #dce3ef;
  border-radius: 8px;
  background: #f8faff;
  box-shadow: inset 3px 0 #b8c9f4;
}

.payload-toolbar {
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px 7px 13px;
  border-bottom: 1px solid #e1e7f0;
}

.payload-toolbar > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.payload-toolbar code {
  color: #68758a;
  font: 10px/1.3 var(--font-mono, ui-monospace, monospace);
}

.payload-toolbar button {
  flex: none;
  padding: 3px 5px;
  border: 0;
  border-radius: 5px;
  color: #6e7a8e;
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}

.payload-toolbar button:hover,
.payload-toolbar button:focus-visible {
  color: var(--accent);
  background: var(--accent-soft);
}

.payload-role {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #758094;
  font: 9px/1.3 var(--font-mono, ui-monospace, monospace);
}

.payload-role::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7c8aa1;
  content: '';
}

.payload-role.is-system::before { background: #7556ba; }
.payload-role.is-human::before { background: #3c67e3; }
.payload-role.is-ai::before { background: #24846b; }
.payload-role.is-tool::before { background: #a56d16; }
.payload-role.is-data::before { background: #7c8aa1; }

.payload-preview pre {
  max-height: 520px;
  margin: 0;
  padding: 14px 16px 16px 18px;
  overflow: auto;
  color: #27344a;
  background: transparent;
  font: 10.5px/1.65 var(--font-mono, ui-monospace, monospace);
  scrollbar-color: #c4cfdf transparent;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.payload-preview.compact pre {
  max-height: 420px;
  padding: 12px 14px 14px;
}

.token-key { color: #356ce0; }
.token-string { color: #087c68; }
.token-number { color: #7451b7; }
.token-boolean,
.token-null { color: #9a650e; }
.token-plain { color: #56637a; }

@media (max-width: 620px) {
  .payload-preview pre {
    font-size: 10px;
  }
}
</style>
