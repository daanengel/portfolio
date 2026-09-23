const STORAGE_KEY = "mijks-fractal-canvas-v6";
const THEME_STORAGE_KEY = "mijks-fractal-theme-dark";
const ROOT_RADIUS = 360;
const CAMERA_DURATION = 820;
const FOCUS_RADIUS_RATIO = 0.44;
const STEP_SCROLL_THRESHOLD = 170;
const ZOOM_SCROLL_THRESHOLD = 230;
const ZOOM_OUT_SCROLL_THRESHOLD = 230;
const WHEEL_ACTION_COOLDOWN = 320;
const GRAPH_PAGE_SCROLL_THRESHOLD = 120;
const GHOST_FADE_DURATION = 190;
const LINK_DRAFT_HIGHLIGHT = "#efd34b";
const LINK_HIGHLIGHT = "#c39a18";
const GRAPH_NODE_RADIUS = 26;
const GRAPH_HIT_RADIUS = 34;
const GRAPH_ZOOM_MIN = 0.62;
const GRAPH_ZOOM_MAX = 2.2;
const GRAPH_LABEL_BREAK_THRESHOLD = 13;
const GRAPH_NODE_MIN_DISTANCE = GRAPH_NODE_RADIUS * 2.85;
const GRAPH_PLACEMENT_ANGLE_STEP = Math.PI / 6;
const APP_BACKGROUND_FALLBACK = "#ffffff";
const HISTORY_LIMIT = 180;
const PROJECT_FILE_KIND = "mijks-fractal-timeline";
const PROJECT_FILE_FORMAT_VERSION = 1;
const DEFAULT_PROJECT_FILENAME = "mijks-project.json";
const PROJECT_FILE_ACCEPT = ".json,application/json";
const PROJECT_FILE_MIME = "application/json";
const ATTACHMENT_DB_NAME = "mijks-node-attachments";
const ATTACHMENT_DB_VERSION = 1;
const ATTACHMENT_DB_STORE = "fileHandles";

const appRoot = document.querySelector("#app");

const runtime = {
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  dpr: window.devicePixelRatio || 1,
  camera: {
    x: 0,
    y: 0,
    scale: 1,
    initialized: false,
  },
  cameraAnimation: null,
  hoverMomentId: null,
  hoverPreviewMomentId: null,
  wheelIntent: {
    mode: null,
    direction: 0,
    magnitude: 0,
    updatedAt: 0,
    cooldownUntil: 0,
  },
  panelWheelIntent: {
    direction: 0,
    magnitude: 0,
    updatedAt: 0,
  },
  panelScrollbarDrag: null,
  graphDrag: null,
  helpOpen: false,
  helpDescriptionOpen: false,
  suppressCanvasClickUntil: 0,
  selection: {
    timelineId: null,
    controlMode: false,
    momentIds: new Set(),
    nodeIds: new Set(),
    attachmentIds: new Set(),
  },
  history: {
    undoStack: [],
    redoStack: [],
    currentSerialized: "",
    restoring: false,
  },
  document: {
    fileHandle: null,
    fileName: "",
    dirty: false,
    savedStateSerialized: "",
    supportsNativeFileSystem:
      typeof window.showOpenFilePicker === "function" && typeof window.showSaveFilePicker === "function",
  },
  attachments: {
    dbPromise: null,
    availabilityById: {},
    transientFilesById: {},
    pickerIntent: null,
  },
  presentedFractionByTimelineId: {},
  presentedMomentFractionById: {},
  fadingTimelines: [],
  lastFrameAt: performance.now(),
  rafId: 0,
  elements: {},
  loopErrorMessage: "",
  appBackgroundColor: APP_BACKGROUND_FALLBACK,
  darkMode: loadThemeMode(),
};

const state = loadState() ?? createInitialState();
ensureStateDefaults(state);
runtime.history.currentSerialized = serializeState(state);
runtime.document.savedStateSerialized = runtime.history.currentSerialized;

mountApp();
applyThemeMode(runtime.darkMode);

if (!window.location.hash) {
  writeHashFromState();
}

syncRouteFromHash(true);
renderOverlay();
syncCameraToCurrentTimeline(true);
bindEvents();
startLoop();
exposePublicApi();

function createInitialState() {
  const now = new Date().toISOString();
  const rootMoment = createMomentRecord("moment-root-1", "timeline-root", 0, "", now, 0);

  return {
    version: 6,
    rootTimelineId: "timeline-root",
    attachmentsById: {},
    timelinesById: {
      "timeline-root": {
        id: "timeline-root",
        title: "Outer shell",
        parentMomentId: null,
        nextMomentNumber: 2,
        createdAt: now,
        updatedAt: now,
      },
    },
    momentsById: {
      [rootMoment.id]: rootMoment,
    },
    navigationStack: [],
    linksById: {},
    linkDraftMomentId: null,
    linkView: null,
    activeMomentIdByTimelineId: {
      "timeline-root": rootMoment.id,
    },
  };
}

function createMomentRecord(id, timelineId, position, title, timestamp, order = 0) {
  return {
    id,
    timelineId,
    position,
    order,
    title,
    notes: "",
    graphNodeId: null,
    graphEdgeId: null,
    childTimelineId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createAttachmentRecord(id, nodeId, fileLike, timestamp) {
  return {
    id,
    nodeId,
    displayName: getAttachmentDisplayName(fileLike),
    extension: getAttachmentExtension(fileLike?.name),
    mimeType: String(fileLike?.type || ""),
    size: Number.isFinite(fileLike?.size) ? fileLike.size : 0,
    lastModified: Number.isFinite(fileLike?.lastModified) ? fileLike.lastModified : null,
    addedAt: timestamp,
    updatedAt: timestamp,
  };
}

function getAttachmentDisplayName(fileLike) {
  const name = typeof fileLike?.displayName === "string" ? fileLike.displayName : fileLike?.name;
  const trimmed = String(name || "").trim();
  return trimmed || "Untitled file";
}

function getAttachmentExtension(fileName) {
  const trimmed = String(fileName || "").trim();
  if (!trimmed.includes(".")) {
    return "";
  }
  return `.${trimmed.split(".").pop().toLowerCase()}`;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 6 || !parsed.timelinesById || !parsed.momentsById) {
      return null;
    }

    ensureStateDefaults(parsed);
    return parsed;
  } catch (error) {
    console.warn("Could not load the fractal timeline state.", error);
    return null;
  }
}

function serializeState(target = state) {
  return JSON.stringify(target);
}

function saveState() {
  try {
    const serialized = serializeState(state);

    if (!runtime.history.restoring && runtime.history.currentSerialized && serialized !== runtime.history.currentSerialized) {
      runtime.history.undoStack.push(runtime.history.currentSerialized);
      if (runtime.history.undoStack.length > HISTORY_LIMIT) {
        runtime.history.undoStack.shift();
      }
      runtime.history.redoStack = [];
    }

    runtime.history.currentSerialized = serialized;
    runtime.document.dirty = serialized !== runtime.document.savedStateSerialized;
    localStorage.setItem(STORAGE_KEY, serialized);
    renderDocumentChrome();
  } catch (error) {
    console.warn("Could not save the fractal timeline state.", error);
  }
}

function createProjectDocument(target = state) {
  return {
    kind: PROJECT_FILE_KIND,
    formatVersion: PROJECT_FILE_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    state: JSON.parse(serializeState(target)),
  };
}

function serializeProjectDocument(target = state) {
  return JSON.stringify(createProjectDocument(target), null, 2);
}

function ensureStateDefaults(target) {
  target.navigationStack ||= [];
  target.activeMomentIdByTimelineId ||= {};
  target.linksById ||= {};
  target.graphsByTimelineId ||= {};
  target.attachmentsById ||= {};
  target.linkDraftMomentId ||= null;
  target.linkView ||= null;
  if (target.linkDraftMomentId && !target.momentsById[target.linkDraftMomentId]) {
    target.linkDraftMomentId = null;
  }
  if (
    target.linkView &&
    (!target.linksById[target.linkView.linkId] || !target.momentsById[target.linkView.endpointMomentId])
  ) {
    target.linkView = null;
  }

  Object.values(target.timelinesById).forEach((timeline) => {
    const orderedMoments = Object.values(target.momentsById)
      .filter((moment) => moment.timelineId === timeline.id)
      .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));

    orderedMoments.forEach((moment, index) => {
      if (typeof moment.order !== "number" || Number.isNaN(moment.order)) {
        moment.order = index;
      }
      if (typeof moment.title !== "string") {
        moment.title = "";
      }
      if (typeof moment.notes !== "string") {
        moment.notes = "";
      }
      if (typeof moment.graphNodeId !== "string") {
        moment.graphNodeId = null;
      }
      if (typeof moment.graphEdgeId !== "string") {
        moment.graphEdgeId = null;
      }
    });

    if (typeof timeline.nextMomentNumber !== "number" || Number.isNaN(timeline.nextMomentNumber)) {
      timeline.nextMomentNumber = orderedMoments.length + 1;
    }
    ensureGraphState(target, timeline.id, orderedMoments);
    ensureLeafSelection(timeline.id, target);
    arrangeTimelineMomentsEvenly(timeline.id, target);
  });

  const validNodeIds = new Set();
  Object.values(target.graphsByTimelineId).forEach((graph) => {
    Object.values(graph?.nodesById ?? {}).forEach((node) => {
      node.attachmentIds = Array.isArray(node.attachmentIds)
        ? Array.from(new Set(node.attachmentIds.filter((attachmentId) => typeof attachmentId === "string")))
        : [];
      validNodeIds.add(node.id);
    });
  });

  Object.entries(target.attachmentsById).forEach(([attachmentId, attachment]) => {
    if (!attachment || typeof attachment !== "object" || !validNodeIds.has(attachment.nodeId)) {
      delete target.attachmentsById[attachmentId];
      return;
    }

    attachment.id = typeof attachment.id === "string" ? attachment.id : attachmentId;
    attachment.displayName = getAttachmentDisplayName(attachment);
    attachment.extension = getAttachmentExtension(attachment.displayName);
    attachment.mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : "";
    attachment.size = Number.isFinite(attachment.size) ? attachment.size : 0;
    attachment.lastModified = Number.isFinite(attachment.lastModified) ? attachment.lastModified : null;
    attachment.addedAt = typeof attachment.addedAt === "string" ? attachment.addedAt : attachment.updatedAt || "";
    attachment.updatedAt = typeof attachment.updatedAt === "string" ? attachment.updatedAt : attachment.addedAt || "";
  });

  Object.values(target.graphsByTimelineId).forEach((graph) => {
    Object.values(graph?.nodesById ?? {}).forEach((node) => {
      const attachedIds = Object.values(target.attachmentsById)
        .filter((attachment) => attachment.nodeId === node.id)
        .map((attachment) => attachment.id);
      node.attachmentIds = Array.from(new Set([...node.attachmentIds, ...attachedIds])).filter(
        (attachmentId) => target.attachmentsById[attachmentId]?.nodeId === node.id,
      );
    });
  });
}

function ensureGraphState(target, timelineId, orderedMoments = getMomentsForTimelineFrom(target, timelineId)) {
  target.graphsByTimelineId ||= {};
  const existing = target.graphsByTimelineId[timelineId];
  if (!existing || !existing.nodesById) {
    target.graphsByTimelineId[timelineId] = seedGraphFromMoments(target, timelineId, orderedMoments);
    separateGraphNodes(timelineId, target, target.graphsByTimelineId[timelineId]);
    return target.graphsByTimelineId[timelineId];
  }

  existing.nodesById ||= {};
  existing.edgesById ||= {};
  existing.view ||= { x: 0, y: 0, zoom: 1 };
  existing.nextNodeNumber ||= Object.keys(existing.nodesById).length + 1;
  existing.nextEdgeNumber ||= Object.keys(existing.edgesById).length + 1;

  Object.values(existing.nodesById).forEach((node) => {
    if (typeof node.title !== "string") {
      node.title = "";
    }
    if (typeof node.x !== "number" || Number.isNaN(node.x)) {
      node.x = 0;
    }
    if (typeof node.y !== "number" || Number.isNaN(node.y)) {
      node.y = 0;
    }
    node.updatedAt ||= node.createdAt || new Date().toISOString();
  });

  orderedMoments.forEach((moment, index) => {
    if (moment.graphNodeId || moment.graphEdgeId) {
      return;
    }
    const fallbackNodeId = createGraphNodeForMoment(target, timelineId, moment, index, orderedMoments.length);
    moment.graphNodeId = fallbackNodeId;
  });

  separateGraphNodes(timelineId, target, existing);
  return existing;
}

function isMultiSelectModifier(event) {
  return Boolean(event?.ctrlKey || event?.metaKey);
}

function clearSelection() {
  runtime.selection.timelineId = null;
  runtime.selection.controlMode = false;
  runtime.selection.momentIds.clear();
  runtime.selection.nodeIds.clear();
  runtime.selection.attachmentIds.clear();
}

function normalizeSelection() {
  if (!runtime.selection.momentIds.size && !runtime.selection.nodeIds.size && !runtime.selection.attachmentIds.size) {
    runtime.selection.timelineId = null;
    runtime.selection.controlMode = false;
  }
}

function ensureSelectionTimeline(timelineId) {
  if (runtime.selection.timelineId === timelineId) {
    return;
  }

  clearSelection();
  runtime.selection.timelineId = timelineId;
}

function pruneSelection() {
  const timelineId = runtime.selection.timelineId;
  if (!timelineId || !state.timelinesById[timelineId]) {
    clearSelection();
    return;
  }

  for (const momentId of Array.from(runtime.selection.momentIds)) {
    const moment = state.momentsById[momentId];
    if (!moment || moment.timelineId !== timelineId) {
      runtime.selection.momentIds.delete(momentId);
    }
  }

  for (const nodeId of Array.from(runtime.selection.nodeIds)) {
    if (!getGraphNodeById(timelineId, nodeId)) {
      runtime.selection.nodeIds.delete(nodeId);
    }
  }

  for (const attachmentId of Array.from(runtime.selection.attachmentIds)) {
    const attachment = state.attachmentsById[attachmentId];
    if (!attachment || getAttachmentTimelineId(attachmentId) !== timelineId) {
      runtime.selection.attachmentIds.delete(attachmentId);
    }
  }

  normalizeSelection();
}

function setSingleMomentSelection(timelineId, momentId, options = {}) {
  ensureSelectionTimeline(timelineId);
  runtime.selection.controlMode = Boolean(options.controlMode);
  runtime.selection.momentIds.clear();
  runtime.selection.nodeIds.clear();
  runtime.selection.attachmentIds.clear();
  if (momentId) {
    runtime.selection.momentIds.add(momentId);
  }
  normalizeSelection();
}

function toggleMomentSelection(timelineId, momentId) {
  ensureSelectionTimeline(timelineId);
  runtime.selection.controlMode = true;
  runtime.selection.attachmentIds.clear();
  runtime.selection.nodeIds.forEach((nodeId) => {
    if (getMomentsForGraphNode(timelineId, nodeId).some((moment) => moment.id === momentId)) {
      runtime.selection.nodeIds.delete(nodeId);
    }
  });
  if (runtime.selection.momentIds.has(momentId)) {
    runtime.selection.momentIds.delete(momentId);
  } else {
    runtime.selection.momentIds.add(momentId);
  }
  normalizeSelection();
}

function setSingleNodeSelection(timelineId, nodeId, options = {}) {
  ensureSelectionTimeline(timelineId);
  runtime.selection.controlMode = Boolean(options.controlMode);
  runtime.selection.momentIds.clear();
  runtime.selection.nodeIds.clear();
  runtime.selection.attachmentIds.clear();
  if (nodeId) {
    runtime.selection.nodeIds.add(nodeId);
  }
  normalizeSelection();
}

function toggleNodeSelection(timelineId, nodeId) {
  ensureSelectionTimeline(timelineId);
  runtime.selection.controlMode = true;
  runtime.selection.attachmentIds.clear();
  for (const moment of getMomentsForGraphNode(timelineId, nodeId)) {
    runtime.selection.momentIds.delete(moment.id);
  }
  if (runtime.selection.nodeIds.has(nodeId)) {
    runtime.selection.nodeIds.delete(nodeId);
  } else {
    runtime.selection.nodeIds.add(nodeId);
  }
  normalizeSelection();
}

function isNodeSelected(timelineId, nodeId) {
  return runtime.selection.timelineId === timelineId && runtime.selection.nodeIds.has(nodeId);
}

function isMomentSelected(moment) {
  if (!moment || runtime.selection.timelineId !== moment.timelineId) {
    return false;
  }

  return runtime.selection.momentIds.has(moment.id) || (moment.graphNodeId ? runtime.selection.nodeIds.has(moment.graphNodeId) : false);
}

function setSingleAttachmentSelection(timelineId, attachmentId, options = {}) {
  ensureSelectionTimeline(timelineId);
  runtime.selection.controlMode = Boolean(options.controlMode);
  runtime.selection.momentIds.clear();
  runtime.selection.nodeIds.clear();
  runtime.selection.attachmentIds.clear();
  if (attachmentId) {
    runtime.selection.attachmentIds.add(attachmentId);
  }
  normalizeSelection();
}

function toggleAttachmentSelection(timelineId, attachmentId) {
  ensureSelectionTimeline(timelineId);
  runtime.selection.controlMode = true;
  runtime.selection.momentIds.clear();
  runtime.selection.nodeIds.clear();
  if (runtime.selection.attachmentIds.has(attachmentId)) {
    runtime.selection.attachmentIds.delete(attachmentId);
  } else {
    runtime.selection.attachmentIds.add(attachmentId);
  }
  normalizeSelection();
}

function toggleAttachmentGroupSelection(timelineId, attachmentIds) {
  const validAttachmentIds = Array.from(new Set(attachmentIds.filter((attachmentId) => state.attachmentsById[attachmentId])));
  if (!validAttachmentIds.length) {
    return;
  }

  ensureSelectionTimeline(timelineId);
  runtime.selection.controlMode = true;
  runtime.selection.momentIds.clear();
  runtime.selection.nodeIds.clear();

  const allSelected = validAttachmentIds.every((attachmentId) => runtime.selection.attachmentIds.has(attachmentId));
  validAttachmentIds.forEach((attachmentId) => {
    if (allSelected) {
      runtime.selection.attachmentIds.delete(attachmentId);
    } else {
      runtime.selection.attachmentIds.add(attachmentId);
    }
  });
  normalizeSelection();
}

function isAttachmentSelected(attachmentId, timelineId = runtime.selection.timelineId) {
  return runtime.selection.timelineId === timelineId && runtime.selection.attachmentIds.has(attachmentId);
}

function isAttachmentGroupSelected(attachmentIds, timelineId = runtime.selection.timelineId) {
  const validAttachmentIds = attachmentIds.filter(Boolean);
  return (
    validAttachmentIds.length > 0 &&
    runtime.selection.timelineId === timelineId &&
    validAttachmentIds.every((attachmentId) => runtime.selection.attachmentIds.has(attachmentId))
  );
}

function getSelectionForTimeline(timelineId) {
  if (runtime.selection.timelineId !== timelineId) {
    return {
      momentIds: new Set(),
      nodeIds: new Set(),
      attachmentIds: new Set(),
      hasExplicitSelection: false,
      explicitSelectionCount: 0,
      useMultiSelectAccent: false,
      controlMode: false,
    };
  }

  const explicitSelectionCount =
    runtime.selection.momentIds.size + runtime.selection.nodeIds.size + runtime.selection.attachmentIds.size;
  return {
    momentIds: new Set(runtime.selection.momentIds),
    nodeIds: new Set(runtime.selection.nodeIds),
    attachmentIds: new Set(runtime.selection.attachmentIds),
    hasExplicitSelection: explicitSelectionCount > 0,
    explicitSelectionCount,
    useMultiSelectAccent: runtime.selection.controlMode && explicitSelectionCount > 0,
    controlMode: runtime.selection.controlMode,
  };
}

function hasControlDeleteSelection(timelineId = null) {
  return (
    runtime.selection.controlMode &&
    (!timelineId || runtime.selection.timelineId === timelineId) &&
    runtime.selection.momentIds.size + runtime.selection.nodeIds.size + runtime.selection.attachmentIds.size > 0
  );
}

function restoreHistoryState(serialized) {
  if (!serialized) {
    return;
  }

  try {
    const nextState = JSON.parse(serialized);
    if (!nextState || nextState.version !== 6 || !nextState.timelinesById || !nextState.momentsById) {
      return;
    }

    runtime.history.restoring = true;
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, nextState);
    ensureStateDefaults(state);
    runtime.history.currentSerialized = serializeState(state);
    runtime.document.dirty = runtime.history.currentSerialized !== runtime.document.savedStateSerialized;
    localStorage.setItem(STORAGE_KEY, runtime.history.currentSerialized);
  } catch (error) {
    console.warn("Could not restore a history snapshot.", error);
  } finally {
    runtime.history.restoring = false;
  }

  clearHoverState();
  clearSelection();
  runtime.graphDrag = null;
  runtime.panelScrollbarDrag = null;
  runtime.cameraAnimation = null;
  runtime.fadingTimelines = [];
  runtime.suppressCanvasClickUntil = 0;
  writeHashFromState();
  renderOverlay();
  syncCameraToCurrentTimeline(true);
}

function undoHistory() {
  if (!runtime.history.undoStack.length) {
    return;
  }

  const previousSerialized = runtime.history.undoStack.pop();
  runtime.history.redoStack.push(runtime.history.currentSerialized);
  restoreHistoryState(previousSerialized);
}

function redoHistory() {
  if (!runtime.history.redoStack.length) {
    return;
  }

  const nextSerialized = runtime.history.redoStack.pop();
  runtime.history.undoStack.push(runtime.history.currentSerialized);
  restoreHistoryState(nextSerialized);
}

function seedGraphFromMoments(target, timelineId, orderedMoments) {
  const graph = {
    view: { x: 0, y: 0, zoom: 1 },
    nextNodeNumber: 1,
    nextEdgeNumber: 1,
    nodesById: {},
    edgesById: {},
  };

  const count = orderedMoments.length;
  orderedMoments.forEach((moment, index) => {
    const nodeId = createGraphNodeForMoment(target, timelineId, moment, index, count, graph);
    moment.graphNodeId = moment.graphNodeId || nodeId;
  });

  return graph;
}

function createGraphNodeForMoment(target, timelineId, moment, index, totalCount, graphOverride = null) {
  target.graphsByTimelineId ||= {};
  let graph = graphOverride ?? target.graphsByTimelineId[timelineId];
  if (!graph) {
    graph = seedGraphFromMoments(target, timelineId, getMomentsForTimelineFrom(target, timelineId));
    target.graphsByTimelineId[timelineId] = graph;
  }
  const nodeId = `node-${timelineId}-${moment.id}`;
  if (graph.nodesById[nodeId]) {
    return nodeId;
  }

  const position = getOpenGraphNodePosition(timelineId, {
    target,
    graphOverride: graph,
    sourcePosition: moment.position,
    index,
    totalCount,
  });
  graph.nodesById[nodeId] = createGraphNodeRecord(
    nodeId,
    moment.title || "",
    position.x,
    position.y,
    moment.createdAt,
    graph.nextNodeNumber,
  );
  graph.nextNodeNumber += 1;
  return nodeId;
}

function getOpenGraphNodePosition(timelineId, options = {}) {
  const {
    target = state,
    graphOverride = null,
    ignoreNodeId = null,
    preferredPosition = null,
    sourcePosition = 0,
    index = 0,
    totalCount = 1,
    fallbackAnchor = null,
  } = options;
  const graph = graphOverride ?? target.graphsByTimelineId?.[timelineId];
  if (!graph) {
    return { x: 0, y: 0 };
  }

  const nodes = getGraphNodesFromGraph(graph, ignoreNodeId);
  const fallbackAngle = getGraphPlacementBaseAngle(sourcePosition, index, totalCount);
  if (!nodes.length) {
    return preferredPosition
      ? {
          x: Number.isFinite(preferredPosition.x) ? preferredPosition.x : 0,
          y: Number.isFinite(preferredPosition.y) ? preferredPosition.y : 0,
        }
      : { x: 0, y: 0 };
  }

  if (preferredPosition) {
    return resolveGraphNodePositionInGraph(graph, preferredPosition, {
      ignoreNodeId,
      fallbackAnchor,
      fallbackAngle,
    });
  }

  const anchorNodes = getGraphPlacementAnchorNodes(graph, ignoreNodeId);
  const layoutNodes = anchorNodes.length ? anchorNodes : nodes.slice(0, 1);
  const center = getGraphNodesCenter(layoutNodes);
  const maxNodeDistance = layoutNodes.reduce(
    (maxDistance, node) => Math.max(maxDistance, Math.hypot(node.x - center.x, node.y - center.y)),
    0,
  );
  const minDistance = GRAPH_NODE_MIN_DISTANCE;
  const baseRadius = Math.max(maxNodeDistance + minDistance * 1.25, minDistance * 1.35);

  for (let ringIndex = 0; ringIndex < 8; ringIndex += 1) {
    const radius = baseRadius + ringIndex * minDistance * 0.72;
    for (let stepIndex = 0; stepIndex < 18; stepIndex += 1) {
      const angle = fallbackAngle + getGraphPlacementOffsetIndex(stepIndex) * GRAPH_PLACEMENT_ANGLE_STEP;
      const candidate = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      };
      if (!isGraphNodePositionOverlapping(graph, candidate, { ignoreNodeId, minDistance })) {
        return candidate;
      }
    }
  }

  return resolveGraphNodePositionInGraph(
    graph,
    {
      x: center.x + Math.cos(fallbackAngle) * (baseRadius + minDistance * 3),
      y: center.y + Math.sin(fallbackAngle) * (baseRadius + minDistance * 3),
    },
    {
      ignoreNodeId,
      fallbackAnchor,
      fallbackAngle,
    },
  );
}

