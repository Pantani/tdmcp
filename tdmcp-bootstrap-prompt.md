# TDMCP — The Definitive TouchDesigner MCP Server

## Bootstrap Prompt for Claude Code / Cursor / Windsurf

> **What this document is:** A complete project specification and implementation prompt.
> Feed this entire file to an AI coding agent (Claude Code, Cursor, Windsurf) to scaffold,
> build, and iterate on a production-grade MCP server that lets any AI agent create
> visual art in TouchDesigner.

---

## 1. PROJECT IDENTITY

**Name:** `tdmcp` (npm: `@tdmcp/server`)
**Tagline:** "AI-native visual creation for TouchDesigner"
**License:** MIT
**Language:** TypeScript (server) + Python (TD-side)
**Target users:** Visual artists, VJs, creative coders, installation artists, educators — anyone who wants to describe a visual and have AI build it in TouchDesigner.

---

## 2. PROBLEM STATEMENT

TouchDesigner has one of the steepest learning curves in creative software. Current MCP servers for TD fall into two camps:

1. **Documentation-only** (`@bottobot/td-mcp`): 630 operators indexed, but read-only — the LLM still hallucinates outdated API and can't execute anything.
2. **Low-level execution** (`touchdesigner-mcp-server` by 8beeeaaat): Can create/delete nodes and run Python, but every interaction is atomic CRUD — building a particle system requires 15+ sequential tool calls with no semantic abstraction.

**Neither is enough alone.** Artists don't think in `create_td_node` calls — they think in "make a generative particle system that reacts to audio." We need a server that:

- Speaks the artist's language (high-level intent → complete network)
- Has authoritative operator knowledge (no hallucinations)
- Executes in TD with a feedback loop (create → verify → fix → preview)
- Works with ANY MCP client (Claude Desktop, Claude Code, Cursor, VS Code, etc.)

---

## 3. ARCHITECTURE

