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

  it('shows the selected authentication catalog as compact name-only entries', () => {
    const page = readFileSync(resolve(
      process.cwd(),
      'apps/admin-web/src/pages/ModelsPage.vue',
    ), 'utf8');
    const template = page.slice(page.indexOf('<template>'), page.lastIndexOf('</template>'));
    const style = page.slice(page.indexOf('<style scoped>'), page.lastIndexOf('</style>'));
    const catalogStart = template.indexOf('class="catalog-section"');
    const catalogEnd = template.indexOf(
      'v-if="selectedConnection.catalogDriver === \'static\'"',
      catalogStart,
    );
    const catalog = template.slice(catalogStart, catalogEnd);

    expect(catalogStart).toBeGreaterThan(-1);
    expect(catalogEnd).toBeGreaterThan(catalogStart);
    expect(catalog).toContain('id="available-models-title"');
    expect(catalog).toContain('{{ selectedCatalog.models.length }}');
    expect(catalog).toContain('v-for="model in selectedCatalog.models"');
    expect(catalog).toContain('<strong>{{ model.displayName }}</strong>');
    expect(catalog).not.toContain('<code');
    expect(catalog).not.toContain('selectedCatalog.fetchedAt');
    expect(catalog).not.toContain('model.metadataTags');
    expect(style).toContain(
      '.catalog-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))',
    );
    expect(style).toContain('.catalog-model{display:flex;min-width:0;min-height:36px');
    expect(style).toContain('.catalog-list{grid-template-columns:1fr}');
  });
});
