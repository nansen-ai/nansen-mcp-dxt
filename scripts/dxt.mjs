#!/usr/bin/env node

/**
 * Generate, check and build the Nansen Claude Desktop extension (API-322).
 *
 * The one maintained source of the connection settings is
 * src/mcp-client-config.json in the public nansen-ai/nansen-cli repository.
 * config/mcp-client-config.json is a byte-identical copy of it, pinned by
 * config/upstream.json (commit SHA + sha256). bundle/manifest.json and
 * bundle/package.json are generated from that copy plus manifest.base.json.
 *
 *   npm run generate                 write bundle/manifest.json and bundle/package.json
 *   npm run check                    exit 1 on any drift (offline; runs in CI)
 *   npm run sync -- --ref <sha>      re-vendor the config from nansen-cli, regenerate, rebuild
 *   npm run verify-upstream          fetch the pinned upstream file and compare (network)
 *   npm run build                    install the pinned mcp-remote and pack nansen.dxt
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(ROOT, ...parts);

export const PATHS = {
  config: at('config', 'mcp-client-config.json'),
  upstream: at('config', 'upstream.json'),
  base: at('manifest.base.json'),
  manifest: at('bundle', 'manifest.json'),
  bundlePackage: at('bundle', 'package.json'),
  bundleLock: at('bundle', 'package-lock.json'),
  dxt: at('nansen.dxt'),
};

const FIX_HINT = 'bundle/manifest.json and bundle/package.json are generated. Edit manifest.base.json (metadata) or re-vendor the nansen-cli config (`npm run sync -- --ref <sha>`), then run `npm run generate && npm run build`.';
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const PROXY = 'node_modules/mcp-remote/dist/proxy.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const toJson = value => `${JSON.stringify(value, null, 2)}\n`;

function fail(message) {
  throw new Error(message);
}

/** Minimal validation; the full rules live in nansen-cli src/mcp-client-config.js. */
export function validateConfig(config) {
  const url = (key, host, bare = false) => {
    let parsed;
    try { parsed = new URL(config[key]); } catch { fail(`config "${key}" is not a URL`); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== host) fail(`config "${key}" must be an https URL on ${host}`);
    if (bare && (parsed.search || parsed.hash || parsed.port || parsed.username || parsed.pathname.endsWith('/'))) {
      fail(`config "${key}" must be a bare endpoint without a "/" suffix`);
    }
  };
  if (config?.schemaVersion !== 1) fail('config "schemaVersion" must be 1');
  url('endpoint', 'mcp.nansen.ai', true);
  url('apiKeyManageUrl', 'app.nansen.ai');
  if (!/^[A-Za-z0-9-]+$/.test(config.apiKeyHeader ?? '')) fail('config "apiKeyHeader" is not a header name');
  if (!/^[A-Z][A-Z0-9_]*$/.test(config.apiKeyEnvVar ?? '')) fail('config "apiKeyEnvVar" is not an env var name');
  if (config.mcpRemote?.package !== 'mcp-remote' || !EXACT_VERSION.test(config.mcpRemote?.version ?? '')) {
    fail('config "mcpRemote" must be mcp-remote at an exact x.y.z version');
  }
  return config;
}

export function buildManifest(base, config) {
  const envVar = config.apiKeyEnvVar;
  return {
    ...base,
    server: {
      type: 'node',
      entry_point: PROXY,
      mcp_config: {
        command: 'node',
        // mcp-remote expands ${VAR} in header values from its own env, so the
        // key stays out of argv. No --allow-http: the endpoint is https.
        args: [`\${__dirname}/${PROXY}`, config.endpoint, '--header', `${config.apiKeyHeader}:\${${envVar}}`],
        env: { [envVar]: `\${user_config.${envVar}}` },
      },
    },
    user_config: {
      [envVar]: {
        type: 'string',
        title: 'Nansen API Key',
        description: `Create or copy one at ${config.apiKeyManageUrl}`,
        required: true,
        sensitive: true,
      },
    },
  };
}

export function buildBundlePackage(config) {
  return {
    name: 'nansen-mcp',
    version: readJson(PATHS.base).version,
    private: true,
    description: 'Nansen MCP packaged extension for Claude Desktop',
    // Exact pin, same as the npx pin in nansen-cli: the bridge carries the key.
    dependencies: { [config.mcpRemote.package]: config.mcpRemote.version },
  };
}

function loadUpstream() {
  const upstream = readJson(PATHS.upstream);
  if (upstream.repository !== 'nansen-ai/nansen-cli') fail('config/upstream.json repository must be nansen-ai/nansen-cli');
  if (!SHA.test(upstream.ref ?? '')) fail('config/upstream.json ref must be a full 40-character commit SHA');
  return upstream;
}

export function generated() {
  const config = validateConfig(readJson(PATHS.config));
  const base = readJson(PATHS.base);
  return { manifest: toJson(buildManifest(base, config)), bundlePackage: toJson(buildBundlePackage(config)), config };
}

function unzip(file, member) {
  return execFileSync('unzip', ['-p', file, member], { maxBuffer: 64 * 1024 * 1024 });
}