```
┌──────────────────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop / Code / Cursor / any)          │
└──────────┬───────────────────────────────────────────────────┘
           │ stdio or HTTP (MCP protocol)
┌──────────▼───────────────────────────────────────────────────┐
│  TDMCP Server (Node.js / TypeScript)                        │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  LAYER 1: High-Level Tools (artist-facing)              │ │
│  │  ├── create_visual_system                               │ │
│  │  ├── create_audio_reactive                              │ │
│  │  ├── create_feedback_network                            │ │
│  │  ├── create_particle_system                             │ │
│  │  ├── create_generative_art                              │ │
│  │  ├── create_data_visualization                          │ │
│  │  ├── apply_post_processing                              │ │
│  │  ├── setup_output                                       │ │
│  │  └── describe_project (natural language → plan)         │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  LAYER 2: Mid-Level Tools (network building blocks)     │ │
│  │  ├── create_node_chain (multiple connected nodes)       │ │
│  │  ├── connect_nodes                                      │ │
│  │  ├── create_glsl_shader                                 │ │
│  │  ├── create_python_script                               │ │
│  │  ├── set_parameters_batch                               │ │
│  │  ├── duplicate_network                                  │ │
│  │  └── create_container                                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  LAYER 3: Low-Level Tools (atomic ops, from 8beeeaaat)  │ │
│  │  ├── create_td_node                                     │ │
│  │  ├── delete_td_node                                     │ │
│  │  ├── update_td_node_parameters                          │ │
│  │  ├── get_td_nodes                                       │ │
│  │  ├── get_td_node_parameters                             │ │
│  │  ├── get_td_node_errors                                 │ │
│  │  ├── execute_python_script                              │ │
│  │  ├── exec_node_method                                   │ │
│  │  └── get_td_info                                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  KNOWLEDGE BASE (embedded, from bottobot + extensions)  │ │
│  │  ├── 630 operator docs (JSON)                           │ │
│  │  ├── 69 Python API classes                              │ │
│  │  ├── 32 workflow patterns + wiring guides               │ │
│  │  ├── 16 GLSL shader patterns                            │ │
│  │  ├── 14 tutorials                                       │ │
│  │  ├── Recipe library (composite network templates)       │ │
│  │  └── Version compatibility matrix                       │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  FEEDBACK ENGINE                                        │ │
│  │  ├── Error checker (post-creation validation)           │ │
│  │  ├── Network verifier (connections, cook status)        │ │
│  │  ├── Preview capture (render TOP → base64 thumbnail)    │ │
│  │  └── Performance monitor (cook time, GPU load)          │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────┬───────────────────────────────────────────────────┘
           │ HTTP REST + WebSocket
┌──────────▼───────────────────────────────────────────────────┐
│  TouchDesigner Bridge (.tox component)                       │
│  ├── WebServer DAT (REST API endpoints)                      │
│  ├── WebSocket DAT (events: errors, cook status, previews)   │
│  ├── Python extensions (route handlers + business logic)     │
│  ├── Preview renderer (Render TOP → base64 pipeline)         │
│  └── CHOP Execute DAT (event emitter for state changes)      │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. TECH STACK

### Server (Node.js)
- **Runtime:** Node.js >= 20 LTS
- **Language:** TypeScript 5.x, ESM modules
- **MCP SDK:** `@modelcontextprotocol/sdk` (latest)
- **Transport:** stdio (default) + HTTP/SSE (optional, for remote)
- **Validation:** Zod schemas for all tool inputs
- **HTTP Client:** Built-in `fetch` for TD communication
- **Linting:** Biome
- **Testing:** Vitest + MSW for mocking TD responses
- **Build:** `tsc` + `tsup` for distribution

### TouchDesigner Side (Python)
- **TD Version:** 2024+ (Python 3.11+)
- **Bridge:** WebServer DAT + WebSocket DAT
- **Format:** Ruff for lint/format
- **Distribution:** `.tox` component (drag-and-drop install)

### Package Distribution
- **npm:** `@tdmcp/server` (the MCP server)
- **GitHub Releases:** `.tox` file + `.dxt` extension for Claude Desktop
- **Docker:** Optional container for headless/remote setups

---

## 5. TOOL SPECIFICATIONS

### 5.1 Layer 1: High-Level Tools (Artist-Facing)

These are the tools artists interact with. Each one orchestrates multiple Layer 2/3 calls internally and validates the result.

#### `create_visual_system`
```typescript
{
  name: "create_visual_system",
  description: "Create a complete visual system from a natural language description. Supports generative art, audio-reactive visuals, data visualization, particle systems, feedback networks, and more. The system will be built as a self-contained COMP with proper inputs/outputs.",
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Natural language description of the visual system. Be as specific as you want. Examples: 'A particle system where particles are attracted to audio frequencies, with trails that fade based on amplitude' or 'Reaction diffusion simulation with controllable parameters, rendered in real-time at 1080p'"
      },
      parent_path: {
        type: "string",
        default: "/project1",
        description: "Where to create the system in the TD node hierarchy"
      },
      resolution: {
        type: "string",
        enum: ["720p", "1080p", "4K", "custom"],
        default: "1080p"
      },
      target_fps: {
        type: "number",
        default: 60,
        description: "Target frame rate — affects complexity decisions"
      }
    },
    required: ["description"]
  }
}
```

**Internal behavior:**
1. Parse description → identify system type (generative, audio-reactive, data-viz, etc.)
2. Consult knowledge base for best operator chains
3. Generate network plan (nodes + connections + parameters)
4. Execute plan via Layer 2/3 tools
5. Run error checker
6. If errors: auto-fix (retry with corrections, up to 3 attempts)
7. Capture preview thumbnail
8. Return: created node paths + preview + any warnings

#### `create_audio_reactive`
```typescript
{
  name: "create_audio_reactive",
  description: "Create an audio-reactive visual network. Analyzes audio input (mic, file, or Audio Device In CHOP) and maps frequency bands, amplitude, and beat detection to visual parameters.",
  inputSchema: {
    type: "object",
    properties: {
      audio_source: {
        type: "string",
        enum: ["microphone", "file", "device_in", "existing_chop"],
        default: "microphone"
      },
      audio_file_path: {
        type: "string",
        description: "Path to audio file (only if audio_source is 'file')"
      },
      existing_chop_path: {
        type: "string",
        description: "Path to existing CHOP (only if audio_source is 'existing_chop')"
      },
      visual_style: {
        type: "string",
        enum: ["geometric", "particle", "feedback", "glsl", "instancing"],
        description: "Visual rendering approach"
      },
      frequency_bands: {
        type: "number",
        default: 8,
        description: "Number of frequency analysis bands"
      },
      beat_detection: {
        type: "boolean",
        default: true
      },
      parent_path: {
        type: "string",
        default: "/project1"
      }
    },
    required: ["visual_style"]
  }
}
```

#### `create_feedback_network`
```typescript
{
  name: "create_feedback_network",
  description: "Create a feedback-based visual system where the output feeds back into the input with transformations (blur, displace, color shift, etc.). Classic technique for generative/evolving visuals.",
  inputSchema: {
    type: "object",
    properties: {
      seed_type: {
        type: "string",
        enum: ["noise", "shape", "image", "video", "webcam", "glsl"],
        default: "noise",
        description: "What feeds into the feedback loop initially"
      },
      transformations: {
        type: "array",
        items: {
          type: "string",
          enum: ["blur", "displace", "edge", "level", "hsv_adjust", "transform", "mirror", "tile", "luma_blur"]
        },
        default: ["blur", "displace", "level"],
        description: "Transformations applied each feedback iteration"
      },
      feedback_gain: {
        type: "number",
        default: 0.95,
        minimum: 0,
        maximum: 1,
        description: "How much of the previous frame carries over (0-1)"
      },
      parent_path: { type: "string", default: "/project1" }
    }
  }
}
```

#### `create_particle_system`
```typescript
{
  name: "create_particle_system",
  description: "Create a GPU-accelerated particle system with configurable emitters, forces, and rendering.",
  inputSchema: {
    type: "object",
    properties: {
      emitter_shape: {
        type: "string",
        enum: ["point", "line", "circle", "sphere", "mesh", "image"],
        default: "point"
      },
      particle_count: {
        type: "number",
        default: 10000,
        description: "Number of particles (affects performance)"
      },
      forces: {
        type: "array",
        items: {
          type: "string",
          enum: ["gravity", "noise", "attract", "repel", "vortex", "turbulence", "drag"]
        },
        default: ["noise", "gravity"]
      },
      render_style: {
        type: "string",
        enum: ["points", "sprites", "lines", "trails", "instanced_geo"],
        default: "sprites"
      },
      lifetime: { type: "number", default: 3, description: "Particle lifetime in seconds" },
      parent_path: { type: "string", default: "/project1" }
    }
  }
}
```

#### `create_generative_art`
```typescript
{
  name: "create_generative_art",
  description: "Create a generative art system — noise-driven, algorithmic, or simulation-based visuals that evolve over time.",
  inputSchema: {
    type: "object",
    properties: {
      technique: {
        type: "string",
        enum: [
          "noise_landscape",
          "reaction_diffusion",
          "strange_attractor",
          "l_system",
          "cellular_automata",
          "flow_field",
          "voronoi",
          "fractal",
          "custom_glsl"
        ],
        description: "Generative technique to use"
      },
      color_palette: {
        type: "string",
        description: "Color palette description (e.g., 'warm sunset tones', 'monochrome blue', 'neon cyberpunk')"
      },
      evolution_speed: {
        type: "number",
        default: 1.0,
        description: "How fast the generative system evolves (multiplier)"
      },
      custom_glsl_code: {
        type: "string",
        description: "Custom GLSL fragment shader code (only if technique is 'custom_glsl')"
      },
      parent_path: { type: "string", default: "/project1" }
    },
    required: ["technique"]
  }
}
```

#### `apply_post_processing`
```typescript
{
  name: "apply_post_processing",
  description: "Apply post-processing effects to an existing TOP chain.",
  inputSchema: {
    type: "object",
    properties: {
      source_path: {
        type: "string",
        description: "Path to the TOP node to post-process"
      },
      effects: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "bloom", "chromatic_aberration", "film_grain", "vignette",
            "color_grade", "sharpen", "blur", "edge_detect", "invert",
            "threshold", "posterize", "glitch", "rgb_split", "scanlines"
          ]
        },
        description: "Effects to apply in order"
      },
      parent_path: { type: "string", default: "/project1" }
    },
    required: ["source_path", "effects"]
  }
}
```

#### `setup_output`
```typescript
{
  name: "setup_output",
  description: "Configure output for the visual system — window, NDI stream, Syphon/Spout, or recording.",
  inputSchema: {
    type: "object",
    properties: {
      source_path: {
        type: "string",
        description: "Path to the final TOP to output"
      },
      output_type: {
        type: "string",
        enum: ["window", "ndi", "syphon_spout", "record", "touch_out"],
        default: "window"
      },
      resolution: { type: "string", enum: ["720p", "1080p", "4K"], default: "1080p" },
      record_format: {
        type: "string",
        enum: ["mp4", "mov", "image_sequence"],
        description: "Only for output_type 'record'"
      }
    },
    required: ["source_path"]
  }
}
```

#### `get_preview`
```typescript
{
  name: "get_preview",
  description: "Capture a preview thumbnail of any TOP node. Returns a base64-encoded image.",
  inputSchema: {
    type: "object",
    properties: {
      node_path: {
        type: "string",
        description: "Path to the TOP node to capture"
      },
      width: { type: "number", default: 640 },
      height: { type: "number", default: 360 }
    },
    required: ["node_path"]
  }
}
```

### 5.2 Layer 2: Mid-Level Tools

#### `create_node_chain`
```typescript
{
  name: "create_node_chain",
  description: "Create multiple nodes and connect them in sequence. Returns all created node paths.",
  inputSchema: {
    type: "object",
    properties: {
      parent_path: { type: "string" },
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", description: "Operator type (e.g., 'noiseTOP', 'feedbackTOP', 'blurTOP')" },
            name: { type: "string", description: "Custom name (optional, auto-generated if omitted)" },
            parameters: {
              type: "object",
              description: "Key-value parameter overrides"
            }
          },
          required: ["type"]
        }
      },
      connect_sequentially: {
        type: "boolean",
        default: true,
        description: "Wire output[0] → input[0] for each consecutive pair"
      }
    },
    required: ["parent_path", "nodes"]
  }
}
```

#### `connect_nodes`
```typescript
{
  name: "connect_nodes",
  description: "Connect two existing nodes by specifying source output and target input ports.",
  inputSchema: {
    type: "object",
    properties: {
      source_path: { type: "string" },
      target_path: { type: "string" },
      source_output: { type: "number", default: 0 },
      target_input: { type: "number", default: 0 }
    },
    required: ["source_path", "target_path"]
  }
}
```

#### `create_glsl_shader`
```typescript
{
  name: "create_glsl_shader",
  description: "Create a GLSL TOP with custom vertex/fragment shader code.",
  inputSchema: {
    type: "object",
    properties: {
      parent_path: { type: "string" },
      name: { type: "string" },
      fragment_shader: { type: "string", description: "GLSL fragment shader code" },
      vertex_shader: { type: "string", description: "GLSL vertex shader code (optional)" },
      uniforms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["float", "vec2", "vec3", "vec4", "int", "sampler2D"] },
            default_value: { type: "string" }
          }
        },
        description: "Custom uniform declarations"
      },
      resolution: { type: "string", enum: ["720p", "1080p", "4K", "input"], default: "input" }
    },
    required: ["parent_path", "fragment_shader"]
  }
}
```

### 5.3 Layer 3: Low-Level Tools

These wrap the 8beeeaaat primitives with added validation and knowledge-base awareness. Same interface as `touchdesigner-mcp-server` v1.4.x but with:
- Pre-call validation (does this operator type exist? are these parameters valid?)
- Post-call error checking
- Automatic retry on transient failures

Tool list (same as 8beeeaaat):
- `create_td_node`
- `delete_td_node`
- `update_td_node_parameters`
- `get_td_nodes`
- `get_td_node_parameters`
- `get_td_node_errors`
- `execute_python_script`
- `exec_node_method`
- `get_td_info`
- `get_td_class_details`
- `get_td_classes`
- `get_module_help`

---

## 6. KNOWLEDGE BASE (MCP Resources)

The server exposes TD knowledge as MCP **Resources** so the LLM can pull context on demand.

### Resource URIs:
```
tdmcp://operators/{category}           → list operators in category (CHOP, TOP, SOP, DAT, COMP, MAT, POP)
tdmcp://operators/{name}               → full operator doc (params, tips, examples, version)
tdmcp://python-api/{class_name}        → Python class docs (members, methods)
tdmcp://patterns/{pattern_name}        → workflow patterns (operator chains)
tdmcp://glsl/{pattern_name}            → GLSL shader code (16 named patterns)
tdmcp://recipes/{recipe_name}          → composite network templates
tdmcp://tutorials/{tutorial_name}      → tutorial content
tdmcp://version/{td_version}           → version compatibility info
```

### Data Sources:
- **Operators (630):** Sourced from `@bottobot/td-mcp` data files, enriched with wiring guides
- **Python API (69 classes, 1510+ methods):** Sourced from `@bottobot/td-mcp`
- **GLSL Patterns (16):** Sourced from `@bottobot/td-mcp` experimental techniques
- **Recipes (new):** Composite templates we author (see Section 8)
- **Workflow Patterns (32):** Sourced from `@bottobot/td-mcp` patterns.json

---

## 7. MCP PROMPTS

Prompts are pre-built instruction templates the LLM can invoke.

```typescript
const prompts = [
  {
    name: "visual_artist_mode",
    description: "Activate visual artist mode — the AI will think in terms of visual composition, color theory, motion, and aesthetics rather than code.",
    arguments: [
      { name: "style", description: "Artistic style (abstract, geometric, organic, glitch, minimal, maximal)", required: false }
    ]
  },
  {
    name: "debug_network",
    description: "Systematically debug a TD network — check errors, verify connections, inspect cook times, and suggest fixes.",
    arguments: [
      { name: "root_path", description: "Root path to debug from", required: true }
    ]
  },
  {
    name: "optimize_performance",
    description: "Analyze and optimize a TD network for performance — identify bottlenecks, suggest resolution changes, recommend cooking optimizations.",
    arguments: [
      { name: "root_path", description: "Root path to optimize", required: true }
    ]
  },
  {
    name: "explain_network",
    description: "Generate a human-readable explanation of what a TD network does, including data flow, key parameters, and artistic intent.",
    arguments: [
      { name: "root_path", description: "Root path to explain", required: true }
    ]
  },
  {
    name: "remix_visual",
    description: "Take an existing visual system and create variations — change colors, swap techniques, add effects, alter timing.",
    arguments: [
      { name: "source_path", description: "Path to the visual system to remix", required: true },
      { name: "remix_direction", description: "What to change (e.g., 'make it darker', 'add glitch', 'slow it down')", required: true }
    ]
  }
];
```

---

## 8. RECIPE LIBRARY

Recipes are pre-validated composite networks. Each recipe is a JSON file defining:

```typescript
interface Recipe {
  id: string;
  name: string;
  description: string;
  tags: string[];               // ["audio-reactive", "particle", "performance"]
  difficulty: "beginner" | "intermediate" | "advanced";
  td_version_min: string;       // "2023"
  nodes: RecipeNode[];
  connections: RecipeConnection[];
  parameters: RecipeParameter[];
  glsl_code?: Record<string, string>;  // node_name → shader code
  python_code?: Record<string, string>; // node_name → script
  preview_description: string;  // what it looks like when running
}
```

### Starter Recipes (implement these first):

1. **`audio_spectrum_bars`** — Audio In → Analyze → CHOP-to-SOP bars → Instanced render
2. **`feedback_tunnel`** — Noise seed → Feedback loop with transform + blur → Hypnotic tunnel
3. **`reaction_diffusion`** — GLSL-based Gray-Scott model → Post-process → Output
4. **`particle_galaxy`** — Sphere emitter → Turbulence + Gravity → Sprite render with trails
5. **`webcam_glitch`** — Video Device In → Edge detect → RGB split → Feedback → Glitch
6. **`noise_landscape`** — Noise TOP → TOP-to-SOP → Phong MAT → Camera orbit → Render
7. **`data_sonification`** — DAT input → CHOP analysis → Audio generation + Visual mapping
8. **`kinect_silhouette`** — Kinect Azure CHOP → Point cloud → Instanced particles following body
9. **`led_strip_mapper`** — Visual → Pixel sampling → Serial DAT output for LED control
10. **`projection_mapping`** — Multi-output with Stoner → Keystone correction → Edge blending

---

## 9. TD-SIDE BRIDGE (.tox)

### Endpoints the WebServer DAT must expose:

```python
# Standard CRUD (from 8beeeaaat, keep compatible)
POST   /api/nodes              # create node
DELETE /api/nodes/{path}       # delete node
GET    /api/nodes              # list nodes
GET    /api/nodes/{path}       # get node details
PATCH  /api/nodes/{path}       # update parameters
POST   /api/exec              # execute Python script
POST   /api/nodes/{path}/method # call node method
GET    /api/info               # server info

