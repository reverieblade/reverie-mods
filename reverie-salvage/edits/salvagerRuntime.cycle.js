
    ? callbacks.getEntityRuntimeSkillMap(entity)
    : null;
  // Drones carry the recovered items home before depositing them in ship cargo.
  // Their inventory rows participate in the same rollback as module rewards.
  const shipID = toPositiveInt(shipItem.itemID, toPositiveInt(entity && entity.itemID, 0));
  const rewardLocationID = toPositiveInt(callbacks.salvageRewardLocationID, shipID);
  const cargoSnapshot = rewardLocationID === shipID
    ? resolveCargoSnapshot(characterID, shipItem, fittedItems, skillMap)
    : null;
  // Reverie hook points (reverie-salvage): a mod may take a cycle over (a hull
  // panel comes apart its own way), add room beside the cargo hold (a salvage
  // hold) and split the rewards between the holds.
  const reverieHooks = globalThis[Symbol.for("reverie.hooks")];
  const salvageCycle = {
    scene,
    entity,
    targetEntity,
    effectState,
    nowMs,
    callbacks,
    characterID,
    shipItem,
    shipID,
    rewardLocationID,
    cargoSnapshot,
    fittedItems,
    skillMap,
    messageSession,
    syncRewards(changes) {
      syncSalvageRewardsToSession(
        rewardLocationID === shipID ? resolveInventorySession(entity, callbacks) : null,
        shipID,
        changes,
      );
    },
    notify(rewards) {
      notifySalvageResult(messageSession, targetEntity, "CustomNotify", rewards);
    },
  };
  const takenOver = reverieHooks ? reverieHooks.run("salvage.cycle", null, salvageCycle) : null;
  if (takenOver) {
    return takenOver;
  }
  const cargoFree = cargoSnapshot ? cargoSnapshot.availableVolume : 0;
  const extraRoom = rewardLocationID === shipID && reverieHooks
    ? Math.max(0, toFiniteNumber(reverieHooks.run("salvage.extraRoom", 0, salvageCycle), 0))
    : 0;
  const rewardEntries = buildSalvageRewardEntries(targetEntity, {
    callbacks,
    availableVolume: cargoSnapshot ? cargoFree + extraRoom : undefined,
  });
  const rewardVolume = roundNumber(computeGrantVolume(rewardEntries), 6);
  const rewardSplit = rewardLocationID === shipID && reverieHooks
    ? reverieHooks.run("salvage.rewardSplit", null, rewardEntries, cargoFree, extraRoom, salvageCycle)
    : null;
  if (rewardLocationID === shipID &&
      (!cargoSnapshot || (rewardSplit
        ? rewardSplit.left.length > 0
        : rewardVolume > cargoFree + 1e-6))) {
    if (reverieHooks) {
      reverieHooks.emit("salvage.cargoFull", salvageCycle, rewardVolume, cargoFree + extraRoom);
    }
    return {
      success: false,
      stopReason: "cargo",
      data: {
        requiredVolume: rewardVolume,
        availableVolume: cargoFree + extraRoom,
      },
    };
  }

