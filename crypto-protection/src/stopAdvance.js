/**
 * Crypto LIVE — direction-aware stop advance (BUY/SELL).
 *
 * Pure calculation module. No Binance, Telegram, Forex, or network I/O.
 *
 * Root-cause context (ADA SELL 2026-10-25):
 * Production emitted be_1r candidates ≈0.184 (profit-side / TP-like), below mark
 * on a short. Safety gate earned_tier_level_already_crossed_by_market then blocked
 * forever without falling back to a valid more-protective stop (e.g. BE at entry).
 */

/** @typedef {'BUY'|'SELL'} Side */

/**
 * Initial risk distance (always positive).
 * SELL entry stop is above entry; BUY entry stop is below entry.
 */
export function initialRisk(entry, entryStop, side) {
  const e = num(entry, 'entry');
  const s = num(entryStop, 'entryStop');
  if (side === 'SELL') {
    if (!(s > e)) throw new Error('SELL entryStop must be above entry');
    return s - e;
  }
  if (side === 'BUY') {
    if (!(s < e)) throw new Error('BUY entryStop must be below entry');
    return e - s;
  }
  throw new Error(`invalid side: ${side}`);
}

/** R multiple at `price` relative to entry/risk (favourable positive). */
export function rMultiple(entry, price, risk, side) {
  const e = num(entry, 'entry');
  const p = num(price, 'price');
  const r = num(risk, 'risk');
  if (!(r > 0)) throw new Error('risk must be > 0');
  if (side === 'SELL') return (e - p) / r;
  if (side === 'BUY') return (p - e) / r;
  throw new Error(`invalid side: ${side}`);
}

/**
 * Progressive floor from peakR (Crypto LIVE policy observed in runtime):
 * - <0.75R: no advance
 * - ≥0.75R: risk reduce (remaining risk 0.25R beyond entry)
 * - ≥1R: break-even (lockedR = 0)
 * - ≥1.5R: profit lock 0.5R; then 2R→1R lock, 3R→2R, 4R+→3R
 *
 * lockedR: profit locked in R units (0 = at entry). Negative = still risk side of entry.
 */
export function computeProgressiveRFloor(
  peakR,
  {
    riskReduceR = 0.75,
    beR = 1,
    profitLockR = 1.5,
  } = {},
) {
  const peak = num(peakR, 'peakR');
  if (!(peak >= 0)) throw new Error('peakR must be >= 0');

  if (peak < riskReduceR) {
    return {
      tier: null,
      lockedR: null,
      reason: `below_risk_reduce_threshold (peakR=${fmt(peak)}R < ${riskReduceR}R)`,
    };
  }
  if (peak < beR) {
    return { tier: 'RISK_REDUCE', lockedR: -0.25, reason: 'risk_reduce_0.75R' };
  }
  if (peak < profitLockR) {
    return { tier: 'BE_1R', lockedR: 0, reason: 'break_even_1R' };
  }
  if (peak < 2) {
    return { tier: 'PROFIT_LOCK', lockedR: 0.5, reason: 'profit_lock_1.5R' };
  }
  if (peak < 3) {
    return { tier: 'PROFIT_LOCK_2R', lockedR: 1, reason: 'profit_lock_2R' };
  }
  if (peak < 4) {
    return { tier: 'PROFIT_LOCK_3R', lockedR: 2, reason: 'profit_lock_3R' };
  }
  return { tier: 'PROFIT_LOCK_4R', lockedR: 3, reason: 'profit_lock_4R_plus' };
}

/** Theoretical stop from locked R (direction-aware). */
export function stopFromLockedR(entry, risk, lockedR, side) {
  const e = num(entry, 'entry');
  const r = num(risk, 'risk');
  const L = num(lockedR, 'lockedR');
  // SELL: higher stop = more risk; lower stop = more protection.
  // stop = entry - lockedR * risk  (lockedR=0 → entry; lockedR=0.5 → below entry)
  if (side === 'SELL') return e - L * r;
  if (side === 'BUY') return e + L * r;
  throw new Error(`invalid side: ${side}`);
}

/**
 * Binance-valid resting stop vs mark:
 * - SELL protective stop is a buy-stop → must be strictly above mark (+ buffer).
 * - BUY protective stop is a sell-stop → must be strictly below mark (− buffer).
 */
