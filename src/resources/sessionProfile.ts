import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { jsonContents, type ResourceRegistrar } from "./shared.js";

// ---------------------------------------------------------------------------
// Session profile resource: tdmcp://session/profile
// ---------------------------------------------------------------------------

const DEFAULT_PROFILE_PATH = join(homedir(), ".tdmcp", "session-profile.json");

function resolveProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TDMCP_SESSION_PROFILE_PATH;
  if (override) return resolve(override);
  return DEFAULT_PROFILE_PATH;
}

function readProfileSafe(profilePath: string): unknown {
  if (!existsSync(profilePath)) {
    return {
      note: "No session profile found. Call the load_session_profile tool to initialise it.",
      profile_path: profilePath,
      created: false,
      sections: [],
    };
  }
  try {
    const raw = readFileSync(profilePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (err) {
    return {
      error: `Could not read session profile: ${err instanceof Error ? err.message : String(err)}`,
      profile_path: profilePath,
    };
  }
}

export const registerSessionProfileResource: ResourceRegistrar = (server, _ctx) => {
  server.registerResource(
    "td-session-profile",
    "tdmcp://session/profile",
    {
      title: "Persistent session profile",
      description:
        "The artist's persistent cross-session profile at ~/.tdmcp/session-profile.json. " +
        "Caches the latest outputs of style_memory, recall_similar_work, learn_conventions, " +
        "and learn_from_my_corpus so an agent can load all preferences in one resource read. " +
        "Use the load_session_profile tool to initialise or refresh the file. " +
        "Override the path with TDMCP_SESSION_PROFILE_PATH.",
      mimeType: "application/json",
    },
    async (uri) => {
      const profilePath = resolveProfilePath();
      const data = readProfileSafe(profilePath);
      return jsonContents(uri, data);
    },
  );
};