# NEW: Preview endpoints
GET    /api/preview/{path}     # capture TOP as base64 PNG
GET    /api/preview/{path}/stream  # WebSocket stream of frames

# NEW: Batch operations
POST   /api/batch              # execute multiple operations atomically
# Body: { operations: [{ action: "create"|"update"|"delete"|"connect", ... }] }

# NEW: Network analysis
GET    /api/network/{path}/errors    # recursive error check
GET    /api/network/{path}/topology  # connection graph
GET    /api/network/{path}/performance  # cook times, GPU usage
```

### WebSocket Events (TD → Server):
```python
# Event format: { "event": "...", "data": { ... } }
"node.error"        # { path, error_message, error_type }
"node.cook"         # { path, cook_time_ms }
"node.created"      # { path, type }
"node.deleted"      # { path }
"project.saved"     # { filename }
"timeline.frame"    # { frame, time, playing }
```

---

## 10. PROJECT STRUCTURE

```
tdmcp/
├── package.json
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── Dockerfile
├── docker-compose.yml
├── README.md
├── CONTRIBUTING.md
├── LICENSE
│
├── src/
│   ├── index.ts                          # entry point
│   ├── server/
│   │   ├── tdmcpServer.ts               # main MCP server class
│   │   ├── connectionManager.ts
│   │   └── transportFactory.ts
│   │
│   ├── tools/
│   │   ├── layer1/                       # high-level artist tools
│   │   │   ├── createVisualSystem.ts
│   │   │   ├── createAudioReactive.ts
│   │   │   ├── createFeedbackNetwork.ts
│   │   │   ├── createParticleSystem.ts
│   │   │   ├── createGenerativeArt.ts
│   │   │   ├── applyPostProcessing.ts
│   │   │   ├── setupOutput.ts
│   │   │   └── getPreview.ts
│   │   │
│   │   ├── layer2/                       # mid-level building blocks
│   │   │   ├── createNodeChain.ts
│   │   │   ├── connectNodes.ts
│   │   │   ├── createGlslShader.ts
│   │   │   ├── createPythonScript.ts
│   │   │   ├── setParametersBatch.ts
│   │   │   └── createContainer.ts
│   │   │
│   │   └── layer3/                       # low-level atomic ops
│   │       ├── createTdNode.ts
│   │       ├── deleteTdNode.ts
│   │       ├── updateTdNodeParameters.ts
│   │       ├── getTdNodes.ts
│   │       ├── getTdNodeParameters.ts
│   │       ├── getTdNodeErrors.ts
│   │       ├── executePythonScript.ts
│   │       ├── execNodeMethod.ts
│   │       └── getTdInfo.ts
│   │
│   ├── resources/                        # MCP resources (knowledge base)
│   │   ├── operatorResource.ts
│   │   ├── pythonApiResource.ts
│   │   ├── glslPatternResource.ts
│   │   ├── recipeResource.ts
│   │   └── tutorialResource.ts
│   │
│   ├── prompts/                          # MCP prompts
│   │   ├── visualArtistMode.ts
│   │   ├── debugNetwork.ts
│   │   ├── optimizePerformance.ts
│   │   ├── explainNetwork.ts
│   │   └── remixVisual.ts
│   │
│   ├── td-client/                        # HTTP client for TD communication
│   │   ├── touchDesignerClient.ts
│   │   ├── types.ts
│   │   └── validators.ts
│   │
│   ├── knowledge/                        # embedded knowledge base
│   │   ├── operators/                    # 630 operator JSON files
│   │   ├── python-api/                   # 69 Python class JSON files
│   │   ├── patterns/                     # workflow patterns
│   │   ├── glsl/                         # GLSL shader code
│   │   ├── recipes/                      # composite templates
│   │   └── index.ts                      # search + lookup engine
│   │
│   ├── feedback/                         # feedback engine
│   │   ├── errorChecker.ts
│   │   ├── networkVerifier.ts
│   │   ├── previewCapture.ts
│   │   └── performanceMonitor.ts
│   │
│   └── utils/
│       ├── logger.ts
│       ├── version.ts
│       └── config.ts
│
├── td/                                   # TouchDesigner-side code
│   ├── modules/
│   │   ├── mcp/
│   │   │   ├── controllers/
│   │   │   │   └── api_controller.py
│   │   │   └── services/
│   │   │       ├── api_service.py
│   │   │       ├── preview_service.py    # NEW: screenshot capture
│   │   │       ├── batch_service.py      # NEW: atomic batch ops
│   │   │       └── analysis_service.py   # NEW: network analysis
│   │   ├── td_server/                    # generated from OpenAPI
│   │   └── utils/
│   │       └── version.py
│   ├── templates/                        # Mustache templates for codegen
│   └── mcp_webserver_base.tox           # drag-and-drop component
│
├── recipes/                              # recipe JSON files
│   ├── audio_spectrum_bars.json
│   ├── feedback_tunnel.json
│   ├── reaction_diffusion.json
│   ├── particle_galaxy.json
│   ├── webcam_glitch.json
│   ├── noise_landscape.json
│   └── ...
│
├── tests/
│   ├── unit/
│   │   ├── tools/
│   │   ├── resources/
│   │   ├── knowledge/
│   │   └── feedback/
│   └── integration/
│       ├── layer1.test.ts
│       ├── layer2.test.ts
│       └── layer3.test.ts
│
└── scripts/
    ├── import-bottobot-data.ts           # import operator data from @bottobot/td-mcp
    ├── validate-recipes.ts               # validate recipe JSON files
    └── generate-td-handlers.ts           # codegen for TD-side Python
