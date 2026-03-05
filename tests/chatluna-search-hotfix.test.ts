import { describe, expect, it } from 'vitest';
import { dedupeSearchResults, parseBingWebResults } from '../src/plugins/chatluna-search-hotfix-core.js';

describe('chatluna-search-hotfix', () => {
  it('parses bing html search blocks into structured results', () => {
    const html = `
      <ul id="b_results">
        <li class="b_algo">
          <h2><a href="https://example.com/a">彩叶是谁</a></h2>
          <div class="b_caption"><p>彩叶是某作品中的角色</p></div>
        </li>
        <li class="b_algo">
          <h2><a href="https://example.com/b">辉叶是谁</a></h2>
          <div class="b_caption"><p>辉叶是另一位角色</p></div>
        </li>
      </ul>
    `;
    expect(parseBingWebResults(html, 5)).toEqual([
      {
        title: '彩叶是谁',
        url: 'https://example.com/a',
        description: '彩叶是某作品中的角色',
      },
      {
        title: '辉叶是谁',
        url: 'https://example.com/b',
        description: '辉叶是另一位角色',
      },
    ]);
  });

  it('deduplicates search results by url and keeps order', () => {
    const results = dedupeSearchResults(
      [
        { title: 'A', url: 'https://example.com/a', description: '1' },
        { title: 'B', url: 'https://example.com/a', description: '2' },
        { title: 'C', url: 'https://example.com/c', description: '3' },
      ],
      5,
    );
    expect(results).toEqual([
      { title: 'A', url: 'https://example.com/a', description: '1' },
      { title: 'C', url: 'https://example.com/c', description: '3' },
    ]);
  });
});
