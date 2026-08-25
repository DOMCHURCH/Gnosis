// THROWAWAY harness — renders the 3D office scene standalone for screenshotting.
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { createOfficeScene, type SceneAgent } from "./officeScene";
import "./styles.css";

const AGENTS: SceneAgent[] = [
  { id: "a1", name: "main", zone: "coordinator", slot: 0, state: "thinking" },
  { id: "a2", name: "plan", zone: "planning", slot: 0, state: "speaking" },
  { id: "a3", name: "spec", zone: "planning", slot: 1, state: "idle" },
  { id: "a4", name: "vite", zone: "application", slot: 0, state: "thinking" },
  { id: "a5", name: "tests", zone: "application", slot: 1, state: "awaiting" },
  { id: "a6", name: "edit-1", zone: "coding", slot: 0, state: "thinking" },
  { id: "a7", name: "edit-2", zone: "coding", slot: 1, state: "thinking" },
  { id: "a8", name: "edit-3", zone: "coding", slot: 2, state: "idle" },
  { id: "a9", name: "edit-4", zone: "coding", slot: 3, state: "awaiting" },
  { id: "a10", name: "sub-a", zone: "subagents", slot: 0, state: "thinking" },
  { id: "a11", name: "sub-b", zone: "subagents", slot: 1, state: "thinking" },
  { id: "a12", name: "sub-c", zone: "subagents", slot: 2, state: "idle" },
];

function Demo() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const s = createOfficeScene(ref.current!);
    for (const a of AGENTS) s.add(a);
    (window as unknown as { domThree: unknown }).domThree = s;
    (window as unknown as { __ready: boolean }).__ready = true;
    return () => s.destroy();
  }, []);
  return <div ref={ref} style={{ position: "absolute", inset: 0, background: "#0d0d12" }} />;
}

createRoot(document.getElementById("root")!).render(<Demo />);
