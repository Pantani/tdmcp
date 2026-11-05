---
description: "Generate music beds with a local ACE-Step 1.5 server and drive TouchDesigner visuals from them with tdmcp."
---

# Music generation with ACE-Step

tdmcp can generate a song or instrumental bed from a text prompt and build a
reactive visual over it. The audio comes from
[ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5), an MIT-licensed model
that runs on your own machine. tdmcp talks to its API server and never bundles the
model.

This is off by default. With `TDMCP_ACE_ENABLED` unset, none of these tools register.

::: warning Plan for pre-rendering
TD's render and the model compete for the same GPU. Generate the next bed ahead of
time instead of expecting a live jam.
:::

## Set it up

1. Install ACE-Step 1.5 and start its API server. Models download on first use, so
   expect about 10 GB ([upstream repository](https://github.com/ace-step/ACE-Step-1.5)):

   ```bash
   git clone https://github.com/ace-step/ACE-Step-1.5.git
   ```

   ```bash
   cd ACE-Step-1.5 && uv sync && uv run acestep-api
   ```

   On Apple Silicon, use `./start_api_server_macos.sh` instead. Either way, the
   server listens on `http://127.0.0.1:8001`.

2. Enable the tools in the environment of your MCP client:

   ```bash
   export TDMCP_ACE_ENABLED=1
   export TDMCP_ACE_OUTPUT_DIR="$HOME/tdmcp-music"
   ```

   Use an absolute output folder. tdmcp downloads each finished file there, and
   TouchDesigner opens it from that path.

3. Restart your MCP client and ask for a bed:

   > Generate 30 seconds of driving 128 bpm techno, then build an audio-reactive
   > visual from it.

## Tools

| Tool | What it does |
|------|--------------|
| `generate_music` | Generates a bed and returns `wavPath`, `seconds` and `seed` when the server reports one. With `mode: "job"`, returns a `job_id` right away. |
| `generate_music_reactive` | Generates a bed and builds an audio-reactive network over it. |
| `submit_music_job` | Queues a generation and returns a `job_id`. |
| `get_music_job` | Reports a job's status. The first poll after it finishes downloads the audio. |

The `song_to_show` prompt walks an AI through generating a song and building a full
show around it. On the command line, use `tdmcp-agent music generate`, `music reactive`,
`music submit` and `music job`.

### Parameters

| Parameter | Range | Default |
|-----------|-------|---------|
| `prompt` | Tags, genre, mood | Required |
| `lyrics` | Text with `[verse]`, `[chorus]` markers | Instrumental |
| `audio_duration` | 10 to 600 seconds | The model chooses |
| `seed` | Integer of 0 or more | Random |
| `inference_steps` | Turbo models 1 to 20, base models 1 to 200 | `TDMCP_ACE_DEFAULT_STEPS` |
| `guidance_scale` | Base models only | 7.0 |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `TDMCP_ACE_ENABLED` | off | Registers the tools. |
| `TDMCP_ACE_HOST` / `TDMCP_ACE_PORT` | `127.0.0.1` / `8001` | Where the server is. |
| `TDMCP_ACE_TOKEN` | none | Must match the server's `ACESTEP_API_KEY`. |
| `TDMCP_ACE_OUTPUT_DIR` | `.tdmcp/ace-output` | Where finished audio is saved. |
| `TDMCP_ACE_TIMEOUT_MS` | `600000` | How long a blocking generation waits. |
| `TDMCP_ACE_DEFAULT_STEPS` | `8` | Steps when none are requested. Base models want 32 to 64. |
| `TDMCP_ACE_POLL_MS` | `2000` | How often a job is checked. |
| `TDMCP_ACE_RTF` | none | Seconds of compute per second of audio on your machine. |
| `TDMCP_ACE_SYNC_MAX_SECONDS` | `120` | Longer estimates become jobs when `TDMCP_ACE_RTF` is set. |

To calibrate, run one blocking `generate_music`, read `observed_rtf` from the result
and set `TDMCP_ACE_RTF` to it. Long requests then return a `job_id` instead of blocking.

## Limits

- **Jobs can't be cancelled.** ACE-Step 1.5 has no cancel API. If your client aborts
  or the timeout passes, tdmcp stops waiting, but the server keeps generating. The
  error names the job, so you can collect it later with `get_music_job`.
- **Jobs don't survive a server restart.** Polling one afterwards reports an unknown job.
- **`seed` can be missing from the result.** The server doesn't always report the
  seed it picked. Pass your own when you need a repeatable result.
- **Progress may not extend client timeouts.** tdmcp sends progress notifications,
  but whether a client resets its tool-call timeout on them depends on the client.

## Verification status {#verification}

Offline tests cover the client against a mock of the upstream contract. These checks
need a real server, and each one stays unverified until it has been run.

| # | Check | Pass criterion |
|---|-------|----------------|
| P-1 | `music generate --prompt "lofi hip hop" --audio_duration 10` | Returns a playable WAV in the output folder. |
| P-2 | The same command, run twice | The second run doesn't reload the model. |
| P-3 | `music submit`, then `music job <job_id>` until done | The status goes from `running` to `done` with a real file. |
| P-4 | Read `observed_rtf`, set `TDMCP_ACE_RTF`, then request a long bed | `mode: "auto"` returns a `job_id`. |
| P-5 | `music reactive` with the TD bridge up | An Audio File In CHOP plays the WAV, and the network cooks without errors. |
| P-6 | A long generation in an MCP client that shows progress | Note whether the client resets its timeout. |
