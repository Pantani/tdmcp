import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capturePreview } from "../feedback/previewCapture.js";
import { buildToolContext } from "../server/context.js";
import { type TdEventHandler, TdEventStream } from "../td-client/eventStream.js";
import { friendlyTdError } from "../td-client/types.js";
import {
  applyPostProcessingImpl,
  applyPostProcessingSchema,
} from "../tools/layer1/applyPostProcessing.js";
import { applyRecipeImpl, applyRecipeSchema } from "../tools/layer1/applyRecipe.js";
import {
  create3dAudioReactiveImpl,
  create3dAudioReactiveSchema,
} from "../tools/layer1/create3dAudioReactive.js";
import { create3dSceneImpl, create3dSceneSchema } from "../tools/layer1/create3dScene.js";
import {
  createAudioReactiveImpl,
  createAudioReactiveSchema,
} from "../tools/layer1/createAudioReactive.js";
import { createAutopilotImpl, createAutopilotSchema } from "../tools/layer1/createAutopilot.js";
import {
  createBodyReactiveImpl,
  createBodyReactiveSchema,
} from "../tools/layer1/createBodyReactive.js";
import { createColorGradeImpl, createColorGradeSchema } from "../tools/layer1/createColorGrade.js";
import {
  createCubemapDomeImpl,
  createCubemapDomeSchema,
} from "../tools/layer1/createCubemapDome.js";
import { createDatamoshImpl, createDatamoshSchema } from "../tools/layer1/createDatamosh.js";
import {
  createDataVisualizationImpl,
  createDataVisualizationSchema,
} from "../tools/layer1/createDataVisualization.js";
import {
  createDepthDisplacementImpl,
  createDepthDisplacementSchema,
} from "../tools/layer1/createDepthDisplacement.js";
import {
  createDepthSilhouetteImpl,
  createDepthSilhouetteSchema,
} from "../tools/layer1/createDepthSilhouette.js";
import {
  createDisplacementWarpImpl,
  createDisplacementWarpSchema,
} from "../tools/layer1/createDisplacementWarp.js";
import { createDomeOutputImpl, createDomeOutputSchema } from "../tools/layer1/createDomeOutput.js";
import {
  createFeedbackNetworkImpl,
  createFeedbackNetworkSchema,
} from "../tools/layer1/createFeedbackNetwork.js";
import {
  createFeedbackTunnelImpl,
  createFeedbackTunnelSchema,
} from "../tools/layer1/createFeedbackTunnel.js";
import {
  createGenerativeArtImpl,
  createGenerativeArtSchema,
} from "../tools/layer1/createGenerativeArt.js";
import {
  createGenerativeAudioImpl,
  createGenerativeAudioSchema,
} from "../tools/layer1/createGenerativeAudio.js";
import { createGlitchImpl, createGlitchSchema } from "../tools/layer1/createGlitch.js";
import {
  createGpuParticleFieldImpl,
  createGpuParticleFieldSchema,
} from "../tools/layer1/createGpuParticleField.js";
import { createHalftoneImpl, createHalftoneSchema } from "../tools/layer1/createHalftone.js";
import {
  createKaleidoscopeImpl,
  createKaleidoscopeSchema,
} from "../tools/layer1/createKaleidoscope.js";
import { createKeyerImpl, createKeyerSchema } from "../tools/layer1/createKeyer.js";
import {
  createKeyframeAnimationImpl,
  createKeyframeAnimationSchema,
} from "../tools/layer1/createKeyframeAnimation.js";
import {
  createKineticTextImpl,
  createKineticTextSchema,
} from "../tools/layer1/createKineticText.js";
import { createLayerMixerImpl, createLayerMixerSchema } from "../tools/layer1/createLayerMixer.js";
import { createLayerStackImpl, createLayerStackSchema } from "../tools/layer1/createLayerStack.js";
import { createLiveSourceImpl, createLiveSourceSchema } from "../tools/layer1/createLiveSource.js";
import { createMediaBinImpl, createMediaBinSchema } from "../tools/layer1/createMediaBin.js";
import { createMeshWarpImpl, createMeshWarpSchema } from "../tools/layer1/createMeshWarp.js";
import {
  createMidiNoteReactiveImpl,
  createMidiNoteReactiveSchema,
} from "../tools/layer1/createMidiNoteReactive.js";
import {
  createMotionReactiveImpl,
  createMotionReactiveSchema,
} from "../tools/layer1/createMotionReactive.js";
import {
  createMultiOutputImpl,
  createMultiOutputSchema,
} from "../tools/layer1/createMultiOutput.js";
import {
  multipass3dDepthImpl,
  multipass3dDepthSchema,
} from "../tools/layer1/createMultipass3dDepth.js";
import {
  createParticleFlockImpl,
  createParticleFlockSchema,
} from "../tools/layer1/createParticleFlock.js";
import {
  createParticleSystemImpl,
  createParticleSystemSchema,
} from "../tools/layer1/createParticleSystem.js";
import { createPbrSceneImpl, createPbrSceneSchema } from "../tools/layer1/createPbrScene.js";
import { createPointCloudImpl, createPointCloudSchema } from "../tools/layer1/createPointCloud.js";
import { createPopFieldImpl, createPopFieldSchema } from "../tools/layer1/createPopField.js";
import {
  createPoseSkeletonImpl,
  createPoseSkeletonSchema,
} from "../tools/layer1/createPoseSkeleton.js";
import {
  createPoseTrackingImpl,
  createPoseTrackingSchema,
} from "../tools/layer1/createPoseTracking.js";
import {
  createProjectionMappingImpl,
  createProjectionMappingSchema,
} from "../tools/layer1/createProjectionMapping.js";
import {
  createRaymarchSceneImpl,
  createRaymarchSceneSchema,
} from "../tools/layer1/createRaymarchScene.js";
import {
  createSetNavigatorImpl,
  createSetNavigatorSchema,
} from "../tools/layer1/createSetNavigator.js";
import { createShaderLibImpl, createShaderLibSchema } from "../tools/layer1/createShaderLib.js";
import { createSimulationImpl, createSimulationSchema } from "../tools/layer1/createSimulation.js";
import { createSpectrumImpl, createSpectrumSchema } from "../tools/layer1/createSpectrum.js";
import { createStrobeImpl, createStrobeSchema } from "../tools/layer1/createStrobe.js";
import {
  createSyncExternalClockImpl,
  createSyncExternalClockSchema,
} from "../tools/layer1/createSyncExternalClock.js";
import { createTempoSyncImpl, createTempoSyncSchema } from "../tools/layer1/createTempoSync.js";
import { createText3dImpl, createText3dSchema } from "../tools/layer1/createText3d.js";
import {
  createTextOverlayImpl,
  createTextOverlaySchema,
} from "../tools/layer1/createTextOverlay.js";
import { createTransitionImpl, createTransitionSchema } from "../tools/layer1/createTransition.js";
import {
  createVideoPlayerImpl,
  createVideoPlayerSchema,
} from "../tools/layer1/createVideoPlayer.js";
import { createVideoSynthImpl, createVideoSynthSchema } from "../tools/layer1/createVideoSynth.js";
import {
  createVisualSystemImpl,
  createVisualSystemSchema,
} from "../tools/layer1/createVisualSystem.js";
import { createWaveformImpl, createWaveformSchema } from "../tools/layer1/createWaveform.js";
import { describeProjectImpl, describeProjectSchema } from "../tools/layer1/describeProject.js";
import { detectOnsetsImpl, detectOnsetsSchema } from "../tools/layer1/detectOnsets.js";
import { detectPitchImpl, detectPitchSchema } from "../tools/layer1/detectPitch.js";
import { detectTempoImpl, detectTempoSchema } from "../tools/layer1/detectTempo.js";
import {
  extractAudioFeaturesImpl,
  extractAudioFeaturesSchema,
} from "../tools/layer1/extractAudioFeatures.js";
import { getPreviewSchema } from "../tools/layer1/getPreview.js";
import { importModelImpl, importModelSchema } from "../tools/layer1/importModel.js";
import { listRecipesImpl, listRecipesSchema } from "../tools/layer1/listRecipes.js";
import { scaffoldGenreImpl, scaffoldGenreSchema } from "../tools/layer1/scaffoldGenre.js";
import { scaffoldShowImpl, scaffoldShowSchema } from "../tools/layer1/scaffoldShow.js";
import {
  setupBodyTrackingImpl,
  setupBodyTrackingSchema,
} from "../tools/layer1/setupBodyTracking.js";
import { setupOutputImpl, setupOutputSchema } from "../tools/layer1/setupOutput.js";
import {
  addCustomParametersImpl,
  addCustomParametersSchema,
} from "../tools/layer2/addCustomParameters.js";
import { animateParameterImpl, animateParameterSchema } from "../tools/layer2/animateParameter.js";
import { arrangeNetworkImpl, arrangeNetworkSchema } from "../tools/layer2/arrangeNetwork.js";
import { batchOperationsImpl, batchOperationsSchema } from "../tools/layer2/batchOperations.js";
import {
  bindAudioReactiveImpl,
  bindAudioReactiveSchema,
} from "../tools/layer2/bindAudioReactive.js";
import { bindToChannelImpl, bindToChannelSchema } from "../tools/layer2/bindToChannel.js";
import { connectNodesImpl, connectNodesSchema } from "../tools/layer2/connectNodes.js";
import {
  createBeatGridSequencerImpl,
  createBeatGridSequencerSchema,
} from "../tools/layer2/createBeatGridSequencer.js";
import {
  createClipLauncherImpl,
  createClipLauncherSchema,
} from "../tools/layer2/createClipLauncher.js";
import { createContainerImpl, createContainerSchema } from "../tools/layer2/createContainer.js";
import {
  createControlPanelImpl,
  createControlPanelSchema,
} from "../tools/layer2/createControlPanel.js";
import {
  createControlSurfaceImpl,
  createControlSurfaceSchema,
} from "../tools/layer2/createControlSurface.js";
import {
  createCueSequencerImpl,
  createCueSequencerSchema,
} from "../tools/layer2/createCueSequencer.js";
import {
  createDataReactiveImpl,
  createDataReactiveSchema,
} from "../tools/layer2/createDataReactive.js";
import { createDataSourceImpl, createDataSourceSchema } from "../tools/layer2/createDataSource.js";
import { createDecksImpl, createDecksSchema } from "../tools/layer2/createDecks.js";
import {
  createEnvelopeFollowerImpl,
  createEnvelopeFollowerSchema,
} from "../tools/layer2/createEnvelopeFollower.js";
import { createExternalIoImpl, createExternalIoSchema } from "../tools/layer2/createExternalIo.js";
import { createGlslShaderImpl, createGlslShaderSchema } from "../tools/layer2/createGlslShader.js";
import { createLedMapperImpl, createLedMapperSchema } from "../tools/layer2/createLedMapper.js";
import { createMacroImpl, createMacroSchema } from "../tools/layer2/createMacro.js";
import { createMidiMapImpl, createMidiMapSchema } from "../tools/layer2/createMidiMap.js";
import { createNodeChainImpl, createNodeChainSchema } from "../tools/layer2/createNodeChain.js";
import { createPaletteImpl, createPaletteSchema } from "../tools/layer2/createPalette.js";
import { createPanicImpl, createPanicSchema } from "../tools/layer2/createPanic.js";
import {
  createPhoneRemoteImpl,
  createPhoneRemoteSchema,
} from "../tools/layer2/createPhoneRemote.js";
import {
  createPythonScriptImpl,
  createPythonScriptSchema,
} from "../tools/layer2/createPythonScript.js";
import { createReplicatorImpl, createReplicatorSchema } from "../tools/layer2/createReplicator.js";
import {
  createStageDashboardImpl,
  createStageDashboardSchema,
} from "../tools/layer2/createStageDashboard.js";
import { duplicateNetworkImpl, duplicateNetworkSchema } from "../tools/layer2/duplicateNetwork.js";
import { learnControlImpl, learnControlSchema } from "../tools/layer2/learnControl.js";
import { manageAnnotationImpl, manageAnnotationSchema } from "../tools/layer2/manageAnnotation.js";
import { manageCheckpointImpl, manageCheckpointSchema } from "../tools/layer2/manageCheckpoint.js";
import { manageComponentImpl, manageComponentSchema } from "../tools/layer2/manageComponent.js";
import { manageCueImpl, manageCueSchema } from "../tools/layer2/manageCue.js";
import { managePresetsImpl, managePresetsSchema } from "../tools/layer2/managePresets.js";
import {
  randomizeControlsImpl,
  randomizeControlsSchema,
} from "../tools/layer2/randomizeControls.js";
import { rebuildNetworkImpl, rebuildNetworkSchema } from "../tools/layer2/rebuildNetwork.js";
import {
  scaffoldExtensionImpl,
  scaffoldExtensionSchema,
} from "../tools/layer2/scaffoldExtension.js";
import {
  setParametersBatchImpl,
  setParametersBatchSchema,
} from "../tools/layer2/setParametersBatch.js";
import { setPerformModeImpl, setPerformModeSchema } from "../tools/layer2/setPerformMode.js";
import { analyzeProjectImpl, analyzeProjectSchema } from "../tools/layer3/analyzeProject.js";
import { compareTdNodesImpl, compareTdNodesSchema } from "../tools/layer3/compareTdNodes.js";
import { createTdNodeImpl, createTdNodeSchema } from "../tools/layer3/createTdNode.js";
import { deleteTdNodeImpl, deleteTdNodeSchema } from "../tools/layer3/deleteTdNode.js";
import { diffSnapshotsImpl, diffSnapshotsSchema } from "../tools/layer3/diffSnapshots.js";
import { disconnectNodesImpl, disconnectNodesSchema } from "../tools/layer3/disconnectNodes.js";
import { documentNetworkImpl, documentNetworkSchema } from "../tools/layer3/documentNetwork.js";
import { editDatContentImpl, editDatContentSchema } from "../tools/layer3/editDatContent.js";
import { execNodeMethodImpl, execNodeMethodSchema } from "../tools/layer3/execNodeMethod.js";
import {
  executePythonScriptImpl,
  executePythonScriptSchema,
} from "../tools/layer3/executePythonScript.js";
import { findTdNodesImpl, findTdNodesSchema } from "../tools/layer3/findTdNodes.js";
import { generateReadmeImpl, generateReadmeSchema } from "../tools/layer3/generateReadme.js";
import { getBridgeLogsImpl, getBridgeLogsSchema } from "../tools/layer3/getBridgeLogs.js";
import { getModuleHelpImpl, getModuleHelpSchema } from "../tools/layer3/getModuleHelp.js";
import {
  getNodeStateRuntimeImpl,
  getNodeStateRuntimeSchema,
} from "../tools/layer3/getNodeStateRuntime.js";
import {
  getTdClassDetailsImpl,
  getTdClassDetailsSchema,
} from "../tools/layer3/getTdClassDetails.js";
import { getTdClassesImpl, getTdClassesSchema } from "../tools/layer3/getTdClasses.js";
import { getTdInfoImpl } from "../tools/layer3/getTdInfo.js";
import { getTdNodeErrorsImpl, getTdNodeErrorsSchema } from "../tools/layer3/getTdNodeErrors.js";
import {
  getTdNodeParametersImpl,
  getTdNodeParametersSchema,
} from "../tools/layer3/getTdNodeParameters.js";
import { getTdNodesImpl, getTdNodesSchema } from "../tools/layer3/getTdNodes.js";
import { getTdPerformanceImpl, getTdPerformanceSchema } from "../tools/layer3/getTdPerformance.js";
import { getTdTopologyImpl, getTdTopologySchema } from "../tools/layer3/getTdTopology.js";
import { inspectComponentImpl, inspectComponentSchema } from "../tools/layer3/inspectComponent.js";
import {
  optimizePerformanceImpl,
  optimizePerformanceSchema,
} from "../tools/layer3/optimizePerformance.js";
import {
  readParameterModesImpl,
  readParameterModesSchema,
} from "../tools/layer3/readParameterModes.js";
import { recordMovieImpl, recordMovieSchema } from "../tools/layer3/recordMovie.js";
import { reloadBridgeImpl, reloadBridgeSchema } from "../tools/layer3/reloadBridge.js";
import { renderOutputImpl, renderOutputSchema } from "../tools/layer3/renderOutput.js";
import { searchOperatorsImpl, searchOperatorsSchema } from "../tools/layer3/searchOperators.js";
import { serializeNetworkImpl, serializeNetworkSchema } from "../tools/layer3/serializeNetwork.js";
import { setDatContentImpl, setDatContentSchema } from "../tools/layer3/setDatContent.js";
import {
  setParameterExpressionImpl,
  setParameterExpressionSchema,
} from "../tools/layer3/setParameterExpression.js";
import { snapshotTdGraphImpl, snapshotTdGraphSchema } from "../tools/layer3/snapshotTdGraph.js";
import {
  summarizeTdErrorsImpl,
  summarizeTdErrorsSchema,
} from "../tools/layer3/summarizeTdErrors.js";
import {
  updateTdNodeParametersImpl,
  updateTdNodeParametersSchema,
} from "../tools/layer3/updateTdNodeParameters.js";
import { writeAgentGuideImpl, writeAgentGuideSchema } from "../tools/layer3/writeAgentGuide.js";
import {
  attachDocsAsAssetsImpl,
  attachDocsAsAssetsSchema,
  browseLibraryImpl,
  browseLibrarySchema,
  componentLinkHealthImpl,
  componentLinkHealthSchema,
  exportRecipeBundleImpl,
  exportRecipeBundleSchema,
  importRecipeBundleImpl,
  importRecipeBundleSchema,
  inspectComponentManifestImpl,
  inspectComponentManifestSchema,
  installLibraryPackageImpl,
  installLibraryPackageSchema,
  localMarketplaceIndexImpl,
  localMarketplaceIndexSchema,
  makePortableToxImpl,
  makePortableToxSchema,
  refreshAssetPreviewsImpl,
  refreshAssetPreviewsSchema,
  scaffoldRecipeTemplateImpl,
  scaffoldRecipeTemplateSchema,
  validateLibraryAssetImpl,
  validateLibraryAssetSchema,
} from "../tools/library/index.js";
import type { ToolContext } from "../tools/types.js";
import {
  describeConfig,
  type LoadConfigOptions,
  loadConfig,
  type TdmcpConfig,
  tdBaseUrl,
} from "../utils/config.js";
import { silentLogger } from "../utils/logger.js";
import { runDoctor } from "./doctor.js";

