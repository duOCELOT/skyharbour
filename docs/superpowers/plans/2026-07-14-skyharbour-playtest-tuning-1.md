# Playtest Tuning 1 (owner feedback, live session)

Owner playtest notes → changes (client-side only; server economy untouched):
1. **World ×10**: `WORLD_SCALE = 10` in flightMath — all world z-coords (rocks/raiders/islands/target) scale ×10, ship speeds unchanged (trips take ~10× longer), fuel accrual rate ÷10 (total fuel = distance, exactly as before; server minFuel/duration floors still satisfied — duration grows, fuel unchanged). HUD DIST displays economy units (scaled÷10).
2. **Fire fix**: SPACE wasn't firing reliably — root-cause and fix (suspects: focused ACCEPT button swallowing Space (blur activeElement at launch), preventDefault gaps, keys[' '] handling).
3. **Raiders gentler**: speed 9→5 u/s, fire interval 2.2→3.5s, bolt speed 60→45, engage only within 300u (idle beyond).
4. **Hull 3→8** (mkRun) — rocks/bolts still 1 dmg each.
Authorized test updates: hull-value assertions, world z-range expectations ×10, target.z math; sweep/loop logic unchanged (more iterations).
