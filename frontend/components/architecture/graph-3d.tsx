"use client";

import * as React from "react";
import { useSyncExternalStore } from "react";
import ForceGraph3D, { type ForceGraphMethods } from "react-force-graph-3d";
import * as THREE from "three";

import { markColor } from "@/components/architecture/product-mark";
import { drawIcon, type IconKey } from "@/lib/node-icons";
import {
  CHILDREN_BY_PARENT,
  LINKS,
  NODES,
  NODE_BY_ID,
  ROOT_ID,
  TIERS,
  TIER_BY_ID,
  STAGES,
  TREE_LINKS,
  type ArchNode,
  type ArchLink,
  type TierId,
} from "@/lib/architecture-data";
import {
  getResolvedServerSnapshot,
  getResolvedSnapshot,
  subscribeResolved,
} from "@/lib/theme-store";

/**
 * Expandable 3D pipeline graph.
 *
 * Opens collapsed as the request pipeline — Client → API Gateway → RAG & Skills
 * → vLLM Server → Database → Monitoring — with Platform underneath. Clicking a
 * stage expands it in place. Clicking **vLLM** unfolds the four things that make
 * one cheap GPU enough: KV caching, quantization, pruning and continuous
 * batching. That is the click the demo is built around.
 *
 * Exactly one axis is pinned: the flow axis, and only for the top-level stages,
 * so the pipeline reads in the order a request travels. Height and depth stay
 * free and stage children are not pinned at all. An earlier version pinned two
 * axes and the result read as a flat diagram that happened to be rendered in
 * WebGL — it lost the thing that makes a 3D graph worth using.
 */

type GraphNode = ArchNode & {
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  collapsed?: boolean;
  childCount?: number;
  __threeObj?: THREE.Object3D;
};

type GraphLink = {
  source: string | GraphNode;
  target: string | GraphNode;
  // Mirrors `ArchLink["kind"]`, so a new relationship added to the data cannot
  // be rendered without also being given a colour and a width here.
  kind: ArchLink["kind"];
};

/**
 * How far to close in after `zoomToFit`. See `reset` for why it is needed.
 *
 * Aggressive on purpose: this diagram is meant to be read on a recording, where
 * a comfortably-framed graph is an illegible one. Filling the viewport and
 * letting the outermost nodes sit near the edges beats a tidy margin nobody can
 * read the labels inside.
 */
const FIT_TIGHTEN = 0.72;

/**
 * How far to close in when a single card is isolated.
 *
 * Nearly none. The tightening above exists because eight stages in a row make a
 * wide, thin shape that leaves the viewport half empty; one card and its parts
 * is a compact cluster where the same tightening just crops the outermost child
 * off the edge — losing exactly what opening the card was meant to show.
 */
const FIT_TIGHTEN_ISOLATED = 0.95;

/** Camera standoff when focusing a node. See `focus`. */
const FOCUS_DISTANCE = 470;

/**
 * Label width as a fraction of the viewport, since labels are drawn without
 * perspective scaling. See `makeLabelSprite`.
 */
const LABEL_SCREEN_WIDTH = 0.23;

/** Label plate height, derived from the 256×80 canvas it is drawn on. */
const LABEL_SCREEN_HEIGHT = LABEL_SCREEN_WIDTH / 3.2;

/**
 * Node diameter as a fraction of the viewport height, per unit of `size`.
 *
 * Screen-constant like the labels, and for the same reason. The pipeline spans
 * ~2500 world units while a node is ~9 across, so a perspective-scaled node is
 * nine pixels wide at any framing that fits the whole diagram — the glyph inside
 * it would be decorative rather than legible. The cost is losing size-with-depth
 * as a cue; the links and the flow axis already carry that.
 */
const NODE_SCREEN_SCALE = 0.006;

/**
 * Distance between pipeline stages along the flow axis.
 *
 * Set against the label width rather than the node radius. Seven stages have to
 * sit side by side without their text colliding, and the labels are drawn at a
 * constant screen size, so spacing them for the spheres alone leaves the names
 * overlapping — which is what actually has to be readable.
 */
const FLOW_SPACING = 360;

