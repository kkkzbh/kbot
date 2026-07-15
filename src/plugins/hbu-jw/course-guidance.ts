import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HbuJwHttpClient } from './jw-client.js';
import type { HbuJwSchedulePuppeteerLike } from './schedule.js';
import type { HbuJwStore } from './store.js';
import {
  HbuJwUserError,
  type HbuJwCourseOffering,
  type HbuJwCourseOfferingMeeting,
  type HbuJwCourseSelectionResult,
  type HbuJwScoreRow,
  type HbuJwThisSemesterSchedule,
  type HbuJwTrainingPlanCourse,
  type HbuJwTrainingPlanCacheRow,
  type HbuJwTrainingPlanSnapshot,
  type OwnerIdentity,
  type SerializedCookieJar,
} from './types.js';

const PLAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NO_PLAN_MESSAGE = '你所在的专业尚未导入培养方案信息，暂时无法提供选课指导。';
const MAX_OFFERINGS_EXPOSED = 80;

export interface HbuJwGuidanceAuthServiceLike {
  ensureAuthenticated(identity: OwnerIdentity): Promise<
    | { kind: 'authenticated'; cookieJar: SerializedCookieJar; credentialVersion?: number }
    | { kind: 'needs_binding'; reason: string }
    | { kind: 'invalid'; reason: string }
  >;
}

export interface HbuJwGuidanceStorageLike {
  createTempFile(
    buffer: Buffer,
    filename: string,
    expireHours?: number,
    mimeType?: string,
  ): Promise<{ id: string; url: string }>;
}

export interface HbuJwGuidanceCategoryProgress {
  code: string;
  name: string;
  requiredCredits: number;
  completedCredits: number;
  inProgressCredits: number;
  remainingCredits: number;
}

export interface HbuJwGuidanceContext {
  plan: {
    planNumber: string;
    planName: string;
    majorName: string;
    cohortYear: number;
    requiredCredits: number;
    match: 'exact' | 'nearest-cohort';
    syncedAt: string;
  };
  progress: {
    completedCredits: number;
    inProgressCredits: number;
    remainingCredits: number;
    categories: HbuJwGuidanceCategoryProgress[];
  };
  passedCourses: Array<{ courseNumber: string; courseName: string; credits: number }>;
  currentSelections: Array<{
    courseNumber: string;
    courseName: string;
    sequenceNumber: string;
    executionPlanNumber: string;
    credits: number;
  }>;
  currentSemesterCourses: Array<{
    courseNumber: string;
    courseName: string;
    credits: number;
  }>;
  missingRequiredCourses: Array<{ courseNumber: string; courseName: string; credits: number | null; categoryCode: string }>;
  candidateCourses: Array<{
    courseNumber: string;
    courseName: string;
    credits: number | null;
    categoryCode: string;
    categoryName: string;
    attribute: HbuJwTrainingPlanCourse['attribute'];
  }>;
  unmappedCourses: Array<{ courseNumber: string; courseName: string; credits: number }>;
  dataAsOf: string;
  card?: { assetRef: string; alt: string; expiresInHours: 1 };
  recommendedReplyOrder?: ['card-image', 'validated-course-recommendations'];
}

interface LoadedGuidanceContext {
  publicContext: HbuJwGuidanceContext;
  cookieJar: SerializedCookieJar;
  snapshot: HbuJwTrainingPlanSnapshot;
  selection: HbuJwCourseSelectionResult;
  passedNumbers: Set<string>;
  selectedNumbers: Set<string>;
}

export interface GuidanceOfferingView extends HbuJwCourseOffering {
  conflict: false;
  mappedCategoryCode: string;
  mappedCategoryName: string;
  priority: 'missing-required' | 'plan-course' | 'elective-gap' | 'general-elective';
}

export interface GuidanceSectionRef {
  executionPlanNumber: string;
  courseNumber: string;
  sequenceNumber: string;
}

export interface GuidanceCreditTarget {
  categoryCode: string;
  categoryName: string;
  remainingCredits: number;
  maximumSelectableCredits: number;
  exactFillPossible: boolean;
  oneMaximumCourseCombination: string[];
  oneMaximumSectionCombination: GuidanceSectionRef[];
}