export function isStopValidVsMarket(stop, mark, side, { tickSize = 0.0001, bufferTicks = 1 } = {}) {
  const s = num(stop, 'stop');
  const m = num(mark, 'mark');
  const tick = num(tickSize, 'tickSize');
  const buf = bufferTicks * tick;
  if (side === 'SELL') return s > m + buf - 1e-12;
  if (side === 'BUY') return s < m - buf + 1e-12;
  throw new Error(`invalid side: ${side}`);
}

/** True if `candidate` is strictly more protective than `current`. */
export function isMoreProtective(candidate, current, side) {
  const c = num(candidate, 'candidate');
  const cur = num(current, 'current');
  if (side === 'SELL') return c < cur - 1e-12;
  if (side === 'BUY') return c > cur + 1e-12;
  throw new Error(`invalid side: ${side}`);
}

/**
 * Round stop to tick without crossing to the invalid side of the market intent:
 * - SELL: round UP (more conservative / farther above a falling mark when clamping)
 * - BUY: round DOWN
 */
export function roundStopToTick(price, tickSize, side) {
  const p = num(price, 'price');
  const t = num(tickSize, 'tickSize');
  if (!(t > 0)) throw new Error('tickSize must be > 0');
  const n = p / t;
  const rounded = side === 'SELL' ? Math.ceil(n - 1e-12) * t : Math.floor(n + 1e-12) * t;
  // normalize float noise
  return Number(rounded.toFixed(decimalsForTick(t)));
}

/**
 * Clamp an invalid theoretical stop to the nearest market-valid protective price.
 * Does not invent profit — only restores a placeable stop on the correct side of mark.
 */
export function clampStopToValidSide(theoretical, mark, side, opts = {}) {
  const tick = opts.tickSize ?? 0.0001;
  const bufferTicks = opts.bufferTicks ?? 1;
  const m = num(mark, 'mark');
  if (isStopValidVsMarket(theoretical, m, side, { tickSize: tick, bufferTicks })) {
    return roundStopToTick(theoretical, tick, side);
  }
  const buf = bufferTicks * tick;
  if (side === 'SELL') return roundStopToTick(m + buf, tick, side);
  return roundStopToTick(m - buf, tick, side);
}

/**
 * Resolve whether to advance the stop after peak observation / PEAK_RECOVERED.
 *
 * Never weakens an existing stop. Never forces a replace when no valid
 * more-protective candidate exists — returns keep + diagnostic reason instead.
 *
 * @returns {{
 *   action: 'REPLACE'|'KEEP',
 *   candidateStop: number|null,
 *   tier: string|null,
 *   lockedR: number|null,
 *   theoreticalStop: number|null,
 *   reason: string,
 *   wouldRequestReplace: boolean,
 *   diagnostics: object
 * }}
 */
