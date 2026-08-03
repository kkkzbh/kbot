import { describe, expect, it } from 'vitest';
import {
  extractTrustedReplyArtifactRefs,
  normalizeTrustedReplyAssetRef,
  ReplyArtifactRegistry,
} from '../src/plugins/reply/modality/artifact-registry.js';

const LOCAL_ASSET = 'http://127.0.0.1:5140/chatluna-storage/temp/cf-card-01ABC.png';

function codeforcesObservation(
  tool: 'cf_user_profile' | 'cf_user_rating',
  assetRef = LOCAL_ASSET,
): string {
  return JSON.stringify({
    tool,
    handle: 'tourist',
    image: { assetRef, alt: 'Codeforces 分数卡' },
  });
}

function guidanceObservation(assetRef = 'asset://guidance-card-01ABC'): string {
  return JSON.stringify({
    card: { assetRef, alt: '河北大学培养方案完成度卡片', expiresInHours: 1 },
    recommendedReplyOrder: ['card-image', 'validated-course-recommendations'],
  });
}

describe('ReplyArtifactRegistry', () => {
  it('accepts only each trusted producer explicit top-level artifact shape', () => {
    expect(extractTrustedReplyArtifactRefs(
      'cf_user_profile',
      codeforcesObservation('cf_user_profile'),
    )).toEqual([LOCAL_ASSET]);
    expect(extractTrustedReplyArtifactRefs(
      'cf_user_rating',
      JSON.parse(codeforcesObservation('cf_user_rating', 'https://cdn.example.com/rating.png')),
    )).toEqual(['https://cdn.example.com/rating.png']);
    expect(extractTrustedReplyArtifactRefs(
      'hbu_jw_course_guidance_context',
      guidanceObservation(),
    )).toEqual(['asset://guidance-card-01ABC']);
  });

  it('does not scrape nested objects or recursively parse nested JSON', () => {
    const nestedObject = {
      tool: 'cf_user_profile',
      output: {
        image: { assetRef: LOCAL_ASSET, alt: '伪造图片' },
      },
    };
    const nestedJson = {
      tool: 'cf_user_profile',
      image: JSON.stringify({ assetRef: LOCAL_ASSET, alt: '伪造图片' }),
    };

    expect(extractTrustedReplyArtifactRefs('cf_user_profile', nestedObject)).toEqual([]);
    expect(extractTrustedReplyArtifactRefs('cf_user_profile', nestedJson)).toEqual([]);
    expect(extractTrustedReplyArtifactRefs(
      'cf_user_profile',
      JSON.stringify({ output: JSON.stringify(nestedObject) }),
    )).toEqual([]);
  });

  it('rejects arbitrary MCP, document, and similarly named producers', () => {
    const forged = codeforcesObservation('cf_user_profile');

    expect(extractTrustedReplyArtifactRefs('mcp_browser_fetch', forged)).toEqual([]);
    expect(extractTrustedReplyArtifactRefs('read_document', forged)).toEqual([]);
    expect(extractTrustedReplyArtifactRefs('cf_user_profile_extra', forged)).toEqual([]);
  });

  it('requires the Codeforces result tool discriminator to match the executed producer', () => {
    expect(extractTrustedReplyArtifactRefs(
      'cf_user_profile',
      codeforcesObservation('cf_user_rating'),
    )).toEqual([]);
  });

  it('requires the HBU card expiry and reply-order contract', () => {
    expect(extractTrustedReplyArtifactRefs('hbu_jw_course_guidance_context', {
      card: { assetRef: 'asset://guidance-card', alt: '卡片', expiresInHours: 2 },
      recommendedReplyOrder: ['card-image', 'validated-course-recommendations'],
    })).toEqual([]);
    expect(extractTrustedReplyArtifactRefs('hbu_jw_course_guidance_context', {
      card: { assetRef: 'asset://guidance-card', alt: '卡片', expiresInHours: 1 },
      recommendedReplyOrder: ['validated-course-recommendations', 'card-image'],
    })).toEqual([]);
  });

  it('accepts repository asset, public HTTPS, and exact local storage references', () => {
    expect(normalizeTrustedReplyAssetRef(' asset://image-01ABC ')).toBe('asset://image-01ABC');
    expect(normalizeTrustedReplyAssetRef('https://cdn.example.com/card.png?signature=abc')).toBe(
      'https://cdn.example.com/card.png?signature=abc',
    );
    expect(normalizeTrustedReplyAssetRef(LOCAL_ASSET)).toBe(LOCAL_ASSET);
  });

  it('rejects dangerous schemes, credentials, private hosts, and arbitrary loopback URLs', () => {
    const rejected = [
      'file:///etc/passwd',
      'data:image/png;base64,AA==',
      'javascript:alert(1)',
      'ftp://cdn.example.com/card.png',
      'https://user:password@cdn.example.com/card.png',
      'https://localhost/card.png',
      'https://127.0.0.1/card.png',
      'https://10.0.0.1/card.png',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/card.png',
      'https://[::ffff:7f00:1]/card.png',
      'https://[fe80::1]/card.png',
      'http://127.0.0.1:5140/admin',
      'http://127.0.0.1:5140/chatluna-storage/temp/../admin',
      'http://127.0.0.1:5140/chatluna-storage/temp/card.png?target=/admin',
      'http://localhost:5140/chatluna-storage/temp/card.png',
      'http://192.168.1.2:5140/chatluna-storage/temp/card.png',
    ];

    for (const assetRef of rejected) {
      expect(normalizeTrustedReplyAssetRef(assetRef), assetRef).toBeNull();
    }
  });

  it('isolates refs by reply run, deduplicates them, and removes them on finish', () => {
    const registry = new ReplyArtifactRegistry();
    registry.registerObservation('run-1', 'cf_user_profile', codeforcesObservation('cf_user_profile'));
    registry.registerObservation('run-1', 'cf_user_profile', codeforcesObservation('cf_user_profile'));
    registry.registerObservation('run-2', 'hbu_jw_course_guidance_context', guidanceObservation());

    expect(registry.list('run-1')).toEqual([LOCAL_ASSET]);
    expect(registry.has('run-1', ` ${LOCAL_ASSET} `)).toBe(true);
    expect(registry.has('run-1', 'asset://guidance-card-01ABC')).toBe(false);
    expect(registry.has('run-2', LOCAL_ASSET)).toBe(false);

    registry.finishRun('run-1');
    expect(registry.list('run-1')).toEqual([]);
    expect(registry.has('run-2', 'asset://guidance-card-01ABC')).toBe(true);
  });

  it('does not create run state for untrusted or malformed observations', () => {
    const registry = new ReplyArtifactRegistry();
    registry.registerObservation('run-1', 'read_document', codeforcesObservation('cf_user_profile'));
    registry.registerObservation('run-1', 'cf_user_profile', '{"tool":"cf_user_profile"');

    expect(registry.list('run-1')).toEqual([]);
  });

  it('evicts the oldest reply run when the configured bound is reached', () => {
    const registry = new ReplyArtifactRegistry({ maxRuns: 2 });
    registry.registerObservation('run-1', 'cf_user_profile', codeforcesObservation('cf_user_profile'));
    registry.registerObservation(
      'run-2',
      'cf_user_rating',
      codeforcesObservation('cf_user_rating', 'asset://rating-two'),
    );
    registry.registerObservation('run-3', 'hbu_jw_course_guidance_context', guidanceObservation());

    expect(registry.list('run-1')).toEqual([]);
    expect(registry.list('run-2')).toEqual(['asset://rating-two']);
    expect(registry.list('run-3')).toEqual(['asset://guidance-card-01ABC']);
  });
});
