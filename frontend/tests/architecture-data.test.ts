import { describe, expect, it } from "vitest";

import {
  ancestorsOf,
  CHILDREN_BY_PARENT,
  LINKS,
  NODES,
  NODE_BY_ID,
  ROOT_ID,
  STAGES,
  TIERS,
  TIER_BY_ID,
  TOUR,
  TREE_LINKS,
} from "@/lib/architecture-data";
import { ICONS } from "@/lib/node-icons";

/**
 * The architecture graph is demo content, and demo content rots silently: a
 * renamed node id breaks a tour step, a missing rationale field renders an empty
 * panel, and neither shows up until someone is recording.
 *
 * These tests are the guard. They are cheap and they fail loudly.
 */

describe("architecture graph integrity", () => {
  it("has unique node ids", () => {
    const ids = NODES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every link connects two real nodes", () => {
    for (const link of LINKS) {
      expect(NODE_BY_ID.has(link.source), `unknown source: ${link.source}`).toBe(true);
      expect(NODE_BY_ID.has(link.target), `unknown target: ${link.target}`).toBe(true);
    }
  });

  it("every node belongs to a declared tier", () => {
    for (const node of NODES) {
      expect(TIER_BY_ID.has(node.tier), `${node.id} has tier ${node.tier}`).toBe(true);
    }
  });

  it("every tier is populated", () => {
    // An empty tier renders as a labelled gap in the graph, which reads as a
    // missing piece of the architecture rather than as a deliberate absence.
    for (const tier of TIERS) {
      expect(
        NODES.some((n) => n.tier === tier.id),
        `tier "${tier.id}" has no nodes`,
      ).toBe(true);
    }
  });

  it("no node is orphaned", () => {
    // Containment counts as connection: group nodes have no request-path edges,
    // they hold children. A node in neither set would render floating alone.
    const connected = new Set(
      [...LINKS, ...TREE_LINKS].flatMap((l) => [l.source, l.target]),
    );
    for (const node of NODES) {
      if (node.id === ROOT_ID) continue;
      expect(connected.has(node.id), `${node.id} is not connected to anything`).toBe(true);
    }
  });
});

describe("hierarchy", () => {
  it("every node reaches the root", () => {
    // An unreachable node can never be revealed by expanding, so it would be
    // invisible however much the client clicks.
    for (const node of NODES) {
      if (node.id === ROOT_ID) continue;
      const chain = ancestorsOf(node.id);
      expect(chain.length, `${node.id} has no ancestors`).toBeGreaterThan(0);
      expect(chain[chain.length - 1], `${node.id} does not reach the root`).toBe(ROOT_ID);
    }
  });

  it("has no parent cycles", () => {
    for (const node of NODES) {
      const chain = ancestorsOf(node.id);
      expect(new Set(chain).size, `cycle above ${node.id}`).toBe(chain.length);
    }
  });

  it("the first view is small enough to take in", () => {
    // The whole point of collapsing is that a client meets a handful of boxes
    // rather than the full system at once.
    const topLevel = CHILDREN_BY_PARENT.get(ROOT_ID) ?? [];
    expect(topLevel.length).toBeGreaterThan(3);
    expect(topLevel.length).toBeLessThanOrEqual(9);
  });

  it("vLLM is a top-level stage and expands into its four optimisations", () => {
    // This is the click the demo is built around: open the vLLM card, reveal
    // the techniques that make one cheap GPU enough.
    expect(NODE_BY_ID.get("vllm")?.parent).toBe(ROOT_ID);

    const children = (CHILDREN_BY_PARENT.get("vllm") ?? []).map((n) => n.id);
    for (const technique of [
      "kvcache",
      "pagedattention",
      "prefixcache",
      "quantized",
      "pruning",
      "batching",
    ]) {
      expect(children, `vLLM does not expand into ${technique}`).toContain(technique);
    }
  });

  it("names the actual model, its instruct variant and its quantization", () => {
    // "an open-source model" is what every competitor says. Naming the exact
    // checkpoint and its precision is the part a technical buyer can verify, and
    // it has to survive on the node itself rather than only in the panel prose.
    const model = NODE_BY_ID.get("model");
    expect(model, "no dedicated model node inside the vLLM card").toBeDefined();
    expect(model!.parent).toBe("vllm");
    expect(model!.label).toMatch(/Qwen2\.5-7B-Instruct/);
    expect(`${model!.sub}`).toMatch(/W4A16|INT4/);
  });

  it("pruning is presented as opt-in rather than as a shipped capability", () => {
    // Pruning exists as a recipe but is deliberately not enabled — one-shot 2:4
    // sparsity costs answer quality. Claiming it as active would be the kind of
    // overstatement a technical buyer checks and finds.
    const pruning = NODE_BY_ID.get("pruning");
    expect(pruning).toBeDefined();
    const copy = `${pruning!.clientBenefit} ${pruning!.userBenefit} ${pruning!.metric?.value ?? ""}`;
    expect(copy).toMatch(/opt-in|not enabled|by default/i);
  });
});