export class HbuJwCourseGuidanceService {
  constructor(
    private readonly auth: HbuJwGuidanceAuthServiceLike,
    private readonly client: HbuJwHttpClient,
    private readonly store: HbuJwStore,
    private readonly puppeteer: HbuJwSchedulePuppeteerLike,
    private readonly storage: HbuJwGuidanceStorageLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async assertBound(identity: OwnerIdentity): Promise<void> {
    await this.authenticate(identity);
  }

  async getContext(identity: OwnerIdentity): Promise<HbuJwGuidanceContext> {
    const loaded = await this.loadContext(identity);
    const image = await renderGuidanceCard(this.puppeteer, loaded.publicContext);
    const stored = await this.storage.createTempFile(
      image,
      `hbu-course-guidance-${randomUUID().slice(0, 8)}.png`,
      1,
      'image/png',
    );
    return {
      ...loaded.publicContext,
      card: { assetRef: stored.url, alt: '河北大学培养方案完成度卡片', expiresInHours: 1 },
      recommendedReplyOrder: ['card-image', 'validated-course-recommendations'],
    };
  }

  async getOfferings(
    identity: OwnerIdentity,
    input: { courseNumbers?: string[]; includeGeneralElectives: boolean },
  ): Promise<{ offerings: GuidanceOfferingView[]; creditTargets: GuidanceCreditTarget[]; dataAsOf: string }> {
    const loaded = await this.loadContext(identity);
    const requested = input.courseNumbers?.length
      ? new Set(input.courseNumbers.map((value) => value.trim()).filter(Boolean))
      : null;
    const planOfferings = await this.client.getPlanCourseOfferings(loaded.cookieJar, loaded.snapshot.planNumber);
    const generalCategory = findGeneralElectiveCategory(loaded);
    const includeGeneral = input.includeGeneralElectives && Boolean(generalCategory?.remainingCredits);
    const freeOfferings = includeGeneral
      ? await this.client.getFreeCourseOfferings(loaded.cookieJar)
      : [];
    const planCourseByNumber = createPlanCourseIndex(loaded.snapshot);
    const missingRequired = new Set(loaded.publicContext.missingRequiredCourses.map((course) => course.courseNumber));
    const meetings = selectionMeetings(loaded.selection);
    const result: GuidanceOfferingView[] = [];
    const sourcedOfferings = [
      ...planOfferings.map((offering) => ({ offering, source: 'plan' as const })),
      ...freeOfferings.map((offering) => ({ offering, source: 'free' as const })),
    ];
    for (const { offering, source } of sourcedOfferings) {
      if (source === 'plan' && requested && !requested.has(offering.courseNumber)) continue;
      if (loaded.passedNumbers.has(offering.courseNumber) || loaded.selectedNumbers.has(offering.courseNumber)) continue;
      if (offering.remainingSeats <= 0 || hasMeetingConflict(offering.meetings, meetings)) continue;
      const planCourse = planCourseByNumber.get(offering.courseNumber);
      const isFree = !planCourse;
      if (isFree && !includeGeneral) continue;
      if (!isFree && !loaded.publicContext.candidateCourses.some((course) => course.courseNumber === offering.courseNumber)) continue;
      const category = planCourse
        ? loaded.publicContext.progress.categories.find((item) => item.code === planCourse.categoryCode)
        : generalCategory;
      if (!category || (planCourse?.attribute !== 'required' && category.remainingCredits <= 0)) continue;
      result.push({
        ...offering,
        conflict: false,
        mappedCategoryCode: category.code,
        mappedCategoryName: category.name,
        priority: missingRequired.has(offering.courseNumber)
          ? 'missing-required'
          : source === 'free'
            ? 'general-elective'
            : 'plan-course',
      });
    }
    result.sort(compareOfferings);
    const exposedOfferings = result.slice(0, MAX_OFFERINGS_EXPOSED);
    const creditTargets = loaded.publicContext.progress.categories
      .filter((category) => category.remainingCredits > 0)
      .map((category) => {
        const options = exposedOfferings.filter((offering) => offering.mappedCategoryCode === category.code && offering.priority !== 'missing-required');
        const combination = selectMaxConflictFreeCreditCombination(
          options,
          Math.min(category.remainingCredits, loaded.publicContext.progress.remainingCredits),
        );
        const maximumSelectableCredits = sumCredits(combination);
        return {
          categoryCode: category.code,
          categoryName: category.name,
          remainingCredits: category.remainingCredits,
          maximumSelectableCredits,
          exactFillPossible: Math.abs(maximumSelectableCredits - category.remainingCredits) < 0.001,
          oneMaximumCourseCombination: combination.map((offering) => offering.courseNumber),
          oneMaximumSectionCombination: combination.map(sectionRef),
        };
      });
    return {
      offerings: exposedOfferings,
      creditTargets,
      dataAsOf: new Date(this.now()).toISOString(),
    };
  }

  async validateRecommendation(
    identity: OwnerIdentity,
    sections: GuidanceSectionRef[],
  ): Promise<{
    valid: boolean;
    errors: Array<{ code: string; section?: GuidanceSectionRef; message: string }>;
    recommendedCredits: number;
    expectedProgress: HbuJwGuidanceContext['progress'];
    unavoidableOverageCredits: number;
    validatedAt: string;
  }> {
    const loaded = await this.loadContext(identity);
    const generalCategory = findGeneralElectiveCategory(loaded);
    const offeringsResult = await this.getOfferings(identity, {
      includeGeneralElectives: Boolean(generalCategory?.remainingCredits),
    });
    const offeringIndex = new Map(offeringsResult.offerings.map((offering) => [offeringKey(offering), offering]));
    const errors: Array<{ code: string; section?: GuidanceSectionRef; message: string }> = [];
    const selected: GuidanceOfferingView[] = [];
    const seenCourses = new Set<string>();
    for (const section of sections) {
      if (seenCourses.has(section.courseNumber)) {
        errors.push({ code: 'duplicate_course', section, message: '同一课程只能推荐一个班次。' });
        continue;
      }
      seenCourses.add(section.courseNumber);
      const offering = offeringIndex.get(offeringKey(section));
      if (!offering) {
        errors.push({ code: 'unavailable', section, message: '班次已满、已选、时间冲突或当前选课接口已不再提供。' });
        continue;
      }
      if (selected.some((current) => hasMeetingConflict(offering.meetings, current.meetings))) {
        errors.push({ code: 'recommendation_conflict', section, message: '推荐班次之间存在时间冲突。' });
        continue;
      }
      selected.push(offering);
    }

    const projected = loaded.publicContext.progress.categories.map((category) => ({ ...category }));
    const projectedByCode = new Map(projected.map((category) => [category.code, category]));
    let recommendedCredits = 0;
    let unavoidableOverageCredits = 0;
    let totalRemaining = loaded.publicContext.progress.remainingCredits;
    const planIndex = createPlanCourseIndex(loaded.snapshot);
    for (const offering of selected) {
      const category = projectedByCode.get(offering.mappedCategoryCode)!;
      const course = planIndex.get(offering.courseNumber);
      const mandatory = course?.attribute === 'required';
      if (!mandatory && (offering.credits > category.remainingCredits || offering.credits > totalRemaining)) {
        errors.push({
          code: 'credit_overflow',
          section: sectionRef(offering),
          message: `该任选课会超过“${category.name}”或总方案的剩余最低学分。`,
        });
        continue;
      }
      recommendedCredits += offering.credits;
      category.inProgressCredits += offering.credits;
      category.remainingCredits = Math.max(0, category.requiredCredits - category.completedCredits - category.inProgressCredits);
      if (mandatory && offering.credits > totalRemaining) unavoidableOverageCredits += offering.credits - totalRemaining;
      totalRemaining = Math.max(0, totalRemaining - offering.credits);
    }
    const mandatorySelections = selected.filter((offering) => planIndex.get(offering.courseNumber)?.attribute === 'required');
    let electiveTotalCapacity = Math.max(
      0,
      loaded.publicContext.progress.remainingCredits - sumCredits(mandatorySelections),
    );
    for (const category of loaded.publicContext.progress.categories) {
      const categorySelected = selected.filter((offering) => offering.mappedCategoryCode === category.code
        && planIndex.get(offering.courseNumber)?.attribute !== 'required');
      const selectedCredits = sumCredits(categorySelected);
      const options = offeringsResult.offerings.filter((offering) => offering.mappedCategoryCode === category.code
        && planIndex.get(offering.courseNumber)?.attribute !== 'required'
        && !mandatorySelections.some((mandatory) => hasMeetingConflict(offering.meetings, mandatory.meetings)));
      const maximum = sumCredits(selectMaxConflictFreeCreditCombination(
        options,
        Math.min(category.remainingCredits, electiveTotalCapacity),
        mandatorySelections.flatMap((offering) => offering.meetings),
      ));
      if (selectedCredits + 0.001 < maximum) {
        errors.push({
          code: 'not_maximal_credit_fit',
          message: `“${category.name}”仍可在不超额的前提下选择 ${formatCredits(maximum)} 学分，本方案只选择了 ${formatCredits(selectedCredits)} 学分。`,
        });
      }
      electiveTotalCapacity = Math.max(0, electiveTotalCapacity - selectedCredits);
    }
    const completedCredits = loaded.publicContext.progress.completedCredits;
    const inProgressCredits = loaded.publicContext.progress.inProgressCredits + recommendedCredits;
    return {
      valid: errors.length === 0 && selected.length === sections.length,
      errors,
      recommendedCredits,
      expectedProgress: {
        completedCredits,
        inProgressCredits,
        remainingCredits: Math.max(0, loaded.snapshot.requiredCredits - completedCredits - inProgressCredits),
        categories: projected,
      },
      unavoidableOverageCredits,
      validatedAt: new Date(this.now()).toISOString(),
    };
  }

  private async loadContext(identity: OwnerIdentity): Promise<LoadedGuidanceContext> {
    const cookieJar = await this.authenticate(identity);
    const profile = await this.client.getStudentPlanProfile(cookieJar);
    const { snapshot, match, syncedAt } = await this.resolveSnapshot(cookieJar, profile);
    const [scores, selection, currentSchedule] = await Promise.all([
      this.client.getAllPassingScores(cookieJar),
      this.client.getCourseSelectionResult(cookieJar),
      this.client.getThisSemesterSchedule(cookieJar),
    ]);
    const calculated = calculateGuidanceProgress(snapshot, scores, selection, currentSchedule);
    return {
      cookieJar,
      snapshot,
      selection,
      passedNumbers: calculated.passedNumbers,
      selectedNumbers: calculated.selectedNumbers,
      publicContext: {
        plan: {
          planNumber: snapshot.planNumber,
          planName: snapshot.planName,
          majorName: snapshot.majorName,
          cohortYear: snapshot.cohortYear,
          requiredCredits: snapshot.requiredCredits,
          match,
          syncedAt: new Date(syncedAt).toISOString(),
        },
        progress: calculated.progress,
        passedCourses: calculated.passedCourses,
        currentSelections: calculated.currentSelections,
        currentSemesterCourses: calculated.currentSemesterCourses,
        missingRequiredCourses: calculated.missingRequiredCourses,
        candidateCourses: calculated.candidateCourses,
        unmappedCourses: calculated.unmappedCourses,
        dataAsOf: new Date(this.now()).toISOString(),
      },
    };
  }

  private async authenticate(identity: OwnerIdentity): Promise<SerializedCookieJar> {
    const auth = await this.auth.ensureAuthenticated(identity);
    if (auth.kind !== 'authenticated') throw new HbuJwUserError(auth.reason);
    return auth.cookieJar;
  }

  private async resolveSnapshot(
    cookieJar: SerializedCookieJar,
    profile: Awaited<ReturnType<HbuJwHttpClient['getStudentPlanProfile']>>,
  ): Promise<{ snapshot: HbuJwTrainingPlanSnapshot; match: 'exact' | 'nearest-cohort'; syncedAt: number }> {
    const now = this.now();
    if (profile.planNumber) {
      const cached = await this.store.getTrainingPlan(profile.planNumber);
      if (cached && now - cached.syncedAt < PLAN_CACHE_TTL_MS) {
        return { snapshot: parseCachedSnapshot(cached.snapshotJson), match: 'exact', syncedAt: cached.syncedAt };
      }
      const snapshot = await this.client.getTrainingPlanSnapshot(cookieJar, profile);
      validateTrainingPlanSnapshot(snapshot);
      const serialized = JSON.stringify(snapshot);
      await this.store.upsertTrainingPlan(snapshot, createHash('sha256').update(serialized).digest('hex'), now);
      return { snapshot, match: 'exact', syncedAt: now };
    }

    const nearest = selectNearestFreshTrainingPlan(
      await this.store.listTrainingPlansByMajor(profile.majorName),
      profile.majorName,
      profile.cohortYear,
      now,
    );
    if (!nearest) throw new HbuJwUserError(NO_PLAN_MESSAGE);
    return { snapshot: parseCachedSnapshot(nearest.snapshotJson), match: 'nearest-cohort', syncedAt: nearest.syncedAt };
  }
}

export function selectMaxCreditCombination<T extends { courseNumber: string; credits: number }>(
  options: T[],
  creditLimit: number,
): T[] {
  const scale = 100;
  const limit = Math.max(0, Math.floor(creditLimit * scale + 0.001));
  const unique = [...new Map(options
    .filter((option) => Number.isFinite(option.credits) && option.credits > 0)
    .map((option) => [option.courseNumber, option])).values()]
    .sort((left, right) => left.courseNumber.localeCompare(right.courseNumber));
  const states = new Map<number, T[]>([[0, []]]);
  for (const option of unique) {
    const weight = Math.round(option.credits * scale);
    for (const [sum, combination] of [...states.entries()].sort((left, right) => right[0] - left[0])) {
      const next = sum + weight;
      if (next <= limit && !states.has(next)) states.set(next, [...combination, option]);
    }
  }
  const best = Math.max(...states.keys());
  return states.get(best) ?? [];
}

export function selectMaxConflictFreeCreditCombination<
  T extends { courseNumber: string; credits: number; meetings: HbuJwCourseOfferingMeeting[] },
>(
  options: T[],
  creditLimit: number,
  blockedMeetings: HbuJwCourseOfferingMeeting[] = [],
): T[] {
  const scale = 100;
  const limit = Math.max(0, Math.floor(creditLimit * scale + 0.001));
  const grouped = new Map<string, T[]>();
  for (const option of options) {
    if (!Number.isFinite(option.credits) || option.credits <= 0) continue;
    const sections = grouped.get(option.courseNumber) ?? [];
    sections.push(option);
    grouped.set(option.courseNumber, sections);
  }
  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, sections]) => sections);
  const reachable = new Set<number>([0]);
  for (const sections of groups) {
    const weights = new Set(sections.map((section) => Math.round(section.credits * scale)));
    for (const current of [...reachable].sort((left, right) => right - left)) {
      for (const weight of weights) {
        if (current + weight <= limit) reachable.add(current + weight);
      }
    }
  }
  const blockedMask = meetingScheduleMask(blockedMeetings);
  const maximumRemaining = new Array<number>(groups.length + 1).fill(0);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    maximumRemaining[index] = maximumRemaining[index + 1]!
      + Math.max(...groups[index]!.map((section) => Math.round(section.credits * scale)));
  }
  for (const target of [...reachable].sort((left, right) => right - left)) {
    const failed = new Set<string>();
    const search = (index: number, credits: number, occupied: bigint): T[] | null => {
      if (credits === target) return [];
      if (index >= groups.length || credits > target || credits + maximumRemaining[index]! < target) return null;
      const stateKey = `${index}:${credits}:${occupied.toString(36)}`;
      if (failed.has(stateKey)) return null;
      for (const section of groups[index]!) {
        const weight = Math.round(section.credits * scale);
        const mask = meetingScheduleMask(section.meetings);
        if (credits + weight > target || (occupied & mask) !== 0n) continue;
        const tail = search(index + 1, credits + weight, occupied | mask);
        if (tail) return [section, ...tail];
      }
      const skipped = search(index + 1, credits, occupied);
      if (skipped) return skipped;
      failed.add(stateKey);
      return null;
    };
    const combination = search(0, 0, blockedMask);
    if (combination) return combination;
  }
  return [];
}

