import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin unified model page layout', () => {
  it('presents connections and model profiles before workload bindings', () => {
    const page = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/ModelsPage.vue',
    ), 'utf8');
    const template = page.slice(page.indexOf('<template>'), page.lastIndexOf('</template>'));

    expect(template.indexOf('<h2>接口连接与模型档案</h2>')).toBeGreaterThan(-1);
    expect(template.indexOf('<h2>用途绑定</h2>')).toBeGreaterThan(-1);
    expect(template.indexOf('<h2>接口连接与模型档案</h2>'))
      .toBeLessThan(template.indexOf('<h2>用途绑定</h2>'));
  });
});