function getGraphNodesFromGraph(graph, ignoreNodeId = null) {
  return Object.values(graph?.nodesById ?? {}).filter((node) => node && node.id !== ignoreNodeId);
}

function getGraphPlacementAnchorNodes(graph, ignoreNodeId = null) {
  const connectedNodeIds = new Set();
  Object.values(graph?.edgesById ?? {}).forEach((edge) => {
    if (edge?.fromNodeId) {
      connectedNodeIds.add(edge.fromNodeId);
    }
    if (edge?.toNodeId) {
      connectedNodeIds.add(edge.toNodeId);
    }
  });

  return getGraphNodesFromGraph(graph, ignoreNodeId).filter((node) => connectedNodeIds.has(node.id));
}

function getGraphNodesCenter(nodes) {
  if (!nodes.length) {
    return { x: 0, y: 0 };
  }

  const bounds = nodes.reduce(
    (accumulator, node) => ({
      minX: Math.min(accumulator.minX, node.x),
      maxX: Math.max(accumulator.maxX, node.x),
      minY: Math.min(accumulator.minY, node.y),
      maxY: Math.max(accumulator.maxY, node.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );

  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

function getGraphPlacementBaseAngle(sourcePosition, index, totalCount) {
  if (Number.isFinite(sourcePosition)) {
    return fractionToRadians(sourcePosition);
  }
  return totalCount > 1 ? -Math.PI / 2 + (index / totalCount) * Math.PI * 2 : -Math.PI / 2;
}

function getGraphPlacementOffsetIndex(stepIndex) {
  if (stepIndex === 0) {
    return 0;
  }
  const magnitude = Math.ceil(stepIndex / 2);
  return stepIndex % 2 === 1 ? magnitude : -magnitude;
}

function isGraphNodePositionOverlapping(graph, position, options = {}) {
  const { ignoreNodeId = null, minDistance = GRAPH_NODE_MIN_DISTANCE } = options;
  return getGraphNodesFromGraph(graph, ignoreNodeId).some(
    (node) => Math.hypot(position.x - node.x, position.y - node.y) < minDistance,
  );
}

function resolveGraphNodePositionInGraph(graph, desiredPosition, options = {}) {
  const {
    ignoreNodeId = null,
    fallbackAnchor = null,
    fallbackAngle = -Math.PI / 2,
    minDistance = GRAPH_NODE_MIN_DISTANCE,
  } = options;
  const nodes = getGraphNodesFromGraph(graph, ignoreNodeId);
  const next = {
    x: Number.isFinite(desiredPosition?.x) ? desiredPosition.x : 0,
    y: Number.isFinite(desiredPosition?.y) ? desiredPosition.y : 0,
  };

  for (let pass = 0; pass < 18; pass += 1) {
    let moved = false;
    nodes.forEach((node, index) => {
      let dx = next.x - node.x;
      let dy = next.y - node.y;
      let distance = Math.hypot(dx, dy);
      if (distance >= minDistance) {
        return;
      }

      if (distance < 0.001) {
        const anchorDistance = fallbackAnchor ? Math.hypot(next.x - fallbackAnchor.x, next.y - fallbackAnchor.y) : 0;
        const angle =
          anchorDistance > 0.001
            ? Math.atan2(next.y - fallbackAnchor.y, next.x - fallbackAnchor.x)
            : fallbackAngle + (pass + index + 1) * GRAPH_PLACEMENT_ANGLE_STEP;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }

      const pushDistance = minDistance - distance + 0.5;
      next.x += (dx / distance) * pushDistance;
      next.y += (dy / distance) * pushDistance;
      moved = true;
    });

    if (!moved) {
      break;
    }
  }

  return next;
}

function separateGraphNodes(timelineId, target = state, graphOverride = null) {
  const graph = graphOverride ?? target.graphsByTimelineId?.[timelineId];
  if (!graph) {
    return;
  }

  const nodes = getGraphNodesFromGraph(graph);
  for (let pass = 0; pass < 10; pass += 1) {
    let moved = false;
    nodes.forEach((node, index) => {
      const next = resolveGraphNodePositionInGraph(graph, node, {
        ignoreNodeId: node.id,
        fallbackAngle: getGraphPlacementBaseAngle(null, index, nodes.length),
      });
      if (Math.hypot(next.x - node.x, next.y - node.y) > 0.001) {
        node.x = next.x;
        node.y = next.y;
        moved = true;
      }
    });
    if (!moved) {
      break;
    }
  }
}

function createGraphNodeRecord(id, title, x, y, timestamp, number = 1) {
  return {
    id,
    title,
    x,
    y,
    attachmentIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    number,
  };
}

function createGraphEdgeRecord(id, fromNodeId, toNodeId, timestamp, kind = "connection", number = 1) {
  return {
    id,
    fromNodeId,
    toNodeId,
    kind,
    createdAt: timestamp,
    updatedAt: timestamp,
    number,
  };
}

function getGraphForTimeline(timelineId, target = state) {
  target.graphsByTimelineId ||= {};
  const graph = target.graphsByTimelineId[timelineId];
  if (!graph && target.timelinesById?.[timelineId]) {
    const ensured = ensureGraphState(target, timelineId);
    return ensured ?? null;
  }
  return graph ?? null;
}

function getGraphNodeById(timelineId, nodeId, target = state) {
  return getGraphForTimeline(timelineId, target)?.nodesById?.[nodeId] ?? null;
}

function getGraphEdgeById(timelineId, edgeId, target = state) {
  return getGraphForTimeline(timelineId, target)?.edgesById?.[edgeId] ?? null;
}

function getGraphNodes(timelineId, target = state) {
  return Object.values(getGraphForTimeline(timelineId, target)?.nodesById ?? {});
}

function getGraphEdges(timelineId, target = state) {
  return Object.values(getGraphForTimeline(timelineId, target)?.edgesById ?? {});
}

function mountApp() {
  appRoot.innerHTML = `
    <div class="app-shell">
      <canvas class="timeline-canvas" aria-label="Fractal circular timeline"></canvas>
      <nav class="path-trail" data-path-bar aria-label="Timeline path"></nav>
      <div class="document-toolbar" data-document-toolbar>
        <div class="document-toolbar-row">
          <div class="document-status" data-document-status aria-live="polite"></div>
          <div class="document-actions" aria-label="Project actions">
            <button class="toolbar-btn" data-action="open-project" type="button">Open</button>
            <button class="toolbar-btn" data-action="save-project" type="button">Save</button>
            <button class="toolbar-btn" data-action="save-project-as" type="button">Save As</button>
            <button class="toolbar-btn reset-btn" data-action="reset-demo" type="button">New</button>
            <button
              class="toolbar-btn help-btn"
              data-action="toggle-help"
              type="button"
              aria-label="Show controls"
              aria-expanded="false"
              aria-controls="controls-help"
            >?</button>
          </div>
        </div>
        <section class="controls-help" data-controls-help id="controls-help" aria-label="Controls" hidden>
          <div class="controls-help-title">Controls</div>
          <dl class="controls-help-list">
            <div><dt>Make new node</dt><dd>Drag from a node to empty space</dd></div>
            <div><dt>Move node</dt><dd>Shift + drag node</dd></div>
            <div><dt>Add update</dt><dd>Double-click on a node</dd></div>
            <div><dt>Add isolated moment</dt><dd>Double-click the timeline ring</dd></div>
            <div><dt>Step time</dt><dd>Scroll inside the circle or use arrow keys</dd></div>
            <div><dt>Enter moment</dt><dd>Hover a moment dot and scroll up / pinch out</dd></div>
            <div><dt>Select (many)</dt><dd>Ctrl / ⌘ + click</dd></div>
            <div><dt>Delete</dt><dd>Ctrl / ⌘ select, then Delete or Backspace</dd></div>
            <div><dt>Reference link</dt><dd>Right-click point A, then right-click point B to finish</dd></div>
          </dl>
        </section>
      </div>
      <aside class="moment-meta-panel" data-meta-panel aria-label="Moment details">
        <input
          class="moment-meta-title"
          data-moment-title
          type="text"
          aria-label="Moment title"
          placeholder=""
          autocomplete="off"
          spellcheck="false"
        />
        <div class="moment-meta-body" data-moment-pages aria-label="Moment pages"></div>
      </aside>
      <input class="project-file-input" data-project-file-input type="file" accept="${PROJECT_FILE_ACCEPT}" hidden />
      <input class="attachment-file-input" data-attachment-file-input type="file" hidden />
      <button
        class="theme-toggle"
        data-action="toggle-theme"
        type="button"
        aria-label="Toggle dark mode"
        aria-pressed="false"
      >
        <span class="theme-toggle-sun" aria-hidden="true">☀</span>
        <span class="theme-toggle-moon" aria-hidden="true">☾</span>
      </button>
    </div>
  `;

  runtime.canvas = document.querySelector(".timeline-canvas");
  runtime.ctx = runtime.canvas.getContext("2d");
  runtime.elements.pathBar = document.querySelector("[data-path-bar]");
  runtime.elements.documentToolbar = document.querySelector("[data-document-toolbar]");
  runtime.elements.documentStatus = document.querySelector("[data-document-status]");
  runtime.elements.helpButton = document.querySelector("[data-action='toggle-help']");
  runtime.elements.controlsHelp = document.querySelector("[data-controls-help]");
  renderControlsHelpContents();
  runtime.elements.metaPanel = document.querySelector("[data-meta-panel]");
  runtime.elements.momentTitleInput = document.querySelector("[data-moment-title]");
  runtime.elements.momentPages = document.querySelector("[data-moment-pages]");
  runtime.elements.resetButton = document.querySelector(".reset-btn");
  runtime.elements.projectFileInput = document.querySelector("[data-project-file-input]");
  runtime.elements.attachmentFileInput = document.querySelector("[data-attachment-file-input]");
  runtime.elements.themeButton = document.querySelector("[data-action='toggle-theme']");
}

function bindEvents() {
  window.addEventListener("resize", () => syncCanvasSize(true));
  window.addEventListener("hashchange", () => syncRouteFromHash(false));
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("keydown", handleKeyDown);
  runtime.canvas.addEventListener("pointermove", handlePointerMove);
  runtime.canvas.addEventListener("pointerleave", clearHoverState);
  runtime.canvas.addEventListener("pointerdown", handleCanvasPointerDown);
  runtime.canvas.addEventListener("click", handleCanvasClick);
  runtime.canvas.addEventListener("contextmenu", handleCanvasContextMenu);
  runtime.canvas.addEventListener("dblclick", handleCanvasDoubleClick);
  runtime.canvas.addEventListener("wheel", handleCanvasWheel, { passive: false });
  window.addEventListener("pointermove", handleWindowPointerMove);
  window.addEventListener("pointerup", handleWindowPointerUp);
  appRoot.addEventListener("click", handleUiClick);
  runtime.elements.momentTitleInput.addEventListener("pointerdown", handleMomentTitlePointerDown);
  runtime.elements.momentTitleInput.addEventListener("focus", handleMomentTitleFocus);
  runtime.elements.momentTitleInput.addEventListener("input", handleMomentTitleInput);
  runtime.elements.momentPages.addEventListener("pointerdown", handleMomentPagesPointerDown);
  runtime.elements.momentPages.addEventListener("click", handleMomentPagesClick);
  runtime.elements.momentPages.addEventListener("contextmenu", handleMomentPagesContextMenu);
  runtime.elements.momentPages.addEventListener("input", handleMomentPagesInput);
  runtime.elements.momentPages.addEventListener("keydown", handleMomentPagesKeyDown);
  runtime.elements.momentPages.addEventListener("wheel", handleMomentPagesWheel, { passive: false });
  runtime.elements.projectFileInput.addEventListener("change", handleProjectFileInputChange);
  runtime.elements.attachmentFileInput.addEventListener("change", handleAttachmentFileInputChange);
}

function handleUiClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;

  if (action === "attach-file" && button.dataset.nodeId && button.dataset.timelineId) {
    void beginAttachmentAddFlow(button.dataset.timelineId, button.dataset.nodeId);
    return;
  }

  if (action === "remove-attachment" && button.dataset.attachmentId) {
    removeAttachment(button.dataset.attachmentId);
    return;
  }

  if (action === "toggle-theme") {
    toggleThemeMode();
    return;
  }

  if (action === "toggle-help") {
    toggleHelpPanel();
    return;
  }

  if (action === "toggle-tool-description") {
    toggleToolDescriptionPanel();
    return;
  }

  if (action === "reset-demo") {
    resetDemo();
    return;
  }

  if (action === "new-project") {
    void newProject();
    return;
  }

  if (action === "open-project") {
    void openProject();
    return;
  }

  if (action === "save-project") {
    void saveProject();
    return;
  }

  if (action === "save-project-as") {
    void saveProjectAs();
    return;
  }

  if (action === "open-timeline" && button.dataset.timelineId) {
    openTimeline(button.dataset.timelineId);
  }
}

function handleBeforeUnload(event) {
  if (!runtime.document.dirty) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
}

function renderDocumentChrome() {
  const status = runtime.elements.documentStatus;
  if (!(status instanceof HTMLElement)) {
    return;
  }

  const displayName = getDocumentDisplayName();
  const dirtySuffix = runtime.document.dirty ? " • unsaved" : "";
  const supportSuffix = runtime.document.supportsNativeFileSystem ? "" : " • Save falls back to Save As";
  status.textContent = `${displayName}${dirtySuffix}${supportSuffix}`;
}

function getDocumentDisplayName() {
  return runtime.document.fileName || "Browser draft";
}

function getCanvasPalette() {
  if (runtime.darkMode) {
    return {
      paper: "#222127",
      ink: "#e8e5ee",
      label: "#ece9f2",
      graphLine: "rgba(232,229,238,0.68)",
      graphMaskSolid: "rgba(34,33,39,0.96)",
      graphMaskSoft: "rgba(34,33,39,0.58)",
      graphMaskTransparent: "rgba(34,33,39,0)",
      blue: "#3b2f78",
      blueSoft: "#31295e",
      blueSoftest: "#282342",
      blueStroke: "#a78bfa",
      blueContext: "#8f7ae0",
      blueAmbient: "#725fc0",
      grayStroke: "#3d3a45",
      graySummaryStroke: "#34313a",
      grayConnectorPath: "#4b4655",
      grayConnector: "#302d35",
    };
  }

  return {
    paper: "#ffffff",
    ink: "#2b2731",
    label: "#2b2731",
    graphLine: "rgba(43,39,49,0.72)",
    graphMaskSolid: "rgba(255,255,255,0.96)",
    graphMaskSoft: "rgba(255,255,255,0.58)",
    graphMaskTransparent: "rgba(255,255,255,0)",
    blue: "#d8cffd",
    blueSoft: "#ede8ff",
    blueSoftest: "#f3f0ff",
    blueStroke: "#7c5cff",
    blueContext: "#9b88ef",
    blueAmbient: "#b8abf3",
    grayStroke: "#d8d4df",
    graySummaryStroke: "#dfdbe7",
    grayConnectorPath: "#cbc4d8",
    grayConnector: "#e6e2ec",
  };
}

function hexToRgba(hex, alpha) {
  const normalized = String(hex || "").replace("#", "").trim();
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    return `rgba(30,112,201,${alpha})`;
  }

  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function loadThemeMode() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "1";
  } catch (error) {
    console.warn("Could not load the theme preference.", error);
    return false;
  }
}

function saveThemeMode() {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, runtime.darkMode ? "1" : "0");
  } catch (error) {
    console.warn("Could not save the theme preference.", error);
  }
}

function applyThemeMode(enabled) {
  document.documentElement.classList.toggle("theme-dark", enabled);
  const button = runtime.elements.themeButton;
  if (button instanceof HTMLButtonElement) {
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("is-active", enabled);
  }
}

function toggleThemeMode() {
  runtime.darkMode = !runtime.darkMode;
  applyThemeMode(runtime.darkMode);
  saveThemeMode();
}

function toggleHelpPanel() {
  runtime.helpOpen = !runtime.helpOpen;
  renderHelpPanel();
}

function toggleToolDescriptionPanel() {
  runtime.helpDescriptionOpen = !runtime.helpDescriptionOpen;
  renderControlsHelpContents();
  renderHelpPanel();
}

function renderHelpPanel() {
  const panel = runtime.elements.controlsHelp;
  const button = runtime.elements.helpButton;
  if (panel instanceof HTMLElement) {
    panel.hidden = !runtime.helpOpen;
  }
  if (button instanceof HTMLButtonElement) {
    button.setAttribute("aria-expanded", String(runtime.helpOpen));
    button.classList.toggle("is-active", runtime.helpOpen);
  }
}

function renderControlsHelpContents() {
  const panel = runtime.elements.controlsHelp;
  if (!(panel instanceof HTMLElement)) {
    return;
  }

  panel.innerHTML = `
    <div class="controls-help-title">Controls</div>
    <button
      class="controls-help-about-toggle"
      data-action="toggle-tool-description"
      type="button"
      aria-expanded="${runtime.helpDescriptionOpen ? "true" : "false"}"
    >what is this tool?</button>
    <section class="controls-help-about" ${runtime.helpDescriptionOpen ? "" : "hidden"}>
      <h3>What is this for?</h3>
      <p>Mijks is for tracking how ideas, decisions, agreements, files, and contributions develop over time in complex and iterative creative work. Instead of treating every meeting, conversation, or update as a separate note, it lets you place moments in chronological order on a circular timeline and then zoom into any moment when it becomes its own deeper discussion or exploration.</p>
      <h3>Example workflow</h3>
      <p>Start with a project, meeting, or conversation. Add nodes for the topics you want to track, then add moments by updating an existing node, connecting a new node, or making more connections between existing nodes whenever someone introduces an idea, agreement, constraint, file, update, or reference link.</p>
      <p>Use the notes on the right to title a node and describe what happened, attach relevant files to the node, and link moments when a later update refers back to an earlier decision or conclusion. All controls for this are found in the help section.</p>
      <p>If a moment becomes important enough to unpack, enter it by zooming into it to create a nested timeline inside that moment, such as a meeting inside a project phase. You can also zoom out from where you started to fill in how a moment is embedded within a larger topic or context.</p>
      <p>This way, the app helps you keep the creative process readable even when the work becomes iterative, nested, and non-linear.</p>
    </section>
    <dl class="controls-help-list">
      <div><dt>Make new node</dt><dd>Drag from a node to empty space</dd></div>
      <div><dt>Move node</dt><dd>Shift + drag node</dd></div>
      <div><dt>Add update</dt><dd>Double-click on a node</dd></div>
      <div><dt>Add isolated moment</dt><dd>Double-click the timeline ring</dd></div>
      <div><dt>Step time</dt><dd>Scroll inside the circle or use arrow keys</dd></div>
      <div><dt>Enter moment</dt><dd>Hover a moment dot and scroll up / pinch out</dd></div>
      <div><dt>Select (many)</dt><dd>Ctrl / ⌘ + click</dd></div>
      <div><dt>Delete</dt><dd>Ctrl / ⌘ select, then Delete or Backspace</dd></div>
      <div><dt>Reference link</dt><dd>Right-click point A, then right-click point B to finish</dd></div>
    </dl>
  `;
}

function renderDocumentChrome() {
  const status = runtime.elements.documentStatus;
  if (!(status instanceof HTMLElement)) {
    return;
  }

  const displayName = getDocumentDisplayName();
  const suffixes = [
    runtime.document.dirty ? "unsaved" : "",
    runtime.document.supportsNativeFileSystem ? "" : "Save falls back to Save As",
  ].filter(Boolean);
  status.innerHTML = `
    <span class="document-status-name">${escapeHtml(displayName)}</span>
    ${suffixes.map((suffix) => `<span class="document-status-detail">${escapeHtml(suffix)}</span>`).join("")}
  `;
  renderHelpPanel();
}

function getSuggestedProjectFileName() {
  if (runtime.document.fileName) {
    return normalizeProjectFileName(runtime.document.fileName);
  }

  const preferredTitle = getVisibleTimelineLabel(state.rootTimelineId) || state.timelinesById[state.rootTimelineId]?.title || "";
  const baseName = sanitizeFileBaseName(preferredTitle) || "mijks-project";
  return `${baseName}.json`;
}

function normalizeProjectFileName(fileName) {
  const trimmed = String(fileName || "").trim();
  if (!trimmed) {
    return DEFAULT_PROJECT_FILENAME;
  }
  return trimmed.toLowerCase().endsWith(".json") ? trimmed : `${trimmed}.json`;
}

function sanitizeFileBaseName(name) {
  return String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function setSavedDocumentReference(fileName, fileHandle = null) {
  runtime.document.fileName = fileName ? normalizeProjectFileName(fileName) : "";
  runtime.document.fileHandle = fileHandle ?? null;
  runtime.document.savedStateSerialized = runtime.history.currentSerialized;
  runtime.document.dirty = false;
  renderDocumentChrome();
}

function clearDocumentReference() {
  runtime.document.fileName = "";
  runtime.document.fileHandle = null;
  runtime.document.savedStateSerialized = runtime.history.currentSerialized;
  runtime.document.dirty = false;
  renderDocumentChrome();
}

function isValidProjectStateObject(value) {
  return Boolean(value && typeof value === "object" && value.version === 6 && value.timelinesById && value.momentsById);
}

function parseProjectDocument(rawText) {
  const parsed = JSON.parse(rawText);

  if (isValidProjectStateObject(parsed)) {
    return parsed;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.kind === PROJECT_FILE_KIND &&
    parsed.formatVersion === PROJECT_FILE_FORMAT_VERSION &&
    isValidProjectStateObject(parsed.state)
  ) {
    return parsed.state;
  }

  throw new Error("This file is not a valid Mijks project JSON document.");
}

function replaceProjectState(nextState, options = {}) {
  const {
    fileName = "",
    fileHandle = null,
    clearDocument = false,
  } = options;

  clearHoverState();
  clearSelection();
  runtime.presentedFractionByTimelineId = {};
  runtime.presentedMomentFractionById = {};
  runtime.fadingTimelines = [];
  runtime.cameraAnimation = null;
  runtime.graphDrag = null;
  runtime.panelScrollbarDrag = null;
  runtime.attachments.availabilityById = {};
  runtime.attachments.transientFilesById = {};
  runtime.attachments.pickerIntent = null;
  runtime.suppressCanvasClickUntil = 0;

  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, nextState);
  ensureStateDefaults(state);

  runtime.history.undoStack = [];
  runtime.history.redoStack = [];
  runtime.history.currentSerialized = serializeState(state);
  localStorage.setItem(STORAGE_KEY, runtime.history.currentSerialized);

  if (clearDocument) {
    clearDocumentReference();
  } else {
    setSavedDocumentReference(fileName, fileHandle);
  }

  if (!window.location.hash) {
    writeHashFromState();
  } else {
    writeHashFromState();
  }
  renderOverlay();
  syncCameraToCurrentTimeline(true);
}

function confirmDiscardUnsavedChanges(actionLabel) {
  if (!runtime.document.dirty) {
    return true;
  }

  return window.confirm(`You have unsaved changes. Do you want to discard them and ${actionLabel}?`);
}

function isPickerAbortError(error) {
  return error?.name === "AbortError";
}

function reportDocumentError(error, fallbackMessage) {
  console.warn(fallbackMessage || "Document action failed.", error);
  window.alert(error instanceof Error ? error.message : fallbackMessage || "The document action failed.");
}

async function writeProjectToFileHandle(fileHandle) {
  const writable = await fileHandle.createWritable();
  await writable.write(serializeProjectDocument(state));
  await writable.close();
}