function sumCredits(items: Array<{ credits: number }>): number {
  return items.reduce((sum, item) => sum + item.credits, 0);
}

export function calculateGuidanceProgress(
  snapshot: HbuJwTrainingPlanSnapshot,
  scores: HbuJwScoreRow[],
  selection: HbuJwCourseSelectionResult,
  currentSchedule?: HbuJwThisSemesterSchedule,
): {
  progress: HbuJwGuidanceContext['progress'];
  passedCourses: HbuJwGuidanceContext['passedCourses'];
  currentSelections: HbuJwGuidanceContext['currentSelections'];
  currentSemesterCourses: HbuJwGuidanceContext['currentSemesterCourses'];
  missingRequiredCourses: HbuJwGuidanceContext['missingRequiredCourses'];
  candidateCourses: HbuJwGuidanceContext['candidateCourses'];
  unmappedCourses: HbuJwGuidanceContext['unmappedCourses'];
  passedNumbers: Set<string>;
  selectedNumbers: Set<string>;
} {
  const courseIndex = createPlanCourseIndex(snapshot);
  const replacementIndex = new Map<string, HbuJwTrainingPlanCourse>();
  for (const course of snapshot.courses) {
    for (const substitute of course.replacementCourseNumbers) replacementIndex.set(substitute, course);
  }
  const passedNumbers = new Set<string>();
  const passedCourses: HbuJwGuidanceContext['passedCourses'] = [];
  const unmappedCourses: HbuJwGuidanceContext['unmappedCourses'] = [];
  const completedByCategory = new Map<string, number>();
  for (const score of scores) {
    const courseNumber = String(score.id?.courseNumber ?? '').trim();
    const credits = Number(score.credit);
    if (!courseNumber || !Number.isFinite(credits) || credits <= 0 || passedNumbers.has(courseNumber)) continue;
    passedNumbers.add(courseNumber);
    const course = courseIndex.get(courseNumber) ?? replacementIndex.get(courseNumber);
    const summary = { courseNumber, courseName: String(score.courseName ?? course?.courseName ?? courseNumber).trim(), credits };
    passedCourses.push(summary);
    if (!course) {
      unmappedCourses.push(summary);
      continue;
    }
    completedByCategory.set(course.categoryCode, (completedByCategory.get(course.categoryCode) ?? 0) + credits);
    passedNumbers.add(course.courseNumber);
  }

  const selectedNumbers = new Set<string>();
  const currentSemesterCourses: HbuJwGuidanceContext['currentSemesterCourses'] = [];
  const currentSelections: HbuJwGuidanceContext['currentSelections'] = [];
  const inProgressByCategory = new Map<string, number>();
  for (const scheduled of currentSchedule?.courses ?? []) {
    if (selectedNumbers.has(scheduled.courseNumber) || passedNumbers.has(scheduled.courseNumber)) continue;
    selectedNumbers.add(scheduled.courseNumber);
    currentSemesterCourses.push({
      courseNumber: scheduled.courseNumber,
      courseName: scheduled.courseName,
      credits: scheduled.unit,
    });
    const course = courseIndex.get(scheduled.courseNumber) ?? replacementIndex.get(scheduled.courseNumber);
    if (!course) {
      unmappedCourses.push({ courseNumber: scheduled.courseNumber, courseName: scheduled.courseName, credits: scheduled.unit });
      continue;
    }
    selectedNumbers.add(course.courseNumber);
    inProgressByCategory.set(course.categoryCode, (inProgressByCategory.get(course.categoryCode) ?? 0) + scheduled.unit);
  }
  for (const selected of selection.groups.flatMap((group) => group.courses)) {
    if (selectedNumbers.has(selected.courseNumber) || passedNumbers.has(selected.courseNumber)) continue;
    selectedNumbers.add(selected.courseNumber);
    currentSelections.push({
      courseNumber: selected.courseNumber,
      courseName: selected.courseName,
      sequenceNumber: selected.sequenceNumber,
      executionPlanNumber: selected.executiveEducationPlanNumber,
      credits: selected.unit,
    });
    const course = courseIndex.get(selected.courseNumber) ?? replacementIndex.get(selected.courseNumber);
    if (!course) {
      unmappedCourses.push({ courseNumber: selected.courseNumber, courseName: selected.courseName, credits: selected.unit });
      continue;
    }
    selectedNumbers.add(course.courseNumber);
    inProgressByCategory.set(course.categoryCode, (inProgressByCategory.get(course.categoryCode) ?? 0) + selected.unit);
  }

  const categories = snapshot.categories.map((category) => {
    const completedCredits = Math.min(category.requiredCredits, completedByCategory.get(category.code) ?? 0);
    const inProgressCredits = Math.min(
      Math.max(0, category.requiredCredits - completedCredits),
      inProgressByCategory.get(category.code) ?? 0,
    );
    return {
      code: category.code,
      name: category.name,
      requiredCredits: category.requiredCredits,
      completedCredits,
      inProgressCredits,
      remainingCredits: Math.max(0, category.requiredCredits - completedCredits - inProgressCredits),
    };
  });
  const completedCredits = categories.reduce((sum, category) => sum + category.completedCredits, 0);
  const inProgressCredits = categories.reduce((sum, category) => sum + category.inProgressCredits, 0);
  const missingRequiredCourses = snapshot.courses
    .filter((course) => course.attribute === 'required' && !passedNumbers.has(course.courseNumber) && !selectedNumbers.has(course.courseNumber))
    .map(publicCourse);
  const candidateCourses = snapshot.courses
    .filter((course) => !passedNumbers.has(course.courseNumber) && !selectedNumbers.has(course.courseNumber))
    .filter((course) => course.attribute === 'required' || (categories.find((category) => category.code === course.categoryCode)?.remainingCredits ?? 0) > 0)
    .map((course) => ({ ...publicCourse(course), categoryName: course.categoryName, attribute: course.attribute }));
  return {
    progress: {
      completedCredits,
      inProgressCredits,
      remainingCredits: Math.max(0, snapshot.requiredCredits - completedCredits - inProgressCredits),
      categories,
    },
    passedCourses,
    currentSelections,
    currentSemesterCourses,
    missingRequiredCourses,
    candidateCourses,
    unmappedCourses,
    passedNumbers,
    selectedNumbers,
  };
}

