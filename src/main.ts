import { createApplication } from "./bootstrap/application.js";
import { stopOnSignals } from "./bootstrap/signals.js";

const app = createApplication();
await app.start();

stopOnSignals(app);
