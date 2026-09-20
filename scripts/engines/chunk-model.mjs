#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_BYTES = 25 * 1024 * 1024;

function usage() {
  return [
    "Usage: node scripts/engines/chunk-model.mjs --input FILE --output-dir DIR [--chunk-bytes BYTES] [--sha256 HEX]",
    "",
    "Chunks FILE into deterministic numbered files and writes FILE.manifest.json.",
  ].join("\n");
}

function fail(message) {
  console.error(`chunk-model: ${message}`);
  process.exitCode = 2;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (!argument.startsWith("--")) throw new Error(`unexpected argument ${argument}`);
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    let value = equals === -1 ? undefined : argument.slice(equals + 1);
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (!["--input", "--output-dir", "--chunk-bytes", "--sha256"].includes(name)) {
      throw new Error(`unknown option ${name}`);
    }
    if (values.has(name)) throw new Error(`duplicate option ${name}`);
    values.set(name, value);
  }
  return values;
}

function parseChunkBytes(value) {
  if (value === undefined) return DEFAULT_CHUNK_BYTES;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("--chunk-bytes must be a positive integer");
  const chunkBytes = Number(value);
  if (!Number.isSafeInteger(chunkBytes)) throw new Error("--chunk-bytes is too large");
  if (chunkBytes >= MAX_CHUNK_BYTES) throw new Error("--chunk-bytes must be less than 25 MiB");
  return chunkBytes;
}

function rejectTraversal(outputDir) {
  const parts = outputDir.split(/[\\/]+/u);
  if (parts.includes("..")) throw new Error("--output-dir must not contain path traversal segments");
}

function ensureInside(directory, filename) {
  const target = resolve(directory, filename);
  const root = resolve(directory);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing output path outside ${root}`);
  }
  return target;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const inputArgument = argumentsMap.get("--input");
  const outputArgument = argumentsMap.get("--output-dir");
  if (!inputArgument) throw new Error("--input is required");
  if (!outputArgument) throw new Error("--output-dir is required");
  rejectTraversal(outputArgument);

  const inputPath = resolve(inputArgument);
  const outputPath = resolve(outputArgument);
  if (inputArgument.includes("\0") || outputArgument.includes("\0")) {
    throw new Error("input and output paths must not contain null bytes");
  }
  const inputStats = await stat(inputPath).catch(() => null);
  if (!inputStats?.isFile()) throw new Error(`input file does not exist: ${inputArgument}`);
  if (inputPath === outputPath) throw new Error("--output-dir must be a directory, not the input file");

  const chunkBytes = parseChunkBytes(argumentsMap.get("--chunk-bytes"));
  const suppliedHash = argumentsMap.get("--sha256");
  if (suppliedHash !== undefined && !/^[0-9a-f]{64}$/iu.test(suppliedHash)) {
    throw new Error("--sha256 must be 64 hexadecimal characters");
  }

  const input = await readFile(inputPath);
  const hash = sha256(input);
  if (suppliedHash !== undefined && hash !== suppliedHash.toLowerCase()) {
    throw new Error(`SHA-256 mismatch: expected ${suppliedHash}, got ${hash}`);
  }

  await mkdir(outputPath, { recursive: true });
  const originalFilename = basename(inputPath);
  const chunkSizes = [];
  const chunks = [];
  const chunkCount = Math.ceil(input.byteLength / chunkBytes);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkBytes;
    const end = Math.min(start + chunkBytes, input.byteLength);
    const filename = `${originalFilename}.chunk-${String(index).padStart(6, "0")}`;
    const destination = ensureInside(outputPath, filename);
    await writeFile(destination, input.subarray(start, end));
    chunks.push(filename);
    chunkSizes.push(end - start);
  }

  const manifest = {
    version: 1,
    originalFilename,
    size: input.byteLength,
    chunkBytes,
    chunkSizes,
    sha256: hash,
    chunks,
  };
  const manifestName = `${originalFilename}.manifest.json`;
  await writeFile(ensureInside(outputPath, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Wrote ${chunks.length} chunk(s) and ${manifestName} to ${outputPath}`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
