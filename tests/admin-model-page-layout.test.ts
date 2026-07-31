import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin unified model page layout', () => {
  it('presents authentication and model discovery before model settings', () => {
    const page = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/ModelsPage.vue',
    ), 'utf8');
    const template = page.slice(page.indexOf('<template>'), page.lastIndexOf('</template>'));

    expect(template.indexOf('<h2>认证与模型列表</h2>')).toBeGreaterThan(-1);
    expect(template.indexOf('<h2>模型设置</h2>')).toBeGreaterThan(-1);
    expect(template.indexOf('<h2>认证与模型列表</h2>'))
      .toBeLessThan(template.indexOf('<h2>模型设置</h2>'));
  });

  it('shows connection health through the row and hides technical IDs', () => {
    const page = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/ModelsPage.vue',
    ), 'utf8');
    const template = page.slice(page.indexOf('<template>'), page.lastIndexOf('</template>'));

    expect(template).toContain("'is-configured': connectionConfigured(connection.id)");
    expect(template).toContain("'needs-configuration': !connectionConfigured(connection.id)");
    expect(template).toContain("connectionConfigured(connection.id) ? '配置良好' : '需要配置'");
    expect(template).not.toContain('<small>{{ connection.id }}</small>');
  });

  it('shows the dynamic catalog returned for the selected authentication', () => {
    const page = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/ModelsPage.vue',
    ), 'utf8');
    const template = page.slice(page.indexOf('<template>'), page.lastIndexOf('</template>'));

    expect(template).toContain('<h4 id="available-models-title">可用模型</h4>');
    expect(template).toContain('v-for="model in selectedCatalog.models"');
    expect(template).toContain('{{ model.displayName }}');
    expect(template).toContain('{{ model.transportModel }}');
  });
});
