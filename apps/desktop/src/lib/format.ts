const DAY = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Short list-row date: time today, weekday this week, month and day this year, else with year. */
export function listDate(t: number, now = Date.now()): string {
  if (!t) return "";
  const d = new Date(t);
  const today = startOfDay(now);
  if (t >= today) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (t >= today - DAY) return "Yesterday";
  if (t >= today - 6 * DAY) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function fullDate(t: number): string {
  return new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function tomorrowMorning(now = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

export function nextMondayMorning(now = Date.now()): number {
  const d = new Date(now);
  const day = d.getDay();
  const add = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + add);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

export function inDays(days: number, now = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

export function participantsLine(participants: Array<{ email: string; name: string }>, ownerEmails: Set<string>): string {
  const names = participants.map((p) => (ownerEmails.has(p.email) ? "Me" : p.name || p.email.split("@")[0] || p.email));
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]}, +${names.length - 2}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function tomorrowAt(hour: number, now = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function nextMondayAt(hour: number, now = Date.now()): number {
  const d = new Date(now);
  const day = d.getDay();
  const add = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + add);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Short eyebrow date: "SEP 3" or "SEP 3, 9:00" when a time matters. */
export function eyebrowDate(t: number, withTime = false): string {
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (withTime ? `${date}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : date).toUpperCase();
}

/** "Tue 9:00 AM" style, for the Scheduled view: when a queued message goes out. */
export function sendsAt(t: number): string {
  return new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
