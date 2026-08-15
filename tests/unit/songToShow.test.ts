import { describe, expect, it, vi } from "vitest";
import { registerSongToShow } from "../../src/prompts/songToShow.js";

type Handler = (args: Record<string, string | undefined>) => {
  messages: { role: string; content: { type: string; text: string } }[];
};

function register() {
  const registerPrompt = vi.fn();
  // biome-ignore lint/suspicious/noExplicitAny: minimal McpServer/PromptContext stand-in
  registerSongToShow({ registerPrompt } as any, {} as any);
  const [name, config, handler] = registerPrompt.mock.calls[0] as unknown as [
    string,
    { title: string; description: string; argsSchema: Record<string, unknown> },
    Handler,
  ];
  return { name, config, handler };
}

describe("song_to_show prompt", () => {
  it("registers under the expected name with the documented args", () => {
    const { name, config } = register();
    expect(name).toBe("song_to_show");
    expect(Object.keys(config.argsSchema).sort()).toEqual([
      "duration",
      "lyrics",
      "sections",
      "song",
      "visual_style",
    ]);
    // It must announce that it GENERATES the audio, so a model doesn't confuse it
    // with audio_to_show (which assumes the audio already exists).
    expect(config.description).toContain("audio_to_show");
  });

  it("renders a user prompt naming the ACE + reactive tool chain", () => {
    const { handler } = register();
    const { messages } = handler({ song: "driving 128bpm techno" });
    expect(messages).toHaveLength(1);
    const text = messages[0]?.content.text ?? "";
    expect(text).toContain("driving 128bpm techno");
    for (const tool of [
      "generate_music_reactive",
      "submit_music_job",
      "get_music_job",
      "cancel_music_job",
      "create_audio_reactive",
      "bind_to_channel",
      "manage_cue",
      "TDMCP_ACE_ENABLED=1",
    ]) {
      expect(text).toContain(tool);
    }
  });

  it("carries the optional args through and defaults the rest", () => {
    const { handler } = register();
    const text =
      handler({ song: "ambient", lyrics: "[verse] hi", sections: "intro, outro" }).messages[0]
        ?.content.text ?? "";
    expect(text).toContain("[verse] hi");
    expect(text).toContain("intro, outro");

    const instrumental = handler({ song: "ambient" }).messages[0]?.content.text ?? "";
    expect(instrumental).toContain("Instrumental");
    expect(instrumental).toContain("intro, build, drop, outro");
  });
});
