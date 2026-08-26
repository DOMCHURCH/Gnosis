import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, JobInfo } from "./types";
import { Z } from "./layers";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

function token(): string {
  return new URLSearchParams(location.search).get("token") ?? "";
}
async function apiGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
  const q = new URLSearchParams({ token: token(), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  try {
    const res = await fetch(`${path}?${q.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** "1m 04s" / "12s" from a millisecond span. */
function fmtRuntime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
const STATUS_COLOR: Record<JobInfo["status"], string> = { running: "#4ADE80", done: "#6B6B7B", error: "#F87171", killed: "#FBBF24" };

// Collapsible right-side panel listing every background job (the same /jobs the TUI
// drives — not a second process manager). Shows pid, command, detected port, live
// runtime and status; view streams captured output into a modal; kill sends a
// job.kill over the session websocket (SIGTERM→SIGKILL server-side). Refreshes on
// job.start/job.end (jobEpoch) and ticks a 1s clock for runtime while jobs run.
export function BackgroundPanel(props: { jobEpoch: number; send: (m: ClientMessage) => void }) {
  const [open, setOpen] = useState(true);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [viewing, setViewing] = useState<{ id: string; output: string; loading: boolean } | null>(null);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  const refresh = useCallback(() => {
    void apiGet<{ jobs: JobInfo[] }>("/api/jobs").then((r) => setJobs(r?.jobs ?? []));
  }, []);

  // Re-list whenever a job starts/ends, and poll while any job is running so a
  // late-bound port and the runtime clock stay current.
  useEffect(() => { refresh(); }, [refresh, props.jobEpoch]);
  const anyRunning = jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!anyRunning && !viewing) return;
    const t = setInterval(() => {
      setNow(Date.now());
      refresh();
      if (viewingRef.current) void loadOutput(viewingRef.current.id, true);
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyRunning, viewing, refresh]);

  const loadOutput = useCallback((id: string, silent = false) => {
    if (!silent) setViewing({ id, output: "", loading: true });
    void apiGet<{ id: string; output: string }>("/api/job", { id }).then((r) => {
      setViewing((cur) => (cur && cur.id === id ? { id, output: r?.output ?? "(no output)", loading: false } : cur));
    });
  }, []);

  const kill = (id: string) => props.send({ type: "job.kill", jobId: id });

  const running = jobs.filter((j) => j.status === "running").length;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} title="show background jobs"
        style={{ flex: "0 0 26px", width: 26, alignSelf: "stretch", position: "relative", zIndex: Z.panel, background: "#101017", color: running ? "#4ADE80" : "#6B6B7B", border: "2px solid #2A2A38", cursor: "pointer", fontFamily: MONO, fontSize: 10, letterSpacing: 1, writingMode: "vertical-rl" as const }}>
        ◂ JOBS{running ? ` ${running}` : ""}
      </button>
    );
  }

  return (
    <div data-testid="right-panel" style={{ flex: "0 0 244px", width: 244, alignSelf: "stretch", position: "relative", zIndex: Z.panel, minHeight: 0, background: "#15151C", border: "2px solid #2A2A38", display: "flex", flexDirection: "column", fontFamily: MONO }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "2px solid #2A2A38" }}>
        <span style={{ fontSize: 9, letterSpacing: 2, color: "#6B6B7B" }}>JOBS{running ? ` · ${running} RUNNING` : ""}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" onClick={refresh} title="refresh" style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>↻</button>
          <button type="button" onClick={() => setOpen(false)} title="hide" style={{ fontFamily: MONO, fontSize: 11, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>▸</button>
        </div>
      </div>
      <div style={{ flex: "1 1 auto", overflowY: "auto", overflowX: "hidden", padding: 6, minHeight: 0 }}>
        {jobs.length === 0 ? (
          <div style={{ fontSize: 10, color: "#4A4A58", padding: 8 }}>no background jobs</div>
        ) : (
          jobs.map((j) => <JobRow key={j.id} job={j} now={now} onView={() => loadOutput(j.id)} onKill={() => kill(j.id)} />)
        )}
      </div>
      {viewing && <OutputModal id={viewing.id} output={viewing.output} loading={viewing.loading} onClose={() => setViewing(null)} />}
    </div>
  );
}

function JobRow(props: { job: JobInfo; now: number; onView: () => void; onKill: () => void }) {
  const { job } = props;
  const live = job.status === "running";
  return (
    <div style={{ border: "1px solid #2A2A38", background: "#101017", padding: "7px 8px", marginBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 4, background: STATUS_COLOR[job.status], flex: "0 0 auto", animation: live ? "domTab 1.4s ease-in-out infinite" : undefined }} />
        <span style={{ fontSize: 10, color: "#C9C9D6" }}>job {job.id}</span>
        <span style={{ marginLeft: "auto", fontSize: 9, letterSpacing: 1, color: STATUS_COLOR[job.status], textTransform: "uppercase" }}>{job.status}</span>
      </div>
      <div title={job.command} style={{ fontSize: 10, color: "#8A8A9B", margin: "4px 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{job.command}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 9, color: "#6B6B7B" }}>
        {job.pid != null && <span>pid {job.pid}</span>}
        {job.port != null && <span style={{ color: "#22D3EE" }}>:{job.port}</span>}
        {live && <span>{fmtRuntime(props.now - job.startedAt)}</span>}
        {job.exitCode != null && !live && <span>exit {job.exitCode}</span>}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button type="button" onClick={props.onView} style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, background: "transparent", color: "#8A8A9B", border: "1px solid #2A2A38", padding: "3px 8px", cursor: "pointer" }}>OUTPUT</button>
        {live && <button type="button" onClick={props.onKill} style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 1, background: "transparent", color: "#F87171", border: "1px solid #402028", padding: "3px 8px", cursor: "pointer" }}>KILL</button>}
      </div>
    </div>
  );
}

function OutputModal(props: { id: string; output: string; loading: boolean; onClose: () => void }) {
  return (
    <div onClick={props.onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,5,8,0.72)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: Z.overlay }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(860px, 92vw)", maxHeight: "86vh", background: "#101017", border: "2px solid #2A2A38", display: "flex", flexDirection: "column", fontFamily: MONO }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "2px solid #2A2A38" }}>
          <span style={{ fontSize: 11, letterSpacing: 1, color: "#4ADE80" }}>job {props.id} · output</span>
          <button type="button" onClick={props.onClose} style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 12, background: "transparent", color: "#6B6B7B", border: 0, cursor: "pointer" }}>✕</button>
        </div>
        <pre style={{ margin: 0, flex: "1 1 auto", overflow: "auto", padding: 12, fontSize: 11, lineHeight: 1.5, color: "#C9C9D6", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {props.loading ? "loading…" : props.output || "(no output yet)"}
        </pre>
      </div>
    </div>
  );
}
