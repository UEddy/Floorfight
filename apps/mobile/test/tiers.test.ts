// The stake tiers exist twice on purpose: here, as the amounts this app will
// put in a create transaction, and in packages/shared/tiers.ts, as what the
// server lists and the page labels. The app's copy is the one that decides
// what a person pays, so it does not import the other. This keeps them equal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLDERS_JOIN_WINDOW, HOLDERS_MAX_PLAYERS, STAKE_TIERS } from "../src/config";
import * as shared from "../../../packages/shared/tiers";

test("the app's stake tiers are the shared tiers, in the same order", () => {
  assert.deepEqual(STAKE_TIERS.map(String), shared.STAKE_TIERS.map((t) => t.lamports));
});

test("the app creates matches with the shared seat count and join window", () => {
  assert.equal(HOLDERS_MAX_PLAYERS, shared.HOLDERS_MAX_PLAYERS);
  assert.equal(HOLDERS_JOIN_WINDOW, shared.HOLDERS_JOIN_WINDOW);
  // Inside what create_match accepts, with room left for the lobby's lock.
  assert.ok(HOLDERS_JOIN_WINDOW >= 30 && HOLDERS_JOIN_WINDOW <= 3600);
  assert.ok(HOLDERS_JOIN_WINDOW > shared.LOCK_BEFORE_DEADLINE * 2);
});
