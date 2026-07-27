import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { elementPlusComponents } from '../apps/admin-web/src/element-plus-components.js';

function vueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? vueFiles(path)
      : entry.name.endsWith('.vue') ? [path] : [];
  });
}

function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

describe('admin Element Plus component registry', () => {
  it('registers every Element Plus component used by Vue templates', () => {
    const sourceRoot = resolve(process.cwd(), 'apps/admin-web/src');
    const usedTags = new Set(vueFiles(sourceRoot).flatMap((file) => (
      [...readFileSync(file, 'utf8').matchAll(/<((?:el)-[a-z0-9-]+)/g)]
        .map((match) => match[1])
    )));
    const registeredTags = new Set(elementPlusComponents.map((component) => {
      if (!component.name) throw new Error('Element Plus component has no registered name.');
      return kebabCase(component.name);
    }));

    expect([...usedTags].filter((tag) => !registeredTags.has(tag))).toEqual([]);
  });
});