function triggerProjectDownload(fileName) {
  const blob = new Blob([serializeProjectDocument(state)], { type: PROJECT_FILE_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = normalizeProjectFileName(fileName);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

async function saveProject() {
  try {
    if (runtime.document.fileHandle && runtime.document.supportsNativeFileSystem) {
      await writeProjectToFileHandle(runtime.document.fileHandle);
      setSavedDocumentReference(runtime.document.fileHandle.name || runtime.document.fileName, runtime.document.fileHandle);
      return true;
    }

    return await saveProjectAs();
  } catch (error) {
    reportDocumentError(error, "Could not save the current project.");
    return false;
  }
}

async function saveProjectAs() {
  const suggestedName = getSuggestedProjectFileName();

  if (runtime.document.supportsNativeFileSystem) {
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: "JSON files",
            accept: {
              [PROJECT_FILE_MIME]: [".json"],
            },
          },
        ],
      });
      await writeProjectToFileHandle(fileHandle);
      setSavedDocumentReference(fileHandle.name || suggestedName, fileHandle);
      return true;
    } catch (error) {
      if (isPickerAbortError(error)) {
        return false;
      }
      console.warn("Falling back to browser download for Save As.", error);
    }
  }

  try {
    triggerProjectDownload(suggestedName);
    setSavedDocumentReference(suggestedName, null);
    return true;
  } catch (error) {
    reportDocumentError(error, "Could not download the project JSON file.");
    return false;
  }
}

async function newProject() {
  if (!confirmDiscardUnsavedChanges("start a new project")) {
    return false;
  }

  replaceProjectState(createInitialState(), { clearDocument: true });
  focusTitleEditor();
  return true;
}

async function openProject() {
  if (!confirmDiscardUnsavedChanges("open another project")) {
    return false;
  }

  if (runtime.document.supportsNativeFileSystem) {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "JSON files",
            accept: {
              [PROJECT_FILE_MIME]: [".json"],
            },
          },
        ],
      });
      const file = await fileHandle.getFile();
      const nextState = parseProjectDocument(await file.text());
      replaceProjectState(nextState, {
        fileName: fileHandle.name || file.name,
        fileHandle,
      });
      return true;
    } catch (error) {
      if (isPickerAbortError(error)) {
        return false;
      }
      console.warn("Falling back to browser file input for Open.", error);
    }
  }

  runtime.elements.projectFileInput.value = "";
  runtime.elements.projectFileInput.click();
  return true;
}

async function handleProjectFileInputChange(event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  const [file] = Array.from(input.files ?? []);
  input.value = "";
  if (!file) {
    return;
  }

  try {
    const nextState = parseProjectDocument(await file.text());
    replaceProjectState(nextState, {
      fileName: file.name,
      fileHandle: null,
    });
  } catch (error) {
    reportDocumentError(error, "Could not open the selected project file.");
  }
}

function openAttachmentDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  if (runtime.attachments.dbPromise) {
    return runtime.attachments.dbPromise;
  }

  runtime.attachments.dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    request.onerror = () => reject(request.error || new Error("Could not open the attachment database."));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATTACHMENT_DB_STORE)) {
        db.createObjectStore(ATTACHMENT_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  }).catch((error) => {
    console.warn("Could not open the attachment database.", error);
    runtime.attachments.dbPromise = null;
    return null;
  });

  return runtime.attachments.dbPromise;
}

function runAttachmentStoreRequest(mode, callback) {
  return openAttachmentDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) {
          resolve(null);
          return;
        }

        const transaction = db.transaction(ATTACHMENT_DB_STORE, mode);
        const store = transaction.objectStore(ATTACHMENT_DB_STORE);
        const request = callback(store);
        request.onerror = () => reject(request.error || new Error("Attachment database request failed."));
        request.onsuccess = () => resolve(request.result ?? null);
      }),
  );
}

function getStoredAttachmentSource(attachmentId) {
  return runAttachmentStoreRequest("readonly", (store) => store.get(attachmentId)).catch((error) => {
    console.warn("Could not read the stored attachment source.", error);
    return null;
  });
}

function storeAttachmentSource(attachmentId, source) {
  return runAttachmentStoreRequest("readwrite", (store) => store.put(source, attachmentId)).catch((error) => {
    console.warn("Could not store the attachment source.", error);
    return null;
  });
}

function getNodeAttachmentIds(timelineId, nodeId, target = state) {
  const node = getGraphNodeById(timelineId, nodeId, target);
  if (!node) {
    return [];
  }
  return Array.isArray(node.attachmentIds)
    ? node.attachmentIds.filter((attachmentId) => target.attachmentsById?.[attachmentId]?.nodeId === node.id)
    : [];
}

function getNodeAttachments(timelineId, nodeId, target = state) {
  return getNodeAttachmentIds(timelineId, nodeId, target)
    .map((attachmentId) => target.attachmentsById[attachmentId])
    .filter(Boolean);
}

function getNodeAndChildTimelineAttachments(timelineId, nodeId, target = state) {
  const attachmentsById = new Map();
  getNodeAttachments(timelineId, nodeId, target).forEach((attachment) => {
    attachmentsById.set(attachment.id, attachment);
  });

  getMomentsForGraphNode(timelineId, nodeId, target).forEach((moment) => {
    if (moment.childTimelineId) {
      collectTimelineAttachments(moment.childTimelineId, attachmentsById, target);
    }
  });

  return Array.from(attachmentsById.values());
}

function collectTimelineAttachments(timelineId, attachmentsById, target = state) {
  const graph = target.graphsByTimelineId?.[timelineId];
  Object.values(graph?.nodesById ?? {}).forEach((node) => {
    getNodeAttachments(timelineId, node.id, target).forEach((attachment) => {
      attachmentsById.set(attachment.id, attachment);
    });
  });

  getMomentsForTimelineFrom(target, timelineId).forEach((moment) => {
    if (moment.childTimelineId) {
      collectTimelineAttachments(moment.childTimelineId, attachmentsById, target);
    }
  });
}

function getAttachmentTimelineId(attachmentId, target = state) {
  const attachment = target.attachmentsById?.[attachmentId];
  if (!attachment) {
    return null;
  }

  const matchedGraphEntry = Object.entries(target.graphsByTimelineId ?? {}).find(([, graph]) => graph?.nodesById?.[attachment.nodeId]);
  return matchedGraphEntry?.[0] ?? null;
}

function isAttachmentPreviewable(attachment) {
  const mimeType = String(attachment?.mimeType || "").toLowerCase();
  const extension = String(attachment?.extension || "").toLowerCase();
  return mimeType === "application/pdf" || mimeType.startsWith("image/") || extension === ".pdf" || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(extension);
}

function getAttachmentStatus(attachmentId) {
  if (runtime.attachments.transientFilesById[attachmentId]) {
    return "available";
  }
  return runtime.attachments.availabilityById[attachmentId] || "checking";
}

function syncAttachmentAvailability(attachmentIds) {
  const uniqueIds = Array.from(new Set(attachmentIds.filter(Boolean)));
  if (!uniqueIds.length) {
    return;
  }

  const pendingIds = uniqueIds.filter(
    (attachmentId) =>
      !runtime.attachments.transientFilesById[attachmentId] &&
      runtime.attachments.availabilityById[attachmentId] == null,
  );
  if (!pendingIds.length) {
    return;
  }

  pendingIds.forEach((attachmentId) => {
    runtime.attachments.availabilityById[attachmentId] = "checking";
  });

  void (async () => {
    let changed = false;
    for (const attachmentId of pendingIds) {
      const storedSource = await getStoredAttachmentSource(attachmentId);
      const nextStatus = storedSource ? "available" : "missing";
      if (runtime.attachments.availabilityById[attachmentId] !== nextStatus) {
        runtime.attachments.availabilityById[attachmentId] = nextStatus;
        changed = true;
      }
    }

    if (changed && !isTextEntryTarget(document.activeElement)) {
      renderMomentMetadataPanel(runtime.elements.momentTitleInput.dataset.momentId);
    }
  })();
}

function updateAttachmentRecordFromFile(attachment, fileLike) {
  attachment.displayName = getAttachmentDisplayName(fileLike);
  attachment.extension = getAttachmentExtension(attachment.displayName);
  attachment.mimeType = String(fileLike?.type || "");
  attachment.size = Number.isFinite(fileLike?.size) ? fileLike.size : 0;
  attachment.lastModified = Number.isFinite(fileLike?.lastModified) ? fileLike.lastModified : null;
  attachment.updatedAt = new Date().toISOString();
}

function ensureNodeAttachmentReference(timelineId, nodeId, attachmentId) {
  const node = getGraphNodeById(timelineId, nodeId);
  if (!node) {
    return null;
  }

  node.attachmentIds ||= [];
  if (!node.attachmentIds.includes(attachmentId)) {
    node.attachmentIds.push(attachmentId);
  }
  return node;
}

async function createNodeAttachmentFromHandle(timelineId, nodeId, fileHandle) {
  const node = getGraphNodeById(timelineId, nodeId);
  if (!node || !fileHandle) {
    return null;
  }

  const file = await fileHandle.getFile();
  const attachmentId = createId("attachment");
  const now = new Date().toISOString();
  state.attachmentsById[attachmentId] = createAttachmentRecord(attachmentId, nodeId, file, now);
  ensureNodeAttachmentReference(timelineId, nodeId, attachmentId);
  runtime.attachments.availabilityById[attachmentId] = "available";
  delete runtime.attachments.transientFilesById[attachmentId];
  await storeAttachmentSource(attachmentId, fileHandle);
  return state.attachmentsById[attachmentId];
}

async function createNodeAttachmentFromFile(timelineId, nodeId, file) {
  const node = getGraphNodeById(timelineId, nodeId);
  if (!node || !file) {
    return null;
  }

  const attachmentId = createId("attachment");
  const now = new Date().toISOString();
  state.attachmentsById[attachmentId] = createAttachmentRecord(attachmentId, nodeId, file, now);
  ensureNodeAttachmentReference(timelineId, nodeId, attachmentId);
  runtime.attachments.transientFilesById[attachmentId] = file;
  runtime.attachments.availabilityById[attachmentId] = "available";
  await storeAttachmentSource(attachmentId, file);
  return state.attachmentsById[attachmentId];
}

async function relinkAttachmentFromHandle(attachmentId, fileHandle) {
  const attachment = state.attachmentsById[attachmentId];
  if (!attachment || !fileHandle) {
    return false;
  }

  const file = await fileHandle.getFile();
  updateAttachmentRecordFromFile(attachment, file);
  runtime.attachments.availabilityById[attachmentId] = "available";
  delete runtime.attachments.transientFilesById[attachmentId];
  await storeAttachmentSource(attachmentId, fileHandle);
  return true;
}

async function relinkAttachmentFromFile(attachmentId, file) {
  const attachment = state.attachmentsById[attachmentId];
  if (!attachment || !file) {
    return false;
  }

  updateAttachmentRecordFromFile(attachment, file);
  runtime.attachments.transientFilesById[attachmentId] = file;
  runtime.attachments.availabilityById[attachmentId] = "available";
  await storeAttachmentSource(attachmentId, file);
  return true;
}

async function beginAttachmentAddFlow(timelineId, nodeId) {
  if (!getGraphNodeById(timelineId, nodeId)) {
    return false;
  }

  if (runtime.document.supportsNativeFileSystem) {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      if (!handles?.length) {
        return false;
      }
      for (const fileHandle of handles) {
        await createNodeAttachmentFromHandle(timelineId, nodeId, fileHandle);
      }
      persistState();
      return true;
    } catch (error) {
      if (isPickerAbortError(error)) {
        return false;
      }
      console.warn("Falling back to browser file input for attachments.", error);
    }
  }

  runtime.attachments.pickerIntent = { mode: "add", timelineId, nodeId };
  runtime.elements.attachmentFileInput.multiple = true;
  runtime.elements.attachmentFileInput.value = "";
  runtime.elements.attachmentFileInput.click();
  return true;
}

async function beginAttachmentRelinkFlow(attachmentId) {
  const attachment = state.attachmentsById[attachmentId];
  if (!attachment) {
    return false;
  }

  if (runtime.document.supportsNativeFileSystem) {
    try {
      const [fileHandle] = await window.showOpenFilePicker({ multiple: false });
      if (!fileHandle) {
        return false;
      }
      await relinkAttachmentFromHandle(attachmentId, fileHandle);
      persistState();
      return true;
    } catch (error) {
      if (isPickerAbortError(error)) {
        return false;
      }
      console.warn("Falling back to browser file input for relinking an attachment.", error);
    }
  }

  runtime.attachments.pickerIntent = { mode: "relink", attachmentId };
  runtime.elements.attachmentFileInput.multiple = false;
  runtime.elements.attachmentFileInput.value = "";
  runtime.elements.attachmentFileInput.click();
  return true;
}

async function handleAttachmentFileInputChange(event) {
  const input = event.currentTarget;
  const pickerIntent = runtime.attachments.pickerIntent;
  runtime.attachments.pickerIntent = null;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!pickerIntent || !files.length) {
    return;
  }

  if (pickerIntent.mode === "add") {
    await Promise.all(files.map((file) => createNodeAttachmentFromFile(pickerIntent.timelineId, pickerIntent.nodeId, file)));
    persistState();
    return;
  }

  if (pickerIntent.mode === "relink") {
    await relinkAttachmentFromFile(pickerIntent.attachmentId, files[0]);
    persistState();
  }
}

function removeAttachment(attachmentId) {
  const attachment = state.attachmentsById[attachmentId];
  if (!attachment) {
    return;
  }

  Object.values(state.graphsByTimelineId).forEach((graph) => {
    Object.values(graph?.nodesById ?? {}).forEach((node) => {
      node.attachmentIds = (node.attachmentIds || []).filter((existingId) => existingId !== attachmentId);
    });
  });

  delete state.attachmentsById[attachmentId];
  pruneSelection();
  persistState();
}

async function resolveAttachmentFile(attachmentId) {
  const transientFile = runtime.attachments.transientFilesById[attachmentId];
  if (transientFile) {
    return transientFile;
  }

  const storedSource = await getStoredAttachmentSource(attachmentId);
  if (!storedSource) {
    runtime.attachments.availabilityById[attachmentId] = "missing";
    return null;
  }

  if (typeof storedSource.getFile === "function") {
    if (typeof storedSource.queryPermission === "function") {
      let permission = await storedSource.queryPermission({ mode: "read" });
      if (permission !== "granted" && typeof storedSource.requestPermission === "function") {
        permission = await storedSource.requestPermission({ mode: "read" });
      }
      if (permission !== "granted") {
        return null;
      }
    }

    runtime.attachments.availabilityById[attachmentId] = "available";
    return await storedSource.getFile();
  }

  if (storedSource instanceof Blob) {
    runtime.attachments.availabilityById[attachmentId] = "available";
    return storedSource;
  }

  runtime.attachments.availabilityById[attachmentId] = "missing";
  return null;
}

function openPreviewWindowShell() {
  try {
    const previewWindow = window.open("about:blank", "_blank");
    if (previewWindow) {
      previewWindow.opener = null;
      previewWindow.document.title = "Opening file...";
    }
    return previewWindow;
  } catch (error) {
    console.warn("Could not prepare a preview window.", error);
    return null;
  }
}

function closePreviewWindowShell(previewWindow) {
  try {
    if (previewWindow && !previewWindow.closed) {
      previewWindow.close();
    }
  } catch (error) {
    console.warn("Could not close the unused preview window.", error);
  }
}

async function openAttachment(attachmentId, previewWindow = null) {
  const attachment = state.attachmentsById[attachmentId];
  if (!attachment) {
    closePreviewWindowShell(previewWindow);
    return false;
  }

  if (!isAttachmentPreviewable(attachment)) {
    closePreviewWindowShell(previewWindow);
    return false;
  }

  try {
    const file = await resolveAttachmentFile(attachmentId);
    if (!file) {
      closePreviewWindowShell(previewWindow);
      await beginAttachmentRelinkFlow(attachmentId);
      return false;
    }

    const url = URL.createObjectURL(file);
    if (previewWindow && !previewWindow.closed) {
      previewWindow.location.href = url;
    } else {
      const popup = window.open(url, "_blank");
      if (popup) {
        popup.opener = null;
      } else {
        window.alert("Your browser blocked the preview tab. Allow pop-ups for this file, then try again.");
        window.setTimeout(() => URL.revokeObjectURL(url), 500);
        return false;
      }
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch (error) {
    closePreviewWindowShell(previewWindow);
    console.warn("Could not open the attachment.", error);
    window.alert("Could not open that file here. Try relinking it if the local file has moved.");
    return false;
  }
}

function handleKeyDown(event) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const lowerKey = event.key.toLowerCase();
    if (lowerKey === "s") {
      event.preventDefault();
      if (event.shiftKey) {
        void saveProjectAs();
      } else {
        void saveProject();
      }
      return;
    }

    if (lowerKey === "o") {
      event.preventDefault();
      void openProject();
      return;
    }

    if (lowerKey === "n") {
      event.preventDefault();
      void newProject();
      return;
    }
  }

  if (event.key === "Escape" && runtime.helpOpen) {
    event.preventDefault();
    runtime.helpOpen = false;
    renderHelpPanel();
    return;
  }

  if (isTextEntryTarget(event.target)) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const lowerKey = event.key.toLowerCase();
    if (lowerKey === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        redoHistory();
      } else {
        undoHistory();
      }
      return;
    }

    if (lowerKey === "y") {
      event.preventDefault();
      redoHistory();
      return;
    }
  }

  if (event.repeat) {
    return;
  }

  const context = getResolvedContext();

  if ((event.key === "Delete" || event.key === "Backspace") && hasControlDeleteSelection(context.timelineId)) {
    event.preventDefault();
    deleteCurrentSelection();
    return;
  }

  if (event.key === "Escape" || event.key === "Backspace") {
    event.preventDefault();
    zoomOut();
    return;
  }

  if (event.key === "Delete") {
    event.preventDefault();
    return;
  }

  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    stepActiveMoment(context.timelineId, 1);
    return;
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    stepActiveMoment(context.timelineId, -1);
    return;
  }

  if ((event.key === "Enter" || event.key === " ") && context.activeMomentId) {
    event.preventDefault();
    zoomIntoMoment(context.activeMomentId);
  }
}

function isTextEntryTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.closest("[data-meta-panel]") &&
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)
  );
}

function handleMomentTitleInput(event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  const inspector = getInspectorState(input.dataset.momentId);
  if (!inspector.activeMoment) {
    return;
  }

  const nextTitle = input.value;
  if (inspector.graphNode) {
    updateGraphNodeTitle(inspector.activeMoment.timelineId, inspector.graphNode.id, nextTitle);
  } else {
    inspector.activeMoment.title = nextTitle;
    inspector.activeMoment.updatedAt = new Date().toISOString();
    syncTimelineTitleFromMomentIfNeeded(inspector.activeMoment.timelineId, inspector.activeMoment.id, nextTitle);
  }
  saveState();
}

function handleMomentTitlePointerDown(event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement) || document.activeElement === input) {
    return;
  }

  event.preventDefault();
  input.focus();
  input.select();
}

function handleMomentTitleFocus(event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  window.requestAnimationFrame(() => {
    if (document.activeElement === input) {
      input.select();
    }
  });
}

function handleMomentPagesClick(event) {
  const attachment = event.target.closest("[data-attachment-id]");
  if (attachment instanceof HTMLElement) {
    if (isMultiSelectModifier(event)) {
      const activeMomentId = runtime.elements.momentTitleInput.dataset.momentId;
      const inspector = getInspectorState(activeMomentId);
      const attachmentIds = getAttachmentIdsFromElement(attachment);
      if (inspector.activeMoment && attachmentIds.length) {
        event.preventDefault();
        toggleAttachmentGroupSelection(inspector.activeMoment.timelineId, attachmentIds);
        renderMomentMetadataPanel(activeMomentId);
      }
    }
    return;
  }

  if (event.target.closest("[data-action]")) {
    return;
  }

  if (event.target.closest(".moment-pages-scrollbar")) {
    return;
  }

  const card = event.target.closest("[data-page-moment-id]");
  if (!(card instanceof HTMLElement)) {
    return;
  }

  const momentId = card.dataset.pageMomentId;
  if (!momentId) {
    return;
  }

  const activeMomentId = runtime.elements.momentTitleInput.dataset.momentId;
  const activeMoment = activeMomentId ? state.momentsById[activeMomentId] : null;
  if (!activeMoment || activeMoment.id === momentId) {
    return;
  }

  setSingleMomentSelection(activeMoment.timelineId, momentId);
  selectMoment(activeMoment.timelineId, momentId);
  focusActivePageEditor();
}

function handleMomentPagesContextMenu(event) {
  const attachment = event.target.closest("[data-attachment-id]");
  if (!(attachment instanceof HTMLElement)) {
    return;
  }

  const activeMomentId = runtime.elements.momentTitleInput.dataset.momentId;
  const inspector = getInspectorState(activeMomentId);
  if (!inspector.activeMoment) {
    return;
  }

  const attachmentIds = getAttachmentIdsFromElement(attachment);
  if (!attachmentIds.length) {
    return;
  }

  event.preventDefault();
  if (!isMultiSelectModifier(event)) {
    return;
  }

  toggleAttachmentGroupSelection(inspector.activeMoment.timelineId, attachmentIds);
  renderMomentMetadataPanel(activeMomentId);
}

function getAttachmentIdsFromElement(element) {
  const rawIds = element.dataset.attachmentIds || element.dataset.attachmentId || "";
  return rawIds
    .split(",")
    .map((attachmentId) => attachmentId.trim())
    .filter((attachmentId) => attachmentId && state.attachmentsById[attachmentId]);
}

function handleMomentPagesPointerDown(event) {
  const scrollbar = event.target.closest(".moment-pages-scrollbar");
  if (!(scrollbar instanceof HTMLElement)) {
    return;
  }

  const activeMomentId = runtime.elements.momentTitleInput.dataset.momentId;
  const inspector = getInspectorState(activeMomentId);
  if (!inspector.activeMoment || inspector.pages.length <= 1) {
    return;
  }

  const track = scrollbar.querySelector(".moment-pages-scrollbar-track");
  if (!(track instanceof HTMLElement)) {
    return;
  }

  const thumb = event.target.closest(".moment-pages-scrollbar-thumb");
  const thumbRect = thumb instanceof HTMLElement ? thumb.getBoundingClientRect() : null;
  const trackRect = track.getBoundingClientRect();
  const thumbHeight = Math.max(12, trackRect.height / inspector.pages.length);

  runtime.panelScrollbarDrag = {
    timelineId: inspector.activeMoment.timelineId,
    pageIds: inspector.pages.map((page) => page.id),
    offsetWithinThumb: thumbRect ? event.clientY - thumbRect.top : thumbHeight / 2,
  };

  event.preventDefault();
  updatePanelScrollbarDrag(event.clientY);
}

function handleMomentPagesInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLTextAreaElement)) {
    return;
  }

  syncMomentNotesFromTextarea(input);
}

function handleMomentPagesKeyDown(event) {
  const input = event.target;
  if (!(input instanceof HTMLTextAreaElement) || event.defaultPrevented) {
    return;
  }

  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }

  if (event.key === " " && tryInsertBulletPrefix(input)) {
    event.preventDefault();
    return;
  }

  if (event.key === "Enter" && tryContinueBulletList(input)) {
    event.preventDefault();
    return;
  }

  if (event.key === "Backspace" && tryRemoveBulletPrefix(input)) {
    event.preventDefault();
  }
}

function handleMomentPagesWheel(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.closest(".moment-attachments")) {
    return;
  }

  const activeMomentId = runtime.elements.momentTitleInput.dataset.momentId;
  const inspector = getInspectorState(activeMomentId);
  if (!inspector.activeMoment || inspector.pages.length <= 1) {
    return;
  }

  event.preventDefault();
  const direction = event.deltaY > 0 ? 1 : -1;
  if (!accumulatePanelWheelIntent(direction, Math.abs(event.deltaY))) {
    return;
  }

  const currentIndex = inspector.pages.findIndex((page) => page.id === inspector.activeMoment.id);
  const nextIndex = clamp(currentIndex + direction, 0, inspector.pages.length - 1);
  if (nextIndex === currentIndex) {
    return;
  }

  selectMoment(inspector.activeMoment.timelineId, inspector.pages[nextIndex].id);
  focusActivePageEditor();
}

function updatePanelScrollbarDrag(clientY) {
  const drag = runtime.panelScrollbarDrag;
  if (!drag) {
    return;
  }

  const track = runtime.elements.momentPages.querySelector(".moment-pages-scrollbar-track");
  if (!(track instanceof HTMLElement) || drag.pageIds.length <= 1) {
    return;
  }

  const trackRect = track.getBoundingClientRect();
  const thumbHeight = Math.max(12, trackRect.height / drag.pageIds.length);
  const availableTravel = Math.max(1, trackRect.height - thumbHeight);
  const nextThumbTop = clamp(clientY - trackRect.top - drag.offsetWithinThumb, 0, availableTravel);
  const ratio = availableTravel <= 0 ? 0 : nextThumbTop / availableTravel;
  const nextIndex = clamp(Math.round(ratio * (drag.pageIds.length - 1)), 0, drag.pageIds.length - 1);
  const nextMomentId = drag.pageIds[nextIndex];
  const currentMomentId = runtime.elements.momentTitleInput.dataset.momentId;

  if (nextMomentId && nextMomentId !== currentMomentId) {
    selectMoment(drag.timelineId, nextMomentId);
  }
}

