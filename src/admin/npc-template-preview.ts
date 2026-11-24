import { pathToFileURL } from "node:url";
import { loadNpcTemplates } from "../discord-npc/template-catalog.js";
import { ZodError } from "zod";

export function previewNpcCatalog(path: string) {
  return loadNpcTemplates(path).map((template) => ({
    key: template.key,
    canonicalName: template.npc.canonicalName,
    aliases: template.aliases,
    home: template.home,
    templateVersion: template.npc.templateVersion,
    profileVersion: template.npc.profileVersion,
    operation: "create_only",
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3)
      throw new Error("Provide one local NPC catalog JSON file.");
    console.info(JSON.stringify(previewNpcCatalog(process.argv[2]), null, 2));
  } catch (error) {
    // Print validation paths and messages, never the raw profile or contents.
    if (error instanceof ZodError)
      console.error(JSON.stringify(error.issues.map(({ path, message }) => ({
        path,
        message,
      }))));
    else console.error("Unable to read or parse the local NPC catalog.");
    process.exitCode = 1;
  }
}