// biome-ignore lint/suspicious/noExplicitAny: args are validated by each command's zod schema before use.
type Runner = (ctx: ToolContext, args: any) => CallToolResult | Promise<CallToolResult>;

interface Command {
  schema: z.ZodTypeAny;
  run: Runner;
  summary: string;
  mutates: boolean;
  unsafe: boolean;
}

const r = (
  schema: z.ZodTypeAny,
  run: Runner,
  summary: string,
  opts: { mutates?: boolean; unsafe?: boolean } = {},
): Command => ({ schema, run, summary, mutates: !!opts.mutates, unsafe: !!opts.unsafe });

/** Static command tree — each entry maps 1:1 onto an existing MCP tool handler. */
const COMMANDS: Record<string, Command> = {
  info: r(z.object({}), (ctx) => getTdInfoImpl(ctx), "Health check + TD/bridge info."),
  reload: r(
    reloadBridgeSchema,
    reloadBridgeImpl,
    "Hot-reload the bridge's Python after editing td/.",
  ),
  "nodes list": r(
    getTdNodesSchema,
    getTdNodesImpl,
    "List a COMP's child nodes (summary by default).",
  ),
  "nodes find": r(findTdNodesSchema, findTdNodesImpl, "Search nodes by name pattern and/or type."),
  "nodes get": r(getTdNodeParametersSchema, getTdNodeParametersImpl, "Read a node's parameters."),
  "nodes errors": r(getTdNodeErrorsSchema, getTdNodeErrorsImpl, "Check a node/network for errors."),
  "nodes compare": r(compareTdNodesSchema, compareTdNodesImpl, "Diff two nodes' parameters."),
  "nodes snapshot": r(snapshotTdGraphSchema, snapshotTdGraphImpl, "Capture a network snapshot."),
  "nodes topology": r(getTdTopologySchema, getTdTopologyImpl, "Map nodes + connections."),
  "nodes performance": r(getTdPerformanceSchema, getTdPerformanceImpl, "Report cook times."),
  "nodes update": r(
    updateTdNodeParametersSchema,
    updateTdNodeParametersImpl,
    "Set node parameters.",
    { mutates: true },
  ),
  "nodes create": r(createTdNodeSchema, createTdNodeImpl, "Create an operator.", { mutates: true }),
  "nodes delete": r(deleteTdNodeSchema, deleteTdNodeImpl, "Delete a node.", { mutates: true }),
  "errors summarize": r(
    summarizeTdErrorsSchema,
    summarizeTdErrorsImpl,
    "Cluster network errors by cause.",
  ),
  "classes list": r(getTdClassesSchema, getTdClassesImpl, "List TD Python API classes (offline)."),
  "classes get": r(
    getTdClassDetailsSchema,
    getTdClassDetailsImpl,
    "Get one Python class (offline).",
  ),
  "module help": r(
    getModuleHelpSchema,
    getModuleHelpImpl,
    "Human-readable help for a class (offline).",
  ),
  operators: r(
    searchOperatorsSchema,
    searchOperatorsImpl,
    "Search the operator knowledge base by keyword (offline).",
  ),
  document: r(
    documentNetworkSchema,
    documentNetworkImpl,
    "Document a network (summary + mermaid).",
  ),
  diff: r(diffSnapshotsSchema, diffSnapshotsImpl, "Diff two network snapshots (offline)."),
  optimize: r(
    optimizePerformanceSchema,
    optimizePerformanceImpl,
    "Find (and optionally fix) cook-time bottlenecks.",
    { mutates: true },
  ),
  render: r(renderOutputSchema, renderOutputImpl, "Save a TOP to a file at full resolution."),
  movie: r(recordMovieSchema, recordMovieImpl, "Record a TOP to a movie/sequence (start/stop).", {
    mutates: true,
  }),
  recipes: r(listRecipesSchema, listRecipesImpl, "List the built-in recipe library (offline)."),
  recipe: r(applyRecipeSchema, applyRecipeImpl, "Build a recipe by id.", { mutates: true }),
  init: r(
    scaffoldShowSchema,
    scaffoldShowImpl,
    "Scaffold a show skeleton (master output + beat clock).",
    {
      mutates: true,
    },
  ),
  "exec python": r(
    executePythonScriptSchema,
    executePythonScriptImpl,
    "Escape hatch: run arbitrary Python in TD.",
    { mutates: true, unsafe: true },
  ),
  "exec node-method": r(
    execNodeMethodSchema,
    execNodeMethodImpl,
    "Escape hatch: call a Python method on a node.",
    { mutates: true, unsafe: true },
  ),
  // Layer 1 — high-level generators (each builds a whole network, verifies, previews).
  visual: r(
    createVisualSystemSchema,
    createVisualSystemImpl,
    "Build a visual system from a description.",
    { mutates: true },
  ),
  feedback: r(createFeedbackNetworkSchema, createFeedbackNetworkImpl, "Build a feedback network.", {
    mutates: true,
  }),
  generative: r(
    createGenerativeArtSchema,
    createGenerativeArtImpl,
    "Build a generative-art system.",
    { mutates: true },
  ),
  particles: r(createParticleSystemSchema, createParticleSystemImpl, "Build a particle system.", {
    mutates: true,
  }),
  "audio-reactive": r(
    createAudioReactiveSchema,
    createAudioReactiveImpl,
    "Build an audio-reactive visual.",
    { mutates: true },
  ),
  "audio-features": r(
    extractAudioFeaturesSchema,
    extractAudioFeaturesImpl,
    "Extract reactive channels (level/bass/mid/treble) to bind to params.",
    { mutates: true },
  ),
  "motion-reactive": r(
    createMotionReactiveSchema,
    createMotionReactiveImpl,
    "Extract camera reactive channels (brightness/motion) to bind to params.",
    { mutates: true },
  ),
  "tempo-sync": r(
    createTempoSyncSchema,
    createTempoSyncImpl,
    "Create a beat clock (ramp/pulse/beat/bar/bpm) + optional beat events.",
    { mutates: true },
  ),
  "clock-sync": r(
    createSyncExternalClockSchema,
    createSyncExternalClockImpl,
    "Drive the global tempo from a Bpm knob + tap-tempo (beat-match the DJ).",
    { mutates: true },
  ),
  dataviz: r(
    createDataVisualizationSchema,
    createDataVisualizationImpl,
    "Build a data visualization.",
    { mutates: true },
  ),
  mixer: r(
    createLayerMixerSchema,
    createLayerMixerImpl,
    "Build a VJ layer mixer (crossfade/blend).",
    {
      mutates: true,
    },
  ),
  video: r(
    createVideoPlayerSchema,
    createVideoPlayerImpl,
    "Build a movie/clip player (+playlist).",
    {
      mutates: true,
    },
  ),
  scene3d: r(create3dSceneSchema, create3dSceneImpl, "Build a renderable 3D scene.", {
    mutates: true,
  }),
  // Phase 12 — dimensional (3D, depth & spatial mapping):
  audio3d: r(
    create3dAudioReactiveSchema,
    create3dAudioReactiveImpl,
    "Build a 3D scene that reacts to sound (instanced FFT bars / bass pulse).",
    { mutates: true },
  ),
  dome: r(
    createDomeOutputSchema,
    createDomeOutputImpl,
    "Remap a source to fisheye/equirectangular for dome / 360 output.",
    { mutates: true },
  ),
  "mesh-warp": r(
    createMeshWarpSchema,
    createMeshWarpImpl,
    "Map a source onto a deformable curved grid (dome/column/sculpture).",
    { mutates: true },
  ),
  "depth-displace": r(
    createDepthDisplacementSchema,
    createDepthDisplacementImpl,
    "Displace a plane into 3D by a depth/luminance map (2.5D relief).",
    { mutates: true },
  ),
  "gpu-particles": r(
    createGpuParticleFieldSchema,
    createGpuParticleFieldImpl,
    "GPU particle field via feedback TOPs + instancing (experimental).",
    { mutates: true },
  ),
  text: r(
    createTextOverlaySchema,
    createTextOverlayImpl,
    "Composite styled text over a visual (lyrics/titles/credits).",
    { mutates: true },
  ),
  mapping: r(
    createProjectionMappingSchema,
    createProjectionMappingImpl,
    "Wrap a source in a corner-pin for projection mapping.",
    { mutates: true },
  ),
  keyframe: r(
    createKeyframeAnimationSchema,
    createKeyframeAnimationImpl,
    "Animate parameters along a keyframed curve (synced/looping).",
    { mutates: true },
  ),
  simulation: r(
    createSimulationSchema,
    createSimulationImpl,
    "Build a GPU simulation (RD/slime/fluid).",
    {
      mutates: true,
    },
  ),
  "post-fx": r(
    applyPostProcessingSchema,
    applyPostProcessingImpl,
    "Apply post-processing (bloom/blur/…).",
    { mutates: true },
  ),
  output: r(setupOutputSchema, setupOutputImpl, "Set up a window / NDI / Syphon-Spout output.", {
    mutates: true,
  }),
  "multi-output": r(
    createMultiOutputSchema,
    createMultiOutputImpl,
    "Fan a master TOP across N projectors (cropped tiles + optional windows).",
    { mutates: true },
  ),
  plan: r(
    describeProjectSchema,
    describeProjectImpl,
    "Plan which tool/recipe builds a described visual (creates nothing).",
  ),
  // Layer 2 — building blocks.
  animate: r(animateParameterSchema, animateParameterImpl, "Drive parameters with an LFO.", {
    mutates: true,
  }),
  bind: r(
    bindToChannelSchema,
    bindToChannelImpl,
    "Bind parameters to a CHOP channel (audio feature / beat) by expression.",
    { mutates: true },
  ),
  arrange: r(arrangeNetworkSchema, arrangeNetworkImpl, "Auto-arrange a network left→right.", {
    mutates: true,
  }),
  connect: r(connectNodesSchema, connectNodesImpl, "Wire two nodes together.", { mutates: true }),
  container: r(createContainerSchema, createContainerImpl, "Create a COMP container.", {
    mutates: true,
  }),
  "control-panel": r(
    createControlPanelSchema,
    createControlPanelImpl,
    "Add bound custom-parameter controls to a COMP.",
    { mutates: true },
  ),
  surface: r(
    createControlSurfaceSchema,
    createControlSurfaceImpl,
    "Build a playable panel: faders + cue buttons.",
    { mutates: true },
  ),
  remote: r(
    createPhoneRemoteSchema,
    createPhoneRemoteImpl,
    "Serve a phone web panel for a COMP's controls.",
    { mutates: true },
  ),
  io: r(
    createExternalIoSchema,
    createExternalIoImpl,
    "Bridge OSC/MIDI in, DMX out, NDI/Syphon in.",
    {
      mutates: true,
    },
  ),
  glsl: r(createGlslShaderSchema, createGlslShaderImpl, "Create a GLSL TOP shader.", {
    mutates: true,
  }),
  chain: r(createNodeChainSchema, createNodeChainImpl, "Create a chain of connected nodes.", {
    mutates: true,
  }),
  script: r(
    createPythonScriptSchema,
    createPythonScriptImpl,
    "Create a DAT preloaded with Python.",
    {
      mutates: true,
    },
  ),
  duplicate: r(duplicateNetworkSchema, duplicateNetworkImpl, "Duplicate a network.", {
    mutates: true,
  }),
  component: r(manageComponentSchema, manageComponentImpl, "Save/load a COMP as a .tox.", {
    mutates: true,
  }),
  "add-params": r(
    addCustomParametersSchema,
    addCustomParametersImpl,
    "Append a custom-parameter page (knobs/menus/toggles/pulses) to a COMP.",
    { mutates: true },
  ),
  "scaffold-ext": r(
    scaffoldExtensionSchema,
    scaffoldExtensionImpl,
    "Give a COMP a Python extension class (behavior/methods).",
    { mutates: true },
  ),
  checkpoint: r(
    manageCheckpointSchema,
    manageCheckpointImpl,
    "Store/restore a full sub-network snapshot (undo point).",
    { mutates: true },
  ),
  preset: r(managePresetsSchema, managePresetsImpl, "Store/recall/list/delete COMP presets.", {
    mutates: true,
  }),
  cue: r(
    manageCueSchema,
    manageCueImpl,
    "Scene system: store/recall/morph/list/delete cues (timed crossfade).",
    { mutates: true },
  ),
  macro: r(createMacroSchema, createMacroImpl, "Add one knob that drives many parameters.", {
    mutates: true,
  }),
  randomize: r(
    randomizeControlsSchema,
    randomizeControlsImpl,
    "Randomize a COMP's numeric controls within range.",
    { mutates: true },
  ),
  autopilot: r(
    createAutopilotSchema,
    createAutopilotImpl,
    "Beat-driven auto-VJ: every N beats randomize controls or cycle cues.",
    { mutates: true },
  ),
  params: r(
    setParametersBatchSchema,
    setParametersBatchImpl,
    "Set many parameters across nodes at once.",
    { mutates: true },
  ),
  // Signature effects, deeper reactivity, creation, live control (waves 1–5).
  strobe: r(createStrobeSchema, createStrobeImpl, "Build a beat-syncable strobe/flash layer.", {
    mutates: true,
  }),
  kaleidoscope: r(
    createKaleidoscopeSchema,
    createKaleidoscopeImpl,
    "Wrap a source in an N-fold kaleidoscope (radial mirror).",
    { mutates: true },
  ),
  glitch: r(
    createGlitchSchema,
    createGlitchImpl,
    "Apply a glitch look (RGB-shift + noise displacement).",
    { mutates: true },
  ),
  spectrum: r(
    createSpectrumSchema,
    createSpectrumImpl,
    "Extract an N-band FFT spectrum to bind per-band.",
    { mutates: true },
  ),
  onsets: r(
    detectOnsetsSchema,
    detectOnsetsImpl,
    "Detect kick/snare/hat onsets (per-band pulse + optional events).",
    { mutates: true },
  ),
  waveform: r(
    createWaveformSchema,
    createWaveformImpl,
    "Render a time-domain audio oscilloscope/waveform.",
    { mutates: true },
  ),
  colorgrade: r(
    createColorGradeSchema,
    createColorGradeImpl,
    "Color-grade a source (lift/gamma/gain + saturation/hue + LUT).",
    { mutates: true },
  ),
  model: r(importModelSchema, importModelImpl, "Import a 3D model file and render it.", {
    mutates: true,
  }),
  shaderlib: r(
    createShaderLibSchema,
    createShaderLibImpl,
    "Instantiate a curated GLSL shader (tunnel/raymarch/fractal/…).",
    { mutates: true },
  ),
  videosynth: r(
    createVideoSynthSchema,
    createVideoSynthImpl,
    "Analog video-synth patterns (lissajous/interference/scanlines).",
    { mutates: true },
  ),
  silhouette: r(
    createDepthSilhouetteSchema,
    createDepthSilhouetteImpl,
    "Extract a silhouette/body mask from a depth or video source.",
    { mutates: true },
  ),
  kinetictext: r(
    createKineticTextSchema,
    createKineticTextImpl,
    "Animated/beat-flashed kinetic typography (lyric flashes).",
    { mutates: true },
  ),
  panic: r(
    createPanicSchema,
    createPanicImpl,
    "Live safety: instant Blackout + Freeze over an output.",
    { mutates: true },
  ),
  launcher: r(
    createClipLauncherSchema,
    createClipLauncherImpl,
    "Build an Ableton-style grid of cue-trigger buttons.",
    { mutates: true },
  ),
  decks: r(
    createDecksSchema,
    createDecksImpl,
    "Build DJ-style A/B decks with a master crossfader.",
    { mutates: true },
  ),
  pitch: r(
    detectPitchSchema,
    detectPitchImpl,
    "Detect monophonic pitch (Hz/note) from the FFT (experimental).",
    { mutates: true },
  ),
  learn: r(
    learnControlSchema,
    learnControlImpl,
    "MIDI/OSC learn: snapshot an input CHOP, then bind the moved control (experimental).",
    { mutates: true },
  ),
  // Post-0.3.0 parallel build — wave 1:
  "cue-sequencer": r(
    createCueSequencerSchema,
    createCueSequencerImpl,
    "Bar-quantized cue timeline: fire stored cues at musical positions on a loop.",
    { mutates: true },
  ),
  dashboard: r(
    createStageDashboardSchema,
    createStageDashboardImpl,
    "Unified web performance surface: cue buttons + faders + panic + live readout.",
    { mutates: true },
  ),
  raymarch: r(
    createRaymarchSceneSchema,
    createRaymarchSceneImpl,
    "Volumetric GLSL raymarcher: SDF scenes (sphere-field/menger/tunnel).",
    { mutates: true },
  ),
  "detect-tempo": r(
    detectTempoSchema,
    detectTempoImpl,
    "Auto-BPM from audio onsets; optionally drive the global tempo (experimental).",
    { mutates: true },
  ),
  palette: r(
    createPaletteSchema,
    createPaletteImpl,
    "Generate a color palette/gradient (harmony rules or sampled from a source).",
    { mutates: true },
  ),
  // Post-0.3.0 parallel build — wave 2:
  "pbr-scene": r(
    createPbrSceneSchema,
    createPbrSceneImpl,
    "3D scene with a PBR material + environment light rig.",
    { mutates: true },
  ),
  flock: r(
    createParticleFlockSchema,
    createParticleFlockImpl,
    "Boids-style GPU particle flocking (separation/alignment/cohesion).",
    { mutates: true },
  ),
  "point-cloud": r(
    createPointCloudSchema,
    createPointCloudImpl,
    "Render a point cloud from a depth/luminance map or synthetic source.",
    { mutates: true },
  ),
  "data-source": r(
    createDataSourceSchema,
    createDataSourceImpl,
    "Ingest live external data (json/csv/osc/serial) onto a bindable CHOP.",
    { mutates: true },
  ),
  "gen-audio": r(
    createGenerativeAudioSchema,
    createGenerativeAudioImpl,
    "Synthesize audio (oscillator/fm/noise); optional device output.",
    { mutates: true },
  ),
  // Post-0.3.0 parallel build — wave 3:
  "cubemap-dome": r(
    createCubemapDomeSchema,
    createCubemapDomeImpl,
    "True cube-map dome render → fisheye/equirectangular for planetarium/360.",
    { mutates: true },
  ),
  "led-mapper": r(
    createLedMapperSchema,
    createLedMapperImpl,
    "Pixel-map a source TOP to an LED fixture layout → DMX/Art-Net out.",
    { mutates: true },
  ),
  genre: r(
    scaffoldGenreSchema,
    scaffoldGenreImpl,
    "Scaffold a genre-flavored show (techno/ambient/installation).",
    { mutates: true },
  ),
  // Phase 13 — project intelligence & agent-DX.
  analyze: r(
    analyzeProjectSchema,
    analyzeProjectImpl,
    "Find dead ops, broken file deps, orphan COMPs + a dependency map.",
  ),
  readme: r(
    generateReadmeSchema,
    generateReadmeImpl,
    "Generate a Markdown project doc (params, I/O, deps, preview).",
  ),
  "dat-edit": r(
    editDatContentSchema,
    editDatContentImpl,
    "Surgically replace text in a DAT (unique-match or replace_all).",
    { mutates: true },
  ),
  "dat-set": r(
    setDatContentSchema,
    setDatContentImpl,
    "Overwrite a DAT's whole text (refuses silent wipes unless confirm_wipe).",
    { mutates: true },
  ),
  batch: r(
    batchOperationsSchema,
    batchOperationsImpl,
    "Run many create/connect/setParam ops in one fail-forward call.",
    { mutates: true },
  ),
  annotate: r(
    manageAnnotationSchema,
    manageAnnotationImpl,
    "Create/list annotation boxes + comments; list ops enclosed by a box.",
    { mutates: true },
  ),
  "perform-mode": r(
    setPerformModeSchema,
    setPerformModeImpl,
    "Toggle perform mode: suspend nonessential MCP/externalization compute during a show.",
    { mutates: true },
  ),
  "agent-guide": r(
    writeAgentGuideSchema,
    writeAgentGuideImpl,
    "Emit a project-local CLAUDE.md/AGENTS.md with tdmcp conventions.",
    { mutates: true },
  ),
  // Phase 13 — body / pose tracking (MediaPipe-driven, camera-reactive).
  "body-tracking": r(
    setupBodyTrackingSchema,
    setupBodyTrackingImpl,
    "One-shot webcam body tracking: load the MediaPipe engine + adapter + live skeleton.",
    { mutates: true },
  ),
  "pose-track": r(
    createPoseTrackingSchema,
    createPoseTrackingImpl,
    "Build a pose-tracking source (MediaPipe/OSC/synthetic) → a 33-landmark pose CHOP.",
    { mutates: true },
  ),
  skeleton: r(
    createPoseSkeletonSchema,
    createPoseSkeletonImpl,
    "Draw a live stick-figure skeleton from a pose CHOP.",
    { mutates: true },
  ),
  "body-reactive": r(
    createBodyReactiveSchema,
    createBodyReactiveImpl,
    "Drive a visual from tracked body motion (camera-reactive performance).",
    { mutates: true },
  ),
  // Phase 14 — live mixing, content & parameter fidelity (v0.5.0):
  transition: r(
    createTransitionSchema,
    createTransitionImpl,
    "Build an A→B transition (dissolve/luma_wipe/slide/zoom/glitch_cut) over a Progress knob.",
    { mutates: true },
  ),
  "live-source": r(
    createLiveSourceSchema,
    createLiveSourceImpl,
    "Build a live input layer (screen-grab/ndi/syphon-spout/camera/stream) → a previewed Null.",
    { mutates: true },
  ),
  "layer-stack": r(
    createLayerStackSchema,
    createLayerStackImpl,
    "Build an N-layer VJ compositor (per-layer blend + opacity + mute/solo + control strip).",
    { mutates: true },
  ),
  "media-bin": r(
    createMediaBinSchema,
    createMediaBinImpl,
    "Build a folder-fed clip bin (Movie File In + Switch) with Index/Next/Prev/Crossfade.",
    { mutates: true },
  ),
  keyer: r(
    createKeyerSchema,
    createKeyerImpl,
    "Key a source (chroma/luma/rgb) and composite it over a background.",
    { mutates: true },
  ),
  "react-audio": r(
    bindAudioReactiveSchema,
    bindAudioReactiveImpl,
    "One-shot: auto-map a COMP's knobs to audio bands and bind them to a feature CHOP.",
    { mutates: true },
  ),
  "params-modes": r(
    readParameterModesSchema,
    readParameterModesImpl,
    "Read each parameter's mode (constant/expression/export/bind) + raw expr/bind/export.",
  ),
  "set-expr": r(
    setParameterExpressionSchema,
    setParameterExpressionImpl,
    "Set a parameter to an expression/bind/constant without raw Python.",
    { mutates: true },
  ),
  disconnect: r(
    disconnectNodesSchema,
    disconnectNodesImpl,
    "Remove input wire(s) from a node (the inverse of connect).",
    { mutates: true },
  ),
  // Phase 14 — signature effects, multipass 3D, data-driven cloning, runtime reads:
  datamosh: r(
    createDatamoshSchema,
    createDatamoshImpl,
    "Build a datamosh / time-echo / frame-blend smear (feedback ghost trails).",
    { mutates: true },
  ),
  warp: r(
    createDisplacementWarpSchema,
    createDisplacementWarpImpl,
    "Warp a source by noise / a second TOP / audio (displacement).",
    { mutates: true },
  ),
  halftone: r(
    createHalftoneSchema,
    createHalftoneImpl,
    "Stylise a source as halftone dots / CMYK / dither / posterize (GLSL).",
    { mutates: true },
  ),
  "feedback-tunnel": r(
    createFeedbackTunnelSchema,
    createFeedbackTunnelImpl,
    "Build an infinite zoom/rotate/hue feedback tunnel generator.",
    { mutates: true },
  ),
  "multipass-3d": r(
    multipass3dDepthSchema,
    multipass3dDepthImpl,
    "Build a multipass 3D scene (Render + SSAO + a synthetic Depth output).",
    { mutates: true },
  ),
  replicator: r(
    createReplicatorSchema,
    createReplicatorImpl,
    "Clone a template COMP per row of a Table DAT (Replicator COMP).",
    { mutates: true },
  ),
  "node-state": r(
    getNodeStateRuntimeSchema,
    getNodeStateRuntimeImpl,
    "Read an operator's runtime telemetry (cook time/count, res, channels, GPU mem).",
  ),
  logs: r(
    getBridgeLogsSchema,
    getBridgeLogsImpl,
    "Collect recent cook errors/warnings (+ best-effort textport) for debugging.",
  ),
  // Phase 15 — set navigation, sequencing, data reactivity, round-trip, introspection:
  "set-nav": r(
    createSetNavigatorSchema,
    createSetNavigatorImpl,
    "Build a stage cue-list navigator (Index/Next/Prev/Go, QLab model).",
    { mutates: true },
  ),
  "pop-field": r(
    createPopFieldSchema,
    createPopFieldImpl,
    "Build a GPU POP point field (experimental — live-validation pending).",
    { mutates: true },
  ),
  "beat-grid": r(
    createBeatGridSequencerSchema,
    createBeatGridSequencerImpl,
    "Build a beat/bar step-grid sequencer (param or cue per active step).",
    { mutates: true },
  ),
  "react-data": r(
    createDataReactiveSchema,
    createDataReactiveImpl,
    "Map live data-source channels onto a COMP's knobs with per-mapping range remap.",
    { mutates: true },
  ),
  serialize: r(
    serializeNetworkSchema,
    serializeNetworkImpl,
    "Serialize a COMP's children to a diffable JSON spec (params + modes + wires).",
  ),
  rebuild: r(
    rebuildNetworkSchema,
    rebuildNetworkImpl,
    "Rebuild a network from a serialize_network spec (create + params + wires).",
    { mutates: true },
  ),
  "inspect-comp": r(
    inspectComponentSchema,
    inspectComponentImpl,
    "Read a COMP's storage, promoted extension members, and custom-parameter definitions.",
  ),
  // Phase 15 — 3D text, sidechain envelope, MIDI (hardware path held pending gear):
  "text-3d": r(
    createText3dSchema,
    createText3dImpl,
    "Build extruded 3D text with spin/depth/material.",
    { mutates: true },
  ),
  envelope: r(
    createEnvelopeFollowerSchema,
    createEnvelopeFollowerImpl,
    "Shape a reactive signal: attack/release + gate/duck (sidechain). Experimental.",
    { mutates: true },
  ),
  "midi-map": r(
    createMidiMapSchema,
    createMidiMapImpl,
    "Build a MIDI controller preset map (APC/Launchpad/MIDI Mix/nanoKONTROL). Hardware-UNVERIFIED.",
    { mutates: true },
  ),
  "midi-notes": r(
    createMidiNoteReactiveSchema,
    createMidiNoteReactiveImpl,
    "Build a MIDI-note reactive chain (synthetic source previews without gear).",
    { mutates: true },
  ),
  // Library / packaging — local-first .tox packages, recipe bundles and package indexes.
  library: r(
    browseLibrarySchema,
    browseLibraryImpl,
    "Browse recipes and local component packages.",
  ),
  manifest: r(
    inspectComponentManifestSchema,
    inspectComponentManifestImpl,
    "Inspect a component package manifest.",
  ),
  "portable-tox": r(
    makePortableToxSchema,
    makePortableToxImpl,
    "Save a COMP as a portable .tox package with a manifest.",
    { mutates: true },
  ),
  "recipe-bundle-export": r(
    exportRecipeBundleSchema,
    exportRecipeBundleImpl,
    "Export recipes to a portable bundle file.",
    { mutates: true },
  ),
  "recipe-bundle-import": r(
    importRecipeBundleSchema,
    importRecipeBundleImpl,
    "Import recipes from a portable bundle file.",
    { mutates: true },
  ),
  "asset-validate": r(
    validateLibraryAssetSchema,
    validateLibraryAssetImpl,
    "Validate a local library asset and manifest reference.",
  ),
  "recipe-template": r(
    scaffoldRecipeTemplateSchema,
    scaffoldRecipeTemplateImpl,
    "Write a minimal valid recipe JSON template.",
    { mutates: true },
  ),
  "docs-assets": r(
    attachDocsAsAssetsSchema,
    attachDocsAsAssetsImpl,
    "Copy docs into a package and update its manifest.",
    { mutates: true },
  ),
  "marketplace-index": r(
    localMarketplaceIndexSchema,
    localMarketplaceIndexImpl,
    "Write an index.json for a local package directory.",
    { mutates: true },
  ),
  "component-health": r(
    componentLinkHealthSchema,
    componentLinkHealthImpl,
    "Check externaltox links for missing local component files.",
  ),
  "preview-assets": r(
    refreshAssetPreviewsSchema,
    refreshAssetPreviewsImpl,
    "Capture TOP previews into package asset files.",
    { mutates: true },
  ),
  "install-library": r(
    installLibraryPackageSchema,
    installLibraryPackageImpl,
    "Install a local package folder, zip, tox, or manifest into a package directory.",
    { mutates: true },
  ),
};

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** Prefer the structured channel; fall back to a JSON code-fence, then to the raw text. */
function extractData(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  const fence = text.match(/```json\n([\s\S]*?)\n```/);
  if (fence) {
    try {
      return JSON.parse(fence[1] as string);
    } catch {
      // fall through
    }
  }
  return { message: text };
}

function firstArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) if (Array.isArray(value)) return value;
  }
  return null;
}

function resolveCommand(positionals: string[]): { key: string; cmd: Command } | undefined {
  const key2 = positionals.slice(0, 2).join(" ");
  if (COMMANDS[key2]) return { key: key2, cmd: COMMANDS[key2] };
  const key1 = positionals[0] ?? "";
  if (COMMANDS[key1]) return { key: key1, cmd: COMMANDS[key1] };
  return undefined;
}

function usage(): string {
  const lines = ["tdmcp-agent — drive TouchDesigner from a shell (machine-readable output).", ""];
  lines.push("Usage: tdmcp-agent <command> [--params '<json>'] [--json '<json>'] [flags]", "");
  lines.push("Flags:");
  lines.push(
    "  --params <json>   Arguments object (validated against the command's input schema).",
  );
  lines.push("  --json <json>     Merged into --params (e.g. for request bodies).");
  lines.push("  --output <fmt>    json (default) | ndjson | text.");
  lines.push("  --dry-run         Validate and print the intended call without executing.");
  lines.push("  --allow-unsafe    Required for `exec` escape-hatch commands.");
  lines.push("  -o, --out <file>  (preview) Output PNG path. Defaults to ./preview.png.");
  lines.push("  --include-high-frequency  (watch) Also stream timeline.frame / node.cook events.");
  lines.push("  --profile <name>  Use a named profile from your config file (tdmcp.json).");
  lines.push("  --config <path>   Use a specific config file instead of the search order.");
  lines.push(
    "  --td-host <h> / --td-port <p> / --timeout <ms>  Override the bridge for this call.",
  );
  lines.push(
    "  --params-file <f> / --params -   Read --params JSON from a file or stdin (Unix pipe).",
  );
  lines.push("  --filter / --exclude <csv>  (watch) Only/never stream these event types.");
  lines.push("  -q, --quiet       Suppress the stderr summary (stdout=data, for pipelines/CI).");
  lines.push("  -V, --version     Print the version and exit.");
  lines.push("  -h, --help        Show this help.", "");
  lines.push("Commands:");
  for (const [key, cmd] of Object.entries(COMMANDS)) {
    const tags = [cmd.mutates ? "mutates" : "", cmd.unsafe ? "unsafe" : ""]
      .filter(Boolean)
      .join(",");
    lines.push(`  ${key.padEnd(20)} ${cmd.summary}${tags ? `  [${tags}]` : ""}`);
  }
  lines.push("  schema <command>     Print a command's JSON Schema and metadata.");
  lines.push(
    "  config               Print the effective config (redacted); --write-env for a paste-ready block.",
  );
  lines.push("  preview <nodePath>   Capture a TOP to a PNG file (-o/--out).  [writes a file]");
  lines.push("  watch                Stream TD events as ndjson until Ctrl-C.  [long-running]");
  lines.push("  repl                 Interactive mode: run commands line-by-line.  [interactive]");
  lines.push(
    "  doctor               Diagnose your setup (TD/LLM/vault/config/tools); --fix suggests commands, --output json, -q/--quiet.",
  );
  return lines.join("\n");
}

