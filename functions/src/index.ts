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
  upsertProfile,
  deleteAccount,
} from "./groupHandlers";

export { demoAsteroid, demoFillCity, demoSetBuildings, demoResetCity } from "./demoHandlers";

export { registerPushToken, unregisterPushToken, sendTestPush } from "./notificationHandlers";

export { sendKudos } from "./kudosHandlers";

export { sendNudge } from "./nudgeHandlers";

export { dailyNudge } from "./scheduled";