function finishPanelScrollbarDrag() {
  runtime.panelScrollbarDrag = null;
}

function getInspectorState(momentId) {
  if (!momentId) {
    return {
      activeMoment: null,
      graphNode: null,
      pages: [],
      attachments: [],
    };
  }

  const activeMoment = state.momentsById[momentId] ?? null;
  if (!activeMoment) {
    return {
      activeMoment: null,
      graphNode: null,
      pages: [],
      attachments: [],
    };
  }

  const graphNode = activeMoment.graphNodeId ? getGraphNodeById(activeMoment.timelineId, activeMoment.graphNodeId) : null;
  const pages = graphNode ? getMomentsForGraphNode(activeMoment.timelineId, graphNode.id) : [activeMoment];
  const attachments = graphNode ? getNodeAndChildTimelineAttachments(activeMoment.timelineId, graphNode.id) : [];
  return {
    activeMoment,
    graphNode,
    pages,
    attachments,
  };
}

function syncMomentNotesFromTextarea(textarea) {
  const momentId = textarea.dataset.momentId;
  const moment = momentId ? state.momentsById[momentId] : null;
  if (!moment) {
    return;
  }

  moment.notes = textarea.value;
  moment.updatedAt = new Date().toISOString();
  saveState();
}

function updateGraphNodeTitle(timelineId, nodeId, title) {
  const graph = getGraphForTimeline(timelineId);
  const node = graph?.nodesById[nodeId];
  if (!node) {
    return;
  }

  const now = new Date().toISOString();
  node.title = title;
  node.updatedAt = now;
  getMomentsForGraphNode(timelineId, nodeId).forEach((moment) => {
    moment.title = title;
    moment.updatedAt = now;
  });
  syncTimelineTitleFromMomentIfNeeded(timelineId, getMomentsForGraphNode(timelineId, nodeId)[0]?.id ?? null, title);
}

function syncTimelineTitleFromMomentIfNeeded(timelineId, momentId, title) {
  const timeline = state.timelinesById[timelineId];
  if (!timeline || !momentId) {
    return;
  }

  const moments = getMomentsForTimeline(timelineId);
  if (moments.length !== 1 || moments[0]?.id !== momentId) {
    return;
  }

  timeline.title = String(title || "").trim();
  timeline.updatedAt = new Date().toISOString();
}

function getTimelineGraphSnapshot(timelineId, target = state) {
  return target.graphsByTimelineId?.[timelineId] ?? null;
}

function isTimelineUntouched(timelineId, target = state) {
  const timeline = target.timelinesById?.[timelineId];
  if (!timeline) {
    return false;
  }

  const moments = getMomentsForTimelineFrom(target, timelineId);
  if (moments.length !== 1) {
    return false;
  }

  const [moment] = moments;
  if (!moment) {
    return false;
  }

  if (String(moment.title || "").trim() || String(moment.notes || "").trim() || moment.graphEdgeId) {
    return false;
  }

  const graph = getTimelineGraphSnapshot(timelineId, target);
  const nodeIds = Object.keys(graph?.nodesById ?? {});
  const edgeIds = Object.keys(graph?.edgesById ?? {});
  if (edgeIds.length > 0 || nodeIds.length > 1) {
    return false;
  }

  const onlyNode = nodeIds.length === 1 ? graph.nodesById[nodeIds[0]] : null;
  if (onlyNode && String(onlyNode.title || "").trim()) {
    return false;
  }
  if (onlyNode && Array.isArray(onlyNode.attachmentIds) && onlyNode.attachmentIds.length > 0) {
    return false;
  }

  const hasLinks = Object.values(target.linksById ?? {}).some(
    (link) => link.fromMomentId === moment.id || link.toMomentId === moment.id,
  );
  if (hasLinks) {
    return false;
  }

  return true;
}

function getVisibleTimelineLabel(timelineId) {
  const timeline = state.timelinesById[timelineId];
  if (!timeline) {
    return "";
  }

  const trimmedTitle = String(timeline.title || "").trim();
  if (!trimmedTitle) {
    return "";
  }

  if (isTimelineUntouched(timelineId)) {
    const timelineCount = Object.keys(state.timelinesById).length;
    if (timelineId === state.rootTimelineId && timelineCount === 1) {
      return trimmedTitle;
    }
    return "";
  }

  return trimmedTitle;
}

function accumulatePanelWheelIntent(direction, deltaMagnitude) {
  const now = performance.now();
  const intent = runtime.panelWheelIntent;
  const stale = now - intent.updatedAt > 260;

  if (stale || intent.direction !== direction) {
    intent.direction = direction;
    intent.magnitude = 0;
  }

  intent.updatedAt = now;
  intent.magnitude += deltaMagnitude;
  if (intent.magnitude >= GRAPH_PAGE_SCROLL_THRESHOLD) {
    intent.direction = 0;
    intent.magnitude = 0;
    intent.updatedAt = 0;
    return true;
  }

  return false;
}

function tryInsertBulletPrefix(textarea) {
  if (textarea.selectionStart !== textarea.selectionEnd) {
    return false;
  }

  const line = getTextareaLineState(textarea);
  const match = line.beforeCaret.match(/^(\s*)-$/);
  if (!match) {
    return false;
  }

  replaceTextareaRange(textarea, line.lineStart, textarea.selectionStart, `${match[1]}• `);
  syncMomentNotesFromTextarea(textarea);
  return true;
}

function tryContinueBulletList(textarea) {
  if (textarea.selectionStart !== textarea.selectionEnd) {
    return false;
  }

  const line = getTextareaLineState(textarea);
  const bulletMatch = line.line.match(/^(\s*)•\s/);
  if (!bulletMatch) {
    return false;
  }

  const indent = bulletMatch[1];
  const hasTextAfterBullet = line.line.slice(bulletMatch[0].length).trim().length > 0;
  if (hasTextAfterBullet) {
    replaceTextareaRange(textarea, textarea.selectionStart, textarea.selectionEnd, `\n${indent}• `);
  } else {
    replaceTextareaRange(textarea, line.lineStart, line.lineEnd, indent);
  }
  syncMomentNotesFromTextarea(textarea);
  return true;
}

function tryRemoveBulletPrefix(textarea) {
  if (textarea.selectionStart !== textarea.selectionEnd) {
    return false;
  }

  const line = getTextareaLineState(textarea);
  const bulletMatch = line.line.match(/^(\s*)•\s/);
  if (!bulletMatch || line.beforeCaret !== bulletMatch[0]) {
    return false;
  }

  replaceTextareaRange(textarea, line.lineStart, line.lineStart + bulletMatch[0].length, bulletMatch[1]);
  syncMomentNotesFromTextarea(textarea);
  return true;
}

function getTextareaLineState(textarea) {
  const value = textarea.value;
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  const lineStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const nextNewline = value.indexOf("\n", selectionEnd);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  const line = value.slice(lineStart, lineEnd);

  return {
    selectionStart,
    selectionEnd,
    lineStart,
    lineEnd,
    line,
    beforeCaret: value.slice(lineStart, selectionStart),
  };
}

function replaceTextareaRange(textarea, start, end, text) {
  const nextValue = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  const nextCaret = start + text.length;
  textarea.value = nextValue;
  textarea.selectionStart = nextCaret;
  textarea.selectionEnd = nextCaret;
}

function handleCanvasPointerDown(event) {
  if (runtime.cameraAnimation) {
    return;
  }

  const context = getResolvedContext();
  const screenPoint = pointerToScreen(event);
  if (!isInsideGraphAreaScreen(context.timelineId, screenPoint)) {
    return;
  }

  const hitNode = getGraphNodeAtScreenPoint(context.timelineId, screenPoint);
  runtime.suppressCanvasClickUntil = performance.now() + 260;

  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  clearHoverState();
  if (hitNode) {
    if (isMultiSelectModifier(event)) {
      toggleNodeSelection(context.timelineId, hitNode.id);
      selectLatestMomentForGraphNode(context.timelineId, hitNode.id);
      return;
    }
    if (event.shiftKey) {
      beginGraphMoveDrag(context.timelineId, hitNode.id, screenPoint);
      return;
    }
    beginGraphCreateDrag(context.timelineId, hitNode.id, screenPoint);
    return;
  }

  if (!isMultiSelectModifier(event)) {
    clearSelection();
  }
}

function handleWindowPointerMove(event) {
  if (runtime.graphDrag) {
    updateGraphDrag(pointerToScreen(event));
    return;
  }

  if (runtime.panelScrollbarDrag) {
    updatePanelScrollbarDrag(event.clientY);
  }
}

function handleWindowPointerUp(event) {
  if (runtime.graphDrag) {
    finishGraphDrag(pointerToScreen(event), event.button);
    return;
  }

  if (runtime.panelScrollbarDrag) {
    finishPanelScrollbarDrag();
  }
}

function handlePointerMove(event) {
  if (runtime.graphDrag) {
    runtime.canvas.style.cursor =
      runtime.graphDrag.type === "create" ? "crosshair" : "grabbing";
    return;
  }

  if (runtime.cameraAnimation) {
    clearHoverState();
    return;
  }

  const context = getResolvedContext();
  const screenPoint = pointerToScreen(event);
  if (isInsideGraphAreaScreen(context.timelineId, screenPoint)) {
    const hitNode = getGraphNodeAtScreenPoint(context.timelineId, screenPoint);
    runtime.canvas.style.cursor = hitNode ? (event.shiftKey ? "grab" : "pointer") : "default";
    runtime.hoverMomentId = null;
    runtime.hoverPreviewMomentId = null;
    return;
  }

  runtime.canvas.style.cursor = "default";
  const pointer = pointerToWorld(event);
  const hitMoment = findMomentHit(context.timelineId, pointer);

  if (!hitMoment) {
    clearHoverState();
    return;
  }

  if (runtime.hoverMomentId === hitMoment.id) {
    return;
  }

  clearHoverState();
  runtime.hoverMomentId = hitMoment.id;
  runtime.hoverPreviewMomentId = hitMoment.id;
}

function handleCanvasClick(event) {
  if (performance.now() < runtime.suppressCanvasClickUntil) {
    return;
  }

  clearHoverState();

  const context = getResolvedContext();
  const screenPoint = pointerToScreen(event);
  if (isInsideGraphAreaScreen(context.timelineId, screenPoint)) {
    return;
  }

  const pointer = pointerToWorld(event);
  const moment = findMomentHit(context.timelineId, pointer);

  if (moment) {
    if (isMultiSelectModifier(event)) {
      toggleMomentSelection(context.timelineId, moment.id);
    } else {
      setSingleMomentSelection(context.timelineId, moment.id);
    }
    selectMoment(context.timelineId, moment.id);
    return;
  }

  if (!isMultiSelectModifier(event)) {
    clearSelection();
  }

  if (isInsideCenterHole(context.timelineId, pointer)) {
    zoomOut();
  }
}

function handleCanvasContextMenu(event) {
  const context = getResolvedContext();
  const screenPoint = pointerToScreen(event);
  if (isInsideGraphAreaScreen(context.timelineId, screenPoint)) {
    event.preventDefault();
    return;
  }

  event.preventDefault();
  clearHoverState();

  const pointer = pointerToWorld(event);
  const moment = findMomentHit(context.timelineId, pointer);

  if (!moment) {
    state.linkDraftMomentId = null;
    state.linkView = null;
    persistState();
    return;
  }

  if (!state.linkDraftMomentId || state.linkDraftMomentId === moment.id) {
    state.linkDraftMomentId = state.linkDraftMomentId === moment.id ? null : moment.id;
    state.linkView = null;
    selectMoment(context.timelineId, moment.id, { preserveDraft: true, preserveLinkView: true });
    persistState();
    return;
  }

  const link = createLink(state.linkDraftMomentId, moment.id);
  selectMoment(context.timelineId, moment.id);
  state.linkDraftMomentId = null;
  state.linkView = link
    ? {
        linkId: link.id,
        endpointMomentId: moment.id,
      }
    : null;
  persistState();
}

function handleCanvasDoubleClick(event) {
  clearHoverState();

  const context = getResolvedContext();
  const screenPoint = pointerToScreen(event);
  const graphNode = isInsideGraphAreaScreen(context.timelineId, screenPoint)
    ? getGraphNodeAtScreenPoint(context.timelineId, screenPoint)
    : null;
  if (graphNode) {
    event.preventDefault();
    createGraphNodeUpdate(context.timelineId, graphNode.id);
    return;
  }

  const pointer = pointerToWorld(event);
  const moment = findMomentHit(context.timelineId, pointer);

  if (moment) {
    zoomIntoMoment(moment.id);
    return;
  }

  const focusPose = buildPoseCache().get(context.timelineId);
  if (!focusPose) {
    return;
  }

  const metrics = getTimelineMetrics(focusPose.r);
  const distance = Math.hypot(pointer.x - focusPose.x, pointer.y - focusPose.y);
  const ringInner = focusPose.r - metrics.band;
  const ringOuter = focusPose.r + metrics.nodeRadius * 1.2;

  if (distance < ringInner || distance > ringOuter) {
    return;
  }

  const angle = Math.atan2(pointer.y - focusPose.y, pointer.x - focusPose.x);
  const fraction = normalizeFraction((angle + Math.PI / 2) / (Math.PI * 2));
  createMoment(context.timelineId, {
    sourcePosition: fraction,
    insertIndex: resolveMomentInsertionIndex(context.timelineId, fraction),
  });
}

function handleCanvasWheel(event) {
  const context = getResolvedContext();
  const pointer = pointerToWorld(event);
  const focusPose = buildPoseCache().get(context.timelineId);
  const hoveredMoment = findMomentHit(context.timelineId, pointer);

  if (!focusPose) {
    return;
  }

  if (hoveredMoment) {
    event.preventDefault();
    const direction = event.deltaY === 0 ? -1 : Math.sign(event.deltaY);
    if (accumulateWheelIntent("zoom-in", direction, Math.abs(event.deltaY), ZOOM_SCROLL_THRESHOLD)) {
      clearHoverState();
      zoomIntoMoment(hoveredMoment.id);
    }
    return;
  }

  const distance = Math.hypot(pointer.x - focusPose.x, pointer.y - focusPose.y);
  if (distance > focusPose.r) {
    event.preventDefault();
    const direction = event.deltaY === 0 ? 1 : Math.sign(event.deltaY);
    if (accumulateWheelIntent("zoom-out", direction, Math.abs(event.deltaY), ZOOM_OUT_SCROLL_THRESHOLD)) {
      clearHoverState();
      zoomOut();
    }
    return;
  }

  event.preventDefault();
  const direction = event.deltaY > 0 ? 1 : -1;
  const stepThreshold = getTimelineStepScrollThreshold(context.timelineId);
  if (accumulateWheelIntent("step", direction, Math.abs(event.deltaY), stepThreshold)) {
    clearHoverState();
    stepActiveMoment(context.timelineId, direction);
  }
}

function getTimelineStepScrollThreshold(timelineId) {
  const momentCount = getMomentsForTimeline(timelineId).length;
  if (momentCount <= 4) {
    return STEP_SCROLL_THRESHOLD;
  }

  const sensitivityMultiplier = clamp(Math.sqrt(momentCount / 4), 1, 2.75);
  return STEP_SCROLL_THRESHOLD / sensitivityMultiplier;
}

function syncRouteFromHash(initial) {
  const segments = parseHashSegments(window.location.hash);
  const rootTimelineId = segments[1] && state.timelinesById[segments[1]] ? segments[1] : state.rootTimelineId;
  let currentTimelineId = rootTimelineId;
  const nextStack = [];

  for (let index = 2; index < segments.length; index += 1) {
    const moment = state.momentsById[segments[index]];
    if (!moment || moment.timelineId !== currentTimelineId || !moment.childTimelineId || !state.timelinesById[moment.childTimelineId]) {
      break;
    }

    nextStack.push({ timelineId: currentTimelineId, momentId: moment.id });
    currentTimelineId = moment.childTimelineId;
  }

  state.navigationStack = nextStack;
  clearSelection();
  ensureLeafSelection(currentTimelineId);
  renderOverlay();
  syncCameraToCurrentTimeline(initial);
}

function parseHashSegments(hash) {
  if (!hash?.startsWith("#/")) {
    return ["timeline", state.rootTimelineId];
  }

  return hash.slice(2).split("/").filter(Boolean);
}

function writeHashFromState() {
  const segments = ["timeline", state.rootTimelineId, ...state.navigationStack.map((entry) => entry.momentId)];
  const nextHash = `#/${segments.join("/")}`;

  if (window.location.hash !== nextHash) {
    history.replaceState(null, "", nextHash);
  }
}

function getResolvedContext() {
  let currentTimelineId = state.rootTimelineId;
  const ancestry = [{ timelineId: currentTimelineId, viaMomentId: null }];

  state.navigationStack.forEach((entry) => {
    const moment = state.momentsById[entry.momentId];
    if (!moment || moment.timelineId !== currentTimelineId || !moment.childTimelineId || !state.timelinesById[moment.childTimelineId]) {
      return;
    }

    ancestry[ancestry.length - 1].viaMomentId = moment.id;
    currentTimelineId = moment.childTimelineId;
    ancestry.push({ timelineId: currentTimelineId, viaMomentId: null });
  });

  const activeMomentId = ensureLeafSelection(currentTimelineId);
  const activeMoment = activeMomentId ? state.momentsById[activeMomentId] : null;

  return {
    timelineId: currentTimelineId,
    timeline: state.timelinesById[currentTimelineId],
    activeMomentId,
    activeMoment,
    moments: getMomentsForTimeline(currentTimelineId),
    ancestry,
    depth: ancestry.length - 1,
  };
}

function getMomentsForTimeline(timelineId) {
  return getMomentsForTimelineFrom(state, timelineId);
}

function getMomentsForTimelineFrom(target, timelineId) {
  return Object.values(target.momentsById)
    .filter((moment) => moment.timelineId === timelineId)
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        left.position - right.position ||
        left.createdAt.localeCompare(right.createdAt),
    );
}

function getMomentsForGraphNode(timelineId, nodeId, target = state) {
  return getMomentsForTimelineFrom(target, timelineId).filter((moment) => moment.graphNodeId === nodeId);
}

function getMomentsForGraphEdge(timelineId, edgeId, target = state) {
  return getMomentsForTimelineFrom(target, timelineId).filter((moment) => moment.graphEdgeId === edgeId);
}

function ensureLeafSelection(timelineId, target = state) {
  const moments = getMomentsForTimelineFrom(target, timelineId);
  const activeMomentId = target.activeMomentIdByTimelineId[timelineId];

  if (activeMomentId && target.momentsById[activeMomentId]?.timelineId === timelineId) {
    return activeMomentId;
  }

  const nextMomentId = moments[0]?.id ?? null;
  target.activeMomentIdByTimelineId[timelineId] = nextMomentId;
  return nextMomentId;
}

function openTimeline(timelineId) {
  if (!state.timelinesById[timelineId]) {
    return;
  }

  clearHoverState();
  clearSelection();
  state.navigationStack = buildStackForTimeline(timelineId);
  ensureLeafSelection(timelineId);
  persistState();
  animateCameraToTimeline(timelineId);
}

function buildStackForTimeline(timelineId) {
  const entries = [];
  let currentTimeline = state.timelinesById[timelineId];

  while (currentTimeline?.parentMomentId) {
    const parentMoment = state.momentsById[currentTimeline.parentMomentId];
    if (!parentMoment) {
      break;
    }

    entries.unshift({ timelineId: parentMoment.timelineId, momentId: parentMoment.id });
    currentTimeline = state.timelinesById[parentMoment.timelineId];
  }

  return entries;
}

function selectMoment(timelineId, momentId, options = {}) {
  const moment = state.momentsById[momentId];
  if (!moment || moment.timelineId !== timelineId) {
    return;
  }

  if (!options.preserveDraft) {
    state.linkDraftMomentId = null;
  }
  state.activeMomentIdByTimelineId[timelineId] = momentId;
  if (!options.preserveLinkView) {
    updateLinkViewFromMoment(momentId);
  }
  persistState();
}

function stepActiveMoment(timelineId, direction) {
  const moments = getMomentsForTimeline(timelineId);
  if (!moments.length) {
    return;
  }

  const currentMomentId = ensureLeafSelection(timelineId);
  const currentIndex = moments.findIndex((moment) => moment.id === currentMomentId);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = normalizeIndex(safeIndex + direction, moments.length);
  state.linkDraftMomentId = null;
  state.activeMomentIdByTimelineId[timelineId] = moments[nextIndex].id;
  updateLinkViewFromMoment(moments[nextIndex].id);
  persistState();
}

function createMoment(timelineId, draft = {}) {
  const timeline = state.timelinesById[timelineId];
  if (!timeline) {
    return null;
  }

  const orderedMoments = getMomentsForTimeline(timelineId);
  const momentId = createId("moment");
  const now = new Date().toISOString();
  const title = draft.title ?? `Moment ${timeline.nextMomentNumber}`;
  const sourcePosition = normalizeFraction(draft.sourcePosition ?? draft.position ?? 0);
  const insertIndex = clampInsertIndex(draft.insertIndex ?? orderedMoments.length, orderedMoments.length);

  timeline.nextMomentNumber += 1;
  timeline.updatedAt = now;
  state.linkDraftMomentId = null;
  state.linkView = null;

  state.momentsById[momentId] = {
    id: momentId,
    timelineId,
    position: sourcePosition,
    order: insertIndex,
    title,
    notes: draft.notes ?? "",
    graphNodeId: draft.graphNodeId ?? null,
    graphEdgeId: draft.graphEdgeId ?? null,
    childTimelineId: null,
    createdAt: now,
    updatedAt: now,
  };

  const moment = state.momentsById[momentId];
  if (!moment.graphNodeId && !moment.graphEdgeId) {
    moment.graphNodeId = createGraphNodeForMoment(state, timelineId, moment, insertIndex, orderedMoments.length + 1);
  }

  runtime.presentedMomentFractionById[momentId] = sourcePosition;
  assignMomentOrderSequence(
    timelineId,
    [
      ...orderedMoments.slice(0, insertIndex).map((moment) => moment.id),
      momentId,
      ...orderedMoments.slice(insertIndex).map((moment) => moment.id),
    ],
  );
  arrangeTimelineMomentsEvenly(timelineId);
  state.activeMomentIdByTimelineId[timelineId] = momentId;
  setSingleMomentSelection(timelineId, momentId);
  persistState();
  return state.momentsById[momentId];
}

function createGraphNodeMoment(timelineId, nodeId, edgeId = null, options = {}) {
  return createMoment(timelineId, {
    title: options.title ?? "",
    notes: options.notes ?? "",
    graphNodeId: nodeId,
    graphEdgeId: edgeId,
    insertIndex: options.insertIndex ?? getMomentsForTimeline(timelineId).length,
    sourcePosition: options.sourcePosition ?? 0,
  });
}

function createGraphEdgeMoment(timelineId, edgeId, options = {}) {
  return createMoment(timelineId, {
    title: options.title ?? "",
    notes: options.notes ?? "",
    graphEdgeId: edgeId,
    insertIndex: options.insertIndex ?? getMomentsForTimeline(timelineId).length,
    sourcePosition: options.sourcePosition ?? 0,
  });
}

function beginGraphCreateDrag(timelineId, nodeId, screenPoint) {
  runtime.graphDrag = {
    type: "create",
    timelineId,
    nodeId,
    viewport: getGraphViewport(timelineId),
    startScreen: { ...screenPoint },
    currentScreen: { ...screenPoint },
    moved: false,
  };
}

function beginGraphPanDrag(timelineId, screenPoint) {
  const graph = getGraphForTimeline(timelineId);
  if (!graph) {
    return;
  }

  runtime.graphDrag = {
    type: "pan",
    timelineId,
    startScreen: { ...screenPoint },
    originX: graph.view.x,
    originY: graph.view.y,
    moved: false,
  };
}

function beginGraphMoveDrag(timelineId, nodeId, screenPoint) {
  const node = getGraphNodeById(timelineId, nodeId);
  const viewport = getGraphViewport(timelineId);
  if (!node || !viewport) {
    return;
  }

  const nodeIds =
    runtime.selection.timelineId === timelineId && runtime.selection.nodeIds.has(nodeId)
      ? Array.from(runtime.selection.nodeIds).filter((selectedNodeId) => getGraphNodeById(timelineId, selectedNodeId))
      : [nodeId];
  const local = graphScreenToLocal(timelineId, screenPoint, viewport);
  runtime.graphDrag = {
    type: "move",
    timelineId,
    nodeId,
    nodeIds,
    viewport,
    startLocal: local,
    startPositions: nodeIds.map((selectedNodeId) => {
      const selectedNode = getGraphNodeById(timelineId, selectedNodeId);
      return {
        nodeId: selectedNodeId,
        x: selectedNode?.x ?? 0,
        y: selectedNode?.y ?? 0,
      };
    }),
    moved: false,
  };
}