export interface RunCliOptions {
  /** Inject a context (used by tests); production builds one from env config. */
  makeCtx?: () => ToolContext;
}

/** Build {@link LoadConfigOptions} from the global CLI flags (profile / config / host / port / timeout). */
function cliLoadOptions(values: Record<string, unknown>): LoadConfigOptions {
  const overrides: Record<string, unknown> = {};
  if (typeof values["td-host"] === "string") overrides.tdHost = values["td-host"];
  if (typeof values["td-port"] === "string") overrides.tdPort = values["td-port"];
  if (typeof values.timeout === "string") overrides.requestTimeoutMs = values.timeout;
  return {
    useFiles: true,
    profile: typeof values.profile === "string" ? values.profile : undefined,
    configPath: typeof values.config === "string" ? values.config : undefined,
    overrides,
  };
}

function buildCtx(
  opts: RunCliOptions,
  loadOpts: LoadConfigOptions = { useFiles: true },
): ToolContext {
  return opts.makeCtx
    ? opts.makeCtx()
    : buildToolContext(loadConfig(process.env, loadOpts), { logger: silentLogger });
}

/** Config key → TDMCP_* env var name, for the `config --write-env` exporter. */
const ENV_NAMES: Record<keyof TdmcpConfig, string> = {
  tdHost: "TDMCP_TD_HOST",
  tdPort: "TDMCP_TD_PORT",
  transport: "TDMCP_TRANSPORT",
  logLevel: "TDMCP_LOG_LEVEL",
  requestTimeoutMs: "TDMCP_REQUEST_TIMEOUT_MS",
  httpPort: "TDMCP_HTTP_PORT",
  events: "TDMCP_EVENTS",
  rawPython: "TDMCP_RAW_PYTHON",
  toolProfile: "TDMCP_TOOL_PROFILE",
  bridgeToken: "TDMCP_BRIDGE_TOKEN",
  llmBaseUrl: "TDMCP_LLM_BASE_URL",
  llmModel: "TDMCP_LLM_MODEL",
  llmApiKey: "TDMCP_LLM_API_KEY",
  chatPort: "TDMCP_CHAT_PORT",
  vaultPath: "TDMCP_VAULT_PATH",
};
const SECRET_ENV: ReadonlySet<keyof TdmcpConfig> = new Set(["bridgeToken", "llmApiKey"]);