/**
 * Rest length for containment edges — how closely a card's parts orbit it.
 *
 * Short enough that an expanded stage still reads as one cluster, wide enough
 * that the seven labels inside the vLLM card clear each other and the parent
 * they orbit.
 *
 * Generous because this is a 3D distance and the labels are 2D: a child pushed
 * mostly along Z sits the full rest length away in the scene while landing
 * almost on top of its parent on screen. The spacing has to survive that
 * foreshortening, not just the flat case.
 */
const CHILD_DISTANCE = 240;

const LINK_COLOR: Record<GraphLink["kind"], string> = {
  tree: "#8d99a4",
  request: "#0f6e7e",
  // Retrieval being pulled *into* the model reads as its own relationship, so
  // it gets its own colour rather than being another request arrow.
  context: "#7a6ba8",
  data: "#5b7596",
  observe: "#b04e72",
  // The only edges that flow back upstream. Given the strongest colour in the
  // set because "this returns to the model" is the whole claim of that stage.
  improve: "#2f8f5b",
  platform: "#6b7280",
};

export interface Graph3DHandle {
  focus: (nodeId: string) => void;
  reset: () => void;
  expand: (nodeId: string) => void;
  collapseAll: () => void;
  expandAll: () => void;
}


interface Graph3DProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  visibleTiers: Set<TierId>;
  showRequestPathOnly: boolean;
  onReady?: (handle: Graph3DHandle) => void;
  onExpandedChange?: (expanded: Set<string>) => void;
  /** Fires with the isolated card's id, or null when the whole network is shown. */
  onIsolatedChange?: (isolatedId: string | null) => void;
}

