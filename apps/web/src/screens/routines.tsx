import { useState } from "react"
import type { Bot } from "@evie/contracts/bot"
import type { BotId, RoutineId } from "@evie/contracts/ids"
import type { Routine } from "@evie/contracts/routine"
import { Dialog, DialogBody, DialogHeader, DialogSurface, DialogToolbar } from "@evie/ui/components/dialog"
import { RoutineRow } from "@evie/ui/components/routine-row"
import { Segmented } from "@evie/ui/components/segmented"
import { TextField } from "@evie/ui/components/text-field"
import {
  buildCron,
  DEFAULT_CADENCE,
  fromTimeInput,
  isFiveField,
  localZone,
  toTimeInput,
  WEEKDAY_NAMES,
  type Cadence,
  type CadenceKind,
} from "@evie/ui/lib/cron"
import { formatDayDivider, formatRelative } from "~/lib/format.ts"

/**
 * Routines: the saved prompts the scheduler runs with nobody present.
 *
 * Two views rather than two screens, the same shape Plugins uses. The list is
 * what you came for; the editor is a tab, not a modal on a modal.
 *
 * The editor offers cadences instead of a cron field, with cron kept as the
 * escape hatch. `0 9 * * 1-5` is a fine thing to store and a bad thing to ask
 * someone to write, and the failure it invites -- an expression that parses and
 * means the wrong morning -- is silent until the run happens at 2am.
 *
 * A routine names its timezone explicitly, defaulted to the viewer's own and
 * editable, because the whole reason `tz` lives on the row is that the host's
 * zone is not the author's.
 */

const TABS = [
  { value: "list" as const, label: "Routines" },
  { value: "new" as const, label: "New routine" },
]

const CADENCES: ReadonlyArray<{ readonly value: CadenceKind; readonly label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "hourly", label: "Hourly" },
  { value: "minutes", label: "Minutes" },
  { value: "custom", label: "Cron" },
]

export interface RoutineDraft {
  readonly name: string
  readonly cron: string
  readonly tz: string
  readonly prompt: string
}

export interface RoutinesDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly routines: readonly Routine[]
  readonly bots: readonly Bot[]
  /** True until the first read settles, so an empty list is not shown as "none". */
  readonly loading: boolean
  readonly onCreate: (botId: BotId, draft: RoutineDraft) => void
  readonly onToggle: (botId: BotId, routineId: RoutineId, enabled: boolean) => void
  readonly onDelete: (botId: BotId, routineId: RoutineId) => void
}