export function resolveStopAdvance({
  side,
  entry,
  entryStop,
  currentStop,
  mark,
  peakR,
  tickSize = 0.0001,
  bufferTicks = 1,
  riskReduceR = 0.75,
  beR = 1,
  profitLockR = 1.5,
} = {}) {
  if (side !== 'BUY' && side !== 'SELL') {
    return keep(null, null, null, 'invalid_side', { side });
  }
  try {
    num(entry, 'entry');
    num(currentStop, 'currentStop');
    num(mark, 'mark');
    num(peakR, 'peakR');
  } catch (err) {
    return keep(null, null, null, `missing_or_invalid_input:${err.message}`, {});
  }

  let risk;
  try {
    risk = initialRisk(entry, entryStop ?? currentStop, side);
  } catch (err) {
    return keep(null, null, null, `risk_calc_failed:${err.message}`, {});
  }

  const floor = computeProgressiveRFloor(peakR, { riskReduceR, beR, profitLockR });
  if (floor.tier == null) {
    return keep(null, null, null, floor.reason, { peakR, risk });
  }

  const theoretical = stopFromLockedR(entry, risk, floor.lockedR, side);
  const opts = { tickSize, bufferTicks };

  // Fallback ladder: theoretical → BE (entry) → risk-reduce (entry ± 0.25R risk side)
  // Each candidate is validated vs market and must be more protective than currentStop.
  const ladder = [
    { label: floor.tier, stop: theoretical, lockedR: floor.lockedR },
    { label: 'BE_1R_FALLBACK', stop: stopFromLockedR(entry, risk, 0, side), lockedR: 0 },
    {
      label: 'RISK_REDUCE_FALLBACK',
      stop: stopFromLockedR(entry, risk, -0.25, side),
      lockedR: -0.25,
    },
  ];

  const evaluated = [];
  for (const step of ladder) {
    const rounded = roundStopToTick(step.stop, tickSize, side);
    const valid = isStopValidVsMarket(rounded, mark, side, opts);
    const more = isMoreProtective(rounded, currentStop, side);
    evaluated.push({
      label: step.label,
      raw: step.stop,
      rounded,
      valid,
      moreProtective: more,
      lockedR: step.lockedR,
    });
    if (valid && more) {
      return {
        action: 'REPLACE',
        candidateStop: rounded,
        tier: step.label,
        lockedR: step.lockedR,
        theoreticalStop: roundStopToTick(theoretical, tickSize, side),
        reason: `advance:${step.label}`,
        wouldRequestReplace: true,
        diagnostics: {
          peakR,
          risk,
          mark,
          currentStop,
          side,
          floor,
          theoreticalInvalid:
            !isStopValidVsMarket(roundStopToTick(theoretical, tickSize, side), mark, side, opts),
          evaluated,
          note:
            step.label !== floor.tier
              ? 'theoretical_or_primary_tier_invalid_or_not_more_protective; used_fallback'
              : 'primary_tier_ok',
        },
      };
    }
  }

  // Optional: clamp theoretical to valid side ONLY if that clamp is more protective
  const clamped = clampStopToValidSide(theoretical, mark, side, opts);
  const clampOk =
    isStopValidVsMarket(clamped, mark, side, opts) &&
    isMoreProtective(clamped, currentStop, side);

  if (clampOk) {
    return {
      action: 'REPLACE',
      candidateStop: clamped,
      tier: `${floor.tier}_CLAMPED`,
      lockedR: floor.lockedR,
      theoreticalStop: roundStopToTick(theoretical, tickSize, side),
      reason: 'advance:clamped_valid_more_protective',
      wouldRequestReplace: true,
      diagnostics: {
        peakR,
        risk,
        mark,
        currentStop,
        side,
        floor,
        evaluated,
        clamped,
      },
    };
  }

  return keep(floor.tier, floor.lockedR, roundStopToTick(theoretical, tickSize, side), {
    code: 'no_valid_more_protective_stop',
    detail:
      'theoretical level invalid or not more protective; fallbacks exhausted; keeping current STOP',
    peakR,
    risk,
    mark,
    currentStop,
    side,
    floor,
    evaluated,
    clamped,
    // Retain old gate name only as diagnostic — it must NOT be a hard permanent block
    legacyGateWouldHaveFired: !isStopValidVsMarket(
      roundStopToTick(theoretical, tickSize, side),
      mark,
      side,
      opts,
    ),
  });
}

/**
 * Legacy bug sketch (documentation / regression): treat a profit-side target
 * as the be_1r stop for SELL (observed ADA dedupe ≈0.1849 ≈ planned TP2 /
 * entry−3.7R — below mark). DO NOT use in production paths.
 */
export function legacyBuggySellBeCandidate(entry, risk, { plannedTp2 } = {}) {
  if (plannedTp2 != null) return Number(num(plannedTp2, 'plannedTp2').toFixed(4));
  // ADA audit: entry 0.2141, risk 0.0079 → 0.1849
  return Number((num(entry, 'entry') - 3.7 * num(risk, 'risk')).toFixed(4));
}

export function legacyAlreadyCrossedGate(candidateStop, mark, side) {
  // Historical behaviour: if candidate is on the wrong side of market, block with
  // earned_tier_level_already_crossed_by_market and do not try fallbacks.
  if (!isStopValidVsMarket(candidateStop, mark, side, { tickSize: 0.0001, bufferTicks: 0 })) {
    return {
      blocked: true,
      reason: 'earned_tier_level_already_crossed_by_market',
      stop_after: null,
    };
  }
  return { blocked: false, reason: null };
}

function keep(tier, lockedR, theoreticalStop, reason, diagnostics = {}) {
  const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
  return {
    action: 'KEEP',
    candidateStop: null,
    tier,
    lockedR,
    theoreticalStop,
    reason: reasonStr,
    wouldRequestReplace: false,
    diagnostics: typeof reason === 'object' ? { ...reason, ...diagnostics } : diagnostics,
  };
}

function num(v, name) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} invalid`);
  return n;
}

function fmt(n) {
  return Number(n).toFixed(4).replace(/\.?0+$/, '');
}

function decimalsForTick(tick) {
  const s = String(tick);
  if (s.includes('e') || s.includes('E')) {
    const n = Number(tick);
    let d = 0;
    let x = n;
    while (x < 1 && d < 12) {
      x *= 10;
      d += 1;
    }
    return d;
  }
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}