function updateGraphDrag(screenPoint) {
  const drag = runtime.graphDrag;
  if (!drag) {
    return;
  }

  const graph = getGraphForTimeline(drag.timelineId);
  if (!graph) {
    runtime.graphDrag = null;
    return;
  }

  if (drag.type === "move") {
    const local = graphScreenToLocal(drag.timelineId, screenPoint, drag.viewport);
    const delta = {
      x: local.x - drag.startLocal.x,
      y: local.y - drag.startLocal.y,
    };
    const resolvedDelta = resolveGraphNodeGroupDelta(graph, drag.nodeIds ?? [drag.nodeId], drag.startPositions ?? [], delta);
    const movedAt = new Date().toISOString();
    let movedAny = false;

    (drag.startPositions ?? []).forEach((startPosition) => {
      const node = getGraphNodeById(drag.timelineId, startPosition.nodeId);
      if (!node) {
        return;
      }

      node.x = startPosition.x + resolvedDelta.x;
      node.y = startPosition.y + resolvedDelta.y;
      node.updatedAt = movedAt;
      movedAny = true;
    });

    if (!movedAny) {
      runtime.graphDrag = null;
      return;
    }

    drag.moved = true;
    return;
  }

  drag.currentScreen = { ...screenPoint };
  drag.moved ||= Math.hypot(screenPoint.x - drag.startScreen.x, screenPoint.y - drag.startScreen.y) > 4;
}

function finishGraphDrag(screenPoint) {
  const drag = runtime.graphDrag;
  if (!drag) {
    return;
  }

  runtime.suppressCanvasClickUntil = performance.now() + 260;

  if (drag.type === "move") {
    runtime.graphDrag = null;
    saveState();
    return;
  }

  const dragDistance = Math.hypot(
    screenPoint.x - drag.startScreen.x,
    screenPoint.y - drag.startScreen.y,
  );

  if (dragDistance < 8) {
    runtime.graphDrag = null;
    setSingleNodeSelection(drag.timelineId, drag.nodeId);
    selectLatestMomentForGraphNode(drag.timelineId, drag.nodeId);
    return;
  }

  const targetNode = getGraphNodeAtScreenPoint(drag.timelineId, screenPoint, drag.viewport);
  if (targetNode && targetNode.id !== drag.nodeId) {
    runtime.graphDrag = null;
    createRelationshipGraphMoment(drag.timelineId, drag.nodeId, targetNode.id);
    return;
  }

  if (!isInsideGraphAreaScreen(drag.timelineId, screenPoint)) {
    runtime.graphDrag = null;
    selectLatestMomentForGraphNode(drag.timelineId, drag.nodeId);
    return;
  }

  runtime.graphDrag = null;
  createConnectedGraphNode(drag.timelineId, drag.nodeId, screenPoint, drag.viewport);
}

function resolveGraphNodeGroupDelta(graph, nodeIds, startPositions, desiredDelta) {
  const movingNodeIds = new Set(nodeIds);
  const externalNodes = getGraphNodesFromGraph(graph).filter((node) => !movingNodeIds.has(node.id));
  const startById = new Map(startPositions.map((position) => [position.nodeId, position]));
  const nextDelta = {
    x: Number.isFinite(desiredDelta.x) ? desiredDelta.x : 0,
    y: Number.isFinite(desiredDelta.y) ? desiredDelta.y : 0,
  };

  for (let pass = 0; pass < 18; pass += 1) {
    let moved = false;

    movingNodeIds.forEach((nodeId) => {
      const start = startById.get(nodeId);
      if (!start) {
        return;
      }

      const candidate = {
        x: start.x + nextDelta.x,
        y: start.y + nextDelta.y,
      };

      externalNodes.forEach((externalNode, externalIndex) => {
        let dx = candidate.x - externalNode.x;
        let dy = candidate.y - externalNode.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= GRAPH_NODE_MIN_DISTANCE) {
          return;
        }

        if (distance < 0.001) {
          const angle = (externalIndex + pass + 1) * GRAPH_PLACEMENT_ANGLE_STEP;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }

        const pushDistance = GRAPH_NODE_MIN_DISTANCE - distance + 0.5;
        nextDelta.x += (dx / distance) * pushDistance;
        nextDelta.y += (dy / distance) * pushDistance;
        moved = true;
      });
    });

    if (!moved) {
      break;
    }
  }

  return nextDelta;
}

function selectLatestMomentForGraphNode(timelineId, nodeId) {
  const moments = getMomentsForGraphNode(timelineId, nodeId);
  const latest = moments[moments.length - 1];
  if (latest) {
    selectMoment(timelineId, latest.id);
  }
}

function createConnectedGraphNode(timelineId, sourceNodeId, screenPoint, viewport = null) {
  if (!ensureGraphNodeTitled(timelineId, sourceNodeId)) {
    return null;
  }

  const graph = getGraphForTimeline(timelineId);
  const sourceNode = getGraphNodeById(timelineId, sourceNodeId);
  if (!graph || !sourceNode) {
    return null;
  }

  const now = new Date().toISOString();
  const nodeId = createId("node");
  const edgeId = createId("edge");
  const desiredLocal = graphScreenToLocal(timelineId, screenPoint, viewport);
  const local = getOpenGraphNodePosition(timelineId, {
    graphOverride: graph,
    preferredPosition: desiredLocal,
    fallbackAnchor: sourceNode,
  });

  graph.nodesById[nodeId] = createGraphNodeRecord(nodeId, "", local.x, local.y, now, graph.nextNodeNumber);
  graph.nextNodeNumber += 1;
  graph.edgesById[edgeId] = createGraphEdgeRecord(edgeId, sourceNodeId, nodeId, now, "branch", graph.nextEdgeNumber);
  graph.nextEdgeNumber += 1;

  const moment = createGraphNodeMoment(timelineId, nodeId, edgeId, {
    title: "",
    insertIndex: getMomentsForTimeline(timelineId).length,
  });
  focusTitleEditor();
  return moment;
}

function createRelationshipGraphMoment(timelineId, fromNodeId, toNodeId) {
  if (!ensureGraphNodeTitled(timelineId, fromNodeId) || !ensureGraphNodeTitled(timelineId, toNodeId)) {
    return null;
  }

  const graph = getGraphForTimeline(timelineId);
  const fromNode = getGraphNodeById(timelineId, fromNodeId);
  const toNode = getGraphNodeById(timelineId, toNodeId);
  if (!graph || !fromNode || !toNode) {
    return null;
  }

  const now = new Date().toISOString();
  const edgeId = createId("edge");
  graph.edgesById[edgeId] = createGraphEdgeRecord(edgeId, fromNodeId, toNodeId, now, "relationship", graph.nextEdgeNumber);
  graph.nextEdgeNumber += 1;

  return createGraphEdgeMoment(timelineId, edgeId, {
    title: `${fromNode.title} -> ${toNode.title}`,
    insertIndex: getMomentsForTimeline(timelineId).length,
  });
}

function createGraphNodeUpdate(timelineId, nodeId) {
  if (!ensureGraphNodeTitled(timelineId, nodeId)) {
    return null;
  }

  const node = getGraphNodeById(timelineId, nodeId);
  if (!node) {
    return null;
  }

  const moment = createGraphNodeMoment(timelineId, nodeId, null, {
    title: node.title,
    insertIndex: getMomentsForTimeline(timelineId).length,
  });
  focusActivePageEditor();
  return moment;
}

function ensureGraphNodeTitled(timelineId, nodeId) {
  const node = getGraphNodeById(timelineId, nodeId);
  if (!node || node.title.trim()) {
    return true;
  }

  selectLatestMomentForGraphNode(timelineId, nodeId);
  focusTitleEditor();
  return false;
}

function focusTitleEditor() {
  window.requestAnimationFrame(() => {
    const input = runtime.elements.momentTitleInput;
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  });
}

function focusActivePageEditor() {
  window.requestAnimationFrame(() => {
    const input = runtime.elements.momentPages?.querySelector(".moment-page-input");
    if (input instanceof HTMLTextAreaElement) {
      input.focus();
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
    }
  });
}

function getGraphAreaScreenMetrics(timelineId) {
  const pose = buildPoseCache().get(timelineId);
  if (!pose) {
    return null;
  }

  const screenPose = worldToScreen(pose.x, pose.y);
  const timelineMetrics = getTimelineMetrics(pose.r);
  const holeRadius = timelineMetrics.centerRadius * runtime.camera.scale;
  return {
    pose,
    centerX: screenPose.x,
    centerY: screenPose.y,
    radius: holeRadius,
    holeRadius,
  };
}

function isInsideGraphAreaScreen(timelineId, screenPoint) {
  const metrics = getGraphAreaScreenMetrics(timelineId);
  if (!metrics) {
    return false;
  }

  return Math.hypot(screenPoint.x - metrics.centerX, screenPoint.y - metrics.centerY) <= metrics.radius;
}

function getGraphViewport(timelineId) {
  const metrics = getGraphAreaScreenMetrics(timelineId);
  const graph = getGraphForTimeline(timelineId);
  if (!metrics || !graph) {
    return null;
  }

  if (runtime.graphDrag?.timelineId === timelineId && runtime.graphDrag.viewport) {
    return runtime.graphDrag.viewport;
  }

  const nodes = getGraphNodes(timelineId);
  if (!nodes.length) {
    return {
      metrics,
      zoom: GRAPH_ZOOM_MAX,
      offsetX: 0,
      offsetY: 0,
    };
  }

  const bounds = nodes.reduce(
    (accumulator, node) => ({
      minX: Math.min(accumulator.minX, node.x),
      maxX: Math.max(accumulator.maxX, node.x),
      minY: Math.min(accumulator.minY, node.y),
      maxY: Math.max(accumulator.maxY, node.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const maxNodeDistance = nodes.reduce(
    (maxDistance, node) => Math.max(maxDistance, Math.hypot(node.x - centerX, node.y - centerY)),
    0,
  );
  const readableRadiusPx = Math.max(24, metrics.radius * 0.82);
  const nodePaddingPx = 54;
  const fittedZoom =
    maxNodeDistance <= 0.0001
      ? GRAPH_ZOOM_MAX
      : clamp((readableRadiusPx - nodePaddingPx) / maxNodeDistance, GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX);

  return {
    metrics,
    zoom: fittedZoom,
    offsetX: -centerX * fittedZoom,
    offsetY: -centerY * fittedZoom,
  };
}

function graphLocalToScreen(timelineId, point, viewport = null) {
  const nextViewport = viewport ?? getGraphViewport(timelineId);
  if (!nextViewport) {
    return { x: 0, y: 0 };
  }

  return {
    x: nextViewport.metrics.centerX + nextViewport.offsetX + point.x * nextViewport.zoom,
    y: nextViewport.metrics.centerY + nextViewport.offsetY + point.y * nextViewport.zoom,
  };
}

function graphScreenToLocal(timelineId, screenPoint, viewport = null) {
  const nextViewport = viewport ?? getGraphViewport(timelineId);
  if (!nextViewport) {
    return { x: 0, y: 0 };
  }

  return {
    x: (screenPoint.x - nextViewport.metrics.centerX - nextViewport.offsetX) / nextViewport.zoom,
    y: (screenPoint.y - nextViewport.metrics.centerY - nextViewport.offsetY) / nextViewport.zoom,
  };
}

function getGraphNodeAtScreenPoint(timelineId, screenPoint, viewport = null) {
  const nextViewport = viewport ?? getGraphViewport(timelineId);
  if (!nextViewport) {
    return null;
  }

  const nodes = getGraphNodes(timelineId);
  const radius = clamp(GRAPH_HIT_RADIUS * nextViewport.zoom, 16, 62);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const screen = graphLocalToScreen(timelineId, node, nextViewport);
    if (Math.hypot(screenPoint.x - screen.x, screenPoint.y - screen.y) <= radius) {
      return node;
    }
  }

  return null;
}

function zoomGraphAtPoint(timelineId, screenPoint, deltaY) {
  return;
}

function resolveMomentInsertionIndex(timelineId, fraction) {
  const moments = getMomentsForTimeline(timelineId);
  if (!moments.length) {
    return 0;
  }

  const nextIndex = moments.findIndex((moment) => moment.position > fraction + 0.0001);
  return nextIndex === -1 ? moments.length : nextIndex;
}

function clampInsertIndex(value, length) {
  return Math.min(length, Math.max(0, Math.round(value)));
}

function assignMomentOrderSequence(timelineId, orderedIds, target = state) {
  orderedIds.forEach((momentId, index) => {
    const moment = target.momentsById[momentId];
    if (!moment || moment.timelineId !== timelineId) {
      return;
    }
    moment.order = index;
    moment.updatedAt = new Date().toISOString();
  });
}

function createChildTimeline(momentId) {
  const moment = state.momentsById[momentId];
  if (!moment) {
    return null;
  }

  if (moment.childTimelineId && state.timelinesById[moment.childTimelineId]) {
    return state.timelinesById[moment.childTimelineId];
  }

  const timelineId = createId("timeline");
  const now = new Date().toISOString();

  state.timelinesById[timelineId] = {
    id: timelineId,
    title: "",
    parentMomentId: moment.id,
    nextMomentNumber: 2,
    createdAt: now,
    updatedAt: now,
  };

  moment.childTimelineId = timelineId;
  moment.updatedAt = now;
  const starterMomentId = createId("moment");
  state.momentsById[starterMomentId] = createMomentRecord(starterMomentId, timelineId, 0, "", now, 0);
  state.activeMomentIdByTimelineId[timelineId] = starterMomentId;
  runtime.presentedMomentFractionById[starterMomentId] = 0;
  state.graphsByTimelineId[timelineId] = {
    view: { x: 0, y: 0, zoom: 1 },
    nextNodeNumber: 2,
    nextEdgeNumber: 1,
    nodesById: {
      [`node-${timelineId}-starter`]: createGraphNodeRecord(`node-${timelineId}-starter`, "", 0, 0, now, 1),
    },
    edgesById: {},
  };
  state.momentsById[starterMomentId].graphNodeId = `node-${timelineId}-starter`;
  return state.timelinesById[timelineId];
}

function zoomIntoMoment(momentId) {
  const moment = state.momentsById[momentId];
  if (!moment) {
    return;
  }

  const parentPose = buildPoseCache().get(moment.timelineId);
  const anchor = parentPose ? getChildPoseFromMoment(parentPose, moment) : null;
  const wasUntouched = !moment.childTimelineId || isTimelineUntouched(moment.childTimelineId);
  clearHoverState();
  clearSelection();
  createChildTimeline(momentId);

  if (!moment.childTimelineId) {
    return;
  }

  state.activeMomentIdByTimelineId[moment.timelineId] = moment.id;
  state.navigationStack.push({ timelineId: moment.timelineId, momentId: moment.id });
  ensureLeafSelection(moment.childTimelineId);
  persistState();
  animateCameraToTimeline(moment.childTimelineId, { anchorWorld: anchor });
  if (wasUntouched) {
    focusTitleEditor();
  }
}

  function zoomOut() {
    const currentTimelineId = getResolvedContext().timelineId;
    const currentPose = buildPoseCache().get(currentTimelineId);
    if (!state.navigationStack.length) {
      if (!createParentTimelineAboveRoot(currentTimelineId)) {
        return;
      }

      const childPose = buildPoseCache().get(currentTimelineId);
      const parentTimelineId = state.rootTimelineId;
      const parentTarget = getCameraTarget(parentTimelineId);
      const anchor = childPose ? { x: childPose.x, y: childPose.y } : null;
      const toScreen =
        anchor && parentTarget
          ? {
              x: (anchor.x - parentTarget.x) * parentTarget.scale + runtime.width / 2,
              y: (anchor.y - parentTarget.y) * parentTarget.scale + runtime.height / 2,
            }
          : null;

      animateCameraToTimeline(parentTimelineId, {
        anchorWorld: anchor,
        fromScreen: {
          x: runtime.width / 2,
          y: runtime.height / 2,
        },
        toScreen,
      });
      return;
    }

    const anchor = currentPose ? { x: currentPose.x, y: currentPose.y } : null;
  if (currentPose) {
    runtime.fadingTimelines.push({
      timelineId: currentTimelineId,
      startedAt: performance.now(),
        duration: GHOST_FADE_DURATION,
    });
  }
  clearHoverState();
  clearSelection();
  state.navigationStack.pop();
  persistState();
    const parentTimelineId = getResolvedContext().timelineId;
    const parentTarget = getCameraTarget(parentTimelineId);
    const toScreen =
      anchor && parentTarget
        ? {
            x: (anchor.x - parentTarget.x) * parentTarget.scale + runtime.width / 2,
            y: (anchor.y - parentTarget.y) * parentTarget.scale + runtime.height / 2,
          }
        : null;

    animateCameraToTimeline(parentTimelineId, {
      anchorWorld: anchor,
      toScreen,
    });
  }

function createParentTimelineAboveRoot(currentTimelineId) {
  const currentTimeline = state.timelinesById[currentTimelineId];
  if (!currentTimeline || currentTimeline.parentMomentId || currentTimelineId !== state.rootTimelineId) {
    return null;
  }

  const now = new Date().toISOString();
  const parentTimelineId = createId("timeline");
  const parentMomentId = createId("moment");

  state.timelinesById[parentTimelineId] = {
    id: parentTimelineId,
    title: "",
    parentMomentId: null,
    nextMomentNumber: 2,
    createdAt: now,
    updatedAt: now,
  };

  state.momentsById[parentMomentId] = createMomentRecord(
    parentMomentId,
    parentTimelineId,
    0,
    "",
    now,
    0,
  );
  state.momentsById[parentMomentId].childTimelineId = currentTimelineId;

  currentTimeline.parentMomentId = parentMomentId;
  currentTimeline.updatedAt = now;
  state.rootTimelineId = parentTimelineId;
  state.activeMomentIdByTimelineId[parentTimelineId] = parentMomentId;
  runtime.presentedMomentFractionById[parentMomentId] = 0;
  runtime.fadingTimelines.push({
    timelineId: currentTimelineId,
    startedAt: performance.now(),
    duration: GHOST_FADE_DURATION,
  });
  clearHoverState();
  clearSelection();
  persistState();
  return state.timelinesById[parentTimelineId];
}

function getParentTimelineTitle(currentTitle) {
  const trimmed = String(currentTitle || "").trim();
  if (!trimmed) {
    return "Outer shell";
  }
  return trimmed.toLowerCase().includes("shell") ? `Wider ${trimmed}` : `${trimmed} context`;
}

function arrangeTimelineMomentsEvenly(timelineId, target = state) {
  const ordered = getMomentsForTimelineFrom(target, timelineId);
  const count = ordered.length;
  if (!count) {
    return;
  }

  ordered.forEach((moment, index) => {
    moment.position = normalizeFraction(index / count);
    moment.updatedAt = new Date().toISOString();
  });
}

function createLink(fromMomentId, toMomentId) {
  if (fromMomentId === toMomentId || !state.momentsById[fromMomentId] || !state.momentsById[toMomentId]) {
    return null;
  }

  const duplicate = Object.values(state.linksById).find(
    (link) =>
      (link.fromMomentId === fromMomentId && link.toMomentId === toMomentId) ||
      (link.fromMomentId === toMomentId && link.toMomentId === fromMomentId),
  );
  if (duplicate) {
    return duplicate;
  }

  const linkId = createId("link");
  state.linksById[linkId] = {
    id: linkId,
    fromMomentId,
    toMomentId,
    createdAt: new Date().toISOString(),
  };
  return state.linksById[linkId];
}

function updateLinkViewFromMoment(momentId) {
  const connectedLinks = Object.values(state.linksById).filter(
    (link) => link.fromMomentId === momentId || link.toMomentId === momentId,
  );

  if (!connectedLinks.length) {
    state.linkView = null;
    return;
  }

  const preferredLink =
    connectedLinks.find((link) => link.id === state.linkView?.linkId) ?? connectedLinks[0];
  state.linkView = {
    linkId: preferredLink.id,
    endpointMomentId: momentId,
  };
}

function deleteCurrentSelection() {
  const context = getResolvedContext();
  const timelineId = context.timelineId;
  const graph = getGraphForTimeline(timelineId);
  const selection = getSelectionForTimeline(timelineId);
  if (!selection.controlMode || !selection.hasExplicitSelection) {
    return;
  }

  const deletedMomentIds = new Set(selection.momentIds);
  const deletedNodeIds = new Set(selection.nodeIds);
  const deletedAttachmentIds = new Set(selection.attachmentIds);
  const deletedEdgeIds = new Set();
  const deletedTimelineIds = new Set();

  if (!deletedMomentIds.size && !deletedNodeIds.size && !deletedAttachmentIds.size) {
    return;
  }

  let changed = true;
  while (changed) {
    changed = false;

    deletedNodeIds.forEach((nodeId) => {
      getMomentsForGraphNode(timelineId, nodeId).forEach((moment) => {
        if (!deletedMomentIds.has(moment.id)) {
          deletedMomentIds.add(moment.id);
          changed = true;
        }
      });

      getGraphEdges(timelineId).forEach((edge) => {
        if ((edge.fromNodeId === nodeId || edge.toNodeId === nodeId) && !deletedEdgeIds.has(edge.id)) {
          deletedEdgeIds.add(edge.id);
          changed = true;
        }
      });
    });

    deletedMomentIds.forEach((momentId) => {
      const moment = state.momentsById[momentId];
      if (moment?.timelineId === timelineId && moment.graphEdgeId && !deletedEdgeIds.has(moment.graphEdgeId)) {
        deletedEdgeIds.add(moment.graphEdgeId);
        changed = true;
      }
    });

    deletedEdgeIds.forEach((edgeId) => {
      getMomentsForGraphEdge(timelineId, edgeId).forEach((moment) => {
        if (!deletedMomentIds.has(moment.id)) {
          deletedMomentIds.add(moment.id);
          changed = true;
        }
      });
    });

    if (graph) {
      const survivingNodeIds = new Set();
      getMomentsForTimeline(timelineId).forEach((moment) => {
        if (!deletedMomentIds.has(moment.id) && moment.graphNodeId) {
          survivingNodeIds.add(moment.graphNodeId);
        }
      });

      getGraphNodes(timelineId).forEach((node) => {
        if (!deletedNodeIds.has(node.id) && !survivingNodeIds.has(node.id)) {
          deletedNodeIds.add(node.id);
          changed = true;
        }
      });
    }
  }

  Array.from(deletedMomentIds).forEach((momentId) => collectMomentSubtreeForDeletion(momentId, deletedMomentIds, deletedTimelineIds));

  Object.keys(state.linksById).forEach((linkId) => {
    const link = state.linksById[linkId];
    if (deletedMomentIds.has(link.fromMomentId) || deletedMomentIds.has(link.toMomentId)) {
      delete state.linksById[linkId];
    }
  });

  deletedNodeIds.forEach((nodeId) => {
    getNodeAttachmentIds(timelineId, nodeId).forEach((attachmentId) => deletedAttachmentIds.add(attachmentId));
  });
  deletedTimelineIds.forEach((deletedTimelineId) => {
    getGraphNodes(deletedTimelineId).forEach((node) => {
      (node.attachmentIds || []).forEach((attachmentId) => deletedAttachmentIds.add(attachmentId));
    });
  });

  if (graph) {
    deletedEdgeIds.forEach((edgeId) => {
      delete graph.edgesById[edgeId];
    });
    deletedNodeIds.forEach((nodeId) => {
      delete graph.nodesById[nodeId];
    });
  }

  deletedAttachmentIds.forEach((attachmentId) => {
    delete state.attachmentsById[attachmentId];
  });
  if (deletedAttachmentIds.size) {
    Object.values(state.graphsByTimelineId).forEach((timelineGraph) => {
      Object.values(timelineGraph?.nodesById ?? {}).forEach((node) => {
        node.attachmentIds = (node.attachmentIds || []).filter((attachmentId) => !deletedAttachmentIds.has(attachmentId));
      });
    });
  }

  deletedTimelineIds.forEach((deletedTimelineId) => {
    delete state.timelinesById[deletedTimelineId];
    delete state.graphsByTimelineId[deletedTimelineId];
    delete state.activeMomentIdByTimelineId[deletedTimelineId];
    delete runtime.presentedFractionByTimelineId[deletedTimelineId];
  });

  deletedMomentIds.forEach((momentId) => {
    if (runtime.hoverMomentId === momentId) {
      runtime.hoverMomentId = null;
    }
    if (runtime.hoverPreviewMomentId === momentId) {
      runtime.hoverPreviewMomentId = null;
    }
    delete state.momentsById[momentId];
    delete runtime.presentedMomentFractionById[momentId];
  });

  Object.values(state.momentsById).forEach((moment) => {
    if (moment.childTimelineId && !state.timelinesById[moment.childTimelineId]) {
      moment.childTimelineId = null;
    }
  });

  state.navigationStack = state.navigationStack.filter((entry) => {
    const moment = state.momentsById[entry.momentId];
    return Boolean(
      state.timelinesById[entry.timelineId] &&
        moment &&
        moment.timelineId === entry.timelineId &&
        moment.childTimelineId &&
        state.timelinesById[moment.childTimelineId],
    );
  });

  if (state.linkDraftMomentId && !state.momentsById[state.linkDraftMomentId]) {
    state.linkDraftMomentId = null;
  }

  if (
    state.linkView &&
    (!state.linksById[state.linkView.linkId] || !state.momentsById[state.linkView.endpointMomentId])
  ) {
    state.linkView = null;
  }

  if (state.timelinesById[timelineId]) {
    const orderedMomentIds = getMomentsForTimeline(timelineId).map((moment) => moment.id);
    assignMomentOrderSequence(timelineId, orderedMomentIds);
    arrangeTimelineMomentsEvenly(timelineId);
    ensureLeafSelection(timelineId);
  }

  clearSelection();
  pruneSelection();
  persistState();
}

function collectMomentSubtreeForDeletion(momentId, deletedMomentIds, deletedTimelineIds) {
  const moment = state.momentsById[momentId];
  if (!moment?.childTimelineId) {
    return;
  }

  collectTimelineSubtreeForDeletion(moment.childTimelineId, deletedMomentIds, deletedTimelineIds);
}

function collectTimelineSubtreeForDeletion(timelineId, deletedMomentIds, deletedTimelineIds) {
  if (!timelineId || deletedTimelineIds.has(timelineId) || !state.timelinesById[timelineId]) {
    return;
  }

  deletedTimelineIds.add(timelineId);
  getMomentsForTimeline(timelineId).forEach((moment) => {
    deletedMomentIds.add(moment.id);
    if (moment.childTimelineId) {
      collectTimelineSubtreeForDeletion(moment.childTimelineId, deletedMomentIds, deletedTimelineIds);
    }
  });
}

function resetDemo() {
  clearHoverState();
  clearSelection();
  runtime.presentedFractionByTimelineId = {};
  runtime.presentedMomentFractionById = {};
  runtime.fadingTimelines = [];
  runtime.cameraAnimation = null;
  runtime.graphDrag = null;
  runtime.suppressCanvasClickUntil = 0;
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, createInitialState());
  ensureStateDefaults(state);
  persistState();
  syncCameraToCurrentTimeline(true);
}

function persistState() {
  writeHashFromState();
  saveState();
  renderOverlay();
}

function clearHoverState() {
  runtime.hoverMomentId = null;
  runtime.hoverPreviewMomentId = null;
  resetWheelIntent();
}

function resetWheelIntent() {
  runtime.wheelIntent.mode = null;
  runtime.wheelIntent.direction = 0;
  runtime.wheelIntent.magnitude = 0;
  runtime.wheelIntent.updatedAt = 0;
}

function accumulateWheelIntent(mode, direction, deltaMagnitude, threshold) {
  const now = performance.now();
  const intent = runtime.wheelIntent;
  if (now < intent.cooldownUntil) {
    return false;
  }

  const stale = now - intent.updatedAt > 260;

  if (stale || intent.mode !== mode || intent.direction !== direction) {
    intent.mode = mode;
    intent.direction = direction;
    intent.magnitude = 0;
  }

  intent.updatedAt = now;
  intent.magnitude += deltaMagnitude;

  if (intent.magnitude >= threshold) {
    resetWheelIntent();
    intent.mode = mode;
    intent.direction = direction;
    intent.cooldownUntil = now + WHEEL_ACTION_COOLDOWN;
    return true;
  }

  return false;
}

function renderOverlay() {
  const context = getResolvedContext();
  runtime.elements.pathBar.innerHTML = context.ancestry
    .map((entry, index) => {
      const timeline = state.timelinesById[entry.timelineId];
      const label = truncate(timeline.title, 20);
      return `
        ${index ? '<span class="path-separator" aria-hidden="true">→</span>' : ""}
        <button class="path-link ${index === context.ancestry.length - 1 ? "is-active" : ""}" data-action="open-timeline" data-timeline-id="${timeline.id}">
          ${escapeHtml(label)}
        </button>
      `;
    })
    .join("");

  const visibleEntries = context.ancestry
    .map((entry) => {
      const timeline = state.timelinesById[entry.timelineId];
      const visibleLabel = getVisibleTimelineLabel(entry.timelineId);
      if (!timeline || !visibleLabel) {
        return null;
      }

      return {
        timelineId: timeline.id,
        label: truncate(visibleLabel, 20),
        isActive: entry.timelineId === context.timelineId,
      };
    })
    .filter(Boolean);

  runtime.elements.pathBar.innerHTML = visibleEntries
    .map(
      (entry, index) => `
        ${index ? '<span class="path-separator" aria-hidden="true">â†’</span>' : ""}
        <button class="path-link ${entry.isActive ? "is-active" : ""}" data-action="open-timeline" data-timeline-id="${entry.timelineId}">
          ${escapeHtml(entry.label)}
        </button>
      `,
    )
    .join("");

  renderMomentMetadataPanel(context.activeMomentId);
}

function renderMomentMetadataPanel(activeMomentId) {
  const panel = runtime.elements.metaPanel;
  const titleInput = runtime.elements.momentTitleInput;
  const pagesContainer = runtime.elements.momentPages;
  const inspector = getInspectorState(activeMomentId);
  const { activeMoment, graphNode, pages, attachments } = inspector;
  const isDisabled = !activeMoment;

  panel.classList.toggle("is-empty", isDisabled);
  titleInput.disabled = isDisabled;
  titleInput.dataset.momentId = activeMoment?.id ?? "";

  const nextTitle = graphNode?.title ?? activeMoment?.title ?? "";
  if (titleInput.value !== nextTitle) {
    titleInput.value = nextTitle;
  }

  if (!activeMoment) {
    pagesContainer.innerHTML = "";
    return;
  }

  syncAttachmentAvailability(attachments.map((attachment) => attachment.id));

  pagesContainer.innerHTML = `
    <div class="moment-pages-region">
      ${renderMomentPagesMarkup(activeMoment, pages)}
    </div>
    ${renderNodeAttachmentsSection(activeMoment.timelineId, graphNode, attachments)}
  `;
}

function renderMomentPagesMarkup(activeMoment, pages) {
  const activeIndex = Math.max(0, pages.findIndex((pageMoment) => pageMoment.id === activeMoment.id));
  if (pages.length <= 1) {
    return `<textarea
      class="moment-page-input is-solo"
      data-moment-id="${activeMoment.id}"
      aria-label="Moment notes page 1"
      placeholder=""
      spellcheck="true"
    >${escapeHtml(activeMoment.notes || "")}</textarea>`;
  }

  return `
    <div class="moment-pages-stack" data-page-count="${pages.length}">
      ${pages
        .map((pageMoment, index) =>
          renderMomentPageCard(pageMoment, {
            isActive: pageMoment.id === activeMoment.id,
            index,
            totalCount: pages.length,
            offsetFromActive: index - activeIndex,
            hasBefore: activeIndex > 0,
            hasAfter: activeIndex < pages.length - 1,
          }),
        )
        .join("")}
    </div>
    ${renderMomentPagesScrollbar(activeIndex, pages.length)}
  `;
}

function renderNodeAttachmentsSection(timelineId, graphNode, attachments) {
  if (!graphNode) {
    return "";
  }

  const uniqueAttachments = getUniqueAttachmentsForDisplay(attachments);

  return `
    <section class="moment-attachments" aria-label="Node files">
      <div class="moment-attachments-header">
        <span class="moment-attachments-title">Files</span>
        <button
          class="moment-attachments-add"
          data-action="attach-file"
          data-timeline-id="${timelineId}"
          data-node-id="${graphNode.id}"
          type="button"
        >Add file</button>
      </div>
      <div class="moment-attachments-list">
        ${
          uniqueAttachments.length
            ? uniqueAttachments.map((attachment) => renderNodeAttachmentItem(attachment)).join("")
            : '<div class="moment-attachments-empty">No files linked yet.</div>'
        }
      </div>
    </section>
  `;
}

function getUniqueAttachmentsForDisplay(attachments) {
  const attachmentsByName = new Map();
  attachments.forEach((attachment) => {
    if (!attachment?.id) {
      return;
    }

    const key = getAttachmentDisplayKey(attachment);
    const existing = attachmentsByName.get(key);
    if (existing) {
      existing.relatedAttachmentIds.push(attachment.id);
      return;
    }

    attachmentsByName.set(key, {
      ...attachment,
      relatedAttachmentIds: [attachment.id],
    });
  });

  return Array.from(attachmentsByName.values());
}

function getAttachmentDisplayKey(attachment) {
  const name = String(attachment?.displayName || "").trim().replace(/\s+/g, " ");
  return name ? name.toLocaleLowerCase() : attachment?.id;
}

function renderLegacyNodeAttachmentItem(attachment) {
  const status = getAttachmentStatus(attachment.id);
  const isPreviewable = isAttachmentPreviewable(attachment);
  const isSelected = isAttachmentSelected(attachment.id);
  const primaryAction = status === "missing" ? "relink-attachment" : isPreviewable ? "open-attachment" : "";
  const titleParts = [attachment.displayName];
  if (status === "missing") {
    titleParts.push("Needs relink");
  } else if (isPreviewable) {
    titleParts.push("Click to open");
  } else {
    titleParts.push("Linked file");
  }
  titleParts.push("Right-click to select");
  const actionAttribute = primaryAction ? `data-action="${primaryAction}"` : "";
  const tagName = primaryAction ? "button" : "span";

  return `
    <${tagName}
      class="moment-attachment-pill is-${status} ${isPreviewable ? "is-previewable" : "is-static"} ${isSelected ? "is-selected" : ""}"
      ${actionAttribute}
      data-attachment-id="${attachment.id}"
      ${primaryAction ? 'type="button"' : ""}
      title="${escapeHtml(titleParts.join(" • "))}"
    >${escapeHtml(attachment.displayName)}</${tagName}>
  `;
}

function renderNodeAttachmentItem(attachment) {
  const attachmentIds = Array.isArray(attachment.relatedAttachmentIds) && attachment.relatedAttachmentIds.length
    ? attachment.relatedAttachmentIds
    : [attachment.id];
  const isSelected = isAttachmentGroupSelected(attachmentIds);
  return `
    <span
      class="moment-attachment-pill is-static ${isSelected ? "is-selected" : ""}"
      data-attachment-id="${attachment.id}"
      data-attachment-ids="${escapeHtml(attachmentIds.join(","))}"
      title="${escapeHtml(`${attachment.displayName} - Ctrl / Cmd + right-click to select`)}"
    >${escapeHtml(attachment.displayName)}</span>
  `;
}

function renderMomentPageCard(moment, { isActive, index, totalCount, offsetFromActive, hasBefore, hasAfter }) {
  const preview = truncate((moment.notes || "").replace(/\s+/g, " ").trim(), 180);
  const style = getMomentPageCardStyle(offsetFromActive, hasBefore, hasAfter);
  const hiddenAttribute = style.hidden ? ' aria-hidden="true"' : "";
  const inactivePreview = escapeHtml(preview || "Empty page");

  return `
    <article
      class="moment-page-card ${isActive ? "is-active" : ""} ${style.className}"
      data-page-moment-id="${moment.id}"
      style="${style.inlineStyle}"
      ${hiddenAttribute}
    >
      ${totalCount > 1 ? `<header class="moment-page-label">Page ${index + 1} of ${totalCount}</header>` : ""}
      ${
        isActive
          ? `<textarea
              class="moment-page-input"
              data-moment-id="${moment.id}"
              aria-label="Moment notes page ${index + 1}"
              placeholder=""
              spellcheck="true"
            >${escapeHtml(moment.notes || "")}</textarea>`
          : `<div class="moment-page-preview">${inactivePreview}</div>`
      }
    </article>
  `;
}

function getMomentPageCardStyle(offsetFromActive, hasBefore, hasAfter) {
  const distance = Math.abs(offsetFromActive);
  const classNames = [];

  if (offsetFromActive === 0) {
    const top = hasBefore ? "calc(var(--page-preview-height) + var(--page-stack-gap))" : "0px";
    const bottom = hasAfter ? "calc(var(--page-preview-height) + var(--page-stack-gap))" : "0px";
    return {
      hidden: false,
      className: "is-active-slot",
      inlineStyle: `top:${top}; right:0; bottom:${bottom}; left:0; opacity:1; z-index:4; transform:none;`,
    };
  }

  if (distance === 1) {
    classNames.push(offsetFromActive < 0 ? "is-before" : "is-after");
    if (offsetFromActive < 0) {
      return {
        hidden: false,
        className: classNames.join(" "),
        inlineStyle:
          "top:0; right:0; left:0; height:var(--page-preview-height); opacity:0.96; z-index:3; transform:none;",
      };
    }
    return {
      hidden: false,
      className: classNames.join(" "),
      inlineStyle:
        "right:0; bottom:0; left:0; height:var(--page-preview-height); opacity:0.96; z-index:3; transform:none;",
    };
  }

  return {
    hidden: distance > 1,
    className: `${offsetFromActive < 0 ? "is-before" : "is-after"} is-hidden`,
    inlineStyle:
      offsetFromActive < 0
        ? "top:0; right:0; left:0; height:var(--page-preview-height); opacity:0; z-index:1; transform:translateY(-130%);"
        : "right:0; bottom:0; left:0; height:var(--page-preview-height); opacity:0; z-index:1; transform:translateY(130%);",
  };
}

function renderMomentPagesScrollbar(activeIndex, totalCount) {
  if (totalCount <= 1) {
    return "";
  }

  const thumbHeight = 100 / totalCount;
  const thumbTop = (activeIndex / totalCount) * 100;
  return `
    <div class="moment-pages-scrollbar" aria-hidden="true">
      <div class="moment-pages-scrollbar-track"></div>
      <div
        class="moment-pages-scrollbar-thumb"
        style="top:${thumbTop}%; height:${thumbHeight}%;"
      ></div>
    </div>
  `;
}

function startLoop() {
  runtime.lastFrameAt = performance.now();
  runtime.rafId = window.requestAnimationFrame(frame);
}

function frame(now) {
  try {
    const deltaMs = now - runtime.lastFrameAt;
    const frameFactor = Math.min(deltaMs / 16.666, 2);
    runtime.lastFrameAt = now;

    syncCanvasSize();
    updateCamera(now);
    stabilizeCameraToCurrentTimeline(frameFactor);
    updatePresentedFractions(frameFactor);
    drawScene();
    runtime.loopErrorMessage = "";
  } catch (error) {
    runtime.loopErrorMessage = error instanceof Error ? error.message : String(error);
    console.error("Canvas frame failed.", error);
    drawFailureState();
  }
  runtime.rafId = window.requestAnimationFrame(frame);
}

function syncCanvasSize(force = false) {
  const rect = runtime.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));

  if (!force && width === runtime.width && height === runtime.height && dpr === runtime.dpr) {
    return;
  }

  runtime.width = width;
  runtime.height = height;
  runtime.dpr = dpr;
  runtime.canvas.width = Math.round(width * dpr);
  runtime.canvas.height = Math.round(height * dpr);

  if (!runtime.camera.initialized || force) {
    syncCameraToCurrentTimeline(true);
  }
}

