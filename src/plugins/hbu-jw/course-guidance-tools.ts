import { StructuredTool } from '@langchain/core/tools';
import type { Context, Session } from 'koishi';
import type { ChatLunaTool, ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types';
import { z } from 'zod';
import type { HbuJwCourseGuidanceService, GuidanceSectionRef } from './course-guidance.js';
import { HbuJwUserError, type OwnerIdentity } from './types.js';

export const HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL = 'hbu_jw_course_guidance_context';
export const HBU_JW_COURSE_OFFERINGS_TOOL = 'hbu_jw_course_offerings';
export const HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL = 'hbu_jw_validate_course_recommendation';
export const HBU_JW_COURSE_GUIDANCE_TOOL_SEQUENCE = [
  HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL,
  HBU_JW_COURSE_OFFERINGS_TOOL,
  HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL,
] as const;

interface ChatLunaPlatformLike {
  registerTool(name: string, tool: ChatLunaTool): () => void;
}

export interface HbuJwCourseGuidanceToolsContext extends Context {
  chatluna: {
    platform: ChatLunaPlatformLike;
  };
}

export type GuidanceRunPhase = 'activated' | 'context-loaded' | 'offerings-loaded' | 'validated';

interface GuidanceRunState {
  phase: GuidanceRunPhase;
  expiresAt: number;
}

const GUIDANCE_RUN_TTL_MS = 15 * 60_000;

export class GuidanceRunRegistry {
  private readonly states = new Map<string, GuidanceRunState>();

  constructor(private readonly now: () => number = Date.now) {}

  activate(session: Session): void {
    const now = this.now();
    this.deleteExpired(now);
    this.states.set(requireGuidanceRunKey(session), {
      phase: 'activated',
      expiresAt: now + GUIDANCE_RUN_TTL_MS,
    });
  }

  isActive(session: Session): boolean {
    const key = guidanceRunKey(session);
    if (!key) return false;
    return this.read(key) != null;
  }

  phase(session: Session): GuidanceRunPhase | null {
    const key = guidanceRunKey(session);
    if (!key) return null;
    return this.read(key)?.phase ?? null;
  }

  require(session: Session, phase: GuidanceRunPhase): void {
    const key = requireGuidanceRunKey(session);
    const state = this.read(key);
    if (!state) {
      throw new HbuJwUserError(`请先调用 ${HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL} 获取本轮实时上下文。`);
    }
    if (state.phase !== phase) {
      throw new HbuJwUserError(expectedPhaseMessage(state.phase));
    }
  }

  markContextLoaded(session: Session): void {
    this.transition(session, 'activated', 'context-loaded');
  }

  markOfferingsLoaded(session: Session): void {
    this.transition(session, 'context-loaded', 'offerings-loaded');
  }

  markValidated(session: Session): void {
    this.transition(session, 'offerings-loaded', 'validated');
  }

  private transition(session: Session, from: GuidanceRunPhase, to: GuidanceRunPhase): void {
    this.require(session, from);
    this.states.set(requireGuidanceRunKey(session), {
      phase: to,
      expiresAt: this.now() + GUIDANCE_RUN_TTL_MS,
    });
  }

  private read(key: string): GuidanceRunState | null {
    const state = this.states.get(key);
    if (!state) return null;
    if (state.expiresAt <= this.now()) {
      this.states.delete(key);
      return null;
    }
    return state;
  }

  private deleteExpired(now: number): void {
    for (const [key, state] of this.states) {
      if (state.expiresAt <= now) this.states.delete(key);
    }
  }
}

function expectedPhaseMessage(phase: GuidanceRunPhase): string {
  if (phase === 'activated') {
    return `当前应调用 ${HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL} 获取本轮实时上下文。`;
  }
  if (phase === 'context-loaded') {
    return `当前应调用 ${HBU_JW_COURSE_OFFERINGS_TOOL} 查询开课班次。`;
  }
  if (phase === 'offerings-loaded') {
    return `当前应调用 ${HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL} 验证推荐方案。`;
  }
  return '本轮选课指导已完成最终验证。';
}

function guidanceRunKey(session: Session): string | null {
  const platform = String(session.platform ?? '').trim();
  const userId = String(session.userId ?? '').trim();
  const channelId = String(session.channelId ?? '').trim();
  const messageId = String(session.messageId ?? '').trim();
  if (!platform || !userId || !channelId || !messageId) return null;
  return `${platform}:${userId}:${channelId}:${messageId}`;
}

function requireGuidanceRunKey(session: Session): string {
  const key = guidanceRunKey(session);
  if (!key) {
    throw new HbuJwUserError('当前 Agent 会话缺少平台、用户、频道或消息标识，无法执行选课指导。');
  }
  return key;
}

const OfferingsSchema = z.object({
  courseNumbers: z.array(z.string().trim().min(1)).max(40).optional()
    .describe('Optional limited list of official course numbers from the guidance context.'),
  includeGeneralElectives: z.boolean().default(false)
    .describe('Set true only when the context reports a remaining general elective category gap.'),
});

const SectionSchema = z.object({
  executionPlanNumber: z.string().trim().min(1).describe('执行计划号'),
  courseNumber: z.string().trim().min(1).describe('课程号'),
  sequenceNumber: z.string().trim().min(1).describe('课序号'),
});

const ValidateSchema = z.object({
  sections: z.array(SectionSchema).min(1).max(30)
    .describe('The exact section identifiers selected from hbu_jw_course_offerings.'),
});

abstract class HbuJwGuidanceToolBase extends StructuredTool {
  constructor(
    protected readonly service: HbuJwCourseGuidanceService,
    protected readonly runs: GuidanceRunRegistry,
  ) {
    super({});
  }

  protected invocation(config: ChatLunaToolRunnable): { identity: OwnerIdentity; session: Session } {
    const session = config.configurable.session as Session | undefined;
    const platform = String(session?.platform ?? '').trim();
    const qqUserId = String(session?.userId ?? '').trim();
    const channelId = String(session?.channelId ?? '').trim();
    const messageId = String(session?.messageId ?? '').trim();
    if (!session || !platform || !qqUserId || !channelId || !messageId) {
      throw new HbuJwUserError('当前 Agent 会话缺少 QQ 身份信息，无法查询教务。');
    }
    return {
      identity: { ownerKey: `${platform}:${qqUserId}`, platform, qqUserId, channelId },
      session,
    };
  }
}

class HbuJwCourseGuidanceContextTool extends HbuJwGuidanceToolBase {
  name = HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL;
  description = 'Load the bound user’s live official training plan, passing courses, current course-selection progress, deterministic credit gaps, candidate course index, and privacy-safe completion card. This must be the first tool used for 选课指导.';
  schema = z.object({});

  async _call(_input: Record<string, never>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const { identity, session } = this.invocation(config);
    this.runs.require(session, 'activated');
    const context = await this.service.getContext(identity);
    this.runs.markContextLoaded(session);
    return JSON.stringify(context);
  }
}

class HbuJwCourseOfferingsTool extends HbuJwGuidanceToolBase {
  name = HBU_JW_COURSE_OFFERINGS_TOOL;
  description = 'Query a bounded list of live selectable HBU sections for the current course-selection round. The server removes passed, already-selected, full, irrelevant, and time-conflicting sections. Call only after hbu_jw_course_guidance_context.';
  schema = OfferingsSchema;

  async _call(input: z.infer<typeof OfferingsSchema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const { identity, session } = this.invocation(config);
    this.runs.require(session, 'context-loaded');
    const result = await this.service.getOfferings(identity, input);
    this.runs.markOfferingsLoaded(session);
    return JSON.stringify(result);
  }
}

class HbuJwValidateCourseRecommendationTool extends HbuJwGuidanceToolBase {
  name = HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL;
  description = 'Re-query live availability and current selections, then validate exact recommended HBU sections, conflicts, category caps, and projected completion. A recommendation must never be shown unless this returns valid=true. Call only after hbu_jw_course_offerings.';
  schema = ValidateSchema;

  async _call(input: { sections: GuidanceSectionRef[] }, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const { identity, session } = this.invocation(config);
    this.runs.require(session, 'offerings-loaded');
    const result = await this.service.validateRecommendation(identity, input.sections);
    if (result.valid) this.runs.markValidated(session);
    return JSON.stringify(result);
  }
}

function toolEntry(
  name: string,
  description: string,
  createTool: () => StructuredTool,
  runs: GuidanceRunRegistry,
): ChatLunaTool {
  return {
    name,
    description,
    selector: () => true,
    authorization: (session) => runs.isActive(session),
    createTool,
  };
}

export function registerHbuJwCourseGuidanceTools(
  ctx: HbuJwCourseGuidanceToolsContext,
  service: HbuJwCourseGuidanceService,
  runs: GuidanceRunRegistry,
): Array<() => void> {
  const platform = ctx.chatluna.platform;
  return [
    platform.registerTool(
      HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL,
      toolEntry(HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL, 'Load live HBU course-guidance context and card.', () => new HbuJwCourseGuidanceContextTool(service, runs), runs),
    ),
    platform.registerTool(
      HBU_JW_COURSE_OFFERINGS_TOOL,
      toolEntry(HBU_JW_COURSE_OFFERINGS_TOOL, 'Query filtered live HBU course offerings.', () => new HbuJwCourseOfferingsTool(service, runs), runs),
    ),
    platform.registerTool(
      HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL,
      toolEntry(HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL, 'Validate a live HBU course recommendation.', () => new HbuJwValidateCourseRecommendationTool(service, runs), runs),
    ),
  ];
}