function parseCachedSnapshot(value: string): HbuJwTrainingPlanSnapshot {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(value);
  } catch {
    throw new Error('hbu-jw training plan cache contains malformed JSON.');
  }
  validateTrainingPlanSnapshot(snapshot);
  return snapshot;
}

export function selectNearestFreshTrainingPlan(
  rows: HbuJwTrainingPlanCacheRow[],
  majorName: string,
  cohortYear: number,
  now: number,
): HbuJwTrainingPlanCacheRow | null {
  return rows
    .filter((row) => row.majorName === majorName && now - row.syncedAt < PLAN_CACHE_TTL_MS)
    .sort((left, right) => {
      const distance = Math.abs(left.cohortYear - cohortYear) - Math.abs(right.cohortYear - cohortYear);
      return distance || left.cohortYear - right.cohortYear;
    })[0] ?? null;
}

export function validateTrainingPlanSnapshot(value: unknown): asserts value is HbuJwTrainingPlanSnapshot {
  if (!value || typeof value !== 'object') throw new Error('hbu-jw training plan snapshot is invalid.');
  const snapshot = value as Partial<HbuJwTrainingPlanSnapshot>;
  if (!snapshot.planNumber || !snapshot.planName || !snapshot.majorCode || !snapshot.majorName
    || !Number.isInteger(snapshot.cohortYear) || !Number.isFinite(snapshot.requiredCredits) || snapshot.requiredCredits! <= 0
    || !Array.isArray(snapshot.categories) || !Array.isArray(snapshot.courses)) {
    throw new Error('hbu-jw training plan snapshot is invalid.');
  }
  const requiredCredits = snapshot.requiredCredits as number;
  const categoryCodes = new Set<string>();
  let categoryTotal = 0;
  for (const category of snapshot.categories) {
    if (!category.code || !category.name || categoryCodes.has(category.code)
      || !Number.isFinite(category.requiredCredits) || category.requiredCredits <= 0) {
      throw new Error('hbu-jw training plan snapshot contains an invalid category.');
    }
    categoryCodes.add(category.code);
    categoryTotal += category.requiredCredits;
  }
  if (Math.abs(categoryTotal - requiredCredits) > 0.001) {
    throw new Error('hbu-jw training plan category credits do not match the official total.');
  }
  const courseNumbers = new Set<string>();
  for (const course of snapshot.courses) {
    if (!course.courseNumber || !course.courseName || courseNumbers.has(course.courseNumber)
      || !categoryCodes.has(course.categoryCode)
      || !['required', 'limited', 'elective'].includes(course.attribute)
      || (course.credits !== null && (!Number.isFinite(course.credits) || course.credits <= 0))
      || !Array.isArray(course.replacementCourseNumbers)) {
      throw new Error('hbu-jw training plan snapshot contains an invalid course.');
    }
    courseNumbers.add(course.courseNumber);
  }
}

