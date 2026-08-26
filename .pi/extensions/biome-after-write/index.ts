import {
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { createMutationHandler } from "./handler.js";

export default function biomeAfterWrite(pi: ExtensionAPI) {
  const handleMutation = createMutationHandler({
    exec: pi.exec.bind(pi),
    withFileMutationQueue,
  });
  pi.on("tool_result", (event, ctx) => handleMutation(event, ctx));
}
