// /init — scan the repo and generate a concise AGENTS.md: detected language and
// framework, the build/test/lint commands, a one-line-per-top-level-dir layout,
// and observed conventions (module style, tests, formatter). Prose, under 60 lines.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".dom",
  ".cache", ".turbo", "target", "__pycache__", ".venv", "venv", ".idea", ".vscode",
]);

const DIR_DESC: Record<string, string> = {
  src: "source code",
  lib: "library code",
  app: "application code",
  verify: "test / verification suites",
  test: "tests",
  tests: "tests",
  __tests__: "tests",
  spec: "tests",
  bin: "executables",
  scripts: "helper scripts",
  docs: "documentation",
  doc: "documentation",
  public: "static assets",
  assets: "static assets",
  static: "static assets",
  examples: "usage examples",
  packages: "workspace packages",
};

const FRAMEWORKS: [string, string][] = [
  ["ink", "Ink (React for the terminal)"],
  ["next", "Next.js"],
  ["@remix-run/react", "Remix"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["@nestjs/core", "NestJS"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["vite", "Vite"],
  ["electron", "Electron"],
];

const TESTERS: [string, string][] = [
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["mocha", "Mocha"],
  ["ava", "AVA"],
  ["@playwright/test", "Playwright"],
  ["node:test", "node:test"],
];

async function readJson(p: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function topDirs(cwd: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** Generate the AGENTS.md body (prose, < 60 lines). */
export async function generateAgentsMd(cwd: string): Promise<string> {
  const pkg = await readJson(path.join(cwd, "package.json"));
  const deps: Record<string, string> = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (d: string) => d in deps;
  const name = pkg?.name || path.basename(cwd);

  // --- language ---
  const tsconfig = await readJson(path.join(cwd, "tsconfig.json"));
  let language = "";
  if (tsconfig || has("typescript")) language = "TypeScript";
  else if (pkg) language = "JavaScript";
  else if (existsSync(path.join(cwd, "pyproject.toml")) || existsSync(path.join(cwd, "requirements.txt"))) language = "Python";
  else if (existsSync(path.join(cwd, "go.mod"))) language = "Go";
  else if (existsSync(path.join(cwd, "Cargo.toml"))) language = "Rust";
  else language = "unknown";

  // --- framework ---
  const framework = FRAMEWORKS.find(([d]) => has(d))?.[1];

  // --- module style ---
  let moduleStyle = "";
  if (pkg) {
    const esm = pkg.type === "module";
    const mod = String(tsconfig?.compilerOptions?.module ?? "").toLowerCase();
    const nodeNext = mod.includes("nodenext") || mod.includes("node16");
    moduleStyle = esm
      ? nodeNext
        ? "ES modules (NodeNext — imports carry explicit .js extensions)"
        : "ES modules (ESM)"
      : "CommonJS";
  }

  // --- commands (only those that exist) ---
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const cmds: [string, string][] = [];
  const pick = (label: string, keys: string[]) => {
    const k = keys.find((x) => scripts[x]);
    if (k) cmds.push([label, `npm run ${k}`]);
  };
  pick("Build", ["build", "compile", "tsc"]);
  pick("Test", ["verify", "test", "tests"]);
  pick("Lint", ["lint", "eslint"]);
  pick("Typecheck", ["typecheck", "check", "tsc:check"]);
  pick("Dev", ["dev", "start", "watch"]);
  pick("Format", ["format", "fmt", "prettier"]);
  if (!pkg) {
    if (language === "Rust") cmds.push(["Build", "cargo build"], ["Test", "cargo test"]);
    else if (language === "Go") cmds.push(["Build", "go build ./..."], ["Test", "go test ./..."]);
    else if (language === "Python") cmds.push(["Test", "pytest"]);
  }

  // --- tests + formatter conventions ---
  const tester =
    TESTERS.find(([d]) => has(d))?.[1] ??
    (scripts.verify ? "a custom Node harness (see the verify script)" : scripts.test ? "the project's test script" : null);
  const formatter = has("prettier") || existsSync(path.join(cwd, ".prettierrc")) || existsSync(path.join(cwd, ".prettierrc.json"))
    ? "Prettier"
    : has("eslint") || existsSync(path.join(cwd, ".eslintrc")) || existsSync(path.join(cwd, ".eslintrc.json")) || existsSync(path.join(cwd, "eslint.config.js"))
      ? "ESLint"
      : null;

  // --- layout ---
  const dirs = await topDirs(cwd);

  // --- assemble prose ---
  const L: string[] = [];
  L.push("# AGENTS.md", "");
  L.push(`${name} is a ${language} project${framework ? ` built on ${framework}` : ""}.`, "");

  L.push("## Stack");
  L.push(`- Language: ${language}`);
  if (framework) L.push(`- Framework: ${framework}`);
  if (moduleStyle) L.push(`- Modules: ${moduleStyle}`);
  const notable = FRAMEWORKS.map(([d]) => d)
    .filter((d) => has(d))
    .concat(["zod", "execa", "commander", "yargs"].filter(has))
    .slice(0, 6);
  if (notable.length) L.push(`- Notable deps: ${[...new Set(notable)].join(", ")}`);
  L.push("");

  if (cmds.length) {
    L.push("## Commands");
    for (const [label, cmd] of cmds) L.push(`- ${label}: \`${cmd}\``);
    L.push("");
  }

  if (dirs.length) {
    L.push("## Layout");
    for (const d of dirs.slice(0, 24)) L.push(`- \`${d}/\` — ${DIR_DESC[d] ?? "project files"}`);
    if (dirs.length > 24) L.push(`- …and ${dirs.length - 24} more top-level directories`);
    L.push("");
  }

  L.push("## Conventions");
  const conv: string[] = [];
  if (language === "TypeScript") conv.push("Written in TypeScript");
  if (moduleStyle.startsWith("ES modules")) conv.push(moduleStyle.includes("NodeNext") ? "ESM with explicit `.js` import extensions" : "ESM");
  if (tester) conv.push(`tests run via ${tester}`);
  conv.push(formatter ? `formatting is enforced by ${formatter}` : "no formatter config detected — match the surrounding style");
  L.push(conv.join("; ") + ".");

  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export interface InitResult {
  written: boolean;
  path: string;
  reason?: string;
  lineCount: number;
}

/** Write AGENTS.md. Refuses to overwrite an existing file unless force is set. */
export async function writeAgentsMd(cwd: string, force: boolean): Promise<InitResult> {
  const target = path.join(cwd, "AGENTS.md");
  if (existsSync(target) && !force) {
    return { written: false, path: target, reason: "AGENTS.md already exists — run /init --force to overwrite it.", lineCount: 0 };
  }
  const body = await generateAgentsMd(cwd);
  await fs.writeFile(target, body, "utf8");
  return { written: true, path: target, lineCount: body.split("\n").length };
}
