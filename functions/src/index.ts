import { initializeApp } from "firebase-admin/app";

initializeApp();

export {
  createGroup,
  joinGroup,
  getGroup,
  completeGoal,
  selectBuild,
  deleteGroup,
} from "./groupHandlers";

export { demoAsteroid, demoFillCity } from "./demoHandlers";
