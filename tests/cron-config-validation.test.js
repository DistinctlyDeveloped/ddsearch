#!/usr/bin/env node
/**
 * Regression test: Validate OpenClaw cron job configurations
 * 
 * Catches issues like:
 * - delivery.mode="announce" without a delivery target (channel/to)
 * - Agent mismatch (using agent that lacks permissions for delivery target)
 * 
 * Run: node tests/cron-config-validation.test.js
 */

import { execSync } from 'child_process';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function main() {
  console.log('🔍 Cron Configuration Validation Tests\n');

  // Fetch cron list as JSON
  let cronOutput;
  try {
    cronOutput = execSync('openclaw cron list --json 2>/dev/null', { encoding: 'utf8' });
  } catch {
    try {
      // Fallback: parse text output
      cronOutput = execSync('openclaw cron list 2>/dev/null', { encoding: 'utf8' });
    } catch (e) {
      console.log('⚠️  Could not fetch cron list — skipping (openclaw not available)');
      process.exit(0);
    }
  }

  // Test 1: No cron jobs should have "error" status for delivery-related issues
  console.log('Test 1: Check for delivery configuration errors');
  
  const errorJobs = [];
  const lines = cronOutput.split('\n');
  for (const line of lines) {
    if (line.includes('error')) {
      errorJobs.push(line.trim());
    }
  }
  
  assert(
    errorJobs.length === 0,
    `No cron jobs in error state (found ${errorJobs.length})`
  );
  if (errorJobs.length > 0) {
    errorJobs.forEach(j => console.log(`    → ${j}`));
  }

  // Test 2: Specifically check project-tracker-update is not in error
  console.log('\nTest 2: project-tracker-update delivery config');
  const trackerLine = lines.find(l => l.includes('project-tracker-update'));
  if (trackerLine) {
    assert(
      !trackerLine.includes('error'),
      'project-tracker-update should not be in error state'
    );
  } else {
    console.log('  ⚠️  project-tracker-update not found — skipping');
  }

  // Test 3: Specifically check Prmptly Help Desk Monitor  
  console.log('\nTest 3: Prmptly Help Desk Monitor agent config');
  const prmptlyLine = lines.find(l => l.includes('Prmptly Help Desk'));
  if (prmptlyLine) {
    assert(
      !prmptlyLine.includes('error'),
      'Prmptly Help Desk Monitor should not be in error state'
    );
  } else {
    console.log('  ⚠️  Prmptly Help Desk Monitor not found — skipping');
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