export function RoutinesDialog({
  open,
  onOpenChange,
  routines,
  bots,
  loading,
  onCreate,
  onToggle,
  onDelete,
}: RoutinesDialogProps) {
  const [tab, setTab] = useState<"list" | "new">("list")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogSurface width={760} aria-label="Routines">
        <DialogHeader title="Routines" />

        <DialogToolbar>
          <Segmented options={TABS} value={tab} onChange={setTab} label="Routines view" />
          <div className="min-w-0 flex-1" />
        </DialogToolbar>

        <DialogBody>
          {tab === "list" ? (
            <RoutineList
              routines={routines}
              bots={bots}
              loading={loading}
              onToggle={onToggle}
              onDelete={onDelete}
              onStart={() => setTab("new")}
            />
          ) : (
            <RoutineEditor
              bots={bots}
              onCreate={(botId, draft) => {
                onCreate(botId, draft)
                setTab("list")
              }}
            />
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}

function RoutineList({
  routines,
  bots,
  loading,
  onToggle,
  onDelete,
  onStart,
}: {
  readonly routines: readonly Routine[]
  readonly bots: readonly Bot[]
  readonly loading: boolean
  readonly onToggle: (botId: BotId, routineId: RoutineId, enabled: boolean) => void
  readonly onDelete: (botId: BotId, routineId: RoutineId) => void
  readonly onStart: () => void
}) {
  const nameOf = new Map(bots.map((bot) => [bot.id as string, bot.name]))

  if (loading) {
    return <p className="text-compact text-fg-muted">Loading…</p>
  }
  if (routines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-compact text-fg-muted">
          No routines yet. A routine runs one of your bots on a schedule, with nobody watching —
          a morning digest, a nightly sweep, a check every fifteen minutes.
        </p>
        <button
          type="button"
          onClick={onStart}
          className="flex h-9 items-center rounded-small bg-raised-strong px-4 text-compact font-medium text-fg select-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none"
        >
          New routine
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {routines.map((routine) => (
        <RoutineRow
          key={routine.id}
          name={routine.name}
          cron={routine.cron}
          tz={routine.tz}
          enabled={routine.enabled}
          blockedReason={routine.blockedReason}
          nextRun={routine.nextRunAt === null ? null : formatDayDivider(routine.nextRunAt)}
          lastRun={routine.lastRunAt === null ? null : formatRelative(routine.lastRunAt)}
          // Only worth the pixels when the list spans bots; with one bot the
          // column is the same word on every row, which the eye learns to skip.
          botName={bots.length > 1 ? nameOf.get(routine.botId as string) : undefined}
          onToggle={() => onToggle(routine.botId, routine.id, !routine.enabled)}
          onDelete={() => onDelete(routine.botId, routine.id)}
        />
      ))}
    </div>
  )
}

function RoutineEditor({
  bots,
  onCreate,
}: {
  readonly bots: readonly Bot[]
  readonly onCreate: (botId: BotId, draft: RoutineDraft) => void
}) {
  const [botId, setBotId] = useState<string>(bots[0]?.id ?? "")
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [cadence, setCadence] = useState<Cadence>(DEFAULT_CADENCE)
  const [customCron, setCustomCron] = useState("")
  // Read once on mount rather than per render: this is a default the person can
  // overwrite, and a field that rewrites itself under the cursor is a bug.
  const [tz, setTz] = useState(localZone)

  const cron = cadence.kind === "custom" ? customCron.trim() : buildCron(cadence)
  const cronValid = isFiveField(cron)
  const ready =
    botId !== "" && name.trim().length > 0 && prompt.trim().length > 0 && cronValid && tz.trim().length > 0

  const submit = () => {
    if (!ready) return
    onCreate(botId as BotId, {
      name: name.trim(),
      cron,
      tz: tz.trim(),
      prompt: prompt.trim(),
    })
  }

  return (
    <div className="flex flex-col gap-5">
      {bots.length > 1 && (
        <label className="flex flex-col gap-2">
          <span className="text-compact text-fg-muted select-none">Bot</span>
          <select
            value={botId}
            onChange={(e) => setBotId(e.target.value)}
            className="h-11 w-full rounded-default bg-raised px-3.5 text-body text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
          >
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <TextField
        id="routine-name"
        label="Name"
        placeholder="Morning digest"
        hint="What you will recognise it by in this list."
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <label className="flex flex-col gap-2">
        <span className="text-compact text-fg-muted select-none">Prompt</span>
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Summarise what changed in the repo since yesterday and post it here."
          className="w-full resize-y rounded-default bg-raised px-3.5 py-3 text-body text-fg outline-none placeholder:text-fg-muted focus-visible:ring-2 focus-visible:ring-focus/50"
        />
        <span className="text-metadata text-fg-muted">
          Sent to the bot exactly as a message would be. Nobody is there to answer a question, so
          say what to do when there is nothing to report.
        </span>
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-compact text-fg-muted select-none">Cadence</span>
        <Segmented
          options={CADENCES}
          value={cadence.kind}
          onChange={(kind) => setCadence((c) => ({ ...c, kind }))}
          label="Cadence"
        />
        <CadenceFields
          cadence={cadence}
          onChange={setCadence}
          customCron={customCron}
          onCustomCron={setCustomCron}
          cronValid={cronValid}
        />
      </div>

      <TextField
        id="routine-tz"
        label="Timezone"
        hint="Stored on the routine. The schedule keeps this zone wherever the server is."
        value={tz}
        onChange={(e) => setTz(e.target.value)}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!ready}
          onClick={submit}
          className="flex h-9 items-center rounded-small bg-raised-strong px-4 text-compact font-medium text-fg select-none hover:opacity-80 disabled:pointer-events-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:outline-none"
        >
          Create routine
        </button>
        {cron !== "" && cronValid && (
          <code className="text-metadata text-fg-muted">{cron}</code>
        )}
      </div>
    </div>
  )
}

function CadenceFields({
  cadence,
  onChange,
  customCron,
  onCustomCron,
  cronValid,
}: {
  readonly cadence: Cadence
  readonly onChange: (cadence: Cadence) => void
  readonly customCron: string
  readonly onCustomCron: (value: string) => void
  readonly cronValid: boolean
}) {
  const time = (
    <TextField
      id="routine-time"
      label="Time"
      type="time"
      value={toTimeInput(cadence.hour, cadence.minute)}
      onChange={(e) => {
        const parsed = fromTimeInput(e.target.value)
        if (parsed) onChange({ ...cadence, ...parsed })
      }}
      containerClassName="w-40"
    />
  )

  switch (cadence.kind) {
    case "daily":
    case "weekdays":
      return <div className="flex gap-4">{time}</div>
    case "weekly":
      return (
        <div className="flex items-end gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-compact text-fg-muted select-none">Day</span>
            <select
              value={cadence.weekday}
              onChange={(e) => onChange({ ...cadence, weekday: Number(e.target.value) })}
              className="h-11 rounded-default bg-raised px-3.5 text-body text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
            >
              {WEEKDAY_NAMES.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </label>
          {time}
        </div>
      )
    case "hourly":
      return (
        <TextField
          id="routine-minute"
          label="Minute past the hour"
          type="number"
          min={0}
          max={59}
          value={cadence.minute}
          onChange={(e) => onChange({ ...cadence, minute: clamp(e.target.value, 0, 59) })}
          containerClassName="w-40"
        />
      )
    case "minutes":
      return (
        <TextField
          id="routine-every"
          label="Every N minutes"
          type="number"
          min={1}
          max={59}
          hint="A frequent routine is a real cost. Prefer the longest gap that still works."
          value={cadence.every}
          onChange={(e) => onChange({ ...cadence, every: clamp(e.target.value, 1, 59) })}
          containerClassName="w-40"
        />
      )
    case "custom":
      return (
        <TextField
          id="routine-cron"
          label="Cron expression"
          placeholder="0 9 * * 1-5"
          hint="Five fields: minute, hour, day of month, month, day of week."
          error={customCron.trim().length > 0 && !cronValid ? "Needs exactly five fields." : undefined}
          value={customCron}
          onChange={(e) => onCustomCron(e.target.value)}
        />
      )
  }
}

const clamp = (value: string, min: number, max: number): number => {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) return min
  return Math.min(Math.max(n, min), max)
}
