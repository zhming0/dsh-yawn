import { dirname, join } from "node:path";

/**
 * Where output the user should keep goes, resolved from the checkout path: a
 * folder beside the checkout, on the workspace volume, outside the repository.
 *
 * It is the session's one durable output location, so every sleep mechanism
 * can promise it back: a hibernation keeps the workspace volume it sits on,
 * and a checkpoint carries it into the machine it rebuilds. Both the prompt
 * text and the checkpoint code resolve the path here, so a workspace that
 * moves cannot leave them telling the model about different folders.
 */
export function artifactsDirectory(workspace: string): string {
  return join(dirname(workspace), "artifacts");
}