describe("the pipeline", () => {
  it("runs user → assistant → gateway → context → serving → data → ops → improve → platform", () => {
    expect(STAGES.map((s) => s.tier)).toEqual([
      "client",
      "ui",
      "gateway",
      "context",
      "serving",
      "data",
      "ops",
      "improve",
      "platform",
    ]);
  });

  it("gives every stage a distinct position on the flow axis", () => {
    const orders = STAGES.map((s) => s.flowOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("only stages are pinned to the flow axis", () => {
    // Pinning a child would drag it out of its parent's cluster and break the
    // expansion layout.
    for (const node of NODES) {
      if (node.flowOrder === undefined) continue;
      expect(node.parent, `${node.id} is pinned but is not top level`).toBe(ROOT_ID);
    }
  });

  it("connects each stage to the next", () => {
    // Rolled up to stage level, the request path must actually be a path — a
    // gap would render as a disconnected card.
    const stageOf = (nodeId: string): string | undefined => {
      for (const id of [nodeId, ...ancestorsOf(nodeId)]) {
        if (STAGES.some((s) => s.id === id)) return id;
      }
      return undefined;
    };

    const edges = new Set(
      LINKS.map((l) => {
        const s = stageOf(l.source);
        const t = stageOf(l.target);
        return s && t && s !== t ? `${s}->${t}` : null;
      }).filter(Boolean) as string[],
    );

    for (const step of [
      "customer->console",
      "console->stage-gateway",
      "stage-gateway->stage-context",
      "stage-context->vllm",
      "vllm->stage-db",
      "stage-db->stage-ops",
    ]) {
      expect(edges, `pipeline is broken at ${step}`).toContain(step);
    }
  });

  it("every group summarises itself", () => {
    // A client may click a group and never open it, so the group's own copy has
    // to stand alone rather than deferring to its children.
    //
    // ROOT_ID is skipped: it is a logical parent with no node and is never
    // rendered — the stages chain to each other directly.
    for (const [parentId] of CHILDREN_BY_PARENT) {
      if (parentId === ROOT_ID) continue;
      const parent = NODE_BY_ID.get(parentId);
      expect(parent, `${parentId} has children but is not a node`).toBeDefined();
      expect(parent!.clientBenefit.length).toBeGreaterThan(20);
      expect(parent!.userBenefit.length).toBeGreaterThan(20);
    }
  });

  it("the root is logical only — it has no node of its own", () => {
    // A rendered root becomes a hub every stage hangs off, which is exactly the
    // shape the pipeline is meant to replace.
    expect(NODE_BY_ID.has(ROOT_ID)).toBe(false);
  });

  it("tree links match the parent fields exactly", () => {
    expect(TREE_LINKS.length).toBe(NODES.filter((n) => n.parent).length);
    for (const link of TREE_LINKS) {
      expect(NODE_BY_ID.get(link.target)?.parent).toBe(link.source);
    }
  });
});

describe("every node explains itself", () => {
  it.each(NODES.map((n) => [n.id, n] as const))(
    "%s carries all four rationale fields",
    (_id, node) => {
      // The four questions a client is actually asking. A node missing one
      // renders a blank section in the detail panel mid-presentation.
      expect(node.what.length, "what").toBeGreaterThan(20);
      expect(node.whyUsed.length, "whyUsed").toBeGreaterThan(20);
      expect(node.clientBenefit.length, "clientBenefit").toBeGreaterThan(20);
      expect(node.userBenefit.length, "userBenefit").toBeGreaterThan(20);
      expect(node.demoNote.length, "demoNote").toBeGreaterThan(10);
    },
  );

  it("every icon a node asks for actually exists", () => {
    // A typo'd key would index ICONS as undefined and throw inside the render
    // loop, taking the whole canvas down rather than one glyph.
    for (const node of NODES) {
      if (!node.icon) continue;
      expect(ICONS[node.icon], `${node.id} wants a missing icon`).toBeTypeOf("function");
    }
  });

  it("gives every top-level stage a glyph", () => {
    // The stages are what a client sees before clicking anything, so shape has
    // to carry meaning at that level even if the leaves rely on their labels.
    for (const stage of STAGES) {
      expect(stage.icon, `stage "${stage.id}" has no icon`).toBeDefined();
    }
  });

  it("marks projected figures as estimates", () => {
    // A number stated flatly reads as measured. Anything not measured must say so,
    // because a client may check it.
    for (const node of NODES) {
      if (!node.metric) continue;
      expect(typeof node.metric.value).toBe("string");
      expect(node.metric.caption.length).toBeGreaterThan(3);
    }
  });
});

describe("the mandated component chain is complete", () => {
  // Every component the brief requires must exist as a node. Checked by concept
  // rather than by id so a rename does not silently drop one from the diagram.
  const REQUIRED: [string, RegExp][] = [
    ["frontend chatbot", /chatbot|console/i],
    ["request analysis", /analysis/i],
    ["RAG retrieval", /rag|retriev/i],
    ["skills", /skill/i],
    ["authorization", /authz|authoriz/i],
    ["authentication", /authn|authentic/i],
    ["inference engine", /vllm/i],
    ["continuous batching", /batching/i],
    ["KV cache", /kvcache|kv cache/i],
    ["PagedAttention", /pagedattention/i],
    ["prefix caching", /prefixcache|prefix caching/i],
    ["quantized model", /quantiz/i],
    ["stateless logging", /logging/i],
    ["audit log", /audit/i],
    ["Prometheus", /prometheus/i],
    ["Grafana", /grafana/i],
    ["staging and production", /envs|staging/i],
    ["Kubernetes", /k8s|kubernetes/i],
    ["feedback capture", /feedbackcapture|feedback capture/i],
    ["A/B comparison", /abcompare|side-by-side/i],
    ["preference dataset", /preferences|preference dataset/i],
    ["answer scoring", /scoring/i],
    ["fine-tuning", /finetune|fine-tuning/i],
    ["promotion gate", /evalgate|promotion gate/i],
  ];

  it.each(REQUIRED)("includes %s", (_concept, pattern) => {
    const found = NODES.some((n) => pattern.test(n.id) || pattern.test(n.label));
    expect(found).toBe(true);
  });
});

describe("guided tour", () => {
  it("every stop points at a real node", () => {
    for (const stop of TOUR) {
      expect(NODE_BY_ID.has(stop.nodeId), `tour stop → ${stop.nodeId}`).toBe(true);
    }
  });

  it("has narration on every stop", () => {
    for (const stop of TOUR) {
      expect(stop.chapter.length).toBeGreaterThan(3);
      expect(stop.say.length).toBeGreaterThan(30);
    }
  });

  it("covers the components that carry the cost argument", () => {
    // These four are the commercial case. A tour that skips one is a tour that
    // does not explain why the system costs what it costs.
    const ids = TOUR.map((s) => s.nodeId);
    for (const required of [
      "vllm",
      "quantized",
      "kvcache",
      "pagedattention",
      "prefixcache",
      "batching",
    ]) {
      expect(ids, `tour omits ${required}`).toContain(required);
    }
  });

  it("starts at the client and ends in operations", () => {
    // Asserted by tier rather than by node id: the tour should open on the
    // customer's side of the system and close on how it is run, and that should
    // stay true through a restructure without needing the test rewritten.
    expect(NODE_BY_ID.get(TOUR[0]!.nodeId)?.tier).toBe("client");
    const lastTier = NODE_BY_ID.get(TOUR[TOUR.length - 1]!.nodeId)?.tier;
    expect(["ops", "platform"]).toContain(lastTier);
  });

  it("follows the pipeline in order", () => {
    // The tour is the narrative spine of the demo. If a stop appears before the
    // stage it belongs to, the story doubles back and stops making sense.
    const order = new Map(STAGES.map((s, i) => [s.id, i]));
    const stageOf = (nodeId: string): number | undefined => {
      for (const id of [nodeId, ...ancestorsOf(nodeId)]) {
        const position = order.get(id);
        if (position !== undefined) return position;
      }
      return undefined;
    };

    const positions = TOUR.map((stop) => stageOf(stop.nodeId)).filter(
      (p): p is number => p !== undefined,
    );
    for (let i = 1; i < positions.length; i++) {
      expect(
        positions[i]! >= positions[i - 1]!,
        `tour goes backwards at "${TOUR[i]!.chapter}"`,
      ).toBe(true);
    }
  });
});
