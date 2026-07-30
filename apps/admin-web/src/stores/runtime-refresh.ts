import { rawApi } from '../api/client';
import { useRuntimeStore, type RuntimeOverviewState } from './runtime';

let overviewRequestVersion = 0;

export async function refreshRuntimeOverview(): Promise<void> {
  const runtime = useRuntimeStore();
  const requestVersion = overviewRequestVersion + 1;
  overviewRequestVersion = requestVersion;
  try {
    const overview = await rawApi<RuntimeOverviewState>('/overview');
    if (requestVersion === overviewRequestVersion) runtime.updateOverview(overview);
  } catch (error) {
    if (requestVersion !== overviewRequestVersion) return;
    runtime.markOverviewFailed(
      error instanceof Error ? error.message : '运行摘要加载失败',
    );
  }
}
