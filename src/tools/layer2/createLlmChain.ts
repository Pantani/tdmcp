import { z } from "zod";
import { buildPayloadScript, parsePythonReport } from "../pythonReport.js";
import { errorResult, guardTd, jsonResult } from "../result.js";
import type { ToolContext, ToolRegistrar } from "../types.js";
import { precheckToxCandidates } from "../util/toxCandidatePrecheck.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const createLlmChainSchema = z
  .object({
    mode: z
      .enum(["webclient", "tox_drop"])
      .default("webclient")
      .describe(
        "webclient: stock chain via webclientDAT — no extra dependencies, works with any OpenAI-compatible endpoint. " +
          "tox_drop: drops the dotsimulate LLM LOPs .tox (requires the TOX installed locally).",
      ),
    parent_path: z.string().default("/project1").describe("COMP path to build inside."),
    name: z
      .string()
      .optional()
      .describe(
        "Inner baseCOMP name. Defaults to llm_<provider> (webclient) or llm_chain (tox_drop).",
      ),
    provider: z
      .enum(["openai", "anthropic", "ollama", "custom"])
      .default("ollama")
      .describe(
        "LLM provider. ollama default — works fully offline, no API key required. " +
          "custom requires endpoint_url and model.",
      ),
    endpoint_url: z
      .string()
      .optional()
      .describe(
        "Override the endpoint URL. Required for provider=custom. " +
          "Defaults: openai → https://api.openai.com/v1/chat/completions, " +
          "anthropic → https://api.anthropic.com/v1/messages, " +
          "ollama → http://127.0.0.1:11434/v1/chat/completions.",
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Model name. Required for provider=custom. " +
          "Defaults: openai → gpt-4o-mini, anthropic → claude-sonnet-4-5, ollama → llama3.2.",
      ),
    system_prompt: z
      .string()
      .default("You are a concise creative assistant for a TouchDesigner live show.")
      .describe("Written into a hidden sys textDAT."),
    initial_prompt: z.string().optional().describe("Seeds the Prompt textDAT on creation."),
    max_tokens: z
      .number()
      .int()
      .min(1)
      .max(8192)
      .default(512)
      .describe("Maximum tokens in the response."),
    temperature: z.number().min(0).max(2).default(0.7).describe("Sampling temperature [0–2]."),
    json_mode: z
      .boolean()
      .default(false)
      .describe(
        "Set response_format={type:json_object} for openai/ollama compatible endpoints. Ignored for anthropic.",
      ),
    auto_request: z
      .boolean()
      .default(false)
      .describe(
        "If true, a datExecuteDAT fires webclient.request() whenever the prompt textDAT changes. " +
          "Default false — caller drives.",
      ),
    tox_path: z
      .string()
      .optional()
      .describe(
        "Path to the dotsimulate LLM TOX. Required for mode=tox_drop. " +
          "Also probes Library/LLM.tox and tox/LLM.tox.",
      ),
    expose_controls: z
      .boolean()
      .default(true)
      .describe(
        "Surface Send (Pulse), Model, Temperature, MaxTokens, Active, JsonMode, Provider on the wrapper.",
      ),
  })
  .refine(
    (d) => d.provider !== "custom" || (d.endpoint_url !== undefined && d.model !== undefined),
    { message: "provider=custom requires both endpoint_url and model.", path: ["endpoint_url"] },
  )
  .refine((d) => d.mode !== "tox_drop" || d.tox_path !== undefined, {
    message: "mode=tox_drop requires tox_path pointing to the dotsimulate LLM .tox file.",
    path: ["tox_path"],
  });

type CreateLlmChainArgs = z.infer<typeof createLlmChainSchema>;

// ---------------------------------------------------------------------------
// Provider defaults
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS: Record<
  string,
  {
    endpoint: string;
    model: string;
    envVar: string | null;
    authHeader: string | null;
    authPrefix: string | null;
  }
