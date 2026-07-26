import 'koishi';
import type {
  ModelConfigService,
  ModelRuntimeClient,
} from '../plugins/model-config/index.js';
import type { CodexOAuthBridgeService } from '../plugins/codex-oauth/index.js';
import type { CopilotOAuthBridgeService } from '../plugins/copilot-oauth/index.js';
import type { StickerMaintenanceServiceLike } from '../plugins/sticker/maintenance.js';

export type StickerMaintenanceService = StickerMaintenanceServiceLike;

declare module 'koishi' {
  interface Context {
    modelConfig: ModelConfigService;
    modelRuntime: ModelRuntimeClient;
    codexBridge: CodexOAuthBridgeService;
    copilotBridge: CopilotOAuthBridgeService;
    stickerMaintenance: StickerMaintenanceServiceLike;
  }
}
