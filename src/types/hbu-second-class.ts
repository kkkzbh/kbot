import 'koishi';
import type { HbuSecondClassService } from '../plugins/hbu-second-class/service.js';
import type { VersionedDataItem, VersionedSyncState } from '../plugins/shared/versioned-json-cache.js';

declare module 'koishi' {
  interface Context {
    hbuSecondClass?: HbuSecondClassService;
  }

  interface Tables {
    hbu_second_class_sync_state: VersionedSyncState;
    hbu_second_class_data_item: VersionedDataItem;
  }
}