/** A paste-ready `export TDMCP_*=...` block; secrets are emitted commented-out (set manually). */
function envExportLines(config: TdmcpConfig): string[] {
  const lines: string[] = ["# tdmcp effective config (secrets redacted — set them manually)"];
  for (const [key, name] of Object.entries(ENV_NAMES) as [keyof TdmcpConfig, string][]) {
    const value = config[key];
    if (value === undefined) continue;
    if (SECRET_ENV.has(key)) lines.push(`# export ${name}=<set manually>`);
    else lines.push(`export ${name}=${JSON.stringify(String(value))}`);
  }
  return lines;
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      params: { type: "string" },
      json: { type: "string" },
      output: { type: "string", default: "json" },
      "dry-run": { type: "boolean", default: false },
      "allow-unsafe": { type: "boolean", default: false },
      out: { type: "string", short: "o" },
      "include-high-frequency": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      // Global config selection / overrides (apply to any command).
      profile: { type: "string" },
      config: { type: "string" },
      "td-host": { type: "string" },
      "td-port": { type: "string" },
      timeout: { type: "string" },
      "write-env": { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      fix: { type: "boolean", default: false },
      version: { type: "boolean", short: "V", default: false },
      "params-file": { type: "string" },
      filter: { type: "string" },
      exclude: { type: "string" },
    },
  });
}

