import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWaterStations, parsePumpStations, bankLevel, riskOf } from '../src/sources/bma.js';
import { evaluate, updateHistory, riseOver, trendOver } from '../src/alerts.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const DISTRICTS = ['ประเวศ', 'สวนหลวง', 'บางกะปิ'];
const NOW = Date.parse('2026-09-28T04:40:00Z'); // 11:40 Bangkok, just after the fixture was captured
const cfg = {
  districts: DISTRICTS,
  riseThresholdM: 0.1,
  riseWindowMinutes: 60,
  alertCooldownMinutes: 120,
  historyHours: 48,
};

test('parses only stations in the target districts', () => {
  const canals = parseWaterStations(load('bma-water.json'), DISTRICTS, { now: NOW });
  assert.equal(canals.length, 37);
  assert.ok(canals.every((s) => DISTRICTS.some((d) => s.district.includes(d))));
  const gate = canals.find((s) => s.code === 'WL.PWT.03');
  assert.equal(gate.isGate, true);
  assert.equal(gate.level, 0.73);
  assert.equal(gate.status, 'critical'); // BMA's label
  assert.equal(gate.bank, 1.05);
  assert.equal(gate.freeboard, 0.32);
  assert.equal(gate.risk, 'watch'); // ours: 32 cm below the bank
});

test('flags placeholder thresholds and unusable bank heights', () => {
  const canals = parseWaterStations(load('bma-water.json'), DISTRICTS, { now: NOW });
  const byCode = (c) => canals.find((s) => s.code === c);
  assert.equal(byCode('WL.HMK.01').thresholdsOk, false); // -0.2 / 0
  assert.equal(byCode('WL.MKT.02').thresholdsOk, false); // 320 / 450, entered in cm
  const happyLand = byCode('WL.YPN.01'); // both banks recorded as 0
  assert.equal(happyLand.bank, null);
  assert.equal(happyLand.risk, 'unknown');
  assert.equal(bankLevel(0.9, 0.75), 0.75);
  assert.equal(bankLevel(320, null), null);
});

test('risk bands follow the distance to the bank', () => {
  const r = (freeboard) => riskOf({ stale: false, level: 0.5, freeboard });
  assert.equal(r(-0.1), 'danger');
  assert.equal(r(0.29), 'danger');
  assert.equal(r(0.3), 'watch');
  assert.equal(r(0.6), 'ok');
  assert.equal(r(null), 'unknown');
  assert.equal(riskOf({ stale: true, level: 0.5, freeboard: 1 }), 'offline');
  assert.equal(riskOf({ stale: false, level: 0.5, freeboard: 0.5 }, { dangerFreeboardM: 0.2, watchFreeboardM: 0.4 }), 'ok');
});

test('readings older than staleMinutes are marked offline', () => {
  const canals = parseWaterStations(load('bma-water.json'), DISTRICTS, { now: NOW });
  const jkk = canals.find((s) => s.code === 'WL.JKK.01'); // last reading 26/09
  assert.equal(jkk.stale, true);
  assert.equal(jkk.status, 'offline');
});

test('parses pump stations with running pump counts', () => {
  const pumps = parsePumpStations(load('bma-pump.json'), DISTRICTS, { now: NOW });
  assert.equal(pumps.length, 15);
  const toYo = pumps.find((p) => p.code === 'ST.BKP.04');
  assert.equal(toYo.pumpsRunning, 3);
  assert.equal(toYo.pumpsTotal, 4);
  assert.equal(toYo.level, 1.18);
});

const station = (over) => ({ id: 'wl-1', name: 'ค.ทดสอบ', district: 'ประเวศ', level: 0.3, bank: 1.3, freeboard: 1, risk: 'ok', ...over });

test('first run sends a single summary, later runs alert only on changes', () => {
  const first = evaluate(null, [station({ risk: 'danger', freeboard: 0.1 })], {}, cfg, NOW);
  assert.deepEqual(first.alerts.map((a) => a.type), ['summary']);

  const same = evaluate(first.state, [station({ risk: 'danger', freeboard: 0.1 })], {}, cfg, NOW);
  assert.equal(same.alerts.length, 0);

  const better = evaluate(same.state, [station({ risk: 'watch', freeboard: 0.4 })], {}, cfg, NOW);
  assert.equal(better.alerts[0].type, 'improve');

  const worse = evaluate(better.state, [station({ risk: 'danger', freeboard: 0.2 })], {}, cfg, NOW);
  assert.equal(worse.alerts[0].type, 'escalate');
});

test('offline flapping does not trigger escalate/improve alerts', () => {
  const s0 = evaluate({ initialized: true, stations: {} }, [station({ risk: 'danger' })], {}, cfg, NOW).state;
  const s1 = evaluate(s0, [station({ risk: 'offline' })], {}, cfg, NOW);
  assert.equal(s1.alerts.length, 0);
  const s2 = evaluate(s1.state, [station({ risk: 'danger' })], {}, cfg, NOW);
  assert.equal(s2.alerts.length, 0);
  // A change that happened while offline is still reported once readings resume.
  const s3 = evaluate(s2.state, [station({ risk: 'offline' })], {}, cfg, NOW);
  const s4 = evaluate(s3.state, [station({ risk: 'ok' })], {}, cfg, NOW);
  assert.deepEqual(s4.alerts.map((a) => a.type), ['improve']);
});

test('rapid rise alerts once, then respects the cooldown', () => {
  const min = 60_000;
  let history = {};
  history = updateHistory(history, [station({ level: 0.2, timestamp: NOW - 50 * min })], { now: NOW, historyHours: 48 });
  history = updateHistory(history, [station({ level: 0.35, timestamp: NOW })], { now: NOW, historyHours: 48 });
  assert.ok(Math.abs(riseOver(history['wl-1'], 60, NOW) - 0.15) < 1e-9);

  const state = { initialized: true, stations: { 'wl-1': { risk: 'ok' } } };
  const r1 = evaluate(state, [station({ level: 0.35 })], history, cfg, NOW);
  assert.deepEqual(r1.alerts.map((a) => a.type), ['rise']);
  const r2 = evaluate(r1.state, [station({ level: 0.35 })], history, cfg, NOW + 10 * min);
  assert.equal(r2.alerts.length, 0);
});

test('stations without bank data never flip the alert state', () => {
  const s0 = evaluate({ initialized: true, stations: {} }, [station({ risk: 'watch' })], {}, cfg, NOW).state;
  const s1 = evaluate(s0, [station({ risk: 'unknown', freeboard: null })], {}, cfg, NOW);
  assert.equal(s1.alerts.length, 0);
  assert.equal(s1.state.stations['wl-1'].risk, 'watch');
});

test('trend needs readings spanning at least half the window', () => {
  const min = 60_000;
  assert.equal(trendOver([{ t: NOW - 10 * min, v: 0.2 }, { t: NOW, v: 0.3 }], 60, NOW), null);
  assert.equal(trendOver([{ t: NOW - 55 * min, v: 0.4 }, { t: NOW - 20 * min, v: 0.2 }, { t: NOW, v: 0.32 }], 60, NOW), -0.08);
});

test('history drops points older than the retention window', () => {
  const h = updateHistory({ 'wl-1': [{ t: NOW - 49 * 3600_000, v: 1 }] }, [], { now: NOW, historyHours: 48 });
  assert.deepEqual(h['wl-1'], []);
});
