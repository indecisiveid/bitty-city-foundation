import { initializeApp } from "firebase-admin/app";

initializeApp();

export {
  createGroup,
  joinGroup,
  getGroup,
  completeGoal,
  completeGoals,
  selectBuild,
  deleteGroup,
  leaveGroup,
  repairStreak,
  rescueBuild,
  dismissRescue,
  repairTile,
  repairPark,
  upsertProfile,
  deleteAccount,
} from "./groupHandlers";

export {
  demoAsteroid,
  demoFillCity,
  demoSetBuildings,
  demoResetCity,
  demoShowcaseCity,
  demoSetNearMisses,
  demoBreakStreak,
} from "./demoHandlers";

export { registerPushToken, unregisterPushToken, sendTestPush } from "./notificationHandlers";

export { sendKudos } from "./kudosHandlers";

export { addProofComment, deleteProofComment } from "./commentHandlers";

export { sendNudge } from "./nudgeHandlers";

export { setMemberPause, setCityPause } from "./pauseHandlers";

export { setGameMode, dismissModeSuggestion } from "./modeHandlers";

export { dismissQuest, demoOfferQuest } from "./questHandlers";

export { buyHardHats } from "./shopHandlers";
export { redeemPurchase, placeHardHats } from "./storeHandlers";

export { updateCitySettings } from "./cityHandlers";

export { stopHealthSharing } from "./healthHandlers";

export { markTipsSeen, setEmailUpdates } from "./preferenceHandlers";

export { dailyNudge } from "./scheduled";

export { previewInvite } from "./inviteHandlers";
