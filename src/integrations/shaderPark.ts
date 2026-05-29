export interface ShaderParkUniform {
  name: string;
  type: string;
  value: number | number[];
}

export interface ShaderParkTouchDesignerSource {
  pixelShader: string;
  vertexShader?: string;
  uniforms: ShaderParkUniform[];
}

interface ShaderParkCoreModule {
  sculptToTouchDesignerShaderSource: (code: string) => unknown;
}

interface RawShaderParkCompileResult {
  frag?: unknown;
  vert?: unknown;
  uniforms?: unknown;
  error?: unknown;
}

let shaderParkCorePromise: Promise<ShaderParkCoreModule> | undefined;
// shader-park-core writes during module evaluation; serialize stream suppression
// so nested import attempts restore the original writers in order.
let shaderParkImportOutputMutex = Promise.resolve();

type StreamWriteCallback = (error?: Error | null) => void;

function suppressStreamWrite(...args: unknown[]): boolean {
  const callback = args.find((arg): arg is StreamWriteCallback => typeof arg === "function");
  if (callback) queueMicrotask(() => callback());
  return true;
}

async function withSuppressedImportOutput<T>(operation: () => Promise<T>): Promise<T> {
  const previousImport = shaderParkImportOutputMutex;
  let releaseImport!: () => void;
  shaderParkImportOutputMutex = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });

  await previousImport;

  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  try {
    process.stdout.write = suppressStreamWrite as typeof process.stdout.write;
    process.stderr.write = suppressStreamWrite as typeof process.stderr.write;
    return await operation();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    releaseImport();
  }
}

async function loadShaderParkCore(): Promise<ShaderParkCoreModule> {
  if (!shaderParkCorePromise) {
    const importPromise = withSuppressedImportOutput(
      async () => (await import("shader-park-core")) as unknown as ShaderParkCoreModule,
    );
    const retryablePromise = importPromise.catch((error) => {
      if (shaderParkCorePromise === retryablePromise) shaderParkCorePromise = undefined;
      throw error;
    });
    shaderParkCorePromise = retryablePromise;
  }
  return shaderParkCorePromise;
}

function isUniform(value: unknown): value is ShaderParkUniform {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const uniformValue = record.value;
  return (
    typeof record.name === "string" &&
    typeof record.type === "string" &&
    (typeof uniformValue === "number" ||
      (Array.isArray(uniformValue) && uniformValue.every((part) => typeof part === "number")))
  );
}

function formatCompilerError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export async function compileShaderParkToTouchDesigner(
  code: string,
): Promise<ShaderParkTouchDesignerSource> {
  const core = await loadShaderParkCore();
  let raw: RawShaderParkCompileResult;
  try {
    raw = core.sculptToTouchDesignerShaderSource(code) as RawShaderParkCompileResult;
  } catch (error) {
    throw new Error(`Shader Park compile failed: ${formatCompilerError(error)}`);
  }

  if (raw.error) {
    throw new Error(`Shader Park compile failed: ${formatCompilerError(raw.error)}`);
  }
  if (typeof raw.frag !== "string" || raw.frag.trim() === "") {
    throw new Error("Shader Park compile failed: missing TouchDesigner pixel shader output.");
  }
  if (!Array.isArray(raw.uniforms) || !raw.uniforms.every(isUniform)) {
    throw new Error("Shader Park compile failed: invalid uniform metadata.");
  }

  return {
    pixelShader: raw.frag,
    vertexShader: typeof raw.vert === "string" && raw.vert.trim() !== "" ? raw.vert : undefined,
    uniforms: raw.uniforms,
  };
}