/** The installed package version (read once from package.json next to the bundle). */
function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Levenshtein distance — for "did you mean" suggestions on an unknown command. */
function editDistance(a: string, b: string): number {
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = curr;
  }
  return prev[n] ?? 0;
}

/** Nearest known command to an unknown input (within a small edit distance), or undefined. */
function nearestCommand(input: string): string | undefined {
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  // Candidates: full command keys, their first token (so "noeds" → "nodes"), and the specials.
  const firstTokens = new Set(Object.keys(COMMANDS).map((k) => k.split(" ")[0] ?? k));
  const keys = [
    ...Object.keys(COMMANDS),
    ...firstTokens,
    "schema",
    "config",
    "preview",
    "watch",
    "repl",
    "doctor",
    "version",
  ];
  for (const key of keys) {
    const d = editDistance(input, key);
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  // Only suggest a genuinely close match (≤ a third of the input length, min 2).
  return best !== undefined && bestDist <= Math.max(2, Math.floor(input.length / 3))
    ? best
    : undefined;
}

/** Reads stdin to a string (for `--params -`). Synchronous: the CLI is a one-shot. */
function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Assembles the args object from --params (inline, `-` for stdin, or via --params-file)
 * merged with --json. Completes the Unix-filter story: `… | tdmcp-agent x --params -`.
 */
function assembleParams(
  values: Record<string, unknown>,
): { raw: Record<string, unknown> } | { error: string } {
  const raw: Record<string, unknown> = {};
  try {
    let paramsStr = typeof values.params === "string" ? values.params : undefined;
    if (paramsStr === "-") paramsStr = readStdin();
    else if (typeof values["params-file"] === "string")
      paramsStr = readFileSync(values["params-file"], "utf8");
    if (typeof paramsStr === "string" && paramsStr.trim())
      Object.assign(raw, JSON.parse(paramsStr));
    if (typeof values.json === "string") Object.assign(raw, JSON.parse(values.json));
  } catch (err) {
    return { error: (err as Error).message };
  }
  return { raw };
}

export async function runCli(argv: string[], opts: RunCliOptions = {}): Promise<CliResult> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
  }

  const { values, positionals } = parsed;
  if (values.version || positionals[0] === "version") {
    return {
      stdout: `tdmcp-agent ${packageVersion()} (node ${process.version})\n`,
      stderr: "",
      code: 0,
    };
  }
  if (values.help || positionals.length === 0) {
    return { stdout: `${usage()}\n`, stderr: "", code: 0 };
  }

  // `schema <command>` — emit the input contract without touching TD.
  if (positionals[0] === "schema") {
    const target = positionals.slice(1).join(" ");
    const cmd = COMMANDS[target];
    if (!cmd) return { stdout: "", stderr: `Unknown command for schema: "${target}".\n`, code: 2 };
    const doc = {
      command: target,
      summary: cmd.summary,
      mutates: cmd.mutates,
      unsafe: cmd.unsafe,
      input: z.toJSONSchema(cmd.schema),
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  // `config` — print the effective resolved config (secrets redacted), honoring
  // --profile/--config and the host/port overrides; --write-env emits a paste-ready
  // export block. Read-only and reachable even when TD is offline.
  if (positionals[0] === "config") {
    let cfg: TdmcpConfig;
    try {
      cfg = loadConfig(process.env, cliLoadOptions(values));
    } catch (err) {
      return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
    }
    if (values["write-env"]) {
      return { stdout: `${envExportLines(cfg).join("\n")}\n`, stderr: "", code: 0 };
    }
    return {
      stdout: `${JSON.stringify({ tdBaseUrl: tdBaseUrl(cfg), ...describeConfig(cfg) }, null, 2)}\n`,
      stderr: "",
      code: 0,
    };
  }

  // `preview <nodePath> -o file.png` — capture a TOP and write it to disk. This is a
  // side effect that doesn't fit the CallToolResult command table, so it's handled here.
  if (positionals[0] === "preview") {
    const assembled = assembleParams(values);
    if ("error" in assembled) {
      return {
        stdout: "",
        stderr: `Invalid JSON in --params/--json: ${assembled.error}\n`,
        code: 2,
      };
    }
    const raw = assembled.raw;
    if (positionals[1]) raw.node_path = positionals[1];
    const parsed = getPreviewSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        stdout: "",
        stderr: `Invalid arguments for "preview": ${parsed.error.message}\n`,
        code: 2,
      };
    }
    const outPath = typeof values.out === "string" && values.out ? values.out : "preview.png";
    if (values["dry-run"]) {
      const doc = { dryRun: true, command: "preview", args: parsed.data, out: resolve(outPath) };
      return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
    }
    let ctx: ToolContext;
    try {
      ctx = buildCtx(opts, cliLoadOptions(values));
    } catch (err) {
      return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
    }
    try {
      const preview = await capturePreview(
        ctx.client,
        parsed.data.node_path,
        parsed.data.width,
        parsed.data.height,
      );
      const bytes = Buffer.from(preview.base64, "base64");
      writeFileSync(outPath, bytes);
      const doc = {
        node_path: preview.path,
        file: resolve(outPath),
        width: preview.width,
        height: preview.height,
        bytes: bytes.length,
        mimeType: preview.mimeType,
      };
      return {
        stdout: `${JSON.stringify(doc, null, 2)}\n`,
        stderr: `Saved preview of ${preview.path} to ${outPath} (${bytes.length} bytes).\n`,
        code: 0,
      };
    } catch (err) {
      return { stdout: "", stderr: `${friendlyTdError(err)}\n`, code: 1 };
    }
  }

  // `doctor` — environment diagnostic (TD bridge, LLM copilot, vault, config). Read-only and
  // reachable even when TD is offline, so it bypasses the CallToolResult command table.
  if (positionals[0] === "doctor") {
    const make = opts.makeCtx;
    let cfg: TdmcpConfig | undefined;
    if (!make) {
      try {
        cfg = loadConfig(process.env, cliLoadOptions(values));
      } catch (err) {
        return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
      }
    }
    const { stdout, stderr, code, report } = await runDoctor(
      make ? { makeCtx: () => make(), fix: values.fix } : { config: cfg, fix: values.fix },
    );
    // --output json (explicit) → structured report; --quiet → exit code only.
    if (argv.includes("--output") && values.output === "json") {
      return { stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: "", code };
    }
    if (values.quiet) return { stdout: "", stderr: "", code };
    return { stdout, stderr, code };
  }

  const resolved = resolveCommand(positionals);
  if (!resolved) {
    const guess = nearestCommand(positionals[0] ?? "");
    const hint = guess ? ` Did you mean "${guess}"?` : "";
    return {
      stdout: "",
      stderr: `Unknown command: "${positionals.join(" ")}".${hint} Run with --help.\n`,
      code: 2,
    };
  }
  const { key, cmd } = resolved;

  const assembled = assembleParams(values);
  if ("error" in assembled) {
    return { stdout: "", stderr: `Invalid JSON in --params/--json: ${assembled.error}\n`, code: 2 };
  }
  const raw = assembled.raw;

  const args = cmd.schema.safeParse(raw);
  if (!args.success) {
    return {
      stdout: "",
      stderr: `Invalid arguments for "${key}": ${args.error.message}\n`,
      code: 2,
    };
  }

  if (values["dry-run"]) {
    const doc = {
      dryRun: true,
      command: key,
      mutates: cmd.mutates,
      unsafe: cmd.unsafe,
      args: args.data,
    };
    return { stdout: `${JSON.stringify(doc, null, 2)}\n`, stderr: "", code: 0 };
  }

  let ctx: ToolContext;
  try {
    ctx = buildCtx(opts, cliLoadOptions(values));
  } catch (err) {
    return { stdout: "", stderr: `${(err as Error).message}\n`, code: 2 };
  }

  if (cmd.unsafe) {
    if (ctx.allowRawPython === false) {
      return { stdout: "", stderr: `"${key}" is disabled (TDMCP_RAW_PYTHON=off).\n`, code: 2 };
    }
    if (!values["allow-unsafe"]) {
      return {
        stdout: "",
        stderr: `"${key}" is an escape hatch. Re-run with --allow-unsafe to execute.\n`,
        code: 2,
      };
    }
  }

  const result = await cmd.run(ctx, args.data);
  // -q/--quiet keeps stdout=data and silences the friendly stderr summary (for pipelines/CI).
  const summary = values.quiet ? "" : (textOf(result).split("\n")[0] ?? "");
  if (result.isError) return { stdout: "", stderr: `${textOf(result)}\n`, code: 1 };

  const output = String(values.output);
  const data = extractData(result);
  if (output === "text") return { stdout: `${textOf(result)}\n`, stderr: "", code: 0 };
  if (output === "ndjson") {
    const arr = firstArray(data);
    const body = arr ? arr.map((item) => JSON.stringify(item)).join("\n") : JSON.stringify(data);
    return { stdout: `${body}\n`, stderr: summary ? `${summary}\n` : "", code: 0 };
  }
  return {
    stdout: `${JSON.stringify(data, null, 2)}\n`,
    stderr: summary ? `${summary}\n` : "",
    code: 0,
  };
}

