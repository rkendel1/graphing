import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '../scripts/ua.mjs');

const tempDirs = [];

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'ua-standalone-test-'));
  tempDirs.push(root);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('standalone ua CLI', () => {
  it('prints usage with --help', () => {
    const result = spawnSync('node', [CLI, '--help'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('ua analyze [project-path]');
  });

  it('generates a knowledge graph via "ua analyze"', () => {
    const projectRoot = makeProject({
      'src/index.ts': 'import { greet } from "./greet";\nexport const run = () => greet("world");\n',
      'src/greet.ts': 'export function greet(name: string) { return `hi ${name}`; }\n',
      'package.json': JSON.stringify({
        name: 'standalone-test',
        dependencies: { react: '^19.0.0' },
      }),
    });

    const result = spawnSync('node', [CLI, 'analyze', projectRoot], { encoding: 'utf-8' });
    expect(result.status).toBe(0);

    const graphPath = join(projectRoot, '.understand-anything', 'knowledge-graph.json');
    expect(existsSync(graphPath)).toBe(true);

    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    expect(graph.project.name).toBe(basename(projectRoot));
    expect(graph.project.frameworks).toContain('react');
    expect(graph.nodes.some((n) => n.id === 'file:src/index.ts')).toBe(true);
    expect(graph.edges.some((e) => e.type === 'imports')).toBe(true);
  });
});