export function Graph3D({
  selectedId,
  onSelect,
  visibleTiers,
  showRequestPathOnly,
  onReady,
  onExpandedChange,
  onIsolatedChange,
}: Graph3DProps) {
  const fgRef = React.useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ width: 800, height: 600 });

  // Which parents are open. Starts with just the root, so the first view is the
  // seven groups rather than everything at once.
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([ROOT_ID]));

  // Set once the user drags, rotates or zooms. Auto-framing stands down after
  // that so it cannot fight them for control of the camera.
  const userMovedCamera = React.useRef(false);
  const pressOrigin = React.useRef<{ x: number; y: number } | null>(null);

  /**
   * When set, the scene shows only this node and what is inside it.
   *
   * Opening a card in place leaves its parts competing with thirty other nodes
   * for attention, which is the opposite of what clicking it was asking for. On
   * a recording the effect is worse: the thing being talked about is the least
   * prominent thing on screen. Isolating answers the question the click asked —
   * "show me what is in here" — and clicking the same node again puts it back.
   */
  const [isolatedId, setIsolatedId] = React.useState<string | null>(null);
  // Mirrored into a ref so `reset` can read it without taking it as a dependency
  // — `reset` is handed out through `onReady`, and re-creating it on every
  // isolate would re-register the handle mid-transition.
  const isolatedRef = React.useRef<string | null>(null);

  const isDark =
    useSyncExternalStore(
      subscribeResolved,
      getResolvedSnapshot,
      getResolvedServerSnapshot,
    ) === "dark";

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const resize = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  /**
   * Walk the tree from the root, descending only into expanded nodes.
   *
   * The request-path links are then overlaid between whichever nodes ended up
   * visible, so the diagram shows containment and flow at the same time —
   * "what is inside what" and "what calls what".
   */
  const data = React.useMemo(() => {
    const visible: GraphNode[] = [];
    const seen = new Set<string>();

    const walk = (id: string) => {
      if (seen.has(id)) return;

      // The root is a logical parent, not a component — it has no node of its
      // own. Rendering one put an unconnected "Support Assistant" hub in the
      // middle with spokes to every stage, which read as a broken pipeline.
      // The stages chain to each other through the request path instead, so the
      // flow is User → Support Assistant → API Gateway → … with nothing hanging.
      //
      // Deliberately not added to `seen`: a link must never roll up to a node
      // that is not on screen.
      if (id === ROOT_ID) {
        for (const child of CHILDREN_BY_PARENT.get(id) ?? []) walk(child.id);
        return;
      }

      const node = NODE_BY_ID.get(id);
      if (!node) return;
      seen.add(id);

      const children = CHILDREN_BY_PARENT.get(id) ?? [];
      visible.push({
        ...node,
        collapsed: children.length > 0 && !expanded.has(id),
        childCount: children.length,
        // Pin only the flow axis, and only for the top-level stages, so the
        // pipeline reads left to right in the order a request actually travels:
        // Client → Gateway → RAG & Skills → vLLM → Database → Monitoring.
        //
        // Height and depth stay free, and children of a stage are not pinned at
        // all — they cluster around their parent under the link force. That
        // keeps it a real 3D graph rather than a flowchart drawn in WebGL, which
        // is what pinning two axes produced.
        //
        // Not pinned while isolated: the flow axis only means anything when the
        // other stages are on screen, and holding a lone card at x = +1080
        // pushes it into a corner with its contents trailing off the edge.
        ...(node.flowOrder !== undefined && !isolatedId
          ? { fx: (node.flowOrder - (STAGES.length - 1) / 2) * FLOW_SPACING }
          : {}),
      });

      if (!expanded.has(id)) return;
      for (const child of children) walk(child.id);
    };

    // Isolated: start the walk at the focused card instead of the root, so only
    // it and its contents are built. Everything else simply never enters `seen`,
    // and the link pass below drops any edge that would leave the subtree.
    walk(isolatedId ?? ROOT_ID);

    // Copied, not filtered in place. The force graph resolves `source`/`target`
    // from ids to node objects on the data it is given, so handing it the shared
    // TREE_LINKS objects would mutate the module's own constant — and the next
    // `seen.has(l.source)` would then be testing an object against a set of ids
    // and quietly dropping every containment edge.
    const treeLinks: GraphLink[] = TREE_LINKS.filter(
      // Root edges are dropped with the root itself.
      (l) => l.source !== ROOT_ID && seen.has(l.source) && seen.has(l.target),
    ).map((l) => ({ source: l.source, target: l.target, kind: l.kind }));

    /**
     * Roll each flow edge up to the nearest ancestor that is actually on screen.
     *
     * Without this the collapsed view is a bare star: every request-path edge
     * runs between leaf nodes — `console → ingress`, `rag → postgres` — and all
     * of them are hidden inside collapsed groups, so the diagram shows
     * containment and no flow at all.
     *
     * Aggregating means `Client → Edge` is drawn because `console → ingress`
     * exists underneath it. The graph is fully connected at every level of
     * expansion, and the edges resolve to finer granularity as groups open.
     */
    const visibleAncestor = (id: string): string | null => {
      let current: string | undefined = id;
      while (current) {
        if (seen.has(current)) return current;
        current = NODE_BY_ID.get(current)?.parent;
      }
      return null;
    };

    const aggregated = new Map<string, GraphLink>();
    for (const link of LINKS) {
      const source = visibleAncestor(link.source);
      const target = visibleAncestor(link.target);
      // Both ends inside the same collapsed group is an internal detail — it
      // would render as a self-loop on the group.
      if (!source || !target || source === target) continue;
      const key = `${source}->${target}:${link.kind}`;
      if (!aggregated.has(key)) aggregated.set(key, { source, target, kind: link.kind });
    }

    return { nodes: visible, links: [...treeLinks, ...aggregated.values()] };
  }, [expanded, isolatedId]);

  const neighbours = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const node of data.nodes) map.set(node.id, new Set([node.id]));
    for (const link of data.links) {
      const s = typeof link.source === "string" ? link.source : link.source.id;
      const t = typeof link.target === "string" ? link.target : link.target.id;
      map.get(s)?.add(t);
      map.get(t)?.add(s);
    }
    return map;
  }, [data]);

  // react-force-graph mutates the node objects it was handed, writing x/y/z on
  // each tick, so positions are read from `data.nodes` — typed, unlike the
  // library's untyped `graphData()` accessor.
  const focus = React.useCallback(
    (nodeId: string) => {
      const graph = fgRef.current;
      if (!graph) return;
      const target = data.nodes.find((n) => n.id === nodeId);
      if (!target || target.x == null || target.y == null || target.z == null) return;

      const { x, y, z } = { x: target.x, y: target.y, z: target.z };

      // Approach along the ray from the origin, so the camera orbits the graph
      // rather than flying through the middle of it.
      //
      // A stage that has just expanded needs a wider shot than a leaf: the point
      // of focusing the vLLM card is to see the four techniques inside it, and a
      // distance that frames one sphere nicely puts its children off-screen.
      //
      // The `max(…, 120)` guards nodes near the origin — without it the ratio
      // explodes and the camera is thrown across the scene.
      const standoff =
        (target.childCount ?? 0) > 0 ? FOCUS_DISTANCE * 1.7 : FOCUS_DISTANCE;
      const ratio = 1 + standoff / Math.max(Math.hypot(x, y, z), 120);
      graph.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 900);
    },
    [data],
  );

  /**
   * Frame the visible graph.
   *
   * `zoomToFit` alone leaves the diagram small: it fits the *3D bounding
   * sphere*, which is considerably wider than what the camera actually projects,
   * so a graph occupying half the frame gets treated as filling it. Fitting and
   * then closing the remaining distance gives a view that fills the viewport
   * without clipping.
   */
  const reset = React.useCallback(() => {
    const graph = fgRef.current;
    if (!graph) return;
    // Reset hands the camera back to the auto-framing — it is the way out of a
    // view you have dragged somewhere unhelpful.
    userMovedCamera.current = false;

    // Square up to the flow axis before fitting.
    //
    // `zoomToFit` only changes the distance, keeping whatever direction the
    // camera is currently pointing. After someone has rotated the graph that
    // means Reset re-frames the pipeline while leaving it standing on end — tidy
    // but unreadable, and no way back to the shot the demo opens on short of a
    // page reload. Dropping the camera back onto the +Z axis first restores
    // left-to-right, and the fit below then sets the distance.
    const orbit = graph.controls() as { target: THREE.Vector3 };
    const { position } = graph.camera();
    const distance = position.distanceTo(orbit.target) || 1000;
    graph.cameraPosition(
      { x: orbit.target.x, y: orbit.target.y, z: orbit.target.z + distance },
      orbit.target,
      0,
    );

    graph.zoomToFit(500, 40);
    window.setTimeout(() => {
      // Read the settled position off the Three.js camera: `cameraPosition()`
      // is typed as a setter only, so it cannot be used to read back.
      const { position } = graph.camera();

      // Close in along the line of sight, toward what the camera is aimed at —
      // not toward the world origin.
      //
      // `zoomToFit` aims at the centre of the graph's bounding box, which is not
      // the origin: the pipeline is pinned symmetrically on the flow axis but
      // free on the other two. Scaling the position toward the origin therefore
      // swings the view direction as well as shortening it, and the graph slides
      // off to one corner — which is exactly what it used to do.
      const target = orbit.target;
      const tighten = isolatedRef.current ? FIT_TIGHTEN_ISOLATED : FIT_TIGHTEN;
      graph.cameraPosition(
        {
          x: target.x + (position.x - target.x) * tighten,
          y: target.y + (position.y - target.y) * tighten,
          z: target.z + (position.z - target.z) * tighten,
        },
        target,
        400,
      );
    }, 520);
  }, []);

  const toggle = React.useCallback((nodeId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        // Collapse the whole subtree, so re-opening starts clean rather than
        // remembering a half-expanded state from earlier in the demo.
        const drop = (id: string) => {
          next.delete(id);
          for (const child of CHILDREN_BY_PARENT.get(id) ?? []) drop(child.id);
        };
        drop(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const expand = React.useCallback((nodeId: string) => {
    // The guided tour walks the whole pipeline, so it needs the whole pipeline
    // on screen. Stepping to a node outside the isolated card would otherwise
    // narrate something nobody can see.
    setIsolatedId(null);
    setExpanded((current) => (current.has(nodeId) ? current : new Set(current).add(nodeId)));
  }, []);

  const collapseAll = React.useCallback(() => {
    setIsolatedId(null);
    setExpanded(new Set([ROOT_ID]));
  }, []);
  const expandAll = React.useCallback(() => {
    setIsolatedId(null);
    setExpanded(new Set(NODES.map((n) => n.id)));
  }, []);

  /**
   * Open a card on its own, or put it back into the network.
   *
   * The two directions are deliberately the same click. A client who has just
   * opened the vLLM card looks for the way back at the thing they clicked, not
   * in the toolbar — and during a recording that is one gesture rather than a
   * hunt for a button.
   */
  const toggleIsolate = React.useCallback(
    (nodeId: string) => {
      // Give the camera back to the auto-framing: the view is about to change
      // completely, and holding the old framing would leave the new subject
      // somewhere off screen.
      userMovedCamera.current = false;

      if (isolatedId === nodeId) {
        setIsolatedId(null);
        toggle(nodeId);
        return;
      }
      setIsolatedId(nodeId);
      setExpanded((current) => (current.has(nodeId) ? current : new Set(current).add(nodeId)));
    },
    [isolatedId, toggle],
  );

  React.useEffect(() => {
    onReady?.({ focus, reset, expand, collapseAll, expandAll });
  }, [onReady, focus, reset, expand, collapseAll, expandAll]);

  React.useEffect(() => {
    isolatedRef.current = isolatedId;
    onIsolatedChange?.(isolatedId);
  }, [isolatedId, onIsolatedChange]);

  // Escape leaves the isolated card, matching the tour's own exit key.
  React.useEffect(() => {
    if (!isolatedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      userMovedCamera.current = false;
      setIsolatedId(null);
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(isolatedId);
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isolatedId]);

  // Refit after an expand or collapse, unless something is focused. New nodes
  // appear outside the frame otherwise, which looks like nothing happened.
  /**
   * Auto-frame after an expand or collapse — but never against the user.
   *
   * The simulation settles repeatedly, and re-framing on every settle meant the
   * camera snapped back to centre a beat after any drag. That reads exactly like
   * "panning is broken": you move the graph, it springs back. Once someone has
   * taken hold of the camera, the framing is theirs until they press Reset.
   */
  React.useEffect(() => {
    if (selectedId || userMovedCamera.current) return;
    const timer = window.setTimeout(reset, 700);
    return () => window.clearTimeout(timer);
  }, [data, selectedId, reset]);

  // A press that moves counts as taking the camera; a press that does not is a
  // click, and clicking a node should still be allowed to re-frame the view.
  //
  // Watching the pointer beats subscribing to the controls' change event, which
  // also fires for our own programmatic moves and so would switch auto-framing
  // off the first time it ran.
  const handlePointerDown = React.useCallback((event: React.PointerEvent) => {
    pressOrigin.current = { x: event.clientX, y: event.clientY };
  }, []);

  const handlePointerMove = React.useCallback((event: React.PointerEvent) => {
    const origin = pressOrigin.current;
    if (!origin) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) {
      userMovedCamera.current = true;
      pressOrigin.current = null;
    }
  }, []);

  const handlePointerUp = React.useCallback(() => {
    pressOrigin.current = null;
  }, []);

  // Focus twice, deliberately.
  //
  // Selecting a node usually expands it, and the new children push the whole
  // neighbourhood around for a second or so afterwards. A single camera move
  // arrives while that is still happening and leaves the subject drifting off
  // centre. The second call re-centres once the layout has settled.
  //
  // Except when the card is isolated: it is then the only thing on screen, and
  // flying at it crops off the very contents the click asked to see. Fitting is
  // the correct framing there, and `reset` already does it.
  React.useEffect(() => {
    if (!selectedId) return;
    const frame = isolatedId ? reset : () => focus(selectedId);
    const first = window.setTimeout(frame, 700);
    const settle = window.setTimeout(frame, 2200);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(settle);
    };
  }, [selectedId, isolatedId, focus, reset, data]);

  // Configured on the first tick, not at mount: `d3Force` reaches a simulation
  // that does not exist until the graph has rendered once, and touching it early
  // crashes the render loop on the next frame.
  const forcesConfigured = React.useRef(false);
  const configureForces = React.useCallback(() => {
    if (forcesConfigured.current) return;
    const charge = fgRef.current?.d3Force("charge");
    if (!charge) return;

    // Tuned for legibility rather than compactness. At the library defaults the
    // groups sit close enough that their spheres and labels overlap, which is
    // what makes a 3D graph look like a ball of dots.
    //
    // The link distance is set against the *label* width (~104 world units),
    // not the node radius. Spacing for the spheres alone leaves the text
    // overlapping, which is the thing that actually has to be readable.
    charge.strength(-1800).distanceMax(1400);

    // Two different rest lengths, because the two kinds of edge mean different
    // things.
    //
    // Flow edges connect stages, which are pinned FLOW_SPACING apart in X. The
    // rest length is set well *above* that spacing on purpose: X is already
    // fixed, so the only way to reach it is to separate in Y and Z, and the
    // pipeline lifts off the line into a ribbon with real depth.
    //
    // This is what fills the frame. Eight stages in a straight row is a very
    // wide, very thin shape — fitting it leaves most of the viewport empty and
    // every node small, and zooming past that crops the ends off. Giving the
    // stages room to rise and fall trades unusable width for usable height, and
    // separates consecutive labels vertically as a side effect.
    //
    // Containment edges are the opposite: a card's parts should hug it, so
    // expanding vLLM reads as "these are inside this" rather than four unrelated
    // nodes drifting off across the diagram.
    fgRef.current
      ?.d3Force("link")
      ?.distance((link: GraphLink) =>
        link.kind === "tree" ? CHILD_DISTANCE : FLOW_SPACING * 1.5,
      );

    forcesConfigured.current = true;
  }, []);

  const nodeThreeObject = React.useCallback(
    (node: GraphNode) => {
      const tier = TIER_BY_ID.get(node.tier);
      const brand = markColor(node.logo);
      const color = brand ?? tier?.color ?? "#888";
      const radius = node.size ?? 6;

      const group = new THREE.Group();

      if (node.icon) {
        // An icon disc rather than a shaded sphere.
        //
        // A glyph painted onto a sphere would be distorted by the spherical UV
        // map and hidden by the sphere's own near face half the time. A billboard
        // disc always faces the camera, so the database always looks like a
        // database. It keeps `sizeAttenuation` on, so distance still reads as
        // size — the depth cue the sphere's shading used to provide.
        group.add(makeIconSprite(node.icon, radius, color, isDark, node.collapsed));
      } else {
        group.add(
          new THREE.Mesh(
            new THREE.SphereGeometry(radius, 24, 18),
            new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.92 }),
          ),
        );

        // A collapsed parent gets a visible shell, so "there is more inside this"
        // is legible before anyone clicks. Without it, expandability is a secret.
        // Iconed nodes draw their own dashed ring instead — a world-space shell
        // around a screen-space disc would drift out of register with it.
        if (node.collapsed) {
          group.add(
            new THREE.Mesh(
              new THREE.SphereGeometry(radius + 4.5, 20, 14),
              new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.16,
                wireframe: true,
              }),
            ),
          );
        }
      }

      group.add(
        makeLabelSprite(
          node.label,
          node.collapsed && node.childCount ? `+${node.childCount} inside` : node.sub,
          radius,
          isDark,
        ),
      );
      return group;
    },
    [isDark],
  );

  const dimmed = React.useCallback(
    (nodeId: string) => Boolean(selectedId) && !neighbours.get(selectedId!)?.has(nodeId),
    [selectedId, neighbours],
  );

  const nodeVisibility = React.useCallback(
    (node: GraphNode) => node.id === ROOT_ID || visibleTiers.has(node.tier),
    [visibleTiers],
  );

  const linkVisibility = React.useCallback(
    (link: GraphLink) => {
      const s = typeof link.source === "string" ? link.source : link.source.id;
      const t = typeof link.target === "string" ? link.target : link.target.id;
      const source = NODE_BY_ID.get(s);
      const target = NODE_BY_ID.get(t);
      if (!source || !target) return false;
      if (s !== ROOT_ID && !visibleTiers.has(source.tier)) return false;
      if (t !== ROOT_ID && !visibleTiers.has(target.tier)) return false;
      // Containment edges stay visible in request-path mode — remove them and
      // expanded children detach from their parent and float free.
      if (showRequestPathOnly && link.kind !== "request" && link.kind !== "tree") return false;
      return true;
    },
    [visibleTiers, showRequestPathOnly],
  );

  const linkColor = React.useCallback(
    (link: GraphLink) => {
      const s = typeof link.source === "string" ? link.source : link.source.id;
      const t = typeof link.target === "string" ? link.target : link.target.id;
      if (selectedId && (dimmed(s) || dimmed(t))) return isDark ? "#232c35" : "#e4e9ee";
      return LINK_COLOR[link.kind];
    },
    [selectedId, dimmed, isDark],
  );

  return (
    <div
      ref={containerRef}
      className="size-full"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <ForceGraph3D<GraphNode, GraphLink>
        ref={fgRef}
        width={size.width}
        height={size.height}
        graphData={data}
        backgroundColor={isDark ? "#0d1217" : "#f7f9fb"}
        showNavInfo={false}
        nodeThreeObject={nodeThreeObject}
        nodeVisibility={nodeVisibility}
        linkVisibility={linkVisibility}
        linkColor={linkColor}
        linkWidth={(link) => (link.kind === "request" ? 1.6 : link.kind === "tree" ? 1 : 0.6)}
        linkOpacity={0.5}
        linkDirectionalParticles={(link) => (link.kind === "request" ? 2 : 0)}
        linkDirectionalParticleWidth={2}
        linkDirectionalParticleSpeed={0.006}
        onNodeClick={(node) => {
          // One click does everything: open the card on its own if it has
          // contents, close it again if it is already open, and select it either
          // way. Making expansion a separate affordance would put a fiddly hit
          // target in the middle of a live demo.
          if ((node.childCount ?? 0) > 0) toggleIsolate(node.id);
          onSelect(node.id);
        }}
        // Nodes can be dragged into place by hand. The force layout is good at
        // untangling but has no idea which arrangement makes the argument
        // clearest, and on a recording that last nudge is worth having.
        enableNodeDrag
        onNodeDragEnd={(node) => {
          // Pin where it was dropped. Without this the simulation pulls it
          // straight back and the drag looks like it failed.
          node.fx = node.x;
          node.fy = node.y;
          node.fz = node.z;
        }}
        onBackgroundClick={() => onSelect(null)}
        onEngineTick={configureForces}
        // Refit once the layout has actually settled.
        //
        // The timed fit below runs 700ms after an expand, while the simulation
        // is still spreading nodes out — it frames a layout that no longer
        // exists a second later, which is why the graph used to end up parked in
        // one corner. This is the fit that counts; the timed one only avoids a
        // visible jump in the meantime.
        onEngineStop={() => {
          if (!selectedId && !userMovedCamera.current) reset();
        }}
        // Left-drag rotates the whole structure, right-drag (or a two-finger
        // trackpad drag) pans it, scroll zooms.
        //
        // Left on the default trackball rather than orbit: orbit's controls and
        // the node-drag controls fight over the pointer, and ending a node drag
        // throws inside OrbitControls.onPointerUp — it processes a release it
        // never saw the press for. Trackball handles the handover cleanly, and
        // node dragging was the more valuable of the two. Its free tumbling is
        // the cost; Reset squaring up to the flow axis is the mitigation.
        cooldownTicks={120}
        d3AlphaDecay={0.04}
        d3VelocityDecay={0.35}
      />
    </div>
  );
}

