import 'koishi';
import type { ZyhService } from '../plugins/zyh/service.js';
import type { VersionedDataItem, VersionedSyncState } from '../plugins/shared/versioned-json-cache.js';

declare module 'koishi' {
  interface Context {
    zyh?: ZyhService;
  }

  interface Tables {
    zyh_sync_state: VersionedSyncState;
    zyh_data_item: VersionedDataItem;
  }
}