function createPlanCourseIndex(snapshot: HbuJwTrainingPlanSnapshot): Map<string, HbuJwTrainingPlanCourse> {
  return new Map(snapshot.courses.map((course) => [course.courseNumber, course]));
}

function publicCourse(course: HbuJwTrainingPlanCourse): {
  courseNumber: string;
  courseName: string;
  credits: number | null;
  categoryCode: string;
} {
  return {
    courseNumber: course.courseNumber,
    courseName: course.courseName,
    credits: course.credits,
    categoryCode: course.categoryCode,
  };
}

function findGeneralElectiveCategory(loaded: LoadedGuidanceContext): HbuJwGuidanceCategoryProgress | undefined {
  return loaded.publicContext.progress.categories.find((category) => /通识.*通选|通选.*通识/.test(category.name));
}

function selectionMeetings(selection: HbuJwCourseSelectionResult): HbuJwCourseOfferingMeeting[] {
  return selection.groups.flatMap((group) => group.courses).flatMap((course) => course.timeAndPlaceList.map((meeting) => ({
    classWeek: meeting.classWeek,
    weekday: meeting.classDay,
    startSection: meeting.classSessions,
    sectionCount: meeting.continuingSession,
    campusName: meeting.campusName,
    teachingBuildingName: meeting.teachingBuildingName,
    classroomName: meeting.classroomName,
  })));
}

