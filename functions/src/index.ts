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
} from "./groupHandlers";

export { demoAsteroid, demoFillCity, demoSetBuildings, demoResetCity } from "./demoHandlers";