export interface RunWatchOptions {
  config?: TdmcpConfig;
  includeHighFrequency?: boolean;
  /** Only emit events whose `type` is in this list (e.g. ["beat","onset"]). */
  filter?: string[];
  /** Drop events whose `type` is in this list (e.g. ["timeline.frame"]). */
  exclude?: string[];
  /** Where each event line goes; defaults to stdout. Overridable for tests. */
  write?: (line: string) => void;
  /** Inject a stream factory for tests; defaults to a real `TdEventStream`. */
  makeStream?: (args: { url: string; onEvent: TdEventHandler; includeHighFrequency: boolean }) => {
    start: () => void;
    close: () => void;
  };
  /** Resolve the returned promise when aborted; defaults to listening for SIGINT. */
  signal?: AbortSignal;
}

/**
 * Streams TouchDesigner bridge events to stdout as ndjson until interrupted.
 * Runs outside `runCli` because it is a long-lived stream, not a request/response.
 */
export function runWatch(opts: RunWatchOptions = {}): Promise<void> {
  const config = opts.config ?? loadConfig(process.env, { useFiles: true });
  const url = `${tdBaseUrl(config).replace(/^http/, "ws")}/`;
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const includeHighFrequency = opts.includeHighFrequency ?? false;
  const filter = opts.filter?.length ? opts.filter : undefined;
  const exclude = opts.exclude?.length ? opts.exclude : undefined;
  const onEvent: TdEventHandler = (event) => {
    const type = (event as { type?: string }).type;
    if (filter && (type === undefined || !filter.includes(type))) return;
    if (exclude && type !== undefined && exclude.includes(type)) return;
    write(JSON.stringify(event));
  };
  const stream = opts.makeStream
    ? opts.makeStream({ url, onEvent, includeHighFrequency })
    : new TdEventStream({ url, onEvent, includeHighFrequency });
  stream.start();
  process.stderr.write(`Watching ${url} for TouchDesigner events (Ctrl-C to stop)…\n`);
  return new Promise<void>((resolveDone) => {
    const stop = () => {
      stream.close();
      resolveDone();
    };
    if (opts.signal) {
      if (opts.signal.aborted) return stop();
      opts.signal.addEventListener("abort", stop, { once: true });
    } else {
      process.once("SIGINT", stop);
    }
  });
}

