import { useState } from "react";
import type { FigState, ManualAgent, ZoneId } from "./sessions";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STATES: FigState[] = ["idle", "thinking", "awaiting", "speaking"];

/** Dialog for placing or editing a decorative "manual" agent on a desk. Add mode
 * (from an empty desk / zone) collects a name + state. Edit mode (from an existing
 * manual figure) pre-fills both and offers Remove. */
export function ManualAgentPopover(props: {
  mode: "add" | "edit";
  zone: ZoneId;
  slot: number;
  defaultName: string;
  agent?: ManualAgent;
  onAdd: (name: string, state: FigState) => void;
  onUpdate: (patch: Partial<ManualAgent>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.agent?.name ?? props.defaultName);
  const [figState, setFigState] = useState<FigState>(props.agent?.state ?? "idle");

  const submit = () => {
    const n = name.trim() || props.defaultName;
    if (props.mode === "add") props.onAdd(n, figState);
    else props.onUpdate({ name: n, state: figState });
    props.onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <DialogContent className="w-[300px] max-w-[92vw] gap-4 font-mono">
        <DialogHeader className="flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-xs tracking-widest">{props.mode === "add" ? "PLACE AGENT" : "EDIT AGENT"}</DialogTitle>
          <span className="text-[9px] tracking-wider text-muted-foreground">{props.zone.toUpperCase()}</span>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label className="text-[9px] tracking-wider text-muted-foreground">NAME</Label>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} className="h-8 text-xs" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-[9px] tracking-wider text-muted-foreground">STATE</Label>
          <div className="flex gap-1">
            {STATES.map((s) => (
              <Button key={s} type="button" size="sm" variant={figState === s ? "default" : "outline"}
                onClick={() => setFigState(s)} className="h-7 flex-1 px-1 text-[9px] uppercase tracking-wider">
                {s}
              </Button>
            ))}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-start">
          <Button type="button" onClick={submit} className="h-8 flex-1 text-[10px] tracking-widest">
            {props.mode === "add" ? "ADD" : "SAVE"}
          </Button>
          {props.mode === "edit" && (
            <Button type="button" variant="outline" onClick={() => { props.onRemove(); props.onClose(); }}
              className="h-8 text-[10px] tracking-wider text-destructive">REMOVE</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
