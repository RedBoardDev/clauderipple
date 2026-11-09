#!/usr/bin/env node
// The mod's hooks and drawings are TSX that only Claude's own engine can type-check and run: its
// types come from the engine (`claude-code`), which is not a package CI can install, and the engine
// tests (`claude plugin test packages/mod`) need a local Claude installation. So a pull request used
// to reach a release with a syntax error or a renamed import in the mod, invisible to `npm test`
// (G-D12).
//
// This gate is what can run anywhere, without executing the mod or fetching a proprietary engine:
//   * every .ts/.tsx under packages/mod parses (the compiler's own syntax diagnostics);
//   * every relative import names a file that exists;
//   * every module named by hooks.json and plugin.json "types" exists.
// Type errors and behaviour stay with `claude plugin test packages/mod` on a machine that has the
// engine; that run is deliberately not in CI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modDir = path.join(root, "packages", "mod");
// Engine-written on load (types for the API this version of Claude offers); never part of the repo.
const skip = new Set([".claude-plugin", "node_modules"]);
const failures = [];
let files = 0;
let imports = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    files++;
    check(full);
  }
}

/** A relative specifier as a file that exists: NodeNext writes `.js`, the source is `.ts`. */
function resolves(from, specifier) {
  if (!specifier.startsWith(".")) return true; // a package: the engine or node_modules provides it
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [base];
  if (/\.m?js$/.test(base)) {
    const stem = base.replace(/\.m?js$/, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`);
  }
  candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.d.ts`);
  return candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function check(file) {
  const source = fs.readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const diagnostic of parsed.parseDiagnostics ?? []) {
    const { line, character } = parsed.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    failures.push(`${path.relative(root, file)}:${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
  const specs = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const specifier of specs) {
    imports++;
    if (!resolves(file, specifier)) failures.push(`${path.relative(root, file)}: imports "${specifier}", which does not exist`);
  }
}

walk(modDir);

for (const [manifest, field] of [["hooks/hooks.json", "modules"], [".claude-plugin/plugin.json", "types"]]) {
  const file = path.join(modDir, manifest);
  let body;
  try { body = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { failures.push(`${manifest}: ${error instanceof Error ? error.message : String(error)}`); continue; }
  const named = field === "modules" ? (body.modules ?? []) : body.types ? [body.types] : [];
  if (!Array.isArray(named) || !named.length) { failures.push(`${manifest}: ${field} names nothing`); continue; }
  for (const entry of named) {
    // hooks.json names its modules from its own folder; plugin.json names files from the plugin
    // root (packages/mod).
    const target = [path.resolve(path.dirname(file), String(entry)), path.resolve(modDir, String(entry))];
    if (!target.some((candidate) => fs.existsSync(candidate))) failures.push(`${manifest}: ${field} names ${entry}, which does not exist`);
  }
}

if (failures.length) {
  console.error(`mod check failed (${failures.length}):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`mod check: ${files} files parse, ${imports} relative imports resolve, manifests point at files`);