> = {
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    envVar: "OPENAI_API_KEY",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-5",
    envVar: "ANTHROPIC_API_KEY",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  ollama: {
    endpoint: "http://127.0.0.1:11434/v1/chat/completions",
    model: "llama3.2",
    envVar: "OLLAMA_HOST",
    authHeader: null,
    authPrefix: null,
  },
  custom: {
    endpoint: "",
    model: "",
    envVar: null,
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
};

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

interface LlmChainReport {
  container_path: string;
  prompt_dat_path: string;
  response_dat_path: string;
  status_chan: string;
  mode: string;
  provider: string;
  model: string;
  endpoint_url: string;
  env_var_name: string | null;
  missing_env?: string;
  warnings: string[];
  fatal?: string;
}

// ---------------------------------------------------------------------------
// Python script
// ---------------------------------------------------------------------------

const LLM_CHAIN_SCRIPT = `
import json, base64, traceback, os
_p = json.loads(base64.b64decode("__PAYLOAD_B64__").decode("utf-8"))
report = {
    "container_path": "",
    "prompt_dat_path": "",
    "response_dat_path": "",
    "status_chan": "",
    "mode": _p["mode"],
    "provider": _p["provider"],
    "model": _p["model"],
    "endpoint_url": _p["endpoint_url"],
    "env_var_name": _p.get("env_var_name"),
    "warnings": [],
}
def _setpar(node, parname, val, label=""):
    pr = getattr(node.par, parname, None)
    if pr is None:
        report["warnings"].append("No par '%s' on %s (%s)" % (parname, node.type, label))
        return False
    try:
        pr.val = val
        return True
    except Exception as _e:
        report["warnings"].append("Could not set '%s' on %s: %s" % (parname, node.type, _e))
        return False

def _connect(src, dst, idx=0):
    try:
        dst.inputConnectors[idx].connect(src)
        return True
    except Exception as _e:
        report["warnings"].append("Could not connect %s -> %s: %s" % (src.name, dst.name, _e))
        return False

try:
    _parent = op(_p["parent_path"])
    if _parent is None:
        report["fatal"] = "Parent COMP not found: " + str(_p["parent_path"])
    else:
        _cname = _p.get("container_name") or ("llm_" + _p["provider"])
        _c = _parent.create(baseCOMP, _cname)
        report["container_path"] = _c.path

        # --- API key resolution (Python-only; never surfaces to TS) ---
        _env_name = _p.get("env_var_name")
        _api_key = os.environ.get(_env_name, "") if _env_name else ""
        _is_ollama = _p["provider"] == "ollama"
        _missing = bool(_env_name) and not _is_ollama and not _api_key
        if _missing:
            report["missing_env"] = _env_name

        if _p["mode"] == "webclient":
            # sys textDAT
            _sys = _c.create(textDAT, "sys")
            _sys.text = _p["system_prompt"]

            # prompt textDAT
            _prompt = _c.create(textDAT, "prompt")
            if _p.get("initial_prompt"):
                _prompt.text = _p["initial_prompt"]
            report["prompt_dat_path"] = _prompt.path

            # response textDAT
            _resp = _c.create(textDAT, "response")
            report["response_dat_path"] = _resp.path

            # headers tableDAT
            _headers = _c.create(tableDAT, "headers")
            _headers.clear()
            _headers.appendRow(["Content-Type", "application/json"])
            _auth_header = _p.get("auth_header_name")
            _auth_prefix = _p.get("auth_header_prefix") or ""
            _anthropic_ver = _p.get("anthropic_version_header")
            if _auth_header and _api_key:
                _headers.appendRow([_auth_header, _auth_prefix + _api_key])
            elif _auth_header and not _api_key and not _is_ollama:
                # key missing — insert a placeholder row so the table structure is correct
                _headers.appendRow([_auth_header, "MISSING_KEY_set_env_" + (_env_name or "")])
            if _anthropic_ver:
                _headers.appendRow(["anthropic-version", _anthropic_ver])

            # body_builder textDAT (model, temperature, max_tokens baked in)
            _provider = _p["provider"]
            _model = _p["model"]
            _temp = _p["temperature"]
            _max_tok = _p["max_tokens"]
            _json_mode = _p["json_mode"]
            if _provider == "anthropic":
                _body_code = (
                    "import json\\n"
                    "def build():\\n"
                    "    return json.dumps({\\n"
                    "        'model': '" + _model + "',\\n"
                    "        'max_tokens': " + str(_max_tok) + ",\\n"
                    "        'temperature': " + str(_temp) + ",\\n"
                    "        'system': op('sys').text,\\n"
                    "        'messages': [{'role':'user','content': op('prompt').text}],\\n"
                    "    })\\n"
                )
            else:
                _jm_line = (
                    "        'response_format': {'type':'json_object'},\\n" if _json_mode else ""
                )
                _body_code = (
                    "import json\\n"
                    "def build():\\n"
                    "    return json.dumps({\\n"
                    "        'model': '" + _model + "',\\n"
                    "        'max_tokens': " + str(_max_tok) + ",\\n"
                    "        'temperature': " + str(_temp) + ",\\n"
                    + _jm_line +
                    "        'messages': [\\n"
                    "            {'role':'system','content': op('sys').text},\\n"
                    "            {'role':'user','content': op('prompt').text},\\n"
                    "        ],\\n"
                    "    })\\n"
                )
            _bb = _c.create(textDAT, "body_builder")
            _bb.text = _body_code

            # webclientDAT
            _client = _c.create(webclientDAT, "client")
            _setpar(_client, "requestmethod", "post", "request method")
            _setpar(_client, "url", _p["endpoint_url"], "url")
            # Headers DAT par: probe both known names
            for _hpar in ("headersdat", "requestheadersdat", "Headers"):
                _hpr = getattr(_client.par, _hpar, None)
                if _hpr is not None:
                    try:
                        _hpr.val = "headers"
                        break
                    except Exception:
                        pass
            else:
                report["warnings"].append("Could not set headers DAT par on webclientDAT (UNVERIFIED par name)")
            # Request data DAT par
            for _dpar in ("requestdatadat", "requestdat", "Data"):
                _dpr = getattr(_client.par, _dpar, None)
                if _dpr is not None:
                    try:
                        _dpr.val = "body_builder"
                        break
                    except Exception:
                        pass
            else:
                report["warnings"].append("Could not set request data DAT par on webclientDAT (UNVERIFIED par name)")
            _setpar(_client, "asynchronous", 1, "async")

            # callbacks datExecuteDAT
            _callbacks_code = (
                "# LLM Chain callbacks\\n"
                "def onResponse(dat, statusCode, headerDict, data, id):\\n"
                "    try:\\n"
                "        import json as _j\\n"
                "        body = _j.loads(data) if isinstance(data, (str, bytes)) else data\\n"
                "        provider = op('..').store('llm_provider', None) or '" + _provider + "'\\n"
                "        if '" + _provider + "' == 'anthropic':\\n"
                "            text = body.get('content', [{}])[0].get('text', '')\\n"
                "        else:\\n"
                "            text = body.get('choices', [{}])[0].get('message', {}).get('content', '')\\n"
                "        op('response').text = str(text)\\n"
                "    except Exception as _e:\\n"
                "        op('response').text = 'parse error: ' + str(_e) + ' | raw: ' + str(data)[:500]\\n"
                "    _s = op('status')\\n"
                "    if _s is not None:\\n"
                "        try: _s.par.value0.val = 0\\n"
                "        except Exception: pass\\n"
                "def onSendStart(dat, id):\\n"
                "    _s = op('status')\\n"
                "    if _s is not None:\\n"
                "        try: _s.par.value0.val = 1\\n"
                "        except Exception: pass\\n"
            )
            _cb = _c.create(datexecuteDAT, "callbacks")
            _cb.text = _callbacks_code
            for _cbpar in ("callbacks", "callbackdat"):
                _cpr = getattr(_client.par, _cbpar, None)
                if _cpr is not None:
                    try:
                        _cpr.val = "callbacks"
                        break
                    except Exception:
                        pass

            # status constantCHOP
            _status = _c.create(constantCHOP, "status")
            _setpar(_status, "name0", "busy", "status channel name")
            _setpar(_status, "value0", 0, "initial busy value")
            _status_out = _c.create(nullCHOP, "status_out")
            _connect(_status, _status_out)
            report["status_chan"] = _status_out.path + ":busy"

            # auto_request: datExecuteDAT that fires on prompt change
            if _p.get("auto_request"):
                _ae_code = (
                    "def onTableChange(dat):\\n"
                    "    op('client').request()\\n"
                    "def onCellChange(dat, cells, prev):\\n"
                    "    op('client').request()\\n"
                )
                _ae = _c.create(datExecuteDAT, "send_trigger")
                _ae.text = _ae_code
                _setpar(_ae, "dat", "prompt", "trigger dat")

            # expose_controls: custom parameters on the wrapper baseCOMP
            if _p.get("expose_controls"):
                try:
                    _pg = _c.appendCustomPage("LLM Chain")
                    _pg.appendPulse("Send", label="Send")
                    _pg.appendStr("Model", label="Model")[0].default = _model
                    _pg.appendFloat("Temperature", label="Temperature")[0].default = _temp
                    _pg.appendInt("Maxtokens", label="Max Tokens")[0].default = _max_tok
                    _pg.appendToggle("Active", label="Active")[0].default = True
                    _pg.appendToggle("Jsonmode", label="JSON Mode")[0].default = _json_mode
                    _pg.appendStr("Provider", label="Provider")[0].default = _provider
                except Exception as _e:
                    report["warnings"].append("Custom pars failed: " + str(_e))

        else:
            # tox_drop mode
            _candidates = _p.get("candidate_paths") or []
            _tox_path = None
            for _cp in _candidates:
                if _cp:
                    _tox_path = _cp
                    break
            if _tox_path is None:
                report["fatal"] = "tox_drop: no tox_path resolved from candidates " + str(_candidates)
            else:
                try:
                    _llm = _c.copy(op(_tox_path), name="llm")
                    if _llm is None:
                        # try dropFile
                        _llm = _c.create(baseCOMP, "llm")
                        report["warnings"].append("Could not copy TOX operator; created empty container instead.")
                except Exception as _te:
                    _llm = _c.create(baseCOMP, "llm")
                    report["warnings"].append("TOX drop failed (%s); created empty container." % str(_te))

                _expected_pars = _p.get("expected_custom_pars") or ["Prompt", "Response", "Model", "Apikey"]
                for _epar in _expected_pars:
                    _pr = getattr(_llm.par, _epar, None)
                    if _pr is None:
                        report["warnings"].append("TOX par '%s' not found (on_missing=warn)." % _epar)
                    elif _epar == "Apikey" and _api_key:
                        try:
                            _pr.val = _api_key
                        except Exception:
                            report["warnings"].append("Could not set Apikey par on TOX.")

                # mirror DATs — evaluateDAT that references TOX pars
                _prompt_mirror = _c.create(textDAT, "prompt")
                _prompt_mirror.text = "# prompt mirror\\n"
                _resp_mirror = _c.create(textDAT, "response")
                _resp_mirror.text = "# response mirror\\n"
                report["prompt_dat_path"] = _prompt_mirror.path
                report["response_dat_path"] = _resp_mirror.path

                # status_out Null CHOP placeholder
                _status = _c.create(constantCHOP, "status")
                _setpar(_status, "name0", "busy", "status channel name")
                _status_out = _c.create(nullCHOP, "status_out")
                _connect(_status, _status_out)
                report["status_chan"] = _status_out.path + ":busy"

except Exception:
    report["fatal"] = traceback.format_exc().splitlines()[-1]
print(json.dumps(report))
`;

// ---------------------------------------------------------------------------
// Exported script builder (for tests)
// ---------------------------------------------------------------------------

export function buildLlmChainScript(payload: object): string {
  return buildPayloadScript(LLM_CHAIN_SCRIPT, payload);
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------

export async function createLlmChainImpl(ctx: ToolContext, args: CreateLlmChainArgs) {
  // Round-2 Wave-4 fix: in tox_drop mode, short-circuit BEFORE the bridge
  // round-trip when every candidate is absolute and missing on disk.
  // Only include the explicit tox_path (absolute) — project-relative paths
  // cannot be pre-checked TS-side and would bypass the short-circuit.
  if (args.mode === "tox_drop") {
    const candidates = [args.tox_path].filter((p): p is string => Boolean(p));
    if (candidates.length > 0) {
      const precheck = precheckToxCandidates(candidates);
      if (precheck.allAbsoluteAndMissing) {
        return errorResult(
          `LLM TOX not found on disk. Tried: ${precheck.absoluteChecked.join(", ")}. ` +
            "Install the dotsimulate LLM TOX or pass an explicit tox_path pointing to an existing file.",
        );
      }
    }
  }

  return guardTd(
    async () => {
      const provider = args.provider;
      const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.custom;
      const endpointUrl = args.endpoint_url ?? defaults?.endpoint ?? "";
      const model = args.model ?? defaults?.model ?? "";
      const containerName =
        args.name ?? (args.mode === "tox_drop" ? "llm_chain" : `llm_${provider}`);

      const payload: Record<string, unknown> = {
        mode: args.mode,
        parent_path: args.parent_path,
        container_name: containerName,
        provider,
        endpoint_url: endpointUrl,
        model,
        system_prompt: args.system_prompt,
        initial_prompt: args.initial_prompt ?? null,
        max_tokens: args.max_tokens,
        temperature: args.temperature,
        json_mode: args.json_mode,
        auto_request: args.auto_request,
        expose_controls: args.expose_controls,
        env_var_name: defaults?.envVar ?? null,
        auth_header_name: defaults?.authHeader ?? null,
        auth_header_prefix: defaults?.authPrefix ?? null,
        anthropic_version_header: provider === "anthropic" ? "2023-06-01" : null,
        candidate_paths: [args.tox_path ?? null],
        expected_custom_pars: ["Prompt", "Response", "Model", "Apikey"],
      };

      const script = buildLlmChainScript(payload);
      const exec = await ctx.client.executePythonScript(script, true);
      return parsePythonReport<LlmChainReport>(exec.stdout);
    },
    (report) => {
      if (report.fatal) {
        return errorResult(`LLM chain build failed: ${report.fatal}`, report);
      }

      const warnings = [...(report.warnings ?? [])];
      if (report.missing_env) {
        warnings.push(
          `API key not found: export ${report.missing_env}=<key> and restart TouchDesigner.`,
        );
      }

      const warnNote = warnings.length > 0 ? `, ${warnings.length} warning(s)` : "";
      const summary =
        `Built LLM chain [${report.mode}/${report.provider}] → ${report.container_path} ` +
        `(model: ${report.model}, endpoint: ${report.endpoint_url})${warnNote}.`;

      return jsonResult(summary, {
        container_path: report.container_path,
        prompt_dat_path: report.prompt_dat_path,
        response_dat_path: report.response_dat_path,
        status_chan: report.status_chan,
        mode: report.mode,
        provider: report.provider,
        model: report.model,
        endpoint_url: report.endpoint_url,
        env_var_name: report.env_var_name,
        missing_env: report.missing_env,
        warnings,
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export const registerCreateLlmChain: ToolRegistrar = (server, ctx) => {
  server.registerTool(
    "create_llm_chain",
    {
      title: "Create LLM chain",
      description:
        "Stand up a prompt → response LLM chain inside TouchDesigner as a self-contained baseCOMP. " +
        "Two modes: webclient — stock chain using webclientDAT + textDATs + headers tableDAT that POSTs " +
        "JSON to any OpenAI-compatible endpoint (OpenAI, Anthropic, Ollama, llama.cpp, LM Studio, OpenRouter). " +
        "tox_drop — drops the dotsimulate LLM LOPs .tox and wires mirror DATs. " +
        "Default provider=ollama (fully offline, no key). API keys are read from env inside TouchDesigner " +
        "(os.environ) and written into a headers tableDAT — the MCP server never sees them. " +
        "Returns container_path, prompt_dat_path, response_dat_path, status_chan (:busy), " +
        "provider, model, endpoint_url, and missing_env when a key is needed but unset. " +
        "PROBE-FIRST risks: webclientDAT par names (headersdat/requestdatadat) vary by TD build — " +
        "resolved defensively; Anthropic uses x-api-key header + anthropic-version, not Authorization; " +
        "Ollama requires ollama serve running on 127.0.0.1:11434; dotsimulate TOX par names are UNVERIFIED.",
      inputSchema: createLlmChainSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) => createLlmChainImpl(ctx, args),
  );
};
