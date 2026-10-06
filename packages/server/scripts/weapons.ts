/**
 * The weapon table as numbers a person reads: damage, fire rate, spread,
 * magazine, reload, and time to kill a full health player with body shots
 * and with head shots, assuming every shot lands.
 *
 *   npm run weapons
 *
 * Time to kill is (shots needed - 1) times the fire interval: the first shot
 * is at time zero. Shotgun damage is the full pattern, all pellets landing,
 * which is point blank; its range column says where that stops being true.
 */
import { MAX_HP, TICK_HZ, YAW_UNITS } from "../../shared/sim";
import { WEAPONS } from "../../shared/weapons";

const deg = (units: number) => (units / YAW_UNITS) * 360;
const rows = WEAPONS.map((w) => {
  const body = w.damage * w.pellets;
  const head = w.headDamage * w.pellets;
  const nBody = Math.ceil(MAX_HP / body);
  const nHead = Math.ceil(MAX_HP / head);
  const ttk = (n: number) => `${n} (${Math.round(((n - 1) * w.fireInterval * 1000) / TICK_HZ)} ms)`;
  return {
    weapon: w.name,
    damage: w.pellets > 1 ? `${w.damage} x ${w.pellets} = ${body}` : `${w.damage}`,
    head: w.pellets > 1 ? `${w.headDamage} x ${w.pellets}` : `${w.headDamage}`,
    "rounds/min": Math.round((TICK_HZ * 60) / w.fireInterval),
    "spread deg": `${deg(w.spread).toFixed(2)} (+${deg(w.moveSpread).toFixed(2)} moving)`,
    mag: w.mag,
    "reload s": (w.reloadTicks / TICK_HZ).toFixed(2),
    range: w.range,
    "body shots to kill": ttk(nBody),
    "head shots to kill": ttk(nHead),
  };
});
console.log(`full health ${MAX_HP}`);
console.table(rows);
