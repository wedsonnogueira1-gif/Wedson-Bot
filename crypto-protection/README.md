# crypto-protection — stop advance (BUY/SELL)

Isolated calculator for Crypto LIVE trailing-stop recovery. **No Binance writes, no Forex, no Telegram.**

## Why this exists

Production ADA SELL (2026-10-25) stayed on `ENTRY_STOP` @ `0.222` with `peak_r≈1.76` because a profit-side candidate (`≈0.184`) tripped `earned_tier_level_already_crossed_by_market` with **no fallback** to a valid more-protective stop (e.g. break-even at entry).

This package implements the correct direction-aware math + fallback ladder.

## API

```js
import { resolveStopAdvance } from './src/stopAdvance.js';

const decision = resolveStopAdvance({
  side: 'SELL',
  entry: 0.2141,
  entryStop: 0.222,
  currentStop: 0.222,
  mark: 0.2059,
  peakR: 1.76,
  tickSize: 0.0001,
});
// decision.action === 'REPLACE' | 'KEEP'
// decision.wouldRequestReplace — wire to STOP_REPLACE_REQUESTED only when true
```

## Integration (production bot — not done here)

Wire `resolveStopAdvance` into the Crypto protection monitor **after** `PEAK_RECOVERED` / peak update and **before** the hard `earned_tier_level_already_crossed_by_market` return that sets `stop_after=null` without alternatives.

Suggested call sites (names from runtime telemetry — confirm in the private bot tree):

1. `computeProgressiveRFloor` (replace or wrap)
2. Protection monitor tick that emits `PROTECTION_LEVEL_CROSSED` / `STOP_REPLACE_REQUESTED`

Rules preserved:

- Never weaken an existing stop
- Never send Binance orders from this module
- Keep Forex paths untouched

## Tests

```bash
cd crypto-protection && npm test
```

## Production safety

Landing this module in git does **not** change Railway/Binance. Deploy + monitor restart require separate explicit authorisation.