function syncCameraToCurrentTimeline(immediate) {
  const target = getCameraTarget(getResolvedContext().timelineId);
  if (!target) {
    return;
  }

  runtime.cameraAnimation = null;

  if (!runtime.camera.initialized || immediate) {
    runtime.camera.x = target.x;
    runtime.camera.y = target.y;
    runtime.camera.scale = target.scale;
    runtime.camera.initialized = true;
    return;
  }

  animateCameraToTimeline(getResolvedContext().timelineId);
}

function animateCameraToTimeline(timelineId, options = {}) {
  const target = getCameraTarget(timelineId);
  if (!target) {
    return;
  }

  if (!runtime.camera.initialized) {
    runtime.camera.x = target.x;
    runtime.camera.y = target.y;
    runtime.camera.scale = target.scale;
    runtime.camera.initialized = true;
    return;
  }

  const targetPose = buildPoseCache().get(timelineId);
  runtime.cameraAnimation = buildCameraAnimation(target, targetPose, options);
}

function getCameraTarget(timelineId) {
  const poseCache = buildPoseCache();
  const pose = poseCache.get(timelineId);
  if (!pose || !runtime.width || !runtime.height) {
    return null;
  }

  const bounds = getVisibleTimelineBounds(timelineId, poseCache);
  if (!bounds) {
    return null;
  }

  const { left: paddingLeft, right: paddingRight, top: paddingTop, bottom: paddingBottom } = getOverlayInsets();
  const usableWidth = Math.max(1, runtime.width - paddingLeft - paddingRight);
  const usableHeight = Math.max(1, runtime.height - paddingTop - paddingBottom);
  const worldWidth = Math.max(bounds.maxX - bounds.minX, pose.r * 2);
  const worldHeight = Math.max(bounds.maxY - bounds.minY, pose.r * 2);
  const scale = Math.min(usableWidth / worldWidth, usableHeight / worldHeight);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const desiredScreenX = paddingLeft + usableWidth / 2;
  const desiredScreenY = paddingTop + usableHeight / 2;

  return {
    x: centerX - (desiredScreenX - runtime.width / 2) / scale,
    y: centerY - (desiredScreenY - runtime.height / 2) / scale,
    scale,
  };
}

function getOverlayInsets() {
  const insets = {
    left: 28,
    right: 28,
    top: 86,
    bottom: 28,
  };

  if (!runtime.width || !runtime.height) {
    return insets;
  }

  const pathRect = runtime.elements.pathBar?.getBoundingClientRect();
  if (pathRect) {
    insets.top = Math.max(insets.top, pathRect.bottom + 18);
  }

  const resetRect = runtime.elements.resetButton?.getBoundingClientRect();
  if (resetRect) {
    insets.top = Math.max(insets.top, resetRect.bottom + 18);
  }

  const panelRect = runtime.elements.metaPanel?.getBoundingClientRect();
  if (panelRect && panelRect.width > 0) {
    if (panelRect.left >= runtime.width * 0.48) {
      insets.right = Math.max(insets.right, runtime.width - panelRect.left + 36);
    } else if (panelRect.top >= runtime.height * 0.55) {
      insets.bottom = Math.max(insets.bottom, runtime.height - panelRect.top + 24);
    }
  }

  return insets;
}

function getVisibleTimelineBounds(timelineId, poseCache) {
  const pose = poseCache.get(timelineId);
  if (!pose) {
    return null;
  }

  const bounds = {
    minX: pose.x - pose.r,
    maxX: pose.x + pose.r,
    minY: pose.y - pose.r,
    maxY: pose.y + pose.r,
  };

  getImmediateChildTimelineIds(timelineId).forEach((childTimelineId) => {
    const childPose = poseCache.get(childTimelineId);
    if (!childPose) {
      return;
    }
    bounds.minX = Math.min(bounds.minX, childPose.x - childPose.r);
    bounds.maxX = Math.max(bounds.maxX, childPose.x + childPose.r);
    bounds.minY = Math.min(bounds.minY, childPose.y - childPose.r);
    bounds.maxY = Math.max(bounds.maxY, childPose.y + childPose.r);
  });

  return bounds;
}

function getImmediateChildTimelineIds(timelineId) {
  return getMomentsForTimeline(timelineId)
    .map((moment) => moment.childTimelineId)
    .filter((childTimelineId) => childTimelineId && state.timelinesById[childTimelineId] && !isTimelineUntouched(childTimelineId));
}

function updateCamera(now) {
  if (!runtime.cameraAnimation) {
    return;
  }

  const { startedAt, duration, from, to, anchorWorld, fromScreen, toScreen } = runtime.cameraAnimation;
  const rawProgress = clamp((now - startedAt) / duration, 0, 1);
  const eased = easeInOutCubic(rawProgress);

  runtime.camera.scale = lerp(from.scale, to.scale, eased);

  if (anchorWorld && fromScreen && toScreen) {
    const screenX = lerp(fromScreen.x, toScreen.x, eased);
    const screenY = lerp(fromScreen.y, toScreen.y, eased);
    runtime.camera.x = anchorWorld.x - (screenX - runtime.width / 2) / runtime.camera.scale;
    runtime.camera.y = anchorWorld.y - (screenY - runtime.height / 2) / runtime.camera.scale;
  } else {
    runtime.camera.x = lerp(from.x, to.x, eased);
    runtime.camera.y = lerp(from.y, to.y, eased);
  }

  runtime.camera.initialized = true;

  if (rawProgress >= 1) {
    runtime.cameraAnimation = null;
  }
}

function stabilizeCameraToCurrentTimeline(frameFactor) {
  if (runtime.cameraAnimation || !runtime.camera.initialized) {
    return;
  }

  const target = getCameraTarget(getResolvedContext().timelineId);
  if (!target) {
    return;
  }

  const positionDelta = Math.hypot(target.x - runtime.camera.x, target.y - runtime.camera.y);
  const scaleDelta = Math.abs(target.scale - runtime.camera.scale);
  if (positionDelta < 0.001 && scaleDelta < 0.00001) {
    return;
  }

  const factor = clamp(0.18 * frameFactor, 0, 1);
  runtime.camera.x = lerp(runtime.camera.x, target.x, factor);
  runtime.camera.y = lerp(runtime.camera.y, target.y, factor);
  runtime.camera.scale = lerp(runtime.camera.scale, target.scale, factor);
}

  function buildCameraAnimation(target, targetPose, options = {}) {
    const base = {
      startedAt: performance.now(),
      duration: CAMERA_DURATION,
      from: {
      x: runtime.camera.x,
      y: runtime.camera.y,
      scale: runtime.camera.scale,
    },
    to: target,
  };

  if (!options.anchorWorld || !targetPose) {
    return base;
  }

    return {
      ...base,
      anchorWorld: options.anchorWorld,
      fromScreen:
        options.fromScreen ?? worldToScreen(options.anchorWorld.x, options.anchorWorld.y),
      toScreen:
        options.toScreen ?? {
          x: runtime.width / 2,
          y: runtime.height / 2,
        },
    };
  }

function updatePresentedFractions(frameFactor) {
  Object.keys(runtime.presentedMomentFractionById).forEach((momentId) => {
    if (!state.momentsById[momentId]) {
      delete runtime.presentedMomentFractionById[momentId];
    }
  });

  Object.values(state.momentsById).forEach((moment) => {
    const current = runtime.presentedMomentFractionById[moment.id];
    if (current == null) {
      runtime.presentedMomentFractionById[moment.id] = moment.position;
      return;
    }

    runtime.presentedMomentFractionById[moment.id] = approachCircularFraction(current, moment.position, 0.16 * frameFactor);
  });

  Object.values(state.timelinesById).forEach((timeline) => {
    const targetFraction = getTargetFractionForTimeline(timeline.id);
    if (targetFraction == null) {
      delete runtime.presentedFractionByTimelineId[timeline.id];
      return;
    }

    const current = runtime.presentedFractionByTimelineId[timeline.id];
    if (current == null) {
      runtime.presentedFractionByTimelineId[timeline.id] = targetFraction;
      return;
    }

    runtime.presentedFractionByTimelineId[timeline.id] = approachCircularFraction(current, targetFraction, 0.18 * frameFactor);
  });
}

function getTargetFractionForTimeline(timelineId) {
  const momentId = state.activeMomentIdByTimelineId[timelineId];
  const moment = momentId ? state.momentsById[momentId] : null;
  return moment ? moment.position : null;
}

function getMomentRenderFraction(momentOrId) {
  const momentId = typeof momentOrId === "string" ? momentOrId : momentOrId?.id;
  if (!momentId) {
    return 0;
  }

  return runtime.presentedMomentFractionById[momentId] ?? state.momentsById[momentId]?.position ?? 0;
}

function getRepresentativeMomentId(momentId, timelineId) {
  const originMoment = state.momentsById[momentId];
  if (!originMoment) {
    return null;
  }

  if (originMoment.timelineId === timelineId) {
    return originMoment.id;
  }

  let currentTimeline = state.timelinesById[originMoment.timelineId];
  while (currentTimeline?.parentMomentId) {
    const parentMoment = state.momentsById[currentTimeline.parentMomentId];
    if (!parentMoment) {
      break;
    }
    if (parentMoment.timelineId === timelineId) {
      return parentMoment.id;
    }
    currentTimeline = state.timelinesById[parentMoment.timelineId];
  }

  return null;
}

