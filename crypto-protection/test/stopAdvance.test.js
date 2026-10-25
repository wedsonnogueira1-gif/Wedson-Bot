import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeProgressiveRFloor,
  initialRisk,
  isMoreProtective,
  isStopValidVsMarket,
  legacyAlreadyCrossedGate,
  legacyBuggySellBeCandidate,
  resolveStopAdvance,
  rMultiple,
  roundStopToTick,
  stopFromLockedR,
} from '../src/stopAdvance.js';

/** ADA snapshot from audit 2026-10-25 15:57 AEST */
const ADA = {
  side: 'SELL',
  entry: 0.2141,
  entryStop: 0.222,
  currentStop: 0.222,
  mark: 0.2059,
  peakR: 1.759493670886081,
  tickSize: 0.0001,
};

describe('risk / R helpers', () => {
  it('SELL initial risk and R at mark/peak', () => {
    const risk = initialRisk(ADA.entry, ADA.entryStop, 'SELL');
    assert.ok(Math.abs(risk - 0.0079) < 1e-9);
    assert.ok(Math.abs(rMultiple(ADA.entry, 0.2002, risk, 'SELL') - ADA.peakR) < 1e-9);
    assert.ok(rMultiple(ADA.entry, ADA.mark, risk, 'SELL') > 1);
  });

  it('BUY initial risk', () => {
    assert.equal(initialRisk(100, 90, 'BUY'), 10);
    assert.equal(rMultiple(100, 115, 10, 'BUY'), 1.5);
  });
});

describe('computeProgressiveRFloor thresholds', () => {
  it('below 0.75R — no advance', () => {
    const f = computeProgressiveRFloor(0.414);
    assert.equal(f.tier, null);
    assert.match(f.reason, /below_risk_reduce_threshold/);
  });

  it('0.75R risk reduce', () => {
    const f = computeProgressiveRFloor(0.8);
    assert.equal(f.tier, 'RISK_REDUCE');
    assert.equal(f.lockedR, -0.25);
  });

  it('1R break-even', () => {
    const f = computeProgressiveRFloor(1.2);
    assert.equal(f.tier, 'BE_1R');
    assert.equal(f.lockedR, 0);
  });

  it('1.5R profit lock', () => {
    const f = computeProgressiveRFloor(1.76);
    assert.equal(f.tier, 'PROFIT_LOCK');
    assert.equal(f.lockedR, 0.5);
  });
});

describe('SELL scenarios', () => {
  it('peak_r below 1R (and below 0.75) → KEEP', () => {
    const r = resolveStopAdvance({ ...ADA, peakR: 0.5 });
    assert.equal(r.action, 'KEEP');
    assert.equal(r.wouldRequestReplace, false);
    assert.match(r.reason, /below_risk_reduce/);
  });

  it('SELL after 1R → REPLACE to BE (entry) when mark still below entry', () => {
    const r = resolveStopAdvance({
      ...ADA,
      peakR: 1.1,
      mark: 0.21, // still below entry; BE at 0.2141 is valid
    });
    assert.equal(r.action, 'REPLACE');
    assert.equal(r.candidateStop, 0.2141);
    assert.ok(isMoreProtective(r.candidateStop, ADA.currentStop, 'SELL'));
    assert.ok(isStopValidVsMarket(r.candidateStop, 0.21, 'SELL'));
  });

  it('SELL after 1.5R with valid profit-lock → REPLACE below entry', () => {
    const r = resolveStopAdvance({
      ...ADA,
      peakR: 1.6,
      mark: 0.205, // profit-lock 0.21015 still above mark
    });
    assert.equal(r.action, 'REPLACE');
    const risk = initialRisk(ADA.entry, ADA.entryStop, 'SELL');
    const expected = roundStopToTick(stopFromLockedR(ADA.entry, risk, 0.5, 'SELL'), 0.0001, 'SELL');
    assert.equal(r.candidateStop, expected);
    assert.ok(r.candidateStop < ADA.entry);
    assert.ok(r.candidateStop > 0.205);
  });

  it('ADA case: theoretical profit-side target crossed → fallback BE, not permanent block', () => {
    // Reproduce legacy bug price ~0.1849
    const risk = initialRisk(ADA.entry, ADA.entryStop, 'SELL');
    const buggy = legacyBuggySellBeCandidate(ADA.entry, risk);
    assert.equal(buggy, 0.1849);
    assert.equal(legacyBuggySellBeCandidate(ADA.entry, risk, { plannedTp2: 0.18476 }), 0.1848);
    const legacy = legacyAlreadyCrossedGate(buggy, ADA.mark, 'SELL');
    assert.equal(legacy.blocked, true);
    assert.equal(legacy.reason, 'earned_tier_level_already_crossed_by_market');

    // Fixed resolver must still advance via BE/fallback
    const r = resolveStopAdvance(ADA);
    assert.equal(r.action, 'REPLACE');
    assert.equal(r.wouldRequestReplace, true);
    assert.ok(r.candidateStop > ADA.mark, 'SELL stop must be above mark');
    assert.ok(r.candidateStop < ADA.currentStop, 'must be more protective');
    // With peak 1.76, primary profit-lock 0.21015 is valid vs mark 0.2059
    assert.ok(r.candidateStop <= 0.2141);
    assert.ok(!String(r.reason).includes('earned_tier_level_already_crossed_by_market'));
  });

  it('SELL candidate on wrong side of market alone is rejected by validator', () => {
    assert.equal(isStopValidVsMarket(0.1849, 0.2059, 'SELL'), false);
  });

  it('SELL candidate less protective than current → KEEP', () => {
    const r = resolveStopAdvance({
      ...ADA,
      peakR: 1.1,
      currentStop: 0.21, // already better than BE 0.2141
      mark: 0.205,
    });
    // BE 0.2141 is less protective than 0.21; profit lock not earned (peak 1.1 < 1.5)
    // risk-reduce fallback also less protective than 0.21
    assert.equal(r.action, 'KEEP');
    assert.match(r.reason, /no_valid_more_protective_stop/);
  });
});

