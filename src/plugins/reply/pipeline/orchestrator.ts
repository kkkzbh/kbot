import type { Session } from 'koishi';
import { StructuredReplyCompilerService, type ReplyCompilerOutputProtocol } from './compiler.js';
import { buildReplyTurnContext } from './context-builder.js';
import { ActionResolverService } from './resolver.js';
import type {
  ReplyRoute,
  ResolvedAction,
  StructuredReply,
  TurnContext,
  TurnInput,
} from './types.js';

export interface ReplyOrchestratorHandleContext {
  responseMessage?: {
    content?: unknown;
    additional_kwargs?: Record<string, unknown>;
  } | null;
  capabilitySnapshot?: TurnContext['capabilitySnapshot'];
  continuationContext?: TurnContext['continuationContext'];
  routeHint?: ReplyRoute | null;
  outputProtocol?: ReplyCompilerOutputProtocol;
}

export type ReplyOrchestratorHandleResult =
  | {
      status: 'no_reply';
      route: 'no_reply';
      turnContext: TurnContext;
      reply: null;
      actions: ResolvedAction[];
    }
  | {
      status: 'await_model';
      route: 'agent' | 'automation';
      turnContext: TurnContext;
      reply: null;
      actions: null;
    }
  | {
      status: 'ready';
      route: 'agent' | 'automation';
      turnContext: TurnContext;
      reply: StructuredReply;
      actions: ResolvedAction[];
    };

export class ReplyOrchestratorService {
  constructor(private readonly actionResolver = new ActionResolverService()) {}

  async handle(
    turnInput: TurnInput,
    _session: Session,
    context: ReplyOrchestratorHandleContext = {},
  ): Promise<ReplyOrchestratorHandleResult> {
    const { route, turnContext } = buildReplyTurnContext(turnInput, {
      capabilitySnapshot: context.capabilitySnapshot,
      continuationContext: context.continuationContext,
      routeHint: context.routeHint,
    });

    if (route === 'no_reply') {
      return {
        status: 'no_reply',
        route,
        turnContext,
        reply: null,
        actions: [{ kind: 'no_reply' }],
      };
    }

    if (!context.responseMessage) {
      return {
        status: 'await_model',
        route,
        turnContext,
        reply: null,
        actions: null,
      };
    }

    const compiler = new StructuredReplyCompilerService(context.responseMessage, {
      outputProtocol: context.outputProtocol,
      ...(context.capabilitySnapshot == null ? {} : {
        canVoice: context.capabilitySnapshot.canVoice,
        canMeme: context.capabilitySnapshot.canSticker,
      }),
    });
    const reply = compiler.compile();
    const actions = await this.actionResolver.resolve(reply, turnContext, _session);
    return {
      status: 'ready',
      route,
      turnContext,
      reply,
      actions,
    };
  }
}
