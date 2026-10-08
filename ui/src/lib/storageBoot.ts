// Runs before any other module of the app reads localStorage (imported first in main.tsx): the
// keys of 1.14 and earlier are copied to their new names once.
import { copyLegacyStorage } from "./legacy";

copyLegacyStorage();
