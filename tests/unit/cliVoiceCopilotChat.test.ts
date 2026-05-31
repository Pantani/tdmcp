import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- module mock BEFORE the import under test ---
vi.mock("../../src/cli/chat.js", () => ({
  runChat: vi.fn().mockResolvedValue(undefined),
}));

import { runChat } from "../../src/cli/chat.js";
import { recordAudio, runVoiceCopilotChat } from "../../src/cli/voiceCopilotChat.js";

const mockRunChat = vi.mocked(runChat);

describe("voiceCopilotChat", () => {
  let written: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    written = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written += String(chunk);
      return true;
    });
    mockRunChat.mockClear();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("prints the banner before delegating to runChat", async () => {
    await runVoiceCopilotChat([]);
    expect(written).toContain("voice mode coming soon");
    expect(mockRunChat).toHaveBeenCalledOnce();
  });

  it("strips --no-voice before forwarding argv to runChat", async () => {
    await runVoiceCopilotChat(["--no-voice", "--no-open"]);
    expect(mockRunChat).toHaveBeenCalledWith(["--no-open"]);
  });

  it("short-circuits on --help and never calls runChat", async () => {
    await runVoiceCopilotChat(["--help"]);
    expect(written).toContain("tdmcp voice");
    expect(mockRunChat).not.toHaveBeenCalled();
  });

  it("recordAudio stub resolves to null", async () => {
    await expect(recordAudio()).resolves.toBeNull();
  });
});