function hasMeetingConflict(left: HbuJwCourseOfferingMeeting[], right: HbuJwCourseOfferingMeeting[]): boolean {
  return left.some((a) => right.some((b) => a.weekday === b.weekday
    && sectionsOverlap(a, b)
    && weeksOverlap(a.classWeek, b.classWeek)));
}

function sectionsOverlap(left: HbuJwCourseOfferingMeeting, right: HbuJwCourseOfferingMeeting): boolean {
  const leftEnd = left.startSection + left.sectionCount - 1;
  const rightEnd = right.startSection + right.sectionCount - 1;
  return left.startSection <= rightEnd && right.startSection <= leftEnd;
}

function weeksOverlap(left: string, right: string): boolean {
  const leftWeeks = parseWeeks(left);
  const rightWeeks = parseWeeks(right);
  if (leftWeeks.size === 0 || rightWeeks.size === 0) return true;
  return [...leftWeeks].some((week) => rightWeeks.has(week));
}

function parseWeeks(value: string): Set<number> {
  const weeks = new Set<number>();
  const odd = /单/.test(value);
  const even = /双/.test(value);
  for (const matched of value.matchAll(/(\d+)(?:\s*[-—~至]\s*(\d+))?/g)) {
    const start = Number(matched[1]);
    const end = Number(matched[2] ?? matched[1]);
    for (let week = start; week <= end && week <= 30; week += 1) {
      if ((!odd && !even) || (odd && week % 2 === 1) || (even && week % 2 === 0)) weeks.add(week);
    }
  }
  return weeks;
}