/** Splits a REPL line into argv, respecting single/double quotes (so JSON --params works). */
function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null = re.exec(line);
  while (m !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
    m = re.exec(line);
  }
  return tokens;
}

/** Interactive read-eval-print loop: each line is tokenized and run through runCli. */
export async function runRepl(opts: RunCliOptions = {}): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write(
    "tdmcp REPL — enter a command (e.g. `info`, `nodes list`); `help` for commands, `exit` to quit.\n> ",
  );
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "exit" || trimmed === "quit") break;
    if (trimmed === "help") {
      process.stdout.write(`${usage()}\n`);
    } else if (trimmed) {
      const result = await runCli(tokenizeLine(trimmed), opts);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.stderr.write("> ");
  }
  rl.close();
}

/** Pull a `--name value` (or `--name=value`) string out of a raw argv list. */
function rawFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
}

/** Split a comma-separated flag value into a trimmed list, or undefined if absent/empty. */
function csvFlag(argv: string[], name: string): string[] | undefined {
  const raw = rawFlag(argv, name);
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  // `watch` (a long-lived stream) and `repl` (interactive) bypass runCli's request/response model.
  if (argv[0] === "watch" && !wantsHelp) {
    await runWatch({
      includeHighFrequency: argv.includes("--include-high-frequency"),
      filter: csvFlag(argv, "filter"),
      exclude: csvFlag(argv, "exclude"),
    });
    return;
  }
  if (argv[0] === "repl" && !wantsHelp) {
    await runRepl();
    return;
  }
  const result = await runCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) void main();
