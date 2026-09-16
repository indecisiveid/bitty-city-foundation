import { initializeApp } from "firebase-admin/app";

initializeApp();

export {
  createGroup,
  joinGroup,
  getGroup,
  completeGoal,
  selectBuild,
  deleteGroup,
  leaveGroup,
  repairStreak,
  rescueBuild,
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
} from "./demoHandlers";

export { registerPushToken, unregisterPushToken, sendTestPush } from "./notificationHandlers";

export { sendKudos } from "./kudosHandlers";

export { sendNudge } from "./nudgeHandlers";

export { setMemberPause, setCityPause } from "./pauseHandlers";

export { setGameMode, dismissModeSuggestion } from "./modeHandlers";

export { dailyNudge } from "./scheduled";
