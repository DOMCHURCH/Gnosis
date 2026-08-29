import { useEffect, useRef, useState } from "react";
import type { FloorLayout, ZoneId } from "./sessions";
import type { TaskPlan } from "./taskplan";
import { TaskPlanView } from "./TaskPlanView";
import { FloorGraphic } from "./FloorGraphic";
import { createOfficeScene, hasWebGL, type SceneAgent } from "./officeScene";
import { Z } from "./layers";

/**
 * The 3D office floor: a React shell around the framework-free officeScene engine.
 * Owns the canvas' lifetime (created once, never re-created on re-render) and pushes
 * the layout in as scene state, so React re-renders cost a diff instead of a rebuild.
 *
 * Falls back to the SVG FloorGraphic — unchanged, same props — when the browser
 * cannot give us a WebGL context.
 */
export function ThreeFloor(props: {
  L: FloorLayout;
  plan?: TaskPlan | null;
  onSelectFig: (id: string | null) => void;
  onDeskClick: (zone: ZoneId, slot: number) => void;
  /** Right-click on a figure / on bare floor. Optional: the SVG fallback and
   * the browser build have no native menu to show. */
  onAgentContext?: (d: { id: string; tabId?: number; name?: string }) => void;
  onZoneContext?: (d: { zone: ZoneId; zoneLabel: string; slot: number | null }) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const scene = useRef<ReturnType<typeof createOfficeScene> | null>(null);
  // Decided once per mount: a mid-session WebGL loss would swap the floor out from
  // under the user, which is worse than a dead canvas.
  const [webgl] = useState(hasWebGL);

  // Latest handlers, read through a ref so the listeners below never need rebinding.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    if (!webgl || !host.current) return;
    const el = host.current;
    const s = createOfficeScene(el);
    scene.current = s;
    // Debug handle: lets a console session (or a screenshot harness) drive the
    // camera deterministically instead of simulating mouse gestures.
    //   domThreeScene.camera.position.set(x, y, z)
    //   domThreeScene.controls.target.set(x, y, z)
    (window as unknown as Record<string, unknown>).domThreeScene = s;
    const onAgent = (e: Event) => cb.current.onSelectFig((e as CustomEvent).detail.id);
    const onDesk = (e: Event) => {
      const d = (e as CustomEvent).detail as { zone: ZoneId; slot: number };
      cb.current.onDeskClick(d.zone, d.slot);
    };
    const onAgentCtx = (e: Event) => cb.current.onAgentContext?.((e as CustomEvent).detail);
    const onZoneCtx = (e: Event) => cb.current.onZoneContext?.((e as CustomEvent).detail);
    el.addEventListener("agentClick", onAgent);
    el.addEventListener("deskClick", onDesk);
    el.addEventListener("agentContext", onAgentCtx);
    el.addEventListener("zoneContext", onZoneCtx);
    return () => {
      el.removeEventListener("agentClick", onAgent);
      el.removeEventListener("deskClick", onDesk);
      el.removeEventListener("agentContext", onAgentCtx);
      el.removeEventListener("zoneContext", onZoneCtx);
      const w = window as unknown as Record<string, unknown>;
      if (w.domThreeScene === s) delete w.domThreeScene;
      s.destroy();
      scene.current = null;
    };
  }, [webgl]);

  // Sync the population every render — setAgents diffs, so unchanged agents keep
  // their geometry and only state changes touch the scene.
  useEffect(() => {
    if (!scene.current) return;
    const agents: SceneAgent[] = props.L.placed.map((p) => ({
      id: p.id, name: p.name, zone: p.zone, slot: p.slot, state: p.state, color: p.color,
    }));
    scene.current.setAgents(agents);
  }, [props.L]);

  if (!webgl) return <FloorGraphic L={props.L} plan={props.plan} onSelectFig={props.onSelectFig} onDeskClick={props.onDeskClick} />;

  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: "1440 / 900", background: "#0D0D12" }}>
      <div ref={host} data-testid="three-floor" style={{ position: "absolute", inset: 0, overflow: "hidden" }} />
      {props.plan && (
        <div style={{ position: "absolute", left: "2.8%", top: "1.5%", pointerEvents: "auto", zIndex: Z.floorCard }}>
          <TaskPlanView plan={props.plan} compact />
        </div>
      )}
    </div>
  );
}
