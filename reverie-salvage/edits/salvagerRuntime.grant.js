
      () => (rewardSplit && typeof rewardSplit.grant === "function"
        ? rewardSplit.grant()
        : grantItemsToCharacterLocation(
          characterID,
          rewardLocationID,
          ITEM_FLAGS.CARGO_HOLD,
          rewardEntries,
        )),
