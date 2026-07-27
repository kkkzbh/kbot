import type {
  AdapterType,
  ConnectionAuth,
} from './types.js';

type ConnectionIdentityInput = {
  adapter: AdapterType;
  baseUrl: string | null;
  auth: ConnectionAuth;
};

export type ConnectionIdentityDescriptor = {
  idBase: string;
  displayNameBase: string;
  providerId: string;
  providerName: string;
};

const PROVIDERS = [
  {
    matches: (hostname: string) => hostname === 'api.siliconflow.cn',
    id: 'siliconflow',
    name: 'SiliconFlow',
  },
  {
    matches: (hostname: string) => hostname === 'api.deepseek.com',
    id: 'deepseek',
    name: 'DeepSeek',
  },
  {
    matches: (hostname: string) => hostname.endsWith('.volces.com'),
    id: 'volcengine-ark',
    name: 'Volcengine Ark',
  },
  {
    matches: (hostname: string) => hostname.endsWith('.xiaomimimo.com'),
    id: 'xiaomi-mimo',
    name: 'Xiaomi MIMO',
  },
  {
    matches: (hostname: string) => hostname === 'api.openai.com',
    id: 'openai',
    name: 'OpenAI',
  },
] as const;

export function describeConnectionIdentity(
  input: ConnectionIdentityInput,
): ConnectionIdentityDescriptor {
  if (input.adapter === 'codexBridge') {
    return {
      idBase: 'codex',
      displayNameBase: 'Codex OAuth',
      providerId: 'codex',
      providerName: 'Codex',
    };
  }
  if (input.adapter === 'copilotBridge') {
    return {
      idBase: 'copilot',
      displayNameBase: 'GitHub Copilot OAuth',
      providerId: 'copilot',
      providerName: 'GitHub Copilot',
    };
  }
  if (input.baseUrl === null) {
    throw new Error('OpenAI-compatible connection identity requires a base URL.');
  }

  const hostname = new URL(input.baseUrl).hostname.toLowerCase();
  const provider = PROVIDERS.find((candidate) => candidate.matches(hostname)) ?? {
    id: 'openai-compatible',
    name: 'OpenAI Compatible',
  };
  if (input.auth.kind === 'apiKey') {
    if (provider.id === 'siliconflow') {
      return {
        idBase: provider.id,
        displayNameBase: provider.name,
        providerId: provider.id,
        providerName: provider.name,
      };
    }
    return {
      idBase: `${provider.id}-api-key`,
      displayNameBase: `${provider.name} API Key`,
      providerId: provider.id,
      providerName: provider.name,
    };
  }
  return {
    idBase: provider.id,
    displayNameBase: provider.name,
    providerId: provider.id,
    providerName: provider.name,
  };
}
