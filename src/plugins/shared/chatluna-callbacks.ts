import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import { CallbackManager } from '@langchain/core/callbacks/manager';

export function createOrderedCallbackManager(
  handlers: CallbackHandlerMethods,
): CallbackManager {
  const manager = CallbackManager.fromHandlers(handlers);
  for (const handler of manager.handlers) {
    handler.awaitHandlers = true;
  }
  return manager;
}
