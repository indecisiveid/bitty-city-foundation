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
  upsertProfile,
  deleteAccount,
} from "./groupHandlers";

export { demoAsteroid, demoFillCity, demoSetBuildings, demoResetCity } from "./demoHandlers";

export { registerPushToken, unregisterPushToken, sendTestPush } from "./notificationHandlers";

export { sendKudos } from "./kudosHandlers";

export { dailyNudge } from "./scheduled";
