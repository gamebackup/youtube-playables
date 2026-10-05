#!/usr/bin/env node
/*
 * Installs the two hooks the cheat shop needs into the game's obfuscated bundle.
 *
 *   node cheats/patch-main.js           apply (idempotent)
 *   node cheats/patch-main.js --check   report status, change nothing
 *   node cheats/patch-main.js --revert  remove the hooks again
 *
 * Why these two anchors:
 *
 *  1. GameplayLogic's constructor assigns its four injected dependencies, and
 *     `arguments[0]` is the GameplayModel. Every property we touch
 *     (CurrentTable, playerObj, opponentList, houseCardDealer...) hangs off it.
 *         function GameplayLogic(model, soundManager, modelEvents, storage) {
 *           var D = a0_0x1071;
 *           this[D(0x314)] = model, <-- here
 *
 *  2. AiPokerPlayer_Casual.beginTurn calls the game's own 7-card evaluator, so
 *     stashing that module namespace gives us CardCalculator for free.
 *         this.handQuality = CC["CardCalculator"]["getCardCombination"](...)
 *                        =^ here
 *
 * Both anchors are unique in the bundle; the script refuses to patch if that
 * ever stops being true.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = path.resolve(__dirname, '..', 'main.js');

const PATCHES = [
  {
    name: 'gameplay model hook',
    find: '=_0x351a6e,',
    replace: '=_0x351a6e,window.__poker=arguments[0],',
    applied: 'window.__poker=arguments[0],',
  },
  {
    name: 'card calculator hook',
    find: '=_0x38232c[',
    replace: '=(window.__CC=_0x38232c)[',
    applied: 'window.__CC=_0x38232c',
  },
];

function countOf(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function status(src) {
  return PATCHES.map(p => {
    const isApplied = src.includes(p.applied);
    const anchors = isApplied ? 0 : countOf(src, p.find);
    return { name: p.name, applied: isApplied, anchors };
  });
}

function main() {
  const mode = process.argv[2] || 'apply';

  if (!fs.existsSync(TARGET)) {
    console.error('main.js not found at ' + TARGET);
    process.exit(1);
  }
  const src = fs.readFileSync(TARGET, 'utf8');

  if (mode === '--check') {
    let ok = true;
    for (const s of status(src)) {
      console.log((s.applied ? '[patched] ' : '[missing] ') + s.name);
      if (!s.applied) ok = false;
    }
    process.exit(ok ? 0 : 1);
  }

  if (mode === '--revert') {
    let out = src;
    let n = 0;
    for (const p of PATCHES) {
      if (!out.includes(p.replace)) continue;
      out = out.replace(p.replace, p.find);
      n++;
    }
    if (!n) {
      console.log('nothing to revert');
      return;
    }
    fs.writeFileSync(TARGET, out);
    console.log('reverted ' + n + ' hook(s) from main.js');
    return;
  }

  // apply
  let out = src;
  const todo = [];
  for (const p of PATCHES) {
    if (out.includes(p.applied)) continue;
    const n = countOf(out, p.find);
    if (n !== 1) {
      console.error('anchor for "' + p.name + '" matched ' + n + ' times (expected 1). Refusing to patch.');
      process.exit(1);
    }
    todo.push(p);
  }
  if (!todo.length) {
    console.log('main.js already patched');
    return;
  }
  for (const p of todo) out = out.replace(p.find, p.replace);

  try {
    new (require('vm').Script)(out, { filename: 'main.js' });
  } catch (e) {
    console.error('patched bundle failed to parse, not writing: ' + e.message);
    process.exit(1);
  }

  fs.writeFileSync(TARGET, out);
  console.log('patched main.js:');
  for (const p of todo) console.log('  + ' + p.name);
  console.log('(' + (out.length - src.length) + ' bytes added)');
}

main();