function getLinkViewState() {
  if (!state.linkView) {
    return null;
  }

  const link = state.linksById[state.linkView.linkId];
  const endpointMoment = state.momentsById[state.linkView.endpointMomentId];
  if (!link || !endpointMoment) {
    return null;
  }

  const otherMomentId = link.fromMomentId === endpointMoment.id ? link.toMomentId : link.fromMomentId;
  const otherMoment = state.momentsById[otherMomentId];
  if (!otherMoment) {
    return null;
  }

  return {
    link,
    endpointMoment,
    otherMoment,
  };
}

function getVisibleLinkSegments(timelineId, activeMomentId) {
  const linkView = getLinkViewState();
  if (!linkView) {
    return [];
  }

  if (linkView.endpointMoment.timelineId !== timelineId || activeMomentId !== linkView.endpointMoment.id) {
    return [];
  }

  const otherVisibleId =
    linkView.otherMoment.timelineId === timelineId
      ? linkView.otherMoment.id
      : getRepresentativeMomentId(linkView.otherMoment.id, timelineId);

  if (!otherVisibleId || otherVisibleId === linkView.endpointMoment.id) {
    return [];
  }

  return [
    {
      link: linkView.link,
      fromVisibleId: linkView.endpointMoment.id,
      toVisibleId: otherVisibleId,
      exactEndpointId: linkView.endpointMoment.id,
      otherExactMomentId: linkView.otherMoment.id,
    },
  ];
}

function getPathSelectionTargetForContext() {
  if (state.linkDraftMomentId) {
    return {
      momentId: state.linkDraftMomentId,
      highlightKind: "draft",
      alignTowardWorld: null,
    };
  }

  const linkView = getLinkViewState();
  if (!linkView) {
    return null;
  }

  const context = getResolvedContext();
  const hasExactEndpoint = linkView.endpointMoment.timelineId === context.timelineId && context.activeMomentId === linkView.endpointMoment.id;
  const focusPose = buildPoseCache().get(linkView.endpointMoment.timelineId);
  const endpointWorld =
    focusPose
      ? getMomentWorldPosition(
          focusPose,
          getMomentRenderFraction(linkView.endpointMoment),
          getTimelineRotationOffset(linkView.endpointMoment.timelineId),
        )
      : null;

  return {
    momentId: linkView.otherMoment.id,
    highlightKind: hasExactEndpoint ? "linked" : "linked-silent",
    alignTowardWorld: endpointWorld,
  };
}

function getPathMomentAndChild(targetMomentId, timelineId) {
  const targetMoment = state.momentsById[targetMomentId];
  if (!targetMoment) {
    return null;
  }

  if (targetMoment.timelineId === timelineId) {
    return {
      momentId: targetMoment.id,
      childTimelineId: null,
    };
  }

  let currentTimeline = state.timelinesById[targetMoment.timelineId];
  while (currentTimeline?.parentMomentId) {
    const parentMoment = state.momentsById[currentTimeline.parentMomentId];
    if (!parentMoment) {
      break;
    }
    if (parentMoment.timelineId === timelineId) {
      return {
        momentId: parentMoment.id,
        childTimelineId: parentMoment.childTimelineId,
      };
    }
    currentTimeline = state.timelinesById[parentMoment.timelineId];
  }

  return null;
}

function buildPoseCache() {
  const cache = new Map();
  const rootTimeline = state.timelinesById[state.rootTimelineId];
  if (!rootTimeline) {
    return cache;
  }

  computeTimelinePose(rootTimeline.id, cache);
  return cache;
}

function computeTimelinePose(timelineId, cache) {
  if (cache.has(timelineId)) {
    return cache.get(timelineId);
  }

  const timeline = state.timelinesById[timelineId];
  if (!timeline) {
    return null;
  }

  let pose;
  if (!timeline.parentMomentId) {
    pose = {
      timelineId,
      x: 0,
      y: 0,
      r: ROOT_RADIUS,
      depth: 0,
      parentMomentId: null,
    };
  } else {
    const parentMoment = state.momentsById[timeline.parentMomentId];
    if (!parentMoment) {
      return null;
    }

    const parentPose = computeTimelinePose(parentMoment.timelineId, cache);
    if (!parentPose) {
      return null;
    }

    const childRadius = getChildRadius(parentPose, parentMoment.childTimelineId);
    const angle = getMomentAngle(parentMoment, parentPose.timelineId);
    const centerDistance = parentPose.r;

    pose = {
      timelineId,
      x: parentPose.x + Math.cos(angle) * centerDistance,
      y: parentPose.y + Math.sin(angle) * centerDistance,
      r: childRadius,
      depth: parentPose.depth + 1,
      parentMomentId: parentMoment.id,
    };
  }

  cache.set(timelineId, pose);

  getMomentsForTimeline(timelineId).forEach((moment) => {
    if (moment.childTimelineId) {
      computeTimelinePose(moment.childTimelineId, cache);
    }
  });

  return pose;
}

function drawScene() {
  const ctx = runtime.ctx;
  const poseCache = buildPoseCache();
  const context = getResolvedContext();
  const visibleSummaryTimelineIds = new Set(getImmediateChildTimelineIds(context.timelineId));
  const parentMoment = context.timeline?.parentMomentId ? state.momentsById[context.timeline.parentMomentId] : null;
  const visibleContextTimelineIds = new Set(parentMoment ? [parentMoment.timelineId] : []);
  const visibleLinks = getVisibleLinkSegments(context.timelineId, context.activeMomentId);
  const pathSelection = getPathSelectionTargetForContext();
  const draftHighlightedMomentIds = new Set(state.linkDraftMomentId && context.activeMomentId === state.linkDraftMomentId ? [state.linkDraftMomentId] : []);
  const linkedHighlightedMomentIds = new Set(
    visibleLinks.length ? [visibleLinks[0].fromVisibleId, ...(visibleLinks[0].toVisibleId === visibleLinks[0].otherExactMomentId ? [visibleLinks[0].toVisibleId] : [])] : [],
  );

  ctx.setTransform(runtime.dpr, 0, 0, runtime.dpr, 0, 0);
  ctx.clearRect(0, 0, runtime.width, runtime.height);
  runtime.appBackgroundColor = getAppBackgroundColor();
  ctx.fillStyle = runtime.appBackgroundColor;
  ctx.fillRect(0, 0, runtime.width, runtime.height);

  const orderedPoses = Array.from(poseCache.values()).sort((left, right) => left.depth - right.depth);

  orderedPoses.forEach((pose) => {
    const timeline = state.timelinesById[pose.timelineId];
    if (!timeline) {
      return;
    }

    const screenPose = worldToScreen(pose.x, pose.y);
    const projectedRadius = pose.r * runtime.camera.scale;
    if (projectedRadius < 6) {
      return;
    }

    const margin = projectedRadius + 120;
    if (
      screenPose.x < -margin ||
      screenPose.x > runtime.width + margin ||
      screenPose.y < -margin ||
      screenPose.y > runtime.height + margin
    ) {
      return;
    }

      const kind =
        pose.timelineId === context.timelineId
          ? "focus"
          : visibleContextTimelineIds.has(pose.timelineId)
            ? "context"
            : visibleSummaryTimelineIds.has(pose.timelineId)
              ? "summary"
              : "ambient";
      if (kind === "ambient") {
        return;
      }
    drawTimeline(ctx, pose, kind, draftHighlightedMomentIds, linkedHighlightedMomentIds, visibleLinks, pathSelection);
  });

  if (runtime.hoverPreviewMomentId) {
    drawHoverPreview(ctx, context.timelineId, runtime.hoverPreviewMomentId, poseCache);
  }

  drawFadingTimelines(ctx, poseCache);
}

function drawFailureState() {
  const ctx = runtime.ctx;
  const palette = getCanvasPalette();
  ctx.setTransform(runtime.dpr, 0, 0, runtime.dpr, 0, 0);
  ctx.clearRect(0, 0, runtime.width, runtime.height);
  ctx.fillStyle = getAppBackgroundColor();
  ctx.fillRect(0, 0, runtime.width, runtime.height);
  ctx.fillStyle = palette.label;
  ctx.font = '16px "Segoe UI", sans-serif';
  ctx.fillText("The canvas hit a render error but is still running.", 24, 40);
  if (runtime.loopErrorMessage) {
    ctx.fillStyle = runtime.darkMode ? "rgba(244,242,234,0.68)" : "rgba(17,17,17,0.68)";
    ctx.fillText(runtime.loopErrorMessage, 24, 66);
  }
}