describe('BUY scenarios', () => {
  const BUY = {
    side: 'BUY',
    entry: 100,
    entryStop: 90,
    currentStop: 90,
    tickSize: 0.01,
  };

  it('BUY below 0.75R → KEEP', () => {
    const r = resolveStopAdvance({ ...BUY, mark: 95, peakR: 0.4 });
    assert.equal(r.action, 'KEEP');
  });

  it('BUY after 1R → REPLACE to BE', () => {
    const r = resolveStopAdvance({ ...BUY, mark: 112, peakR: 1.2 });
    assert.equal(r.action, 'REPLACE');
    assert.equal(r.candidateStop, 100);
    assert.ok(isStopValidVsMarket(100, 112, 'BUY'));
  });

  it('BUY after 1.5R → REPLACE above entry', () => {
    const r = resolveStopAdvance({ ...BUY, mark: 120, peakR: 1.6 });
    assert.equal(r.action, 'REPLACE');
    assert.ok(r.candidateStop > 100);
    assert.ok(r.candidateStop < 120);
  });

  it('BUY theoretical already crossed → fallback BE', () => {
    // peak high enough for profit lock, but mark pulled back below theoretical lock
    // locked 0.5R → stop 105; mark 102 → invalid for BUY (stop must be < mark)
    // BE at 100 is valid and more protective than 90
    const r = resolveStopAdvance({ ...BUY, mark: 102, peakR: 1.8 });
    assert.equal(r.action, 'REPLACE');
    assert.ok(r.candidateStop < 102);
    assert.ok(r.candidateStop > 90);
  });

  it('BUY wrong-side candidate invalid', () => {
    assert.equal(isStopValidVsMarket(110, 105, 'BUY'), false);
  });
});

describe('rounding / filters / failures', () => {
  it('roundStopToTick SELL rounds up', () => {
    assert.equal(roundStopToTick(0.21411, 0.0001, 'SELL'), 0.2142);
  });

  it('roundStopToTick BUY rounds down', () => {
    assert.equal(roundStopToTick(100.019, 0.01, 'BUY'), 100.01);
  });

  it('missing data → KEEP with diagnostic', () => {
    const r = resolveStopAdvance({ side: 'SELL', entry: 1, currentStop: 1.1, mark: null, peakR: 2 });
    assert.equal(r.action, 'KEEP');
    assert.match(r.reason, /missing_or_invalid_input/);
  });

  it('never weakens protection (SELL)', () => {
    const r = resolveStopAdvance({
      side: 'SELL',
      entry: 0.2141,
      entryStop: 0.222,
      currentStop: 0.209,
      mark: 0.205,
      peakR: 1.2, // BE would be 0.2141 — worse than 0.209
    });
    assert.equal(r.action, 'KEEP');
  });
});

describe('PEAK_RECOVERED → calc → validate → replace sequence', () => {
  it('regression: recovered peakR 1.76 on ADA does not stick in ENTRY_STOP logic', () => {
    // Step 1: peak recovered
    const peakR = 1.759493670886081;
    // Step 2: floor
    const floor = computeProgressiveRFloor(peakR);
    assert.equal(floor.tier, 'PROFIT_LOCK');
    // Step 3: resolve (includes validation + fallbacks)
    const r = resolveStopAdvance({ ...ADA, peakR });
    // Step 4: would request replace (caller emits STOP_REPLACE_REQUESTED) — no I/O here
    assert.equal(r.wouldRequestReplace, true);
    assert.equal(r.action, 'REPLACE');
    assert.ok(r.candidateStop > ADA.mark);
    assert.ok(isMoreProtective(r.candidateStop, 0.222, 'SELL'));
  });
});