/** Offline drift checks. Returns a list of problems; empty means current. */
export function checkProblems() {
  const problems = [];
  const upstream = loadUpstream();
  const vendored = fs.readFileSync(PATHS.config);
  if (sha256(vendored) !== upstream.sha256) {
    problems.push(`config/mcp-client-config.json does not match config/upstream.json sha256 (edited by hand?). Re-vendor: npm run sync -- --ref ${upstream.ref}`);
  }
  const { manifest, bundlePackage, config } = generated();
  if (fs.readFileSync(PATHS.manifest, 'utf8') !== manifest) problems.push(`bundle/manifest.json is out of date. ${FIX_HINT}`);
  if (fs.readFileSync(PATHS.bundlePackage, 'utf8') !== bundlePackage) problems.push(`bundle/package.json is out of date. ${FIX_HINT}`);

  const lock = readJson(PATHS.bundleLock);
  const locked = lock.packages?.['node_modules/mcp-remote']?.version;
  if (locked !== config.mcpRemote.version) {
    problems.push(`bundle/package-lock.json locks mcp-remote ${locked}, expected ${config.mcpRemote.version}. Run: npm run build`);
  }

  // The committed .dxt is what the docs link to, so its contents must match too.
  try {
    if (unzip(PATHS.dxt, 'manifest.json').toString('utf8') !== manifest) {
      problems.push('nansen.dxt contains a different manifest.json than bundle/manifest.json. Run: npm run build');
    }
    const bundled = JSON.parse(unzip(PATHS.dxt, 'node_modules/mcp-remote/package.json').toString('utf8')).version;
    if (bundled !== config.mcpRemote.version) {
      problems.push(`nansen.dxt bundles mcp-remote ${bundled}, expected ${config.mcpRemote.version}. Run: npm run build`);
    }
    for (const name of ['logo.png', 'package.json']) {
      if (!unzip(PATHS.dxt, name).equals(fs.readFileSync(at('bundle', name)))) {
        problems.push(`nansen.dxt contains a different ${name} than bundle/${name}. Run: npm run build`);
      }
    }
  } catch (err) {
    problems.push(`could not inspect nansen.dxt: ${err.message.split('\n')[0]}. Run: npm run build`);
  }
  return problems;
}

async function fetchUpstream(upstream, ref) {
  const url = `https://raw.githubusercontent.com/${upstream.repository}/${ref}/${upstream.path}`;
  const response = await fetch(url);
  if (!response.ok) fail(`GET ${url} returned HTTP ${response.status}`);
  return { url, data: Buffer.from(await response.arrayBuffer()) };
}

async function resolveRef(repository, ref) {
  if (SHA.test(ref)) return ref;
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`, {
    headers: { Accept: 'application/vnd.github.sha' },
  });
  const sha = (await response.text()).trim();
  if (!response.ok || !SHA.test(sha)) fail(`could not resolve ${ref} in ${repository}`);
  return sha;
}

function writeGenerated() {
  const { manifest, bundlePackage } = generated();
  fs.writeFileSync(PATHS.manifest, manifest);
  fs.writeFileSync(PATHS.bundlePackage, bundlePackage);
}

function build() {
  writeGenerated();
  const bundle = at('bundle');
  // Re-lock from bundle/package.json, then install exactly the lock.
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: bundle, stdio: 'inherit' });
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: bundle, stdio: 'inherit' });
  execFileSync('npx', ['--no-install', 'mcpb', 'validate', PATHS.manifest], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('npx', ['--no-install', 'mcpb', 'pack', bundle, PATHS.dxt], { cwd: ROOT, stdio: 'inherit' });
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'generate':
      writeGenerated();
      console.log('Wrote bundle/manifest.json and bundle/package.json');
      return 0;
    case 'check': {
      const problems = checkProblems();
      for (const problem of problems) console.error(`ERROR: ${problem}`);
      if (!problems.length) console.log('Extension config is current.');
      return problems.length ? 1 : 0;
    }
    case 'verify-upstream': {
      const upstream = loadUpstream();
      const { url, data } = await fetchUpstream(upstream, rest.includes('--latest') ? 'main' : upstream.ref);
      if (!data.equals(fs.readFileSync(PATHS.config))) {
        console.error(`ERROR: config/mcp-client-config.json is not a byte-identical copy of ${url}.${rest.includes('--latest') ? ' Run: npm run sync -- --ref main' : ''}`);
        return 1;
      }
      console.log(`config/mcp-client-config.json matches ${url}`);
      return 0;
    }
    case 'sync': {
      const refIndex = rest.indexOf('--ref');
      const ref = refIndex === -1 ? 'main' : rest[refIndex + 1];
      if (!ref) fail('--ref requires a value');
      const upstream = loadUpstream();
      const sha = await resolveRef(upstream.repository, ref);
      const { url, data } = await fetchUpstream(upstream, sha);
      validateConfig(JSON.parse(data.toString('utf8')));
      fs.writeFileSync(PATHS.config, data);
      fs.writeFileSync(PATHS.upstream, toJson({ ...upstream, ref: sha, sha256: sha256(data) }));
      console.log(`Vendored ${url}`);
      build();
      return 0;
    }
    case 'build':
      build();
      return 0;
    default:
      console.error('Usage: node scripts/dxt.mjs <generate|check|sync [--ref <sha>]|verify-upstream [--latest]|build>');
      return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
