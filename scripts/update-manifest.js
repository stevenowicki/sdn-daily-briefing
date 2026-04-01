#!/usr/bin/env node
/**
 * update-manifest.js
 *
 * Called by the briefing task after generating a new briefing HTML file.
 * Downloads manifest.json from S3, prepends the new entry, re-uploads,
 * then invalidates CloudFront for /manifest.json and /index.html.
 *
 * Usage:
 *   node scripts/update-manifest.js \
 *     --url /2026/04/01-0800.html \
 *     --date 2026-04-01 \
 *     --label Morning \
 *     --time 08:00 \
 *     --iso-timestamp 2026-04-01T08:00:00-04:00 \
 *     --summary "Two or three sentence summary of top stories."
 *
 * Required env vars (set by briefing environment):
 *   BRIEFINGS_BUCKET_NAME              e.g. sdn-briefings-prod
 *   BRIEFINGS_CLOUDFRONT_DISTRIBUTION_ID
 *   AWS_DEFAULT_REGION                 (or AWS_REGION) — defaults to us-east-1
 *
 * Optional:
 *   AWS_PROFILE                        if running locally with named profile
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key.startsWith('--')) {
      result[key.slice(2)] = args[++i];
    }
  }
  return result;
}

const args = parseArgs();
const required = ['url', 'date', 'label', 'time', 'iso-timestamp', 'summary'];
for (const field of required) {
  if (!args[field]) {
    console.error(`Missing required argument: --${field}`);
    process.exit(1);
  }
}

const bucket = process.env.BRIEFINGS_BUCKET_NAME;
const distId = process.env.BRIEFINGS_CLOUDFRONT_DISTRIBUTION_ID;
const region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1';

if (!bucket) { console.error('BRIEFINGS_BUCKET_NAME is not set'); process.exit(1); }
if (!distId) { console.error('BRIEFINGS_CLOUDFRONT_DISTRIBUTION_ID is not set'); process.exit(1); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function run(cmd) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefings-manifest-'));
const localManifest = path.join(tmpDir, 'manifest.json');

const newEntry = {
  url: args['url'],
  date: args['date'],
  label: args['label'],
  time: args['time'],
  isoTimestamp: args['iso-timestamp'],
  summary: args['summary'],
};

console.log('\n1. Downloading current manifest.json from S3...');
try {
  run(`aws s3 cp s3://${bucket}/manifest.json ${localManifest} --region ${region}`);
} catch {
  // First run — manifest doesn't exist yet; start fresh
  console.log('   (manifest.json not found — creating new)');
  fs.writeFileSync(localManifest, JSON.stringify({ briefings: [] }, null, 2));
}

console.log('\n2. Prepending new entry...');
const manifest = JSON.parse(fs.readFileSync(localManifest, 'utf8'));
manifest.briefings = [newEntry, ...(manifest.briefings || [])];
fs.writeFileSync(localManifest, JSON.stringify(manifest, null, 2));
console.log(`   Total entries: ${manifest.briefings.length}`);

console.log('\n3. Uploading updated manifest.json to S3...');
run(
  `aws s3 cp ${localManifest} s3://${bucket}/manifest.json ` +
  `--content-type application/json ` +
  `--cache-control "max-age=60" ` +
  `--region ${region}`
);

console.log('\n4. Creating CloudFront invalidation...');
run(
  `aws cloudfront create-invalidation ` +
  `--distribution-id ${distId} ` +
  `--paths "/manifest.json" "/index.html"`
);

console.log('\nDone. New briefing is live at: https://briefings.stevenowicki.com' + args['url']);

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
