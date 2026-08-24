// Pure coordinated-task plan model. A task.plan event seeds one row per subtask
// (status "queued"); the subagent.start/end events that follow flip each row to
// running → done/failed and stamp start/end times for the elapsed clock. Kept as
// plain JS (like sessions.js / telemetry.js) so the browser and the Node verify run
// identical code. `now` is injected so the fold stays pure/deterministic.

/** Build a fresh plan from a task.plan event. */
export function planFromEvent(ev) {
  return {
    planId: ev.planId,
    subtasks: (ev.subtasks || []).map((s) => ({ index: s.index, description: s.description, status: "queued", startedAt: null, endedAt: null })),
  };
}

function updateFirst(plan, description, fn) {
  let changed = false;
  const subtasks = plan.subtasks.map((st) => {
    if (!changed && st.description === description && st.status !== "done" && st.status !== "failed") {
      changed = true;
      return fn(st);
    }
    return st;
  });
  return changed ? { ...plan, subtasks } : plan;
}

/** Fold a subagent.start / subagent.end event into the active plan (matched by
 * description). Returns the plan unchanged for unrelated events / no match. */
export function foldPlan(plan, ev, now) {
  if (!plan) return plan;
  if (ev.type === "subagent.start") return updateFirst(plan, ev.description, (st) => ({ ...st, status: "running", startedAt: st.startedAt ?? now }));
  if (ev.type === "subagent.end") return updateFirst(plan, ev.description, (st) => ({ ...st, status: ev.ok === false ? "failed" : "done", endedAt: now }));
  return plan;
}

/** Roll-up counts + whether every subtask has finished. */
export function planStatus(plan) {
  const c = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const s of plan.subtasks) c[s.status]++;
  return { ...c, total: plan.subtasks.length, complete: c.done + c.failed === plan.subtasks.length };
}

export function statusIcon(status) {
  return status === "done" ? "✓" : status === "failed" ? "✗" : status === "running" ? "◐" : "○";
}
export function statusColor(status) {
  return status === "done" ? "#4ADE80" : status === "failed" ? "#F87171" : status === "running" ? "#22D3EE" : "#6B6B7B";
}

/** Elapsed label for one subtask, ticking while running. "" before it starts. */
export function subtaskElapsed(st, now) {
  if (st.startedAt == null) return "";
  const end = st.endedAt ?? now;
  const s = Math.max(0, Math.floor((end - st.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