function meetingScheduleMask(meetings: HbuJwCourseOfferingMeeting[]): bigint {
  let mask = 0n;
  for (const meeting of meetings) {
    const parsedWeeks = parseWeeks(meeting.classWeek);
    const weeks = parsedWeeks.size > 0 ? parsedWeeks : new Set(Array.from({ length: 30 }, (_, index) => index + 1));
    const lastSection = meeting.startSection + meeting.sectionCount - 1;
    for (const week of weeks) {
      for (let section = meeting.startSection; section <= lastSection; section += 1) {
        const index = ((week - 1) * 7 + (meeting.weekday - 1)) * 11 + (section - 1);
        mask |= 1n << BigInt(index);
      }
    }
  }
  return mask;
}

function compareOfferings(left: GuidanceOfferingView, right: GuidanceOfferingView): number {
  const priorities = { 'missing-required': 0, 'plan-course': 1, 'elective-gap': 2, 'general-elective': 3 } as const;
  return priorities[left.priority] - priorities[right.priority]
    || left.courseNumber.localeCompare(right.courseNumber)
    || right.remainingSeats - left.remainingSeats;
}

function offeringKey(section: GuidanceSectionRef): string {
  return `${section.executionPlanNumber}@${section.courseNumber}@${section.sequenceNumber}`;
}

function sectionRef(offering: HbuJwCourseOffering): GuidanceSectionRef {
  return {
    executionPlanNumber: offering.executionPlanNumber,
    courseNumber: offering.courseNumber,
    sequenceNumber: offering.sequenceNumber,
  };
}