function drawTimeline(
  ctx,
  pose,
  kind,
  draftHighlightedMomentIds = new Set(),
  linkedHighlightedMomentIds = new Set(),
  visibleLinks = [],
  pathSelection = null,
  opacityOverride = 1,
) {
  if (kind === "summary") {
    drawSummaryTimeline(ctx, pose, pathSelection, opacityOverride);
    return;
  }

  const screenPose = worldToScreen(pose.x, pose.y);
  const screenRadius = pose.r * runtime.camera.scale;
  const metrics = getTimelineMetrics(pose.r);
  const bandPx = metrics.band * runtime.camera.scale;
  const nodeRadiusPx = metrics.nodeRadius * runtime.camera.scale;
  const moments = getMomentsForTimeline(pose.timelineId);
  const activeFraction = runtime.presentedFractionByTimelineId[pose.timelineId];
  const activeMomentId = state.activeMomentIdByTimelineId[pose.timelineId];
  const activeMoment = activeMomentId ? state.momentsById[activeMomentId] : null;
  const selectionState = getSelectionForTimeline(pose.timelineId);
  const selectedNodeIds = selectionState.nodeIds;
  const multiSelectColor = selectionState.useMultiSelectAccent ? LINK_DRAFT_HIGHLIGHT : null;
  const activeAngle = activeFraction != null ? fractionToRadians(activeFraction) : null;
  const opacity = opacityOverride;
  const palette = getCanvasPalette();
  const activeHighlightKind = draftHighlightedMomentIds.has(activeMomentId)
    ? "draft"
    : linkedHighlightedMomentIds.has(activeMomentId)
      ? "linked"
      : null;

    if (pose.parentMomentId && kind !== "focus" && kind !== "context") {
      drawConnector(ctx, pose, kind, opacity);
    }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.lineCap = "round";

  ctx.fillStyle = palette.paper;
  ctx.beginPath();
  ctx.arc(screenPose.x, screenPose.y, screenRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = runtime.appBackgroundColor;
  ctx.lineWidth = bandPx;
  ctx.beginPath();
  ctx.arc(screenPose.x, screenPose.y, screenRadius - bandPx / 2, 0, Math.PI * 2);
  ctx.stroke();

    if (activeAngle != null) {
      drawRingSegment(
        ctx,
        screenPose.x,
        screenPose.y,
        screenRadius,
        bandPx,
        -Math.PI / 2,
        activeAngle,
        kind === "focus" ? palette.blue : kind === "context" ? palette.blueSoft : palette.blueSoftest,
        null,
      );
      if (kind === "focus") {
        drawNeedle(
          ctx,
          screenPose.x,
          screenPose.y,
          screenRadius,
          bandPx,
          activeAngle,
          activeHighlightKind === "draft"
            ? LINK_DRAFT_HIGHLIGHT
            : activeHighlightKind === "linked"
              ? LINK_HIGHLIGHT
              : palette.blueStroke,
        );
      }
    }

  const outerStrokeWidth = Math.max(1.5, bandPx * 0.05);
  ctx.strokeStyle = palette.grayStroke;
  ctx.lineWidth = outerStrokeWidth;
  ctx.beginPath();
  ctx.arc(screenPose.x, screenPose.y, screenRadius, 0, Math.PI * 2);
  ctx.stroke();
  if (activeAngle != null) {
    drawArcStroke(
      ctx,
      screenPose.x,
        screenPose.y,
        screenRadius,
        outerStrokeWidth,
        -Math.PI / 2,
        activeAngle,
        kind === "focus" ? palette.blueStroke : kind === "context" ? palette.blueContext : palette.blueAmbient,
      );
    }

  if (visibleLinks.length && pose.timelineId === getResolvedContext().timelineId) {
    drawVisibleLinks(ctx, pose, visibleLinks, opacity);
  }

  if (kind === "focus") {
    drawNodeMomentBridges(ctx, pose, activeMoment, opacity);
    drawNodeWeb(ctx, pose, activeMoment, opacity, selectedNodeIds, multiSelectColor);
  }

  if (moments.length && (kind !== "ambient" || screenRadius > 80)) {
    moments.forEach((moment) => {
      const highlightKind = draftHighlightedMomentIds.has(moment.id)
        ? "draft"
        : linkedHighlightedMomentIds.has(moment.id)
          ? "linked"
          : null;
      drawMomentNode(
        ctx,
        pose,
        moment,
        activeMoment?.id === moment.id,
        nodeRadiusPx,
        highlightKind,
        isMomentSelected(moment),
        multiSelectColor,
      );
    });
  }

  ctx.restore();
}

function drawSummaryTimeline(ctx, pose, pathSelection, opacity) {
  const screenPose = worldToScreen(pose.x, pose.y);
  const screenRadius = pose.r * runtime.camera.scale;
  if (screenRadius < 10) {
    return;
  }

  const metrics = getSummaryMetrics(screenRadius);
  const summarySelection = pathSelection ? buildSummarySelectionState(pose, pathSelection) : null;
  const palette = getCanvasPalette();

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = palette.paper;
  ctx.beginPath();
  ctx.arc(screenPose.x, screenPose.y, screenRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = palette.graySummaryStroke;
  ctx.lineWidth = metrics.ringWidth;
  ctx.beginPath();
  ctx.arc(screenPose.x, screenPose.y, screenRadius - metrics.ringWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  if (summarySelection) {
    drawRingSegment(
      ctx,
      screenPose.x,
      screenPose.y,
      screenRadius,
      metrics.ringWidth,
      -Math.PI / 2,
      summarySelection.selectedAngle,
      palette.blue,
      palette.blueStroke,
    );
    if (summarySelection.highlightKind !== "linked-silent") {
      drawNeedle(
        ctx,
        screenPose.x,
        screenPose.y,
        screenRadius * 0.78,
        metrics.ringWidth,
        summarySelection.selectedAngle,
        summarySelection.highlightKind === "draft" ? LINK_DRAFT_HIGHLIGHT : LINK_HIGHLIGHT,
      );
    }
  }

  const moments = getMomentsForTimeline(pose.timelineId);
  moments.forEach((moment) => {
    const momentAngle = getMomentAngle(moment, pose.timelineId, summarySelection?.rotationOffset ?? 0);
    const world = getPointOnCircle(pose.x, pose.y, pose.r, momentAngle);
    const screen = worldToScreen(world.x, world.y);
    const highlightKind = summarySelection?.selectedMomentId === moment.id ? summarySelection.highlightKind : null;
    ctx.fillStyle = palette.paper;
    ctx.strokeStyle =
      highlightKind === "draft" ? LINK_DRAFT_HIGHLIGHT : highlightKind === "linked" ? LINK_HIGHLIGHT : palette.ink;
    ctx.lineWidth = Math.max(2.1, metrics.nodeRadius * 0.18);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, metrics.nodeRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  if (summarySelection?.childTimelineId) {
    drawNestedSummaryGlyph(
      ctx,
      screenPose,
      screenRadius,
      summarySelection.selectedAngle,
      summarySelection.childTimelineId,
      pathSelection,
      opacity,
    );
  }

  ctx.restore();
}

function drawVisibleLinks(ctx, pose, visibleLinks, opacity) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = LINK_HIGHLIGHT;
  ctx.lineWidth = Math.max(1.5, getTimelineMetrics(pose.r).nodeRadius * runtime.camera.scale * 0.12);
  ctx.lineCap = "round";

  visibleLinks.forEach((segment) => {
    const fromMoment = state.momentsById[segment.fromVisibleId];
    if (!fromMoment) {
      return;
    }
    const from = getMomentWorldPosition(pose, getMomentRenderFraction(fromMoment), getTimelineRotationOffset(pose.timelineId));
    const to =
      segment.toVisibleId === segment.otherExactMomentId
        ? getMomentWorldPosition(
            pose,
            getMomentRenderFraction(state.momentsById[segment.toVisibleId]),
            getTimelineRotationOffset(pose.timelineId),
          )
        : getVisibleSummaryAnchorForLink(segment, from);
    if (!to) {
      return;
    }
    const fromScreen = worldToScreen(from.x, from.y);
    const toScreen = worldToScreen(to.x, to.y);
    ctx.beginPath();
    ctx.moveTo(fromScreen.x, fromScreen.y);
    ctx.lineTo(toScreen.x, toScreen.y);
    ctx.stroke();
  });

  ctx.restore();
}

function getVisibleSummaryAnchorForLink(segment, alignTowardWorld) {
  const representativeMoment = state.momentsById[segment.toVisibleId];
  if (!representativeMoment?.childTimelineId) {
    return null;
  }

  const childPose = buildPoseCache().get(representativeMoment.childTimelineId);
  if (!childPose) {
    return null;
  }

  return getSummaryAnchorWorldPosition(childPose, segment.otherExactMomentId, "linked", alignTowardWorld);
}

function drawConnector(ctx, pose, kind, opacity) {
  const timeline = state.timelinesById[pose.timelineId];
  const parentMoment = timeline?.parentMomentId ? state.momentsById[timeline.parentMomentId] : null;
  if (!parentMoment) {
    return;
  }

  const parentPose = buildPoseCache().get(parentMoment.timelineId);
  if (!parentPose) {
    return;
  }

  const parentScreen = worldToScreen(parentPose.x, parentPose.y);
  const childScreen = worldToScreen(pose.x, pose.y);
  const childMetrics = getTimelineMetrics(pose.r);
  const width = Math.max(12, childMetrics.band * runtime.camera.scale * 0.9);
  const palette = getCanvasPalette();

  ctx.save();
  ctx.globalAlpha = kind === "ambient" ? opacity * 0.55 : opacity;
  ctx.strokeStyle = kind === "focus" ? palette.blueStroke : kind === "path" ? palette.grayConnectorPath : palette.grayConnector;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(parentScreen.x, parentScreen.y);
  ctx.lineTo(childScreen.x, childScreen.y);
  ctx.stroke();
  ctx.restore();
}

function drawHoverPreview(ctx, timelineId, momentId, poseCache) {
  const moment = state.momentsById[momentId];
  if (
    !moment ||
    moment.timelineId !== timelineId ||
    (moment.childTimelineId && !isTimelineUntouched(moment.childTimelineId))
  ) {
    return;
  }

  const parentPose = poseCache.get(timelineId);
  if (!parentPose) {
    return;
  }

  const previewPose = getChildPoseFromMoment(parentPose, moment);
  const screenPose = worldToScreen(previewPose.x, previewPose.y);
  const screenRadius = previewPose.r * runtime.camera.scale;

  if (screenRadius < 10) {
    return;
  }

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = getCanvasPalette().paper;
  ctx.beginPath();
  ctx.arc(screenPose.x, screenPose.y, screenRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = getCanvasPalette().blueStroke;
  ctx.lineWidth = Math.max(2, screenRadius * 0.1);
  ctx.beginPath();
  ctx.arc(screenPose.x, screenPose.y, screenRadius - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawFadingTimelines(ctx, poseCache) {
  const now = performance.now();
  runtime.fadingTimelines = runtime.fadingTimelines.filter((ghost) => now - ghost.startedAt < ghost.duration);

  runtime.fadingTimelines.forEach((ghost) => {
    const pose = poseCache.get(ghost.timelineId);
    if (!pose) {
      return;
    }
    const progress = clamp((now - ghost.startedAt) / ghost.duration, 0, 1);
    const opacity = 1 - easeInOutCubic(progress);
    if (opacity <= 0.01) {
      return;
    }
    drawTimeline(ctx, pose, "ghost", new Set(), new Set(), [], null, opacity);
  });
}

function drawRingSegment(ctx, x, y, radius, bandPx, startAngle, endAngle, fillColor, edgeColor) {
  if (startAngle === endAngle) {
    return;
  }

  const outerRadius = radius;
  const innerRadius = radius - bandPx;

  ctx.save();
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.arc(x, y, outerRadius, startAngle, endAngle, false);
  ctx.arc(x, y, innerRadius, endAngle, startAngle, true);
  ctx.closePath();
  ctx.fill();

  if (edgeColor) {
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = Math.max(2, bandPx * 0.08);
    ctx.beginPath();
    ctx.arc(x, y, outerRadius, startAngle, endAngle, false);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArcStroke(ctx, x, y, radius, lineWidth, startAngle, endAngle, color) {
  if (startAngle === endAngle) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(x, y, radius, startAngle, endAngle, false);
  ctx.stroke();
  ctx.restore();
}

function drawNeedle(ctx, x, y, radius, bandPx, angle, color) {
  const nodeDistance = radius;
  const outerDistance = radius + bandPx * 0.42;
  const nodeX = x + Math.cos(angle) * nodeDistance;
  const nodeY = y + Math.sin(angle) * nodeDistance;
  const outerX = x + Math.cos(angle) * outerDistance;
  const outerY = y + Math.sin(angle) * outerDistance;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(6, bandPx * 0.24);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(nodeX, nodeY);
  ctx.lineTo(outerX, outerY);
  ctx.stroke();
  ctx.restore();
}

function drawNodeWeb(ctx, pose, activeMoment, opacity, selectedNodeIds = new Set(), multiSelectColor = null) {
  const graph = getGraphForTimeline(pose.timelineId);
  const area = getGraphAreaScreenMetrics(pose.timelineId);
  if (!graph || !area) {
    return;
  }

  const activeNodeId = activeMoment?.graphNodeId ?? null;
  const activeEdgeId = activeMoment?.graphEdgeId ?? null;
  const palette = getCanvasPalette();

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.arc(area.centerX, area.centerY, area.radius, 0, Math.PI * 2);
  ctx.clip();

  const background = ctx.createRadialGradient(
    area.centerX,
    area.centerY,
    area.radius * 0.08,
    area.centerX,
    area.centerY,
    area.radius,
  );
  background.addColorStop(0, palette.graphMaskSolid);
  background.addColorStop(0.58, palette.graphMaskSolid);
  background.addColorStop(0.84, palette.graphMaskSoft);
  background.addColorStop(1, palette.graphMaskTransparent);
  ctx.fillStyle = background;
  ctx.beginPath();
  ctx.arc(area.centerX, area.centerY, area.radius, 0, Math.PI * 2);
  ctx.fill();

  drawGraphEdges(ctx, pose.timelineId, activeEdgeId);
  drawGraphCreatePreview(ctx, pose.timelineId);
  drawGraphNodes(ctx, pose.timelineId, activeNodeId, selectedNodeIds, multiSelectColor);
  ctx.restore();
}

function drawGraphEdges(ctx, timelineId, activeEdgeId) {
  const edges = getUniqueGraphEdgesForDrawing(timelineId, activeEdgeId);
  if (!edges.length) {
    return;
  }

  const palette = getCanvasPalette();

  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    const curve = getGraphEdgeCurve(timelineId, edge, 0);
    if (!curve) {
      continue;
    }

    ctx.save();
    ctx.strokeStyle = edge.id === activeEdgeId ? palette.blueStroke : palette.graphLine;
    ctx.lineWidth = edge.id === activeEdgeId ? 3.4 : 2.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(curve.start.x, curve.start.y);
    ctx.bezierCurveTo(
      curve.control1.x,
      curve.control1.y,
      curve.control2.x,
      curve.control2.y,
      curve.end.x,
      curve.end.y,
    );
    ctx.stroke();
    ctx.restore();
  }
}

function getUniqueGraphEdgesForDrawing(timelineId, activeEdgeId) {
  const edgesByPair = new Map();
  getGraphEdges(timelineId).forEach((edge) => {
    const key = getGraphEdgePairKey(edge);
    const existing = edgesByPair.get(key);
    if (!existing || edge.id === activeEdgeId) {
      edgesByPair.set(key, edge);
    }
  });
  return Array.from(edgesByPair.values());
}

function drawGraphNodes(ctx, timelineId, activeNodeId, selectedNodeIds = new Set(), multiSelectColor = null) {
  const viewport = getGraphViewport(timelineId);
  const nodes = getGraphNodes(timelineId);
  if (!viewport || !nodes.length) {
    return;
  }

  const radius = clamp(GRAPH_NODE_RADIUS * viewport.zoom, 14, 42);
  const palette = getCanvasPalette();
  nodes.forEach((node) => {
    const screen = graphLocalToScreen(timelineId, node, viewport);
    const isActive = node.id === activeNodeId;
    const isSelected = selectedNodeIds.has(node.id);
    const strokeColor = isSelected && multiSelectColor ? multiSelectColor : isActive || isSelected ? palette.blueStroke : palette.ink;
    ctx.save();
    ctx.fillStyle = palette.paper;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = isActive || isSelected ? 3.2 : 2.2;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (node.title.trim()) {
      drawGraphNodeLabel(ctx, node.title, screen.x, screen.y, radius);
    }
    ctx.restore();
  });
}

function drawGraphCreatePreview(ctx, timelineId) {
  const drag = runtime.graphDrag;
  if (!drag || drag.type !== "create" || drag.timelineId !== timelineId) {
    return;
  }

  const sourceNode = getGraphNodeById(timelineId, drag.nodeId);
  if (!sourceNode) {
    return;
  }

  const from = graphLocalToScreen(timelineId, sourceNode);
  ctx.save();
  ctx.strokeStyle = getCanvasPalette().blueStroke;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(drag.currentScreen.x, drag.currentScreen.y);
  ctx.stroke();
  ctx.restore();
}

function drawNodeMomentBridges(ctx, pose, activeMoment, opacity) {
  const bridgeSegments = getTimelineNodeBridgeSegments(pose.timelineId);
  if (!bridgeSegments.length) {
    return;
  }

  const palette = getCanvasPalette();
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.lineCap = "round";

  bridgeSegments.forEach((segment) => {
    const fromMoment = state.momentsById[segment.fromMomentId];
    const toMoment = state.momentsById[segment.toMomentId];
    if (!fromMoment || !toMoment) {
      return;
    }

    const from = getMomentWorldPosition(
      pose,
      getMomentRenderFraction(fromMoment),
      getTimelineRotationOffset(pose.timelineId),
    );
    const to = getMomentWorldPosition(
      pose,
      getMomentRenderFraction(toMoment),
      getTimelineRotationOffset(pose.timelineId),
    );
    const fromScreen = worldToScreen(from.x, from.y);
    const toScreen = worldToScreen(to.x, to.y);
    const touchesActive = activeMoment && (activeMoment.id === segment.fromMomentId || activeMoment.id === segment.toMomentId);

    ctx.strokeStyle = touchesActive
      ? hexToRgba(palette.blueStroke, 0.28)
      : hexToRgba(palette.blueStroke, 0.16);
    ctx.lineWidth = touchesActive ? 1.6 : 1.1;
    ctx.beginPath();
    ctx.moveTo(fromScreen.x, fromScreen.y);
    ctx.lineTo(toScreen.x, toScreen.y);
    ctx.stroke();
  });

  ctx.restore();
}

function getTimelineNodeBridgeSegments(timelineId) {
  const bridgeSegments = [];
  const nodeIds = new Set(
    getMomentsForTimeline(timelineId)
      .map((moment) => moment.graphNodeId)
      .filter(Boolean),
  );

  nodeIds.forEach((nodeId) => {
    const nodeMoments = getMomentsForGraphNode(timelineId, nodeId);
    for (let index = 1; index < nodeMoments.length; index += 1) {
      bridgeSegments.push({
        nodeId,
        fromMomentId: nodeMoments[index - 1].id,
        toMomentId: nodeMoments[index].id,
      });
    }
  });

  return bridgeSegments;
}

function getGraphEdgePairKey(edge) {
  return [edge.fromNodeId, edge.toNodeId].sort().join("|");
}

function getGraphEdgeSlot(edgeIndex, edges, pairBuckets) {
  const edge = edges[edgeIndex];
  if (!edge) {
    return 0;
  }

  const bucket = pairBuckets.get(getGraphEdgePairKey(edge));
  if (!bucket) {
    return 0;
  }

  const position = bucket.indexOf(edgeIndex);
  const rawSlot = position - (bucket.length - 1) / 2;
  const [first] = [edge.fromNodeId, edge.toNodeId].sort();
  return rawSlot * (edge.fromNodeId === first ? 1 : -1);
}

function getGraphEdgeCurve(timelineId, edge, slot) {
  const fromNode = getGraphNodeById(timelineId, edge.fromNodeId);
  const toNode = getGraphNodeById(timelineId, edge.toNodeId);
  const viewport = getGraphViewport(timelineId);
  if (!fromNode || !toNode || !viewport) {
    return null;
  }

  const dx = toNode.x - fromNode.x;
  const dy = toNode.y - fromNode.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) {
    return null;
  }

  const unit = { x: dx / distance, y: dy / distance };
  const opposite = { x: -unit.x, y: -unit.y };
  const radius = clamp(GRAPH_NODE_RADIUS * viewport.zoom, 14, 42) / Math.max(viewport.zoom, 0.0001);
  const maxAngle = 0.52;
  const angleStep = 0.15;
  const angleOffset = clamp(slot * angleStep, -maxAngle, maxAngle);
  const startNormal = rotateGraphVector(unit, angleOffset);
  const endNormal = rotateGraphVector(opposite, -angleOffset);

  const start = graphLocalToScreen(timelineId, {
    x: fromNode.x + startNormal.x * radius,
    y: fromNode.y + startNormal.y * radius,
  }, viewport);
  const end = graphLocalToScreen(timelineId, {
    x: toNode.x + endNormal.x * radius,
    y: toNode.y + endNormal.y * radius,
  }, viewport);

  const available = Math.max(24, distance - radius * 2);
  const handle = Math.max(30, Math.min(100, available * 0.55)) * viewport.zoom;

  return {
    start,
    end,
    control1: {
      x: start.x + startNormal.x * handle,
      y: start.y + startNormal.y * handle,
    },
    control2: {
      x: end.x + endNormal.x * handle,
      y: end.y + endNormal.y * handle,
    },
  };
}

function rotateGraphVector(vector, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos,
  };
}

function drawGraphNodeLabel(ctx, label, centerX, centerY, radius) {
  const layout = layoutGraphNodeLabel(ctx, label, radius);
  if (!layout) {
    return;
  }

  ctx.fillStyle = getCanvasPalette().label;
  ctx.font = `${layout.fontSize}px "Aptos", "Trebuchet MS", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const totalHeight = layout.lines.length * layout.lineHeight;
  let lineY = centerY - totalHeight / 2 + layout.lineHeight / 2;
  layout.lines.forEach((line) => {
    ctx.fillText(line, centerX, lineY);
    lineY += layout.lineHeight;
  });
}

function layoutGraphNodeLabel(ctx, label, radius) {
  const normalized = String(label || "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }

  const maxWidth = radius * 1.4;
  const maxHeight = radius * 1.34;
  const maxFontSize = clamp(radius * 0.52, 10, 18);
  const minFontSize = 6;

  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 0.5) {
    ctx.font = `${fontSize}px "Aptos", "Trebuchet MS", sans-serif`;
    const lines = wrapGraphNodeLabel(ctx, normalized, maxWidth, 3, { allowWordBreak: false });
    if (!lines.length) {
      continue;
    }

    const lineHeight = fontSize * 1.04;
    if (lines.length * lineHeight <= maxHeight) {
      return {
        fontSize,
        lineHeight,
        lines,
      };
    }
  }

  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 0.5) {
    ctx.font = `${fontSize}px "Aptos", "Trebuchet MS", sans-serif`;
    const lines = wrapGraphNodeLabel(ctx, normalized, maxWidth, 3, { allowWordBreak: true });
    if (!lines.length) {
      continue;
    }

    const lineHeight = fontSize * 1.04;
    if (lines.length * lineHeight <= maxHeight) {
      return {
        fontSize,
        lineHeight,
        lines,
      };
    }
  }

  ctx.font = `${minFontSize}px "Aptos", "Trebuchet MS", sans-serif`;
  return {
    fontSize: minFontSize,
    lineHeight: minFontSize * 1.04,
    lines: wrapGraphNodeLabel(ctx, normalized, maxWidth, 3, { allowWordBreak: true, forceClamp: true }),
  };
}

function wrapGraphNodeLabel(ctx, text, maxWidth, maxLines, options = {}) {
  const { allowWordBreak = false, forceClamp = false } = options;
  const tokens = text.split(" ");
  const lines = [];
  let currentLine = "";
  let invalid = false;

  const pushLine = (line) => {
    if (line) {
      lines.push(line);
    }
  };

  const appendToken = (token) => {
    const candidate = currentLine ? `${currentLine} ${token}` : token;
    if (ctx.measureText(candidate).width <= maxWidth) {
      currentLine = candidate;
      return;
    }

    if (!currentLine) {
      if (!allowWordBreak || token.length < GRAPH_LABEL_BREAK_THRESHOLD) {
        invalid = true;
        return;
      }
      const brokenParts = breakGraphWord(ctx, token, maxWidth);
      if (!brokenParts.length) {
        invalid = true;
        return;
      }
      brokenParts.forEach((part) => {
        if (lines.length < maxLines - 1) {
          pushLine(part);
        } else {
          currentLine = part;
        }
      });
      return;
    }

    pushLine(currentLine);
    currentLine = "";
    if (invalid) {
      return;
    }
    appendToken(token);
  };

  tokens.forEach((token) => appendToken(token));
  pushLine(currentLine);

  if (invalid || !lines.length) {
    return [];
  }

  if (lines.length <= maxLines && !forceClamp) {
    return lines;
  }

  const clamped = lines.slice(0, maxLines);
  if (!clamped.length) {
    return [];
  }
  clamped[clamped.length - 1] = clampGraphLabelLine(ctx, clamped[clamped.length - 1], maxWidth);
  return clamped;
}

function breakGraphWord(ctx, word, maxWidth) {
  if (ctx.measureText(word).width <= maxWidth) {
    return [word];
  }

  const parts = [];
  let remaining = word;
  while (remaining.length >= GRAPH_LABEL_BREAK_THRESHOLD) {
    const splitIndex = findGraphWordBreakIndex(ctx, remaining, maxWidth);
    if (splitIndex === -1) {
      break;
    }

    parts.push(`${remaining.slice(0, splitIndex)}-`);
    remaining = remaining.slice(splitIndex);
  }

  if (remaining) {
    parts.push(remaining);
  }
  return parts;
}

function findGraphWordBreakIndex(ctx, word, maxWidth) {
  const minimumChunk = 3;
  const maximumIndex = word.length - minimumChunk;
  if (maximumIndex <= minimumChunk) {
    return -1;
  }

  const targetIndex = Math.round(word.length * 0.5);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = minimumChunk; index <= maximumIndex; index += 1) {
    const candidate = `${word.slice(0, index)}-`;
    if (ctx.measureText(candidate).width > maxWidth) {
      continue;
    }

    const distance = Math.abs(index - targetIndex);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }

  return bestIndex;
}

function clampGraphLabelLine(ctx, line, maxWidth) {
  if (ctx.measureText(line).width <= maxWidth) {
    return line;
  }

  let nextLine = line;
  while (nextLine.length > 1 && ctx.measureText(`${nextLine.slice(0, -1)}…`).width > maxWidth) {
    nextLine = nextLine.slice(0, -1);
  }
  return `${nextLine.slice(0, -1)}…`;
}

function drawMomentNode(ctx, pose, moment, isActive, nodeRadiusPx, highlightKind, isSelected = false, multiSelectColor = null) {
  const { x: worldX, y: worldY } = getMomentWorldPosition(
    pose,
    getMomentRenderFraction(moment),
    getTimelineRotationOffset(pose.timelineId),
  );
  const screen = worldToScreen(worldX, worldY);

  ctx.save();
  const palette = getCanvasPalette();
  ctx.fillStyle = palette.paper;
  ctx.strokeStyle =
    highlightKind === "draft"
      ? LINK_DRAFT_HIGHLIGHT
      : highlightKind === "linked"
        ? LINK_HIGHLIGHT
        : isSelected && multiSelectColor
          ? multiSelectColor
          : isActive || isSelected
            ? palette.blueStroke
            : palette.ink;
  ctx.lineWidth = Math.max(isActive || isSelected ? 2.8 : 1.8, nodeRadiusPx * (isActive || isSelected ? 0.16 : 0.12));
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, nodeRadiusPx, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function findMomentHit(timelineId, pointer) {
  const pose = buildPoseCache().get(timelineId);
  if (!pose) {
    return null;
  }

  const metrics = getTimelineMetrics(pose.r);
  const moments = getMomentsForTimeline(timelineId);
  const hitRadius = metrics.nodeRadius * 1.8;

  for (let index = moments.length - 1; index >= 0; index -= 1) {
    const moment = moments[index];
    const { x: worldX, y: worldY } = getMomentWorldPosition(
      pose,
      getMomentRenderFraction(moment),
      getTimelineRotationOffset(timelineId),
    );
    if (Math.hypot(pointer.x - worldX, pointer.y - worldY) <= hitRadius) {
      return moment;
    }
  }

  return null;
}

function isInsideCenterHole(timelineId, pointer) {
  const pose = buildPoseCache().get(timelineId);
  if (!pose) {
    return false;
  }

  const metrics = getTimelineMetrics(pose.r);
  return Math.hypot(pointer.x - pose.x, pointer.y - pose.y) <= metrics.centerRadius;
}

function getChildPoseFromMoment(parentPose, moment) {
  const childRadius = getChildRadius(parentPose, moment.childTimelineId);
  const anchor = getMomentWorldPosition(
    parentPose,
    getMomentRenderFraction(moment),
    getTimelineRotationOffset(parentPose.timelineId),
  );

  return {
    x: anchor.x,
    y: anchor.y,
    r: childRadius,
  };
}

function getMomentWorldPosition(pose, fraction, rotationOffset = 0) {
  const angle = fractionToRadians(fraction + rotationOffset);
  return getPointOnCircle(pose.x, pose.y, pose.r, angle);
}

function getPointOnCircle(x, y, radius, angle) {
  return {
    x: x + Math.cos(angle) * radius,
    y: y + Math.sin(angle) * radius,
  };
}

function getMomentAngle(momentOrId, timelineId, rotationOffset = 0) {
  const moment = typeof momentOrId === "string" ? state.momentsById[momentOrId] : momentOrId;
  if (!moment) {
    return -Math.PI / 2;
  }

  return fractionToRadians(getMomentRenderFraction(moment) + getTimelineRotationOffset(timelineId) + rotationOffset);
}

function getTimelineRotationOffset() {
  return 0;
}

function getChildRadius(parentPose, childTimelineId = null) {
  const parentMetrics = getTimelineMetrics(parentPose.r);
  const baseRadius = parentMetrics.nodeRadius * 2.3;
  if (!childTimelineId || !state.timelinesById[childTimelineId]) {
    return baseRadius;
  }

  const { momentCount, nestedCount } = getTimelineComplexity(childTimelineId);
  const growth = 1 + 0.16 * Math.sqrt(Math.max(0, momentCount - 1)) + 0.22 * Math.sqrt(nestedCount);
  return baseRadius * growth;
}

function getTimelineComplexity(timelineId) {
  const moments = getMomentsForTimeline(timelineId);
  const nestedCount = moments.filter((moment) => moment.childTimelineId).length;
  return {
    momentCount: moments.length,
    nestedCount,
  };
}

function getTimelineMetrics(radius) {
  const centerRadius = radius * 0.65;
  const band = radius - centerRadius;
  return {
    band,
    nodeRadius: radius * 0.044,
    centerRadius,
  };
}

function getSummaryMetrics(screenRadius) {
  return {
    ringWidth: clamp(screenRadius * 0.22, 8, 32),
    nodeRadius: clamp(screenRadius * 0.105, 6, 22),
  };
}

function getAppBackgroundColor() {
  const rootStyle = getComputedStyle(document.documentElement);
  const configured = rootStyle.getPropertyValue("--app-bg").trim();
  return configured || APP_BACKGROUND_FALLBACK;
}

function buildSummarySelectionState(pose, pathSelection) {
  const path = getPathMomentAndChild(pathSelection.momentId, pose.timelineId);
  if (!path) {
    return null;
  }

  const selectedMoment = state.momentsById[path.momentId];
  if (!selectedMoment) {
    return null;
  }

  const baseAngle = getMomentAngle(selectedMoment, pose.timelineId, 0);
  const alignAngle = pathSelection.alignTowardWorld
    ? Math.atan2(pathSelection.alignTowardWorld.y - pose.y, pathSelection.alignTowardWorld.x - pose.x)
    : baseAngle;
  const rotationOffset = normalizeFraction((alignAngle - baseAngle) / (Math.PI * 2));
  const selectedAngle = getMomentAngle(selectedMoment, pose.timelineId, rotationOffset);

  return {
    selectedMomentId: selectedMoment.id,
    childTimelineId: path.childTimelineId,
    highlightKind: pathSelection.highlightKind,
    rotationOffset,
    selectedAngle,
  };
}

function drawNestedSummaryGlyph(ctx, parentScreenPose, parentScreenRadius, parentAngle, childTimelineId, pathSelection, opacity) {
  const glyphRadius = Math.max(6, parentScreenRadius * 0.18);
  const glyphCenter = {
    x: parentScreenPose.x + Math.cos(parentAngle) * parentScreenRadius * 0.3,
    y: parentScreenPose.y + Math.sin(parentAngle) * parentScreenRadius * 0.3,
  };
  const childMoments = getMomentsForTimeline(childTimelineId);
  if (!childMoments.length) {
    return;
  }

  ctx.save();
  const palette = getCanvasPalette();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = palette.paper;
  ctx.beginPath();
  ctx.arc(glyphCenter.x, glyphCenter.y, glyphRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = palette.graySummaryStroke;
  ctx.lineWidth = Math.max(1.2, glyphRadius * 0.18);
  ctx.beginPath();
  ctx.arc(glyphCenter.x, glyphCenter.y, glyphRadius - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();

  const path = getPathMomentAndChild(pathSelection.momentId, childTimelineId);
  const selectedMomentId = path?.momentId ?? null;
  const selectedMoment = selectedMomentId ? state.momentsById[selectedMomentId] : null;
  const baseSelectedAngle = selectedMoment ? fractionToRadians(getMomentRenderFraction(selectedMoment)) : null;
  const rotationOffset =
    baseSelectedAngle == null ? 0 : normalizeFraction((parentAngle - baseSelectedAngle) / (Math.PI * 2));
  const selectedAngle =
    selectedMoment == null ? null : fractionToRadians(getMomentRenderFraction(selectedMoment) + rotationOffset);
  if (selectedAngle != null && pathSelection.highlightKind !== "linked-silent") {
    ctx.strokeStyle = pathSelection.highlightKind === "draft" ? LINK_DRAFT_HIGHLIGHT : LINK_HIGHLIGHT;
    ctx.lineWidth = Math.max(1.4, glyphRadius * 0.22);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(glyphCenter.x, glyphCenter.y);
    ctx.lineTo(
      glyphCenter.x + Math.cos(selectedAngle) * glyphRadius * 0.8,
      glyphCenter.y + Math.sin(selectedAngle) * glyphRadius * 0.8,
    );
    ctx.stroke();
  }

  childMoments.forEach((moment) => {
    const angle = fractionToRadians(getMomentRenderFraction(moment) + rotationOffset);
    const x = glyphCenter.x + Math.cos(angle) * glyphRadius;
    const y = glyphCenter.y + Math.sin(angle) * glyphRadius;
    ctx.fillStyle = palette.paper;
    ctx.strokeStyle =
      moment.id === selectedMomentId
        ? pathSelection.highlightKind === "draft"
          ? LINK_DRAFT_HIGHLIGHT
          : pathSelection.highlightKind === "linked"
            ? LINK_HIGHLIGHT
            : palette.ink
        : palette.ink;
    ctx.lineWidth = Math.max(0.8, glyphRadius * 0.15);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2, glyphRadius * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
}

function getSummaryAnchorWorldPosition(pose, targetMomentId, highlightKind, alignTowardWorld) {
  const summarySelection = buildSummarySelectionState(pose, {
    momentId: targetMomentId,
    highlightKind: highlightKind === LINK_DRAFT_HIGHLIGHT ? "draft" : "linked",
    alignTowardWorld,
  });
  if (!summarySelection) {
    return null;
  }
  return getPointOnCircle(pose.x, pose.y, pose.r, summarySelection.selectedAngle);
}

function pointerToScreen(event) {
  const rect = runtime.canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function pointerToWorld(event) {
  const screenPoint = pointerToScreen(event);

  return {
    x: runtime.camera.x + (screenPoint.x - runtime.width / 2) / runtime.camera.scale,
    y: runtime.camera.y + (screenPoint.y - runtime.height / 2) / runtime.camera.scale,
  };
}

function worldToScreen(x, y) {
  return {
    x: runtime.width / 2 + (x - runtime.camera.x) * runtime.camera.scale,
    y: runtime.height / 2 + (y - runtime.camera.y) * runtime.camera.scale,
  };
}

function renderOverlay() {
  const context = getResolvedContext();
  const visibleEntries = context.ancestry
    .map((entry) => {
      const timeline = state.timelinesById[entry.timelineId];
      const visibleLabel = getVisibleTimelineLabel(entry.timelineId);
      if (!timeline || !visibleLabel) {
        return null;
      }

      return {
        timelineId: timeline.id,
        label: truncate(visibleLabel, 20),
        isActive: entry.timelineId === context.timelineId,
      };
    })
    .filter(Boolean);

  runtime.elements.pathBar.innerHTML = visibleEntries
    .map(
      (entry, index) => `
        ${index ? '<span class="path-separator" aria-hidden="true">→</span>' : ""}
        <button class="path-link ${entry.isActive ? "is-active" : ""}" data-action="open-timeline" data-timeline-id="${entry.timelineId}">
          ${escapeHtml(entry.label)}
        </button>
      `,
    )
    .join("");

  renderDocumentChrome();
  renderMomentMetadataPanel(context.activeMomentId);
}

function getOverlayInsets() {
  const insets = {
    left: 28,
    right: 28,
    top: 86,
    bottom: 28,
  };

  if (!runtime.width || !runtime.height) {
    return insets;
  }

  const pathRect = runtime.elements.pathBar?.getBoundingClientRect();
  if (pathRect) {
    insets.top = Math.max(insets.top, pathRect.bottom + 18);
  }

  const toolbarRect = runtime.elements.documentToolbar?.getBoundingClientRect();
  if (toolbarRect) {
    insets.top = Math.max(insets.top, toolbarRect.bottom + 18);
  }

  const panelRect = runtime.elements.metaPanel?.getBoundingClientRect();
  if (panelRect && panelRect.width > 0) {
    if (panelRect.left >= runtime.width * 0.48) {
      insets.right = Math.max(insets.right, runtime.width - panelRect.left + 36);
    } else if (panelRect.top >= runtime.height * 0.55) {
      insets.bottom = Math.max(insets.bottom, runtime.height - panelRect.top + 24);
    }
  }

  return insets;
}

function renderPathTrailEntry(entry, index, totalCount) {
  return `
    <div class="path-entry">
      <button class="path-link ${entry.isActive ? "is-active" : ""}" data-action="open-timeline" data-timeline-id="${entry.timelineId}">
        ${escapeHtml(entry.label)}
      </button>
      ${index < totalCount - 1 ? '<span class="path-separator" aria-hidden="true"></span>' : ""}
    </div>
  `;
}

function renderOverlay() {
  const context = getResolvedContext();
  const visibleEntries = context.ancestry
    .map((entry) => {
      const timeline = state.timelinesById[entry.timelineId];
      const visibleLabel = getVisibleTimelineLabel(entry.timelineId);
      if (!timeline || !visibleLabel) {
        return null;
      }

      return {
        timelineId: timeline.id,
        label: truncate(visibleLabel, 20),
        isActive: entry.timelineId === context.timelineId,
      };
    })
    .filter(Boolean);

  runtime.elements.pathBar.innerHTML = visibleEntries
    .map((entry, index) => renderPathTrailEntry(entry, index, visibleEntries.length))
    .join("");

  renderDocumentChrome();
  renderMomentMetadataPanel(context.activeMomentId);
}

function resetDemo() {
  replaceProjectState(createInitialState(), { clearDocument: true });
  focusTitleEditor();
}

function exposePublicApi() {
  window.timelineApp = {
    state,
    openTimeline,
    selectMoment,
    createMoment,
    createChildTimeline,
    zoomIntoMoment,
    zoomOut,
    newProject,
    openProject,
    saveProject,
    saveProjectAs,
  };
}

function approachCircularFraction(current, target, factor) {
  let delta = target - current;
  if (delta > 0.5) {
    delta -= 1;
  }
  if (delta < -0.5) {
    delta += 1;
  }

  if (Math.abs(delta) < 0.0005) {
    return target;
  }

  return normalizeFraction(current + delta * factor);
}

function normalizeFraction(value) {
  let next = value;
  while (next < 0) {
    next += 1;
  }
  while (next >= 1) {
    next -= 1;
  }
  return Number(next.toFixed(4));
}

function normalizeIndex(index, size) {
  return ((index % size) + size) % size;
}

function fractionToRadians(fraction) {
  return fraction * Math.PI * 2 - Math.PI / 2;
}

function easeInOutCubic(value) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function lerp(start, end, progress) {
  return start + (end - start) * progress;
}

function truncate(value, limit) {
  if (!value) {
    return "";
  }
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 3))}...` : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-5)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