```

---

## 11. IMPLEMENTATION ORDER

### Phase 1: Foundation (Week 1)
1. Scaffold project (package.json, tsconfig, biome, vitest)
2. Implement Layer 3 tools (port from 8beeeaaat with added validation)
3. Implement TD client with connection management
4. Import bottobot knowledge base (script: `import-bottobot-data.ts`)
5. Basic MCP resources (operator lookup, Python API lookup)
6. Integration test: create a Noise TOP → Null TOP chain via MCP

### Phase 2: Building Blocks (Week 2)
7. Implement Layer 2 tools (create_node_chain, connect_nodes, create_glsl_shader)
8. Implement feedback engine (error checker, network verifier)
9. Implement preview capture (TD-side: render → base64 pipeline)
10. First 3 recipes (feedback_tunnel, noise_landscape, reaction_diffusion)

### Phase 3: Artist Tools (Week 3)
11. Implement `create_generative_art` (orchestrates Layer 2/3 + recipes)
12. Implement `create_feedback_network`
13. Implement `create_audio_reactive`
14. Implement `create_particle_system`
15. Implement `apply_post_processing`
16. Implement `setup_output`

### Phase 4: Polish (Week 4)
17. Implement all MCP prompts
18. Remaining recipes (7 more)
19. Implement `create_visual_system` (the universal entry point)
20. Performance monitor
21. Documentation (README, installation guide, recipe authoring guide)
22. Claude Desktop extension (.dxt)
23. npm publish + GitHub Release

---

## 12. DESIGN PRINCIPLES

1. **Artist-first:** Every tool name and parameter should make sense to someone who has never written code. No `noiseTOP` in Layer 1 — that's `technique: "noise_landscape"`.

2. **Fail forward:** If a node creation fails, the system should try to fix it automatically before reporting an error. Use `get_td_node_errors` after every creation.

3. **Knowledge-grounded:** Before creating any node, consult the knowledge base to verify operator name, valid parameters, and compatible connections. Never hallucinate an operator that doesn't exist.

4. **Preview everything:** After building any visual, capture a preview. The artist needs to *see* what was created, not just read a list of node paths.

5. **Composable:** High-level tools are built from mid-level tools, which are built from low-level tools. An advanced user can drop down to any level.

6. **Version-aware:** Check TD version before using operators or Python API that may not exist in the user's installation.

7. **Non-destructive:** Never delete nodes without explicit request. Always create in new containers. Support undo via snapshot/restore.

8. **Performance-conscious:** Include cook time estimates in tool descriptions. Warn when a configuration might cause low FPS.

---

## 13. CONTRIBUTION & COMMUNITY

### Recipe Contribution Format
Artists can contribute recipes as JSON files:
```bash
# Validate a recipe
npm run validate:recipe -- recipes/my_cool_effect.json

