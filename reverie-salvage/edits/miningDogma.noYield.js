
  // Reverie hook point (reverie-salvage): hull cutters run on mining laser
  // frames with the mining numbers taken off, and need the range, cycle and
  // capacitor from here without a yield.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const allowNoYield = miningAmountM3 <= 0 && reverieHooks
    ? reverieHooks.run("mining.allowNoYield", false, { moduleItem, effectRecord, shipItem }) === true
    : false;
  if (miningAmountM3 <= 0 && !allowNoYield) {
    return null;
  }