/**
 * Camera-facing text label, drawn on a canvas at 2× so it survives video
 * compression. Kept to a couple of words — anything longer belongs in the HTML
 * panel, where it renders at full resolution.
 */
/**
 * The node itself: a filled disc in the component's colour with its glyph inside.
 *
 * Drawn at 4× and mipmapped, because this is the element a viewer looks at
 * longest and a soft glyph is the first thing that reads as cheap on video.
 */
function makeIconSprite(
  icon: IconKey,
  radius: number,
  color: string,
  isDark: boolean,
  collapsed: boolean | undefined,
): THREE.Sprite {
  const size = 128;
  const scale = 4;

  const canvas = document.createElement("canvas");
  canvas.width = size * scale;
  canvas.height = size * scale;
  const ctx = canvas.getContext("2d");

  if (ctx) {
    ctx.scale(scale, scale);

    const centre = size / 2;
    // The dashed ring, when present, needs room outside the disc.
    const discRadius = centre - (collapsed ? 12 : 4);

    ctx.beginPath();
    ctx.arc(centre, centre, discRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // A rim in the page background separates touching nodes without needing a
    // gap the force layout cannot guarantee.
    ctx.lineWidth = 3;
    ctx.strokeStyle = isDark ? "rgba(13,18,23,0.9)" : "rgba(247,249,251,0.9)";
    ctx.stroke();

    // A dashed ring means "this opens". Drawn into the same texture as the disc
    // so it can never drift out of register with it.
    if (collapsed) {
      ctx.beginPath();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.arc(centre, centre, discRadius + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // The glyph is knocked out in the background colour rather than in white, so
    // it reads the same way in both themes against any node colour.
    const glyph = discRadius * 1.05;
    ctx.translate(centre - glyph / 2, centre - glyph / 2);
    drawIcon(ctx, icon, glyph, isDark ? "#0d1217" : "#f7f9fb");
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, sizeAttenuation: false }),
  );
  const diameter = iconScreenSize(radius);
  sprite.scale.set(diameter, diameter, 1);
  return sprite;
}

/** Screen-space diameter of a node, so the label can be placed clear of it. */
function iconScreenSize(radius: number): number {
  return radius * NODE_SCREEN_SCALE;
}

function makeLabelSprite(
  label: string,
  sub: string | undefined,
  radius: number,
  isDark: boolean,
): THREE.Sprite {
  // 3× supersampling. The sprite is scaled up in world units below, so a
  // 2× texture would visibly soften once the camera is close enough to read it.
  const scale = 3;
  const width = 256 * scale;
  const height = 80 * scale;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  if (ctx) {
    ctx.scale(scale, scale);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Halo behind the glyphs rather than a filled plate: labels stay readable
    // over links and distant nodes without boxing every node in a rectangle.
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.lineWidth = 6;
    ctx.strokeStyle = isDark ? "rgba(13,18,23,0.95)" : "rgba(247,249,251,0.95)";

    ctx.font = "650 22px ui-sans-serif, -apple-system, system-ui, sans-serif";
    ctx.strokeText(label, 128, 22);
    ctx.fillStyle = isDark ? "#f0f4f8" : "#0d1217";
    ctx.fillText(label, 128, 22);

    if (sub) {
      ctx.lineWidth = 5;
      ctx.font = "500 16px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.strokeText(sub, 128, 48);
      ctx.fillStyle = isDark ? "#9aa7b3" : "#4b5763";
      ctx.fillText(sub, 128, 48);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      // Constant size on screen regardless of depth.
      //
      // With perspective scaling, a node at the back of the scene gets a label
      // a third the size of one at the front — legible on a monitor, unreadable
      // in a recording, and the labels are the part that has to be read. The
      // cost is losing depth as a size cue, which the links and the shading
      // already provide.
      sizeAttenuation: false,
    }),
  );

  // In screen space these are fractions of viewport height, not world units.
  // The ratio matches the texture's 256×80 aspect so the text is not stretched.
  sprite.scale.set(LABEL_SCREEN_WIDTH, LABEL_SCREEN_HEIGHT, 1);

  // Hang the label below the node using `center` rather than a world-space
  // position.
  //
  // `center` is the sprite's own anchor point, so the offset is measured in
  // sprite heights and therefore stays constant on screen — a world offset would
  // shrink toward nothing as the camera pulled back, and the label would end up
  // sitting on top of the node it names. `center.y = 1` puts the sprite's top
  // edge at the node; the extra term clears the node's own disc.
  const clearance = iconScreenSize(radius) / 2 + LABEL_SCREEN_HEIGHT * 0.18;
  sprite.center.set(0.5, 1 + clearance / LABEL_SCREEN_HEIGHT);
  return sprite;
}

export { TIERS };