# Test a recipe against a running TD instance
npm run test:recipe -- recipes/my_cool_effect.json
```

### Community Goals
- Recipe gallery website (auto-generated from JSON files)
- Discord/GitHub Discussions for sharing creations
- Video tutorials showing AI → TD workflow
- Integration with popular VJ software (Resolume, MadMapper) via NDI/Spout output

---

## 14. GETTING STARTED (for the implementing agent)

```bash
# 1. Create the project
mkdir tdmcp && cd tdmcp
npm init -y

# 2. Install core dependencies
npm install @modelcontextprotocol/sdk zod
npm install -D typescript @types/node vitest @biomejs/biome tsup msw

# 3. Install bottobot for knowledge data extraction
npm install @bottobot/td-mcp

# 4. Initialize TypeScript
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir dist --strict true

# 5. Start building from Phase 1, Step 1
```

### Key References:
- **MCP SDK docs:** https://modelcontextprotocol.io/docs
- **8beeeaaat architecture:** https://github.com/8beeeaaat/touchdesigner-mcp/blob/main/docs/architecture.md
- **bottobot data format:** Each operator is a JSON file with fields: id, name, displayName, category, subcategory, description, parameters, tips, warnings, pythonExamples, codeExamples, version
- **TD Python API:** https://docs.derivative.ca/Python_Reference
- **TD Wiki:** https://docs.derivative.ca/Main_Page

---

## 15. SUCCESS CRITERIA

The project is "done" when an artist can say:

> "Create a 1080p audio-reactive particle system where bass frequencies control particle size, mids control color hue, and highs trigger particle bursts. Add a feedback loop with chromatic aberration and output to a window."

...and the AI agent builds the complete network in TouchDesigner, verifies it runs without errors, captures a preview, and returns a working visual system — all without the artist touching the TD interface.

---

*Built by the community, for artists who dream in visuals and speak in words.*