async function renderGuidanceCard(
  puppeteer: HbuJwSchedulePuppeteerLike,
  context: HbuJwGuidanceContext,
): Promise<Buffer> {
  const page = await puppeteer.page();
  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'qqbot-hbu-jw-guidance-'));
    const htmlPath = join(tempDir, 'guidance.html');
    await writeFile(htmlPath, renderGuidanceHtml(context), 'utf8');
    await page.setViewport?.({ width: 1120, height: 1200, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle0' });
    await page.waitForSelector?.('#guidance-card', { timeout: 5000 });
    const card = await page.$('#guidance-card');
    if (!card) throw new Error('hbu jw guidance card root not found');
    const box = await card.boundingBox();
    if (!box) throw new Error('hbu jw guidance card root has no bounding box');
    const screenshot = await page.screenshot({
      type: 'png',
      clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) },
    });
    return Buffer.from(screenshot);
  } finally {
    await page.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export function renderGuidanceHtml(context: HbuJwGuidanceContext): string {
  const totalDone = context.progress.completedCredits + context.progress.inProgressCredits;
  const percent = Math.min(100, Math.round(totalDone / context.plan.requiredCredits * 100));
  const categoryRows = context.progress.categories.map((category) => `
    <div class="row">
      <div><strong>${escapeHtml(category.name)}</strong><small>${escapeHtml(category.code)}</small></div>
      <div>${formatCredits(category.completedCredits)} 已完成 · ${formatCredits(category.inProgressCredits)} 进行中</div>
      <div class="gap">缺 ${formatCredits(category.remainingCredits)}</div>
    </div>`).join('');
  const warnings = context.unmappedCourses.length
    ? `<div class="warning">⚠ 有 ${context.unmappedCourses.length} 门课程无法映射到官方方案，未静默计入方案进度：${escapeHtml(context.unmappedCourses.map((course) => course.courseName).join('、'))}</div>`
    : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:32px;background:#eef3f8;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:#17324d}
    #guidance-card{width:1056px;background:linear-gradient(145deg,#fff,#f7fbff);border-radius:28px;padding:38px;box-shadow:0 18px 50px #244a7026;border:1px solid #d9e7f3}
    .top{display:flex;justify-content:space-between;gap:30px}.eyebrow{color:#167d87;font-weight:700;letter-spacing:2px}.title{font-size:34px;font-weight:800;margin:8px 0}.meta{color:#61778c;font-size:16px}.tag{height:max-content;padding:8px 14px;border-radius:999px;background:#dff5ed;color:#13705b;font-weight:700}
    .progress{margin:30px 0 22px;background:#e7eef5;height:18px;border-radius:99px;overflow:hidden}.bar{height:100%;width:${percent}%;background:linear-gradient(90deg,#188c93,#40b77b)}
    .totals{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:26px}.metric{background:#edf6fa;border-radius:18px;padding:18px}.metric b{display:block;font-size:27px}.metric span{color:#60768b}
    .rows{border-top:1px solid #dbe7ef}.row{display:grid;grid-template-columns:1.45fr 1.2fr .45fr;align-items:center;gap:18px;padding:15px 8px;border-bottom:1px solid #e2ebf2}.row small{display:block;color:#8798a8;margin-top:3px}.gap{text-align:right;color:#b65038;font-weight:700}
    .warning{margin-top:22px;padding:16px 18px;background:#fff3d8;border-left:5px solid #e2a72e;border-radius:12px;color:#735117}.footer{margin-top:20px;color:#7890a4;font-size:14px}
  </style></head><body><main id="guidance-card">
    <div class="top"><div><div class="eyebrow">河北大学 · 培养方案完成度</div><div class="title">${escapeHtml(context.plan.planName)}</div><div class="meta">${escapeHtml(context.plan.majorName)} · ${context.plan.cohortYear} 级 · 方案 ${escapeHtml(context.plan.planNumber)}</div></div><div class="tag">${context.plan.match === 'exact' ? '精确方案' : '最近年级方案'}</div></div>
    <div class="progress"><div class="bar"></div></div>
    <div class="totals"><div class="metric"><b>${formatCredits(context.plan.requiredCredits)}</b><span>最低要求</span></div><div class="metric"><b>${formatCredits(context.progress.completedCredits)}</b><span>已完成</span></div><div class="metric"><b>${formatCredits(context.progress.inProgressCredits)}</b><span>修读 / 选课进行中</span></div><div class="metric"><b>${formatCredits(context.progress.remainingCredits)}</b><span>剩余缺口</span></div></div>
    <div class="rows">${categoryRows}</div>${warnings}
    <div class="footer">方案同步：${escapeHtml(context.plan.syncedAt)} · 个人进度查询：${escapeHtml(context.dataAsOf)}</div>
  </main></body></html>`;
}

function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
