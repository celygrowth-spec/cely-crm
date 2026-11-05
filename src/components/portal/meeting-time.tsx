"use client";

// Horaire d'un point : fuseau du point affiché clairement, et conversion dans le fuseau du visiteur s'il diffère.
import { useSyncExternalStore } from "react";
import { browserTimeZone, formatLongDate, formatTimeShort, timeZoneLabel } from "@/lib/appointments/time";

const subscribe = () => () => undefined;

export function MeetingTime({ start, end, tz, long = true }: { start: string; end: string; tz: string; long?: boolean }) {
  const local = useSyncExternalStore(subscribe, browserTimeZone, () => tz);
  return (
    <span>
      {long && <>{formatLongDate(start, tz)}, </>}
      {formatTimeShort(start, tz)} – {formatTimeShort(end, tz)} <span className="text-muted">({timeZoneLabel(tz, new Date(start))})</span>
      {local !== tz && <span className="block text-xs text-muted">Soit {formatTimeShort(start, local)} – {formatTimeShort(end, local)} chez vous ({timeZoneLabel(local, new Date(start))})</span>}
    </span>
  );
}
