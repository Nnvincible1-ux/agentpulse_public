// Run from the application's terminal in Coolify. Never put this code in chat.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "../lib/auth.mjs";

try {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const auth = new Auth({
    dir: process.env.AGENTPULSE_DATA_DIR ? path.resolve(process.env.AGENTPULSE_DATA_DIR) : path.join(root, "data"),
    origin: process.env.AGENTPULSE_PUBLIC_ORIGIN || "",
    bootstrapToken: "",
  });
  const { token } = auth.issuePasswordReset();
  process.stdout.write("Open AgentPulse > Forgot password? > Reset code from Coolify.\n");
  process.stdout.write("This private code works once and expires in 15 minutes. Your authenticator remains enabled.\n\n");
  process.stdout.write(token + "\n");
} catch {
  console.error("Could not create a reset code. Run this inside the configured AgentPulse container after owner setup.");
  process.exitCode = 1;
}
