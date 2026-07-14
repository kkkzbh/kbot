import { StructuredTool } from '@langchain/core/tools';
import type { Context, Session } from 'koishi';
import type { ChatLunaTool, ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types';
import { z } from 'zod';
import type { HbuJwCourseGuidanceService, GuidanceSectionRef } from './course-guidance.js';
import { HbuJwUserError, type OwnerIdentity } from './types.js';

export const HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL = 'hbu_jw_course_guidance_context';
export const HBU_JW_COURSE_OFFERINGS_TOOL = 'hbu_jw_course_offerings';
export const HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL = 'hbu_jw_validate_course_recommendation';

interface ChatLunaPlatformLike {
  registerTool(name: string, tool: ChatLunaTool): () => void;
}

export interface HbuJwCourseGuidanceToolsContext extends Context {
  chatluna: {
    platform: ChatLunaPlatformLike;
  };
}

interface GuidanceRunState {
  phase: 'context-loaded' | 'offerings-loaded';
  expiresAt: number;
}

class GuidanceRunRegistry {
  private readonly states = new Map<string, GuidanceRunState>();

  start(ownerKey: string): void {
    this.states.set(ownerKey, { phase: 'context-loaded', expiresAt: Date.now() + 15 * 60_000 });
  }

  require(ownerKey: string, phase: GuidanceRunState['phase']): void {
    const state = this.states.get(ownerKey);
    if (!state || state.expiresAt <= Date.now()) {
      this.states.delete(ownerKey);
      throw new HbuJwUserError(`请先调用 ${HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL} 获取本轮实时上下文。`);
    }
    if (state.phase !== phase) {
      throw new HbuJwUserError(phase === 'context-loaded'
        ? `当前应调用 ${HBU_JW_COURSE_OFFERINGS_TOOL} 查询开课班次。`
        : `请先调用 ${HBU_JW_COURSE_OFFERINGS_TOOL} 查询开课班次。`);
    }
  }

  markOfferingsLoaded(ownerKey: string): void {
    this.states.set(ownerKey, { phase: 'offerings-loaded', expiresAt: Date.now() + 15 * 60_000 });
  }

  finish(ownerKey: string): void {
    this.states.delete(ownerKey);
  }
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

  protected identity(config: ChatLunaToolRunnable): OwnerIdentity {
    const session = config.configurable.session as Session | undefined;
    const platform = String(session?.platform ?? '').trim();
    const qqUserId = String(session?.userId ?? '').trim();
    const channelId = String(session?.channelId ?? '').trim();
    if (!platform || !qqUserId || !channelId) {
      throw new HbuJwUserError('当前 Agent 会话缺少 QQ 身份信息，无法查询教务。');
    }
    return { ownerKey: `${platform}:${qqUserId}`, platform, qqUserId, channelId };
  }
}

class HbuJwCourseGuidanceContextTool extends HbuJwGuidanceToolBase {
  name = HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL;
  description = 'Load the bound user’s live official training plan, passing courses, current course-selection progress, deterministic credit gaps, candidate course index, and privacy-safe completion card. This must be the first tool used for 选课指导.';
  schema = z.object({});

  async _call(_input: Record<string, never>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const identity = this.identity(config);
    const context = await this.service.getContext(identity);
    this.runs.start(runKey(identity));
    return JSON.stringify(context);
  }
}

class HbuJwCourseOfferingsTool extends HbuJwGuidanceToolBase {
  name = HBU_JW_COURSE_OFFERINGS_TOOL;
  description = 'Query a bounded list of live selectable HBU sections for the current course-selection round. The server removes passed, already-selected, full, irrelevant, and time-conflicting sections. Call only after hbu_jw_course_guidance_context.';
  schema = OfferingsSchema;

  async _call(input: z.infer<typeof OfferingsSchema>, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const identity = this.identity(config);
    this.runs.require(runKey(identity), 'context-loaded');
    const result = await this.service.getOfferings(identity, input);
    this.runs.markOfferingsLoaded(runKey(identity));
    return JSON.stringify(result);
  }
}

class HbuJwValidateCourseRecommendationTool extends HbuJwGuidanceToolBase {
  name = HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL;
  description = 'Re-query live availability and current selections, then validate exact recommended HBU sections, conflicts, category caps, and projected completion. A recommendation must never be shown unless this returns valid=true. Call only after hbu_jw_course_offerings.';
  schema = ValidateSchema;

  async _call(input: { sections: GuidanceSectionRef[] }, _runManager: unknown, config: ChatLunaToolRunnable): Promise<string> {
    const identity = this.identity(config);
    this.runs.require(runKey(identity), 'offerings-loaded');
    const result = await this.service.validateRecommendation(identity, input.sections);
    if (result.valid) this.runs.finish(runKey(identity));
    return JSON.stringify(result);
  }
}

function runKey(identity: OwnerIdentity): string {
  return `${identity.ownerKey}:${identity.channelId}`;
}

function toolEntry(
  name: string,
  description: string,
  createTool: () => StructuredTool,
  isSessionEnabled: (session: Session) => boolean,
): ChatLunaTool {
  return {
    name,
    description,
    selector: () => true,
    authorization: (session) => Boolean(session?.userId) && isSessionEnabled(session),
    createTool,
  };
}

export function registerHbuJwCourseGuidanceTools(
  ctx: HbuJwCourseGuidanceToolsContext,
  service: HbuJwCourseGuidanceService,
  isSessionEnabled: (session: Session) => boolean,
): Array<() => void> {
  const runs = new GuidanceRunRegistry();
  const platform = ctx.chatluna.platform;
  return [
    platform.registerTool(
      HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL,
      toolEntry(HBU_JW_COURSE_GUIDANCE_CONTEXT_TOOL, 'Load live HBU course-guidance context and card.', () => new HbuJwCourseGuidanceContextTool(service, runs), isSessionEnabled),
    ),
    platform.registerTool(
      HBU_JW_COURSE_OFFERINGS_TOOL,
      toolEntry(HBU_JW_COURSE_OFFERINGS_TOOL, 'Query filtered live HBU course offerings.', () => new HbuJwCourseOfferingsTool(service, runs), isSessionEnabled),
    ),
    platform.registerTool(
      HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL,
      toolEntry(HBU_JW_VALIDATE_COURSE_RECOMMENDATION_TOOL, 'Validate a live HBU course recommendation.', () => new HbuJwValidateCourseRecommendationTool(service, runs), isSessionEnabled),
    ),
  ];
}
