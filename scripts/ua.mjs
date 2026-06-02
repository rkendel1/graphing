#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'understand-anything-plugin');
const CORE_DIST = resolve(PLUGIN_ROOT, 'packages/core/dist/index.js');
const SCAN_SCRIPT = resolve(PLUGIN_ROOT, 'skills/understand/scan-project.mjs');
const IMPORT_MAP_SCRIPT = resolve(PLUGIN_ROOT, 'skills/understand/extract-import-map.mjs');

const EMPTY_ANALYSIS = {
  functions: [],
  classes: [],
  imports: [],
  exports: [],
  sections: [],
  definitions: [],
  services: [],
  endpoints: [],
  steps: [],
  resources: [],
};

function printUsage() {
  process.stdout.write(
    `Understand Anything standalone CLI

Usage:
  ua analyze [project-path]
  ua dashboard [project-path]
  ua --help

Commands:
  analyze    Generate .understand-anything/knowledge-graph.json without plugin skills
  dashboard  Launch the interactive dashboard for an existing graph
`,
  );
}

function resolveProjectRoot(arg) {
  const root = resolve(arg || process.cwd());
  if (!existsSync(root)) {
    throw new Error(`Project path does not exist: ${root}`);
  }
  return root;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Script failed: ${scriptPath}`);
  }
}

function inferComplexity(totalLines, analysis) {
  const fnCount = analysis.functions?.length ?? 0;
  const classCount = analysis.classes?.length ?? 0;
  const endpointCount = analysis.endpoints?.length ?? 0;
  const score = totalLines + fnCount * 20 + classCount * 35 + endpointCount * 20;
  if (score <= 180) return 'simple';
  if (score <= 700) return 'moderate';
  return 'complex';
}

function inferNodeTypeForCategory(fileCategory, language) {
  switch (fileCategory) {
    case 'docs':
      return 'document';
    case 'infra':
      return language === 'dockerfile' ? 'service' : 'resource';
    case 'data':
      if (language === 'sql') return 'table';
      if (language === 'graphql' || language === 'protobuf') return 'schema';
      return 'table';
    case 'config':
      return 'config';
    case 'markup':
      return 'document';
    default:
      return 'file';
  }
}

function collectManifestContents(projectRoot, files, frameworkRegistry) {
  const manifestNames = new Set(
    frameworkRegistry.getAllFrameworks().flatMap((f) => f.manifestFiles),
  );

  const manifests = {};
  for (const file of files) {
    const name = basename(file.path);
    if (!manifestNames.has(name)) continue;
    try {
      manifests[file.path] = readFileSync(join(projectRoot, file.path), 'utf-8');
    } catch {
      // Ignore unreadable manifest files.
    }
  }
  return manifests;
}

function getGitHash(projectRoot) {
  const result = spawnSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

async function loadCore() {
  if (!existsSync(CORE_DIST)) {
    throw new Error(
      `Core build not found at ${CORE_DIST}. ` +
      'Run "pnpm --filter @understand-anything/core build" in the repository root ' +
      `after installing dependencies.`,
    );
  }
  return import(pathToFileURL(CORE_DIST).href);
}

export async function analyzeProject(projectArg) {
  const projectRoot = resolveProjectRoot(projectArg);
  const uaRoot = join(projectRoot, '.understand-anything');
  const intermediate = join(uaRoot, 'intermediate');
  const tmpDir = join(uaRoot, 'tmp');
  mkdirSync(intermediate, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const scanPath = join(intermediate, 'scan-result.json');
  const importInputPath = join(tmpDir, 'standalone-import-map-input.json');
  const importOutputPath = join(tmpDir, 'standalone-import-map-output.json');

  process.stdout.write(`[ua] Scanning files in ${projectRoot}\n`);
  runNodeScript(SCAN_SCRIPT, [projectRoot, scanPath]);
  const scan = readJson(scanPath);

  writeJson(importInputPath, {
    projectRoot,
    files: scan.files,
  });
  process.stdout.write('[ua] Building import map\n');
  runNodeScript(IMPORT_MAP_SCRIPT, [importInputPath, importOutputPath]);
  const importMapData = readJson(importOutputPath);
  const importMap = importMapData.importMap ?? {};

  const core = await loadCore();
  const {
    TreeSitterPlugin,
    PluginRegistry,
    builtinLanguageConfigs,
    registerAllParsers,
    FrameworkRegistry,
    GraphBuilder,
    detectLayers,
    generateHeuristicTour,
    saveGraph,
    saveMeta,
  } = core;

  const tsPlugin = new TreeSitterPlugin(
    builtinLanguageConfigs.filter((cfg) => cfg.treeSitter),
  );
  await tsPlugin.init();
  const registry = new PluginRegistry();
  registry.register(tsPlugin);
  registerAllParsers(registry);

  const gitHash = getGitHash(projectRoot);
  const projectName = basename(projectRoot);
  const builder = new GraphBuilder(projectName, gitHash);

  for (const file of scan.files) {
    const absPath = join(projectRoot, file.path);
    let content = '';
    try {
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    let analysis = EMPTY_ANALYSIS;
    try {
      const parsed = registry.analyzeFile(file.path, content);
      if (parsed) analysis = { ...EMPTY_ANALYSIS, ...parsed };
    } catch {
      analysis = EMPTY_ANALYSIS;
    }

    const totalLines = content.length === 0 ? 0 : content.split('\n').length;
    const complexity = inferComplexity(totalLines, analysis);

    if (file.fileCategory === 'code' || file.fileCategory === 'script') {
      const summaryText = `${file.language} ${file.fileCategory} file: ${file.path}`;
      builder.addFileWithAnalysis(file.path, analysis, {
        summaries: {},
        fileSummary: summaryText,
        summary: summaryText,
        tags: [file.language, file.fileCategory],
        complexity,
      });
    } else {
      builder.addNonCodeFileWithAnalysis(file.path, {
        nodeType: inferNodeTypeForCategory(file.fileCategory, file.language),
        summary: `${file.fileCategory} file: ${file.path}`,
        tags: [file.language, file.fileCategory],
        complexity,
        definitions: analysis.definitions,
        services: analysis.services,
        endpoints: analysis.endpoints,
        steps: analysis.steps,
        resources: analysis.resources,
        sections: analysis.sections,
      });
    }
  }

  for (const [fromFile, targets] of Object.entries(importMap)) {
    for (const toFile of targets) {
      builder.addImportEdge(fromFile, toFile);
    }
  }

  const graph = builder.build();
  graph.project.languages = [...new Set(scan.files.map((f) => f.language))]
    .filter((lang) => lang && lang !== 'unknown')
    .sort((a, b) => a.localeCompare(b));

  const frameworkRegistry = FrameworkRegistry.createDefault();
  const manifests = collectManifestContents(projectRoot, scan.files, frameworkRegistry);
  graph.project.frameworks = frameworkRegistry
    .detectFrameworks(manifests)
    .map((fw) => fw.id)
    .sort((a, b) => a.localeCompare(b));
  graph.project.description = `Standalone structural analysis for ${projectName}. For semantic summaries and domain modeling, run plugin/skill workflows.`;

  graph.layers = detectLayers(graph);
  graph.tour = generateHeuristicTour(graph);

  saveGraph(projectRoot, graph);
  saveMeta(projectRoot, {
    lastAnalyzedAt: new Date().toISOString(),
    gitCommitHash: gitHash,
    version: graph.version,
    analyzedFiles: scan.totalFiles,
  });

  process.stdout.write(
    `[ua] Wrote ${graph.nodes.length} nodes and ${graph.edges.length} edges to ` +
    `${join(projectRoot, '.understand-anything/knowledge-graph.json')}\n`,
  );
}

export async function runDashboard(projectArg) {
  const projectRoot = resolveProjectRoot(projectArg);
  const graphPath = join(projectRoot, '.understand-anything', 'knowledge-graph.json');
  if (!existsSync(graphPath)) {
    throw new Error(
      `No graph found at ${graphPath}. Run "ua analyze ${projectRoot}" first.`,
    );
  }

  const child = spawn(
    'pnpm',
    ['--filter', '@understand-anything/dashboard', 'dev', '--', '--host', '127.0.0.1'],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, GRAPH_DIR: projectRoot },
    },
  );

  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main(argv) {
  const [command, projectPath] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }

  if (command === 'analyze') {
    await analyzeProject(projectPath);
    return;
  }

  if (command === 'dashboard') {
    await runDashboard(projectPath);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

const isDirectExecution =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
