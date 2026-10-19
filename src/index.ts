import { pathToFileURL } from "node:url";
import { startApplication } from "./runtime.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void startApplication().catch(() => {
    console.error(JSON.stringify({ event: "startup_error" }));
    process.exitCode = 1;
  });
}